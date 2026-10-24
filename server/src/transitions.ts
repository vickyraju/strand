// Which transition a move uses, and whether its rules let it happen. The rules themselves are in shared/transitionRules.ts.
import { z } from 'zod'
import type { Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { roleOf } from './access.ts'
import {
  LIMITS, SETTABLE, allows, conditionsIn, depthOf, groupsIn, isRuleField, type ConditionGroup, type RuleCtx, type TransitionRules,
} from './shared/transitionRules.ts'

const uuid = z.string().uuid()
const field = z.string().refine(isRuleField, 'Unknown field')
const value = z.union([z.string().max(5000), z.number()])
const condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), who: z.enum(['assignee', 'reporter', 'lead']) }),
  z.object({ kind: z.literal('users'), userIds: z.array(uuid).min(1).max(100) }),
  z.object({ kind: z.literal('role'), roles: z.array(z.enum(['admin', 'member'])).min(1) }),
  z.object({ kind: z.literal('group'), groupIds: z.array(uuid).min(1).max(100) }),
  z.object({ kind: z.literal('field'), field, op: z.enum(['empty', 'notEmpty', 'is', 'isNot']), value: value.optional() }),
  z.object({ kind: z.literal('childrenDone') }),
  z.object({ kind: z.literal('hidden') }),
])
const group: z.ZodType<ConditionGroup> = z.lazy(() => z.object({
  op: z.enum(['all', 'any']), items: z.array(z.union([group, condition])).max(LIMITS.rulesPerGroup),
}))
export const rulesSchema = z.object({
  restrict: group.optional(),
  validate: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('required'), fields: z.array(z.union([field, z.literal('comment')])).min(1) }),
    z.object({ kind: z.literal('changed'), field }),
    z.object({ kind: z.literal('parentStatus'), statusIds: z.array(uuid).min(1) }),
  ])).max(LIMITS.validators).optional(),
  screen: z.array(z.union([field, z.literal('comment')])).max(30).optional(),
  actions: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('assign'), to: z.enum(['mover', 'reporter', 'lead', 'none', 'user']), userId: uuid.optional() }),
    z.object({ kind: z.literal('set'), field: field.refine(f => SETTABLE.includes(f) || f.startsWith('custom.'), 'This field can’t be set by a transition'), value: z.union([value, z.null()]) }),
    z.object({ kind: z.literal('copyFromParent'), field }),
    z.object({ kind: z.literal('comment'), body: z.string().min(1).max(20000) }),
  ])).max(LIMITS.actions).optional(),
}).superRefine((r, c) => {
  if (r.restrict && groupsIn(r.restrict) > LIMITS.groups) c.addIssue({ code: 'custom', path: ['restrict'], message: `At most ${LIMITS.groups} groups` })
  if (r.restrict && depthOf(r.restrict) > LIMITS.depth) c.addIssue({ code: 'custom', path: ['restrict'], message: `Groups nest at most ${LIMITS.depth} deep` })
  for (const a of r.actions ?? []) if (a.kind === 'assign' && a.to === 'user' && !a.userId) c.addIssue({ code: 'custom', path: ['actions'], message: 'Choose who to assign' })
}) satisfies z.ZodType<TransitionRules>

export interface TransitionRow { id: string; name: string; fromIds: string[] | null; toId: string | null; rules: TransitionRules; typeKeys: string[] | null }

/** Is this transition part of the workflow for the item's work type? (null: every type) */
const forType = (t: TransitionRow, item: any) => t.typeKeys === null || t.typeKeys.includes(item.type)

/** Everything a rule may look at for one item and one mover (null: automation). */
export async function ruleContext(d: Db, item: any, me: Me | null): Promise<RuleCtx> {
  const [[p], [{ open }], [parent], groups] = await Promise.all([
    d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [item.projectId]),
    d.query<{ open: number }>(
      `select count(*)::int as open from issues c join statuses s on s.id = c.status_id
        where c.parent_id = $1 and c.deleted_at is null and s.category <> 'done'`, [item.id]) as any,
    item.parentId ? d.query<any>('select status_id, custom, release_id, sprint_id, priority, labels, due_date, start_date, estimate, time_estimate, resolution, assignee_id, description, type from issues where id = $1', [item.parentId]) : Promise.resolve([]),
    me ? d.query<{ groupId: string }>('select group_id from group_members where user_id = $1', [me.id]) : Promise.resolve([]),
  ])
  const names = await d.query<{ id: string; name: string }>(
    `select id::text, name from statuses where project_id = $1 union all select id::text, name from field_defs where project_id = $1`, [item.projectId])
  const name = new Map(names.map(n => [n.id, n.name]))
  return {
    mover: me ? { id: me.id, role: await roleOf(d, me, item.projectId), groupIds: groups.map(g => g.groupId) } : null,
    item, leadId: p?.leadId ?? null, openChildren: open, parent: parent ?? null,
    statusName: id => name.get(id) ?? 'another status',
    fieldName: f => (f.startsWith('custom.') ? name.get(f.slice(7)) ?? 'A custom field' : undefined) as string,
  }
}

const rowsOf = (d: Db, projectId: string) =>
  d.query<TransitionRow>('select id, name, from_ids, to_id, rules, type_keys from transitions where project_id = $1 order by id', [projectId])

/** The transition for moving `item` to status `to`: one that starts where the item is and ends there, and whose
 *  Restrict rules let this mover use it. Null when the project has no workflow (any move goes).
 *  409 when the workflow has no such move; 403 when it has, but its rules don't let this person make it. */
export async function transitionTo(d: Db, item: any, to: string, ctx: RuleCtx): Promise<TransitionRow | null> {
  const all = await rowsOf(d, item.projectId)
  if (!all.length) return null
  const fits = all.filter(t => forType(t, item) && t.toId === to && (t.fromIds === null || t.fromIds.includes(item.statusId)))
  if (!fits.length) throw new HttpError(409, 'That move is not allowed by the workflow')
  const usable = fits.find(t => allows(t.rules.restrict, ctx))
  if (!usable) throw new HttpError(403, `You can’t make this move: ${restrictMessage(fits[0]!.rules.restrict)}`)
  return usable
}

/** A transition chosen by id (POST /issues/:key/transitions), which must start where the item is and be allowed for this mover. */
export async function transitionById(d: Db, item: any, id: string, ctx: RuleCtx): Promise<TransitionRow> {
  const [t] = await d.query<TransitionRow>('select id, name, from_ids, to_id, rules, type_keys from transitions where id = $1 and project_id = $2', [id, item.projectId])
  if (!t || !forType(t, item)) throw new HttpError(404, 'No such transition for this work type')
  if (t.fromIds !== null && !t.fromIds.includes(item.statusId)) throw new HttpError(409, `“${t.name}” doesn’t start from this item’s status`)
  if (!allows(t.rules.restrict, ctx)) throw new HttpError(403, `You can’t make this move: ${restrictMessage(t.rules.restrict)}`)
  return t
}

/** Transitions this mover can use from where the item is now (Jira's GET issue transitions). */
export async function available(d: Db, item: any, ctx: RuleCtx) {
  return (await rowsOf(d, item.projectId)).filter(t => forType(t, item) && (t.fromIds === null || t.fromIds.includes(item.statusId)) && t.toId !== item.statusId && allows(t.rules.restrict, ctx))
}

/** A short reason for a refusal, from the kinds of rule involved. */
function restrictMessage(g: ConditionGroup | undefined) {
  const kinds = new Set(conditionsIn(g).map(c => c.kind))
  if (kinds.has('hidden')) return 'only automation makes it'
  if (kinds.has('childrenDone') && kinds.size === 1) return 'its child items must be done first'
  return 'the workflow limits who can make it, or when'
}
