// Moving work between projects (spec 0501), as Jira's Move: the target's type and status, versions and components by name,
// custom fields by name and kind, a new key while the old one keeps working, sub-items moving with their parent.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { canJoinWork, need, roleOf } from '../access.ts'
import { statusesFor } from '../workflows.ts'
import { publish } from '../events.ts'
import { emit } from '../webhooks.ts'
import { getSetting } from '../settings.ts'
import { ISSUE_ROW, checkLevels, checkType, issueByKey } from './issues.ts'
import { projectByKey } from './projects.ts'
import { enforceRules, rulesFor } from '../fields.ts'

const uuid = z.string().uuid()
const target = {
  projectKey: z.string().min(1).max(255).describe('The project it moves to'),
  type: z.string().min(1).max(40).optional().describe('A work type of the target (default: the same one, when the target has it)'),
}
const one = z.object({
  ...target,
  statusId: uuid.optional().describe('A status of the target’s workflow for the type (needed when the item’s status isn’t in it)'),
  assigneeId: uuid.nullable().optional().describe('Who it goes to when its assignee can’t be assigned in the target (default: nobody)'),
  fixReleaseIds: z.array(uuid).max(50).optional().describe('The target’s versions (default: those with the same names)'),
  affectsReleaseIds: z.array(uuid).max(50).optional(), componentIds: z.array(uuid).max(50).optional(),
  dryRun: z.boolean().default(false).describe('Only say what would change (Jira’s confirmation page)'),
})

interface Change { field: string; from: unknown; to: unknown }
interface Plan { id: string; key: string; newKey: string; changes: Change[]; patch: Record<string, unknown> }

/** Names, for the preview. */
async function names(d: Db, table: string, ids: string[] | null) {
  if (!ids?.length) return [] as string[]
  return (await d.query<{ name: string }>(`select name from ${table} where id = any($1::uuid[]) order by name`, [ids])).map(r => r.name)
}

/** The same-named versions or components of the target. */
async function sameNames(d: Db, table: 'releases' | 'components', from: string[] | null, targetId: string) {
  if (!from?.length) return []
  return (await d.query<{ id: string }>(`select t.id from ${table} t join ${table} s on lower(s.name) = lower(t.name)
      where s.id = any($1::uuid[]) and t.project_id = $2${table === 'releases' ? ' and not t.archived' : ''}`, [from, targetId])).map(r => r.id)
}

/** What moving one item (or one of its sub-items) to the target does: the changes for its preview and the patch to write. */
async function planFor(d: Db, item: any, tgt: { id: string; key: string; nextNumber: number }, o: z.infer<typeof one> & { statusMap?: Record<string, string> }, type: string, n: number, sub: boolean): Promise<Plan> {
  const changes: Change[] = []
  const patch: Record<string, unknown> = { project_id: tgt.id, type }
  const allowed = await statusesFor(d, tgt.id, type)
  if (!allowed.length) throw new HttpError(400, `${tgt.key} has no workflow for that type`, { type: 'No workflow' })
  // R3: the same status when the target's workflow has it, else the one chosen, else (sub-items, bulk) one of the same category, else the start
  const [same] = await d.query<{ id: string }>(`select t.id from statuses s join statuses t on t.global_status_id = s.global_status_id and t.project_id = $2
      where s.id = $1 and t.id = any($3::uuid[])`, [item.statusId, tgt.id, allowed])
  let statusId = o.statusMap?.[item.statusId] ?? same?.id ?? (!sub ? o.statusId : undefined)
  if (!statusId && sub) {
    const [cat] = await d.query<{ id: string }>(`select t.id from statuses s join statuses t on t.category = s.category and t.project_id = $2
        where s.id = $1 and t.id = any($3::uuid[]) order by array_position($3::uuid[], t.id) limit 1`, [item.statusId, tgt.id, allowed])
    statusId = cat?.id ?? allowed[0]
  }
  if (!statusId) throw new HttpError(400, `${item.key}’s status isn’t in ${tgt.key}’s workflow: choose its new status`, { statusId: 'Choose a status' })
  if (!allowed.includes(statusId)) throw new HttpError(400, 'That status isn’t in the target’s workflow for this type', { statusId: 'Not in the workflow' })
  patch.status_id = statusId
  const st = async (id: string) => (await d.query<{ name: string; category: string }>('select name, category from statuses where id = $1', [id]))[0]
  const [was, now] = [await st(item.statusId), await st(statusId)]
  changes.push({ field: 'Project', from: item.key.split('-')[0], to: tgt.key }, { field: 'Key', from: item.key, to: `${tgt.key}-${n}` })
  if (type !== item.type) changes.push({ field: 'Type', from: item.type, to: type })
  if (was?.name !== now?.name) changes.push({ field: 'Status', from: was?.name, to: now?.name })
  // R4: versions and components by name, unless chosen
  for (const [field, col, table, label] of [['fixReleaseIds', 'fix_release_ids', 'releases', 'Fix versions'], ['affectsReleaseIds', 'affects_release_ids', 'releases', 'Affects versions'],
    ['componentIds', 'component_ids', 'components', 'Components']] as const) {
    const chosen = !sub ? o[field] : undefined
    if (chosen?.length && (await d.query(`select 1 from ${table} where id = any($1::uuid[]) and project_id <> $2`, [chosen, tgt.id])).length)
      throw new HttpError(400, `Those ${label.toLowerCase()} aren’t ${tgt.key}’s`, { [field]: `Not ${tgt.key}’s` })
    const next = chosen ?? await sameNames(d, table, item[field], tgt.id)
    patch[col] = next
    const [a, b] = [await names(d, table, item[field]), await names(d, table, next)]
    if (a.join() !== b.join()) changes.push({ field: label, from: a.join(', ') || null, to: b.join(', ') || null })
  }
  // custom fields: kept under the target's field of the same name and kind
  if (item.custom && Object.keys(item.custom).length) {
    const map = await d.query<{ src: string; dst: string | null; name: string; kind: string }>(`select s.id as src, t.id as dst, s.name, s.kind from field_defs s
        left join field_defs t on t.project_id = $2 and lower(t.name) = lower(s.name) and t.kind = s.kind where s.project_id = $1`, [item.projectId, tgt.id])
    const custom: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item.custom)) {
      const m = map.find(x => x.src === k)
      // version pickers name the target's versions of the same names (spec 0502)
      if (m?.dst && (m.kind === 'version' || m.kind === 'versions')) {
        const ids = await sameNames(d, 'releases', (Array.isArray(v) ? v : [v]) as string[], tgt.id)
        if (ids.length) custom[m.dst] = m.kind === 'version' ? ids[0]! : ids
        else changes.push({ field: m.name, from: (await names(d, 'releases', (Array.isArray(v) ? v : [v]) as string[])).join(', '), to: null })
      } else if (m?.dst) custom[m.dst] = v
      else changes.push({ field: m?.name ?? 'A custom field', from: v, to: null })
    }
    patch.custom = JSON.stringify(custom)
  }
  if (item.sprintId) { patch.sprint_id = null; changes.push({ field: 'Sprint', from: (await names(d, 'sprints', [item.sprintId]))[0], to: null }) }
  if (item.testFolderId) patch.test_folder_id = null
  // strand: security levels belong to a project, so the target's own apply (spec 0501, Strand branch)
  if (item.securityLevelId) { patch.security_level_id = null; changes.push({ field: 'Security level', from: (await names(d, 'security_levels', [item.securityLevelId]))[0], to: null }) }
  // an assignee who can't be assigned in the target is replaced (JRASERVER-39112)
  if (item.assigneeId && !(await canJoinWork(d, tgt.id, item.assigneeId))) {
    const to = !sub && o.assigneeId && (await canJoinWork(d, tgt.id, o.assigneeId)) ? o.assigneeId : null
    patch.assignee_id = to
    const who = async (id: string | null) => (id ? (await d.query<{ name: string }>('select name from users where id = $1', [id]))[0]?.name : null)
    changes.push({ field: 'Assignee', from: await who(item.assigneeId), to: await who(to) })
  }
  if (item.resolution && now?.category !== 'done') { patch.resolution = null; patch.resolved_at = null; changes.push({ field: 'Resolution', from: item.resolution, to: null }) }
  return { id: item.id, key: item.key, newKey: `${tgt.key}-${n}`, changes, patch }
}

/** Moves one item and its sub-items (or, with `dryRun`, only says what would change). */
export async function moveItem(d: Db, me: Me, item: any, o: z.infer<typeof one> & { statusMap?: Record<string, string> }, req: { me: Me; method: string }) {
  const tgt = await projectByKey(d, req, o.projectKey, 'createIssues')
  if (tgt.id === item.projectId) throw new HttpError(400, 'It’s already in that project: change its type instead', { projectKey: 'Same project' })
  need((await roleOf(d, me, item.projectId)) ?? 'viewer', 'moveIssues', item.key.split('-')[0])
  const [parent] = item.parentId ? await d.query<{ type: string }>('select type from issues where id = $1', [item.parentId]) : []
  if (parent && parent.type !== 'epic') throw new HttpError(400, 'A sub-item moves with its parent: move the parent', { issue: 'A sub-item' })
  const type = o.type ?? item.type
  if (!o.type && !(await d.query('select 1 from work_types where project_id = $1 and key = $2', [tgt.id, type])).length)
    throw new HttpError(400, `${tgt.key} has no ${item.type} type: choose one`, { type: 'Choose a type' })
  await checkType(d, tgt.id, type)
  await checkLevels(d, me, tgt.id, item, type, item.parentId)
  const subs = await d.query<any>(`${ISSUE_ROW} where i.parent_id = $1 and i.deleted_at is null order by i.rank`, [item.id])
  const [{ next }] = await d.query<{ next: number }>('select next_number as next from projects where id = $1', [tgt.id]) as any
  const t = { id: tgt.id, key: tgt.key, nextNumber: next }
  const plans = [await planFor(d, item, t, o, type, next, false)]
  // the target's field configuration (spec 0504 R4): what it requires, the item must have once moved
  const pa = plans[0]!.patch
  const after = { ...item, type, statusId: pa.status_id, fixReleaseIds: pa.fix_release_ids, affectsReleaseIds: pa.affects_release_ids, componentIds: pa.component_ids,
    sprintId: 'sprint_id' in pa ? pa.sprint_id : item.sprintId, assigneeId: 'assignee_id' in pa ? pa.assignee_id : item.assigneeId,
    resolution: 'resolution' in pa ? pa.resolution : item.resolution, custom: typeof pa.custom === 'string' ? JSON.parse(pa.custom) : item.custom }
  const rules = (await rulesFor(d, tgt.id))[type] ?? {}
  const missing = Object.entries(rules).filter(([, r]) => r.required && !r.hidden).map(([k]) => k)
  if (missing.length) await enforceRules(d, tgt.id, type, after, missing)
  for (const [k, s] of subs.entries()) plans.push(await planFor(d, s, t, o, s.type, next + 1 + k, true))
  if (o.dryRun) return { dryRun: true, items: plans.map(({ patch, ...p }) => p) }

  for (const p of plans) {
    const [{ number }] = await d.query<{ number: number }>('select next_issue_number($1) as number', [tgt.id]) as any
    const [old] = await d.query<{ projectId: string; number: number; workspaceId: string }>('select project_id, number, workspace_id from issues where id = $1 for update', [p.id])
    // R5: the old key keeps meaning this item (numbers are never reused)
    await d.query('insert into moved_issue_keys (workspace_id, project_id, number, issue_id, moved_by) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [old!.workspaceId, old!.projectId, old!.number, p.id, me.id])
    const cols = Object.keys(p.patch)
    await d.query(`update issues set number = $2, ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now() where id = $1`,
      [p.id, number, ...cols.map(c => p.patch[c])])
    const newKey = `${tgt.key}-${number}`
    await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
      [p.id, me.id, 'key', p.key, newKey, `Moved from ${p.key}`])
    await emit(d, me.workspaceId, 'jira:issue_updated', { issueId: p.id, projectId: tgt.id, type: 'issue_moved' }, me.id,
      [{ field: 'key', from: p.key, to: newKey }, { field: 'projectId', from: old!.projectId, to: tgt.id }])
  }
  await publish(d, item.projectId, { type: 'issue.deleted', id: item.id })
  await publish(d, tgt.id, { type: 'issue.created', id: item.id })
  return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [item.id]))[0]
}

const plugin: FastifyPluginAsyncZod = async app => {
  app.post('/issues/:key/move', { schema: {
    tags: ['Issues'], summary: 'Move an item (with its sub-items) to another project, as Jira’s Move: a new key, the old one still works. dryRun: only say what would change',
    params: z.object({ key: z.string() }), body: one,
  } }, async req => tx(async d => moveItem(d, req.me, await issueByKey(d, req, req.params.key, false, 'browse'), req.body, req)))

  app.post('/issues/bulk/move', { schema: {
    tags: ['Issues: bulk'], summary: 'Move many items to one project (Jira’s bulk Move); statuses map as for one item, or by statusMap',
    body: z.object({ issues: z.array(z.string()).min(1).max(5000), ...target, statusMap: z.record(uuid, uuid).optional().describe('Source status id → target status id') }),
  } }, async req => {
    const { bulkMaxItems } = await getSetting(req.me.workspaceId, 'searchAndBulk')
    const refs = [...new Set(req.body.issues)]
    if (refs.length > bulkMaxItems) throw new HttpError(400, `At most ${bulkMaxItems} items in one bulk change (System settings)`, { issues: 'Too many' })
    return tx(async d => {
      const out: { key: string; newKey: string }[] = []
      for (const ref of refs) {
        const item = await issueByKey(d, req, ref, false, 'browse')
        const [parent] = item.parentId ? await d.query<{ type: string }>('select type from issues where id = $1', [item.parentId]) : []
        if (parent && parent.type !== 'epic' && refs.length > 1) continue      // moves with its parent
        const moved = await moveItem(d, req.me, item, { ...req.body, dryRun: false }, req)
        out.push({ key: item.key, newKey: moved.key })
      }
      return { moved: out }
    })
  })
}
export default plugin
