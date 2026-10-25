import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { canJoinWork, commentShown, levelOk, minFor, need, roleOf, visible, visibleAs, type ProjectRole } from '../access.ts'
import { publish } from '../events.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { runRules, moveAllowed } from '../rules.ts'
import { available, ruleContext, transitionById, transitionTo, type TransitionRow } from '../transitions.ts'
import { actionChanges, problems, type RuleCtx } from '../shared/transitionRules.ts'
import { adjustRemaining, remainingWhenEstimated, type Adjust } from '../shared/estimates.ts'
import { projectByKey } from './projects.ts'

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const type = z.string().min(1).max(40).describe('A work type key of the project (GET /projects/:key: types): epic, story, task, bug, or one the project added')
const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])
export const RESOLUTIONS = ['Done', "Won't do", 'Duplicate', 'Cannot reproduce'] as const

export const ISSUE_ROW = `
  select i.id, p.key || '-' || i.number as key, i.project_id, i.number, i.type, i.title, i.description,
         i.status_id, i.priority, i.assignee_id, i.reporter_id, i.labels, i.estimate, i.time_estimate, i.time_remaining, i.component_ids, i.affects_release_ids, i.security_level_id,
         i.due_date, i.start_date, i.sprint_id, i.release_id, i.parent_id, i.custom, i.rank, i.version,
         i.resolution, i.resolved_at, i.created_at, i.updated_at
    from issues i join projects p on p.id = i.project_id`

const patchBody = z.object({
  title: z.string().min(1).max(500), description: z.string(), type, priority, statusId: uuid,
  assigneeId: uuid.nullable(), labels: z.array(z.string().max(50)).max(50), estimate: z.number().nonnegative().nullable(),
  timeEstimate: z.number().int().nonnegative().nullable(), timeRemaining: z.number().int().nonnegative().nullable().describe('Remaining estimate, minutes (starts at the original estimate)'),
  dueDate: date.nullable(), startDate: date.nullable(),
  sprintId: uuid.nullable(), releaseId: uuid.nullable().describe('Fix version'), parentId: uuid.nullable(),
  securityLevelId: uuid.nullable().describe('Security level: only its members see the item (null: everyone in the project)'),
  componentIds: z.array(uuid).max(50).describe('Components of the project'), affectsReleaseIds: z.array(uuid).max(50).describe('Affects versions: releases of the project where it was found'),
  custom: z.record(z.string(), z.union([z.string(), z.number()])), rank: z.number(),
  resolution: z.enum(RESOLUTIONS).nullable().describe('How a finished item ended. Only for items in a Done status; reaching Done sets "Done" unless you say otherwise (null: the default)'),
}).partial()
const FIELDS = Object.keys(patchBody.shape)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** "PAY-12" or the issue's uuid → the issue, or 404 when it does not exist or I cannot see its project (Jira calls this issueIdOrKey).
 *  `min` is the project role the request needs: by default reading needs any role and changing things needs member. */
export async function issueByKey(d: Db, req: { me: Me; method: string }, ref: string, includeDeleted = false, min?: ProjectRole) {
  const live = includeDeleted ? '' : 'and i.deleted_at is null'
  const byId = UUID.test(ref)
  const m = byId ? null : /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref)
  if (!byId && !m) throw new HttpError(404, 'Issue not found')
  const ws = req.me.workspaceId
  const [i] = byId
    ? await d.query<any>(`${ISSUE_ROW} where i.workspace_id = $1 and i.id = $2 ${live}`, [ws, ref])
    : await d.query<any>(`${ISSUE_ROW} where i.workspace_id = $1 and p.key = $2 and i.number = $3 ${live}`, [ws, m![1]!.toUpperCase(), Number(m![2])])
  const role = i ? await roleOf(d, req.me, i.projectId) : null
  if (!i || !role) throw new HttpError(404, 'Issue not found')
  // an item whose security level leaves me out doesn't exist, as far as I can tell
  if (i.securityLevelId && !(await d.query(`select 1 from issues i where i.id = $1 and ${levelOk(req.me, 2)}`, [i.id, req.me.id])).length) throw new HttpError(404, 'Issue not found')
  need(role, min ?? minFor(req.method))
  return i
}

/** Tell someone about an issue, unless it is me or they cannot see the project (a person removed from a project hears nothing more from it). */
const note = (d: Db, to: string, me: Me, issueId: string, kind: string, text: string) =>
  to === me.id ? null : d.query(
    `insert into notifications (user_id, actor_id, issue_id, kind, text)
     select $1, $2, i.id, $4, $5 from issues i
      where i.id = $3 and (exists (select 1 from project_access pm where pm.project_id = i.project_id and pm.user_id = $1)
                        or exists (select 1 from memberships m where m.user_id = $1 and m.workspace_id = i.workspace_id and m.role in ('owner', 'admin')))
        and issue_visible(i.security_level_id, i.reporter_id, i.assignee_id, i.project_id, $1,
                          exists (select 1 from memberships m where m.user_id = $1 and m.workspace_id = i.workspace_id and m.role in ('owner', 'admin')))`,
    [to, me.id, issueId, kind, text])

/** True when `@name` appears in the text as a whole name (`@Ann` does not match inside `@Anna`). */
const mentions = (text: string, name: string) => {
  for (let at = text.indexOf('@' + name); at >= 0; at = text.indexOf('@' + name, at + 1)) {
    const next = text[at + 1 + name.length]
    if (!next || !/[A-Za-z0-9_]/.test(next)) return true
  }
  return false
}

/** People written as `@Full Name` in a text, except the author: only those who can see the project (its members and workspace admins). */
export async function mentionedIn(d: Db, projectId: string, text: string, authorId: string): Promise<string[]> {
  if (!text.includes('@')) return []
  const candidates = await d.query<{ id: string; name: string }>(
    `select u.id, u.name from users u
      where u.active and u.id <> $3 and position('@' || u.name in $2) > 0
        and (exists (select 1 from project_access pm where pm.project_id = $1 and pm.user_id = u.id)
          or exists (select 1 from memberships m join projects p on p.workspace_id = m.workspace_id where p.id = $1 and m.user_id = u.id and m.role in ('owner', 'admin')))`, [projectId, text, authorId])
  return candidates.filter(c => mentions(text, c.name)).map(c => c.id)
}

async function watchersOf(d: Db, issue: { id: string; assigneeId: string | null; reporterId: string | null }) {
  const w = await d.query<{ userId: string }>('select user_id from issue_watchers where issue_id = $1', [issue.id])
  return [...new Set([...w.map(x => x.userId), issue.assigneeId, issue.reporterId].filter((x): x is string => !!x))]
}

/** A transition's actions, after the move, in the same transaction: field changes (recorded as made by the transition)
 *  and comments by the mover. An assignee who isn't in the project is skipped, as automation does. */
export async function runActions(d: Db, me: Me | null, issueId: string, t: TransitionRow, ctx: RuleCtx) {
  if (!t.rules.actions?.length) return
  const [now] = await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [issueId])
  const { patch, comments } = actionChanges(t.rules, ctx, now)
  if (patch.assigneeId && !(await canJoinWork(d, now.projectId, patch.assigneeId as string))) {
    delete patch.assigneeId
    await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, $3)`, [issueId, me?.id ?? null, `“${t.name}” skipped an assignment: that person is not in this project`])
  }
  const changed = Object.keys(patch).filter(k => JSON.stringify(patch[k] ?? null) !== JSON.stringify(now[k] ?? null))
  if (changed.length) {
    const w = pick(Object.fromEntries(changed.map(k => [k, patch[k]])), FIELDS, ['custom'])
    await d.query(`update issues set ${w.cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() where id = $1`, [issueId, ...w.vals])
    for (const f of changed)
      await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
        [issueId, me?.id ?? null, f, now[f] == null ? null : String(now[f]), patch[f] == null ? null : String(patch[f]), `“${t.name}” changed ${f.replace(/([A-Z])/g, ' $1').toLowerCase()}`])
    if (changed.includes('assigneeId') && patch.assigneeId && me) await note(d, patch.assigneeId as string, me, issueId, 'assigned', 'assigned you a work item')
  }
  for (const body of comments) await d.query('insert into comments (issue_id, author_id, body) values ($1, $2, $3)', [issueId, me?.id ?? null, body])
}

const keyP = z.object({ key: z.string().describe('Issue key (PAY-12) or id (uuid)') })
const projKeyP = z.object({ key: z.string().describe('Project key, e.g. PAY') })
const idP = z.object({ id: uuid })
const TAG = ['Issues']

const listQuery = z.object({
  status: uuid.optional(), assignee: uuid.optional(), type: type.optional(), sprint: z.union([uuid, z.literal('none')]).optional().describe('Sprint id, or "none" for the backlog'),
  release: uuid.optional(), parent: uuid.optional(), cursor: z.string().optional().describe('`next` from the previous page'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

/** Who has this issue open for editing right now, with the user's name for display (heartbeat < 90 s). */
async function editorsOf(d: Db, issueId: string) {
  const rows = await d.query<{ userId: string; name: string; initials: string; color: string }>(
    `select e.user_id as user_id, u.name, u.initials, u.color
       from issue_editors e join users u on u.id = e.user_id
      where e.issue_id = $1 and e.last_heartbeat > now() - interval '90 seconds'
      order by e.last_heartbeat desc`, [issueId])
  return rows
}

/** Custom field values must belong to a field of this project and fit its kind: text (at most 5000 characters), a finite
 *  number, one of a select field's options, or a YYYY-MM-DD date. Only values that change are checked, so an item keeps a
 *  value whose option was later renamed until someone edits that field. A cleared field is simply left out. */
async function checkCustom(d: Db, projectId: string, next: Record<string, string | number>, prev: Record<string, string | number> = {}) {
  const changed = Object.keys(next).filter(k => next[k] !== prev[k])
  if (!changed.length) return
  const defs = new Map((await d.query<{ id: string; name: string; kind: string; options: string[] | null }>(
    'select id, name, kind, options from field_defs where project_id = $1', [projectId])).map(f => [f.id, f]))
  const errors: Record<string, string> = {}
  for (const k of changed) {
    const f = defs.get(k), v = next[k]
    if (!f) { errors[k] = 'No such field in this project'; continue }
    const ok = f.kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : f.kind === 'select' ? typeof v === 'string' && (f.options ?? []).includes(v)
      : f.kind === 'date' ? typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
      : typeof v === 'string' && v.length <= 5000
    if (!ok) errors[k] = f.kind === 'select' ? `${f.name} must be one of: ${(f.options ?? []).join(', ')}` : `${f.name} must be a valid ${f.kind}`
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Some custom field values are not valid', Object.fromEntries(Object.entries(errors).map(([k, m]) => [`custom.${k}`, m])))
}

/** Ranks are fractions: a move takes the midpoint of its neighbours, so a busy spot halves its gap on every move.
 *  Long before the numbers run out of precision (about 40 halvings), the project's ranks are spread out again:
 *  same order, 1024 apart. Renumbering does not change versions, so nobody's edit conflicts because of it.
 *  Returns whether it renumbered, so clients holding the old numbers can be told to reload them. */
async function keepRanksApart(d: Db, projectId: string, issueId: string, rank: number) {
  const [{ n }] = await d.query<{ n: number }>(
    'select count(*)::int as n from issues where project_id = $1 and id <> $2 and abs(rank - $3) < 1e-6', [projectId, issueId, rank]) as any
  if (!n) return false
  await d.query(
    `update issues i set rank = r.n * 1024
       from (select id, row_number() over (order by rank, id) as n from issues where project_id = $1) r
      where i.id = r.id`, [projectId])
  return true
}

/** One issue edit: version check, workflow check, history, notifications, automation, live event. Shared by the single and bulk edits. */
async function applyPatch(d: Db, me: Me, cur: any, patch: z.infer<typeof patchBody>, o: { ifMatch: number | null; override: boolean; ip?: string; transition?: TransitionRow; comment?: string }) {
  // Hold the row for the rest of the transaction, and work from its latest copy: a change made between reading it and
  // here (a sprint completing, another edit) is then seen by the checks below instead of failing the save. If-Match
  // still refuses a stale edit.
  const [{ version }] = await d.query<{ version: number }>('select version from issues where id = $1 for update', [cur.id]) as any
  if (version !== cur.version) cur = (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [cur.id]))[0]
  if (o.ifMatch !== null && o.ifMatch !== cur.version) throw new HttpError(409, `Edited elsewhere (current version ${cur.version})`)
  const [lead] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [cur.projectId])
  const override = o.override && (await roleOf(d, me, cur.projectId)) === 'admin'
  if (patch.assigneeId && patch.assigneeId !== cur.assigneeId && !(await canJoinWork(d, cur.projectId, patch.assigneeId)))
    throw new HttpError(400, 'The assignee must be a member of this project')
  // A status change goes through a transition: its Restrict rules decide whether this person may use it, its Validate
  // rules check the item as it will be after the change, and its Actions run after it
  const moving = patch.statusId !== undefined && patch.statusId !== cur.statusId
  let t = o.transition ?? null
  let ctx: RuleCtx | null = null
  if ((moving && !override) || t) {
    ctx = await ruleContext(d, cur, me)
    t ??= await transitionTo(d, cur, patch.statusId!, ctx)
    const errors = problems(t?.rules, ctx, cur, { ...cur, ...patch }, o.comment)
    if (Object.keys(errors).length) throw new HttpError(400, `“${t!.name}” needs more information`, errors)
  }
  // a move the workflow does not allow, made by a project admin with the override, is recorded
  if (moving && override && !(await moveAllowed(d, cur.projectId, cur.statusId, patch.statusId!, cur.type)))
    await audit(d, { me, ip: o.ip }, { action: 'issue.workflow_overridden', type: 'issue', id: cur.id, name: cur.key, project: { id: cur.projectId, key: cur.key.split('-')[0] },
      before: { statusId: cur.statusId }, after: { statusId: patch.statusId } })
  if (patch.parentId === cur.id) throw new HttpError(400, 'An item cannot be its own parent')
  // a first original estimate starts the remaining one (Jira's time tracking)
  if (patch.timeEstimate != null && patch.timeRemaining === undefined && cur.timeRemaining === null) patch = { ...patch, timeRemaining: patch.timeEstimate }
  if (patch.type !== undefined && patch.type !== cur.type) await checkType(d, cur.projectId, patch.type)
  await checkParts(d, cur.projectId, patch)
  if (patch.securityLevelId !== undefined && patch.securityLevelId !== cur.securityLevelId)
    await checkLevel(d, me, cur.projectId, patch.securityLevelId, cur.reporterId, patch.assigneeId !== undefined ? patch.assigneeId : cur.assigneeId)
  if (patch.custom) await checkCustom(d, cur.projectId, patch.custom, cur.custom)
  if (patch.resolution) {
    const [st] = await d.query<{ category: string }>('select category from statuses where id = $1', [patch.statusId ?? cur.statusId])
    if (st?.category !== 'done') throw new HttpError(400, 'Only a finished item has a resolution', { resolution: 'Move the item to a Done status first' })
  }

  const changed = Object.keys(patch).filter(k => k !== 'rank' && JSON.stringify((patch as any)[k]) !== JSON.stringify(cur[k]))
  const w = pick(patch, FIELDS, ['custom'])
  if (!w.keys.length && !t) return cur
  if (w.keys.length) {
    // No row back: someone saved this item after we read it (no row at all, so nothing to destructure)
    const updated = await d.query(
      `update issues set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now()
        where id = $1 and version = $2 returning 1 as n`, [cur.id, cur.version, ...w.vals])
    if (!updated.length) throw new HttpError(409, 'Edited elsewhere: reload to see the latest version')
  }

  for (const f of changed) {
    const to = (patch as any)[f], from = cur[f]
    await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
      [cur.id, me.id, f, from == null ? null : String(from), to == null ? null : String(to), `Changed ${f.replace(/([A-Z])/g, ' $1').toLowerCase()}`])
  }
  if (t) {
    if (!moving) await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [cur.id, me.id, `“${t.name}”`])   // a loop: the action itself is the history
    if (o.comment?.trim()) {
      await d.query('insert into comments (issue_id, author_id, body) values ($1, $2, $3)', [cur.id, me.id, o.comment])
      for (const u of await mentionedIn(d, cur.projectId, o.comment, me.id)) await note(d, u, me, cur.id, 'mentioned', 'mentioned you in a comment')
    }
    await runActions(d, me, cur.id, t, ctx!)
  }
  const rctx = { projectId: cur.projectId, issueId: cur.id, reporterId: cur.reporterId, leadId: lead?.leadId ?? null }
  if (changed.includes('assigneeId') && patch.assigneeId) {
    await note(d, patch.assigneeId, me, cur.id, 'assigned', 'assigned you a work item')
    await runRules(d, rctx, { kind: 'assigned' })
  }
  if (changed.includes('statusId')) {
    for (const u of await watchersOf(d, cur)) await note(d, u, me, cur.id, 'status', 'changed the status')
    await runRules(d, rctx, { kind: 'status', to: patch.statusId! })
  }
  if (patch.rank !== undefined && await keepRanksApart(d, cur.projectId, cur.id, patch.rank)) await publish(d, cur.projectId, { type: 'issues.reranked' })
  await publish(d, cur.projectId, { type: 'issue.updated', id: cur.id, key: cur.key, editors: await editorsOf(d, cur.id) })
  return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [cur.id]))[0]
}

/** Components and affects versions must be the project's own. */
async function checkParts(d: Db, projectId: string, b: { componentIds?: string[]; affectsReleaseIds?: string[] }) {
  for (const [ids, table, field, what] of [[b.componentIds, 'components', 'componentIds', 'component'], [b.affectsReleaseIds, 'releases', 'affectsReleaseIds', 'release']] as const) {
    if (!ids?.length) continue
    const [{ n }] = await d.query<{ n: number }>(`select count(*)::int as n from ${table} where project_id = $1 and id = any($2::uuid[])`, [projectId, [...new Set(ids)]]) as any
    if (n !== new Set(ids).size) throw new HttpError(400, `Every ${what} must be one of this project's`, { [field]: `Unknown ${what}` })
  }
}

/** Jira's component default assignee: new work in a component, with nobody chosen, goes to the component's lead or the
 *  project's lead (the first component that says so). Only someone who can work in the project. */
async function defaultAssignee(d: Db, projectId: string, componentIds: string[] | undefined) {
  if (!componentIds?.length) return null
  const rows = await d.query<{ who: string | null }>(
    `select case c.default_assignee when 'component_lead' then c.lead_id when 'project_lead' then p.lead_id end as who
       from components c join projects p on p.id = c.project_id
      where c.project_id = $1 and c.id = any($2::uuid[]) and c.default_assignee <> 'none' order by array_position($2::uuid[], c.id)`, [projectId, componentIds])
  for (const r of rows) if (r.who && (await canJoinWork(d, projectId, r.who))) return r.who
  return null
}

/** A security level must be the project's, and (as in Jira) one I am in myself, judged with the item as it will be. */
async function checkLevel(d: Db, me: Me, projectId: string, levelId: string | null | undefined, reporterId: string | null, assigneeId: string | null) {
  if (!levelId) return
  const [ok] = await d.query<{ ok: boolean }>(`select issue_visible($1, $2, $3, $4, $5, $6) as ok from security_levels where id = $1 and project_id = $4`,
    [levelId, reporterId, assigneeId, projectId, me.id, me.admin])
  if (!ok) throw new HttpError(400, 'No such security level in this project', { securityLevelId: 'Unknown level' })
  if (!ok.ok) throw new HttpError(400, 'You can only choose a security level you are in', { securityLevelId: 'You aren’t in this level' })
}

/** Is this one of the project's work types? (400 otherwise) */
async function checkType(d: Db, projectId: string, type: string | undefined) {
  if (type === undefined) return
  if (!(await d.query('select 1 from work_types where project_id = $1 and key = $2', [projectId, type])).length)
    throw new HttpError(400, 'That work type isn’t in this project', { type: 'Unknown work type' })
}

/** Create one issue (key, rank and start status from the project unless given), with its first history entry, the
 *  assignee's notification and "created" automation. Returns its id. Shared by create and clone. */
export async function insertIssue(d: Db, me: Me, projectId: string, b: Record<string, any>, created = 'Created this work item') {
  const [pr] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [projectId])
  if (b.assigneeId && !(await canJoinWork(d, projectId, b.assigneeId))) throw new HttpError(400, 'The assignee must be a member of this project')
  if (b.custom) await checkCustom(d, projectId, b.custom)
  await checkType(d, projectId, b.type)
  await checkParts(d, projectId, b)
  await checkLevel(d, me, projectId, b.securityLevelId, me.id, b.assigneeId ?? null)
  if (b.assigneeId === undefined && b.componentIds?.length) { const who = await defaultAssignee(d, projectId, b.componentIds); if (who) b = { ...b, assigneeId: who } }
  let statusId = b.statusId
  if (!statusId) {
    const [s] = await d.query<{ id: string }>('select id from statuses where project_id = $1 order by position limit 1', [projectId])
    if (!s) throw new HttpError(409, 'Project has no statuses')
    statusId = s.id
  }
  const [{ number }] = await d.query<{ number: number }>('select next_issue_number($1) as number', [projectId]) as any
  const [{ rank }] = await d.query<{ rank: number }>(
    'select coalesce(max(rank), 0) + 1000 as rank from issues where project_id = $1', [projectId]) as any
  const timeRemaining = b.timeRemaining !== undefined ? b.timeRemaining : remainingWhenEstimated(null, b.timeEstimate)
  const w = pick({ ...b, statusId, rank: b.rank ?? rank, ...(timeRemaining !== null ? { timeRemaining } : {}) }, FIELDS, ['custom'])
  const cols = ['workspace_id', 'project_id', 'number', 'reporter_id', ...(b.id ? ['id'] : []), ...w.cols]
  const vals = [me.workspaceId, projectId, number, me.id, ...(b.id ? [b.id] : []), ...w.vals]
  const [row] = await d.query<{ id: string }>(
    `insert into issues (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals)
  await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, $3)`, [row!.id, me.id, created])
  if (b.assigneeId) await note(d, b.assigneeId, me, row!.id, 'assigned', 'assigned you a work item')
  await runRules(d, { projectId, issueId: row!.id, reporterId: me.id, leadId: pr!.leadId }, { kind: 'created' })
  await publish(d, projectId, { type: 'issue.created', id: row!.id })
  return row!.id
}

const plugin: FastifyPluginAsyncZod = async app => {
  // Board/list page of a project, in backlog order. Keyset-paginated: pass `next` back as `cursor`.
  // Everything the project's reports are calculated from: every item (not just a page) and every status change.
  // ponytail: whole project in one response; move the calculations to SQL when projects outgrow a few tens of thousands of items.
  app.get('/projects/:key/report-data', { schema: { tags: TAG, summary: 'All live items of a project and the full history of their status changes, for reports', params: projKeyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [issues, statusChanges] = await Promise.all([
      db.query(`${ISSUE_ROW} where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} order by i.rank, i.id`, [p.id, req.me.id]),
      db.query(`select a.issue_id, a.from_value as from_id, a.to_value as to_id, a.created_at as at
                  from activity a join issues i on i.id = a.issue_id
                 where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} and a.field = 'statusId' and a.to_value is not null
                 order by a.created_at, a.id`, [p.id, req.me.id]),
    ])
    return { issues, statusChanges }
  })

  app.get('/projects/:key/issues', { schema: { tags: TAG, summary: 'List a project\'s issues in backlog order (keyset-paginated)', params: projKeyP, querystring: listQuery } }, async req => {
    const q = req.query
    const p = await projectByKey(db, req, req.params.key)
    const args: unknown[] = [p.id, req.me.id]
    const where = ['i.project_id = $1', 'i.deleted_at is null', levelOk(req.me, 2)]
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)) }
    if (q.status) add('i.status_id = ?', q.status)
    if (q.assignee) add('i.assignee_id = ?', q.assignee)
    if (q.type) add('i.type = ?', q.type)
    if (q.release) add('i.release_id = ?', q.release)
    if (q.parent) add('i.parent_id = ?', q.parent)
    if (q.sprint === 'none') where.push('i.sprint_id is null')
    else if (q.sprint) add('i.sprint_id = ?', q.sprint)
    if (q.cursor) {
      const [r, id] = Buffer.from(q.cursor, 'base64url').toString().split('|')
      args.push(Number(r), id)
      where.push(`(i.rank, i.id) > ($${args.length - 1}, $${args.length})`)
    }
    args.push(q.limit + 1)
    const rows = await db.query<any>(`${ISSUE_ROW} where ${where.join(' and ')} order by i.rank, i.id limit $${args.length}`, args)
    const more = rows.length > q.limit
    const items = more ? rows.slice(0, q.limit) : rows
    const last = items.at(-1)
    return { items, next: more && last ? Buffer.from(`${last.rank}|${last.id}`).toString('base64url') : null }
  })

  const createBody = patchBody.required({ title: true }).extend({
    labels: z.array(z.string()).default([]),
    id: uuid.optional().describe('Client-chosen id: lets the app keep its local id, and makes a retried create a conflict instead of a duplicate'),
  })
  app.post('/projects/:key/issues', { schema: { tags: TAG, summary: 'Create an issue (key and rank are assigned by the server)', params: projKeyP, body: createBody } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [await insertIssue(d, req.me, p.id, req.body)]))[0])
  })

  // Clone (Jira's): a copy in the same project, starting at the start status, linked "clones" to the original
  app.post('/issues/:key/clone', { schema: {
    tags: TAG, summary: 'Clone an issue: a copy of its fields, in the start status, linked to it (clones / is cloned by). Optionally its child items, its links and its sprint',
    params: keyP, body: z.object({
      title: z.string().min(1).max(500).optional().describe('Default: "CLONE - " and the original title'),
      assigneeId: uuid.nullable().optional().describe('Default: the original\'s assignee'),
      include: z.object({ children: z.boolean().default(false), links: z.boolean().default(false), sprint: z.boolean().default(false) }).default({ children: false, links: false, sprint: false }),
    }),
  } }, async (req, reply) => {
    return tx(async d => {
      const src = await issueByKey(d, req, req.params.key)
      const { include } = req.body
      const copy = async (i: any, over: Record<string, unknown>) => insertIssue(d, req.me, i.projectId, {
        type: i.type, title: i.title, description: i.description, priority: i.priority, labels: i.labels, estimate: i.estimate,
        timeEstimate: i.timeEstimate, dueDate: i.dueDate, startDate: i.startDate, releaseId: i.releaseId, custom: i.custom, securityLevelId: i.securityLevelId,
        assigneeId: i.assigneeId && (await canJoinWork(d, i.projectId, i.assigneeId)) ? i.assigneeId : null,
        sprintId: include.sprint ? i.sprintId : null, ...over,
      }, `Cloned from ${i.key}`)
      const id = await copy(src, {
        title: req.body.title ?? `CLONE - ${src.title}`.slice(0, 500), parentId: src.parentId,
        ...(req.body.assigneeId !== undefined ? { assigneeId: req.body.assigneeId } : {}),
      })
      await d.query(`insert into issue_links (issue_id, target_id, type) values ($1, $2, 'clones')`, [id, src.id])
      if (include.children)
        for (const c of await d.query<any>(`${ISSUE_ROW} where i.parent_id = $1 and i.deleted_at is null order by i.rank`, [src.id])) await copy(c, { parentId: id })
      if (include.links) {
        await d.query(`insert into issue_links (issue_id, target_id, type) select $2, target_id, type from issue_links where issue_id = $1 and target_id <> $2 and type <> 'clones' on conflict do nothing`, [src.id, id])
        await d.query(`insert into issue_links (issue_id, target_id, type) select issue_id, $2, type from issue_links where target_id = $1 and issue_id <> $2 and type <> 'clones' on conflict do nothing`, [src.id, id])
      }
      reply.code(201)
      return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [id]))[0]
    })
  })

  const EXPAND = ['links', 'watchers', 'comments', 'activity', 'worklogs', 'attachments', 'children'] as const
  app.get('/issues/:key', { schema: {
    tags: TAG, summary: 'Issue, with its related records. `expand` picks which; omit it for all (comments and history have their own paginated endpoints).',
    params: keyP, querystring: z.object({ expand: z.string().optional().describe(`Comma-separated: ${EXPAND.join(', ')}`) }),
  } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    const want = new Set(req.query.expand ? req.query.expand.split(',').map(x => x.trim()).filter(Boolean) : EXPAND)
    for (const w of want) if (!(EXPAND as readonly string[]).includes(w)) throw new HttpError(400, `Unknown expand value: ${w}`)
    const out: Record<string, unknown> = { ...i }
    const jobs: Promise<void>[] = []
    const load = (name: string, sql: string, map?: (rows: any[]) => unknown) => { if (want.has(name)) jobs.push(db.query(sql, sql.includes('$2') ? [i.id, req.me.id] : [i.id]).then(r => { out[name === 'watchers' ? 'watcherIds' : name] = map ? map(r) : r })) }
    load('links', `select l.type, 'out' as dir, t.id as issue_id, p.key || '-' || t.number as key, t.title
                  from issue_links l join issues t on t.id = l.target_id join projects p on p.id = t.project_id where l.issue_id = $1 and t.deleted_at is null and ${levelOk(req.me, 2, 't')} and ${visibleAs(req.me, 't.project_id', 2)}
                union all
                select l.type, 'in', t.id, p.key || '-' || t.number, t.title
                  from issue_links l join issues t on t.id = l.issue_id join projects p on p.id = t.project_id where l.target_id = $1 and t.deleted_at is null and ${levelOk(req.me, 2, 't')} and ${visibleAs(req.me, 't.project_id', 2)}`)
    load('watchers', 'select user_id from issue_watchers where issue_id = $1', rows => rows.map((w: any) => w.userId))
    load('comments', `select * from comments c where issue_id = $1 and ${commentShown(req.me, i.projectId, 2)} order by created_at, id limit 200`)
    load('activity', 'select * from activity where issue_id = $1 order by created_at desc, id desc limit 200')
    load('worklogs', 'select * from worklogs where issue_id = $1 order by date desc, created_at desc limit 200')
    load('attachments', 'select id, name, size, type, added_by, added_at from attachments where issue_id = $1 and uploaded_at is not null order by added_at')
    load('children', `${ISSUE_ROW} where i.parent_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} order by i.rank limit 500`)
    await Promise.all(jobs)
    return out
  })

  // Comments and history, paged (the detail call embeds only the first 200)
  const page = z.object({ cursor: z.string().optional().describe('`next` from the previous page'), limit: z.coerce.number().int().min(1).max(200).default(50) })
  // Cursors carry the timestamp as the database printed it (microseconds); a JS Date would cut it to milliseconds and repeat or skip rows
  const cursorOf = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url')
  const readCursor = (c?: string) => { if (!c) return null; const [t, id] = Buffer.from(c, 'base64url').toString().split('|'); if (!t || !id || !UUID.test(id) || isNaN(Date.parse(t))) throw new HttpError(400, 'Invalid cursor'); return [t, id] as const }
  app.get('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Comments on an issue, oldest first (keyset-paginated)', params: keyP, querystring: page } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    const cur = readCursor(req.query.cursor)
    const rows = await db.query<any>(
      `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts from comments c where issue_id = $1 and ${commentShown(req.me, i.projectId, 3)} ${cur ? 'and (created_at, id) > ($4::timestamptz, $5::uuid)' : ''} order by created_at, id limit $2`,
      cur ? [i.id, req.query.limit + 1, req.me.id, cur[0], cur[1]] : [i.id, req.query.limit + 1, req.me.id])
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).cursorTs, items.at(-1).id) : null }
  })
  app.get('/issues/:key/activity', { schema: { tags: TAG, summary: 'Change history of an issue, newest first (keyset-paginated)', params: keyP, querystring: page } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    const cur = readCursor(req.query.cursor)
    const rows = await db.query<any>(
      `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts from activity where issue_id = $1 ${cur ? 'and (created_at, id) < ($3::timestamptz, $4::uuid)' : ''} order by created_at desc, id desc limit $2`,
      cur ? [i.id, req.query.limit + 1, cur[0], cur[1]] : [i.id, req.query.limit + 1])
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).cursorTs, items.at(-1).id) : null }
  })

  app.patch('/issues/:key', { schema: {
    tags: TAG, summary: 'Update issue fields. Send If-Match: <version> to reject stale edits (409). Workflow transitions are enforced.',
    params: keyP, body: patchBody, headers: z.object({
      'if-match': z.string().optional().describe('Issue version you last read'),
      'x-workflow-override': z.string().optional().describe('Send 1 to skip the workflow check. Honored only for workspace admins and the project lead (used when moving work off a status that is being deleted).'),
    }),
  } }, async req => {
    const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/"/g, '')) : null
    return tx(async d => applyPatch(d, req.me, await issueByKey(d, req, req.params.key), req.body, { ifMatch, override: req.headers['x-workflow-override'] === '1', ip: req.ip }))
  })

  // ── Transitions (Jira's issue transitions: what I can do from here, and doing one with its screen fields and a comment) ──
  app.get('/issues/:key/transitions', { schema: { tags: TAG, summary: 'Transitions I can use from the item\'s current status, with the fields each asks for. Loops (toId null) leave the status as it is', params: keyP } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    const ctx = await ruleContext(db, i, req.me)
    return (await available(db, i, ctx)).map(t => ({
      id: t.id, name: t.name, toId: t.toId, screen: t.rules.screen ?? [],
      problems: problems(t.rules, ctx, i, i),   // what would stop it if made now without filling anything in
    }))
  })
  app.post('/issues/:key/transitions', { schema: {
    tags: TAG, summary: 'Make a transition: its rules are checked, `fields` (the transition screen) are saved with it, `comment` is added, and its actions run, all or nothing',
    params: keyP, body: z.object({
      transitionId: uuid, fields: patchBody.omit({ statusId: true, rank: true }).partial().default({}),
      comment: z.string().max(20000).optional(),
    }),
    headers: z.object({ 'if-match': z.string().optional().describe('Issue version you last read') }),
  } }, async req => {
    const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/"/g, '')) : null
    return tx(async d => {
      const cur = await issueByKey(d, req, req.params.key)
      const t = await transitionById(d, cur, req.body.transitionId, await ruleContext(d, cur, req.me))
      const patch = t.toId ? { ...req.body.fields, statusId: t.toId } : req.body.fields
      return applyPatch(d, req.me, cur, patch, { ifMatch, override: false, ip: req.ip, transition: t, comment: req.body.comment })
    })
  })

  // ── Bulk (all or nothing: nothing changes if any issue is missing or refuses the change; size limit in System settings) ──
  const refs = z.array(z.string()).min(1).max(5000).describe('Issue keys (PAY-12) or ids; at most the bulk limit in System settings')
  const bulkResult = (n: number) => ({ count: n })
  const checkBulk = async (req: { me: Me; body: { issues: string[] } }) => {
    const max = (await getSetting(req.me.workspaceId, 'searchAndBulk')).bulkMaxItems
    const n = new Set(req.body.issues).size
    if (n > max) throw new HttpError(400, `A bulk change can include at most ${max} work items (you sent ${n})`, { issues: `At most ${max}` })
  }
  app.post('/issues/bulk/edit', { schema: { tags: ['Issues: bulk'], summary: 'Apply the same field changes to many issues (workflow rules apply to each)', body: z.object({ issues: refs, patch: patchBody }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      const out: any[] = []
      for (const ref of [...new Set(req.body.issues)]) out.push(await applyPatch(d, req.me, await issueByKey(d, req, ref), req.body.patch, { ifMatch: null, override: false }))
      return { count: out.length, issues: out }
    })
  })
  app.post('/issues/bulk/delete', { schema: { tags: ['Issues: bulk'], summary: 'Soft-delete many issues (restorable)', body: z.object({ issues: refs }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      const rows = []
      for (const ref of [...new Set(req.body.issues)]) rows.push(await issueByKey(d, req, ref))
      await d.query('update issues set deleted_at = now(), version = version + 1 where id = any($1::uuid[])', [rows.map(r => r.id)])
      for (const r of rows) await audit(d, req, { action: 'issue.deleted', type: 'issue', id: r.id, name: r.key, project: { id: r.projectId, key: r.key.split('-')[0]! }, after: { bulk: true } })
      for (const pid of new Set(rows.map(r => r.projectId))) await publish(d, pid, { type: 'issue.deleted' })
      return bulkResult(rows.length)
    })
  })
  app.post('/issues/bulk/restore', { schema: { tags: ['Issues: bulk'], summary: 'Restore many soft-deleted issues (Undo)', body: z.object({ issues: refs }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      const rows = []
      for (const ref of [...new Set(req.body.issues)]) rows.push(await issueByKey(d, req, ref, true))
      await d.query('update issues set deleted_at = null, version = version + 1 where id = any($1::uuid[])', [rows.map(r => r.id)])
      for (const r of rows) await audit(d, req, { action: 'issue.restored', type: 'issue', id: r.id, name: r.key, project: { id: r.projectId, key: r.key.split('-')[0]! }, after: { bulk: true } })
      for (const pid of new Set(rows.map(r => r.projectId))) await publish(d, pid, { type: 'issue.created' })
      return bulkResult(rows.length)
    })
  })

  // Soft delete + restore back the client's Undo
  app.delete('/issues/:key', { schema: { tags: TAG, summary: 'Soft-delete an issue (restorable)', params: keyP } }, async (req, reply) => {
    await tx(async d => {
      const i = await issueByKey(d, req, req.params.key)
      await d.query('update issues set deleted_at = now(), version = version + 1 where id = $1', [i.id])
      await audit(d, req, { action: 'issue.deleted', type: 'issue', id: i.id, name: i.key, project: { id: i.projectId, key: i.key.split('-')[0]! } })
      await publish(d, i.projectId, { type: 'issue.deleted', id: i.id, key: i.key })
    })
    reply.code(204).send()
  })
  // Opening a work item records it for "Your work → Viewed". Anyone who can see the item may record that they did (read-only users too).
  app.post('/issues/:key/view', { schema: { tags: TAG, summary: 'Record that I opened this work item (Your work → Viewed keeps my newest 50)', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    await tx(async d => {
      await d.query('insert into issue_views (user_id, issue_id) values ($1, $2) on conflict (user_id, issue_id) do update set viewed_at = now()', [req.me.id, i.id])
      await d.query('delete from issue_views where user_id = $1 and issue_id in (select issue_id from issue_views where user_id = $1 order by viewed_at desc offset 50)', [req.me.id])
    })
    reply.code(204).send()
  })

  app.post('/issues/:key/restore', { schema: { tags: TAG, summary: 'Restore a soft-deleted issue (Undo)', params: keyP } }, async req => {
    return tx(async d => {
      const i = await issueByKey(d, req, req.params.key, true)
      await d.query('update issues set deleted_at = null, version = version + 1 where id = $1', [i.id])
      await audit(d, req, { action: 'issue.restored', type: 'issue', id: i.id, name: i.key, project: { id: i.projectId, key: i.key.split('-')[0]! } })
      await publish(d, i.projectId, { type: 'issue.created', id: i.id })
      return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [i.id]))[0]
    })
  })

  // ── Links & watchers ──
  const linkType = z.string().max(40).describe('A link type id (GET /link-types), e.g. blocks, relates, duplicates, clones')
  const linkBody = z.object({ type: linkType, targetKey: z.string() })
  app.post('/issues/:key/links', { schema: { tags: ['Links & watchers'], summary: 'Link two issues: this one <type\'s outward words> the target (blocks, relates to, duplicates…)', params: keyP, body: linkBody } }, async (req, reply) => {
    const b = req.body
    const [a, t] = await Promise.all([issueByKey(db, req, req.params.key), issueByKey(db, req, b.targetKey, false, 'viewer')])
    if (a.id === t.id) throw new HttpError(400, 'Cannot link an item to itself')
    if (!(await db.query('select 1 from link_types where workspace_id = $1 and id = $2', [req.me.workspaceId, b.type])).length) throw new HttpError(400, 'No such link type', { type: 'Unknown link type' })
    await db.query('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing', [a.id, t.id, b.type])
    reply.code(204).send()
  })
  app.delete('/issues/:key/links', { schema: {
    tags: ['Links & watchers'], summary: 'Remove a link', params: keyP,
    querystring: z.object({ type: linkType, target: z.string().describe('Key of the linked issue') }),
  } }, async (req, reply) => {
    const q = { type: req.query.type, targetKey: req.query.target }
    const [a, t] = await Promise.all([issueByKey(db, req, req.params.key), issueByKey(db, req, q.targetKey, false, 'viewer')])
    await db.query('delete from issue_links where issue_id = $1 and target_id = $2 and type = $3', [a.id, t.id, q.type])
    reply.code(204).send()
  })
  app.put('/issues/:key/watch', { schema: { tags: ['Links & watchers'], summary: 'Watch an issue', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    await db.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, req.me.id])
    reply.code(204).send()
  })
  app.delete('/issues/:key/watch', { schema: { tags: ['Links & watchers'], summary: 'Stop watching an issue', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    await db.query('delete from issue_watchers where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    reply.code(204).send()
  })

  // ── Edit presence (soft lock, Jira/monday.com style: others can still edit, they just see who is here) ──
  app.post('/issues/:key/presence', { schema: {
    tags: TAG, summary: 'Heartbeat: I am editing this issue. Broadcasts `issue.editing` to the project stream; prunes stale rows.',
    params: keyP,
  } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key)
    await db.query(
      `insert into issue_editors (issue_id, user_id) values ($1, $2)
         on conflict (issue_id, user_id) do update set last_heartbeat = now()`, [i.id, req.me.id])
    await db.query("delete from issue_editors where last_heartbeat < now() - interval '90 seconds'")
    await publish(db, i.projectId, { type: 'issue.editing', key: i.key, editors: await editorsOf(db, i.id) })
    reply.code(204).send()
  })
  app.delete('/issues/:key/presence', { schema: { tags: TAG, summary: 'I stopped editing this issue (panel closed).', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    await db.query('delete from issue_editors where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    await publish(db, i.projectId, { type: 'issue.editing', key: i.key, editors: await editorsOf(db, i.id) })
    reply.code(204).send()
  })

  // ── Comments (authors edit/delete their own) ──
  const body = z.object({ body: z.string().min(1).max(20000) })
  const visibility = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('role'), role: z.enum(['admin', 'member', 'viewer']) }), z.object({ kind: z.literal('group'), id: uuid }),
  ]).nullable().describe('Who can read it (Jira\'s comment visibility): a project role or a group; null or left out: everyone who sees the item')
  const commentCreate = body.extend({ id: uuid.optional().describe('Client-chosen id'), visibility: visibility.optional() })
  /** Who of these people may read a comment with this visibility (the author always can). */
  const readers = async (d: Db, projectId: string, people: string[], v: z.infer<typeof visibility> | undefined) => {
    if (!v || !people.length) return people
    const rows = await d.query<{ id: string }>(v.kind === 'group'
      ? 'select user_id as id from group_members where group_id = $2 and user_id = any($1::uuid[])'
      : `select u.id from unnest($1::uuid[]) u(id) where exists (select 1 from project_access pa where pa.project_id = $2 and pa.user_id = u.id and pa.role = $3)
           or ($3 = 'admin' and exists (select 1 from memberships m join projects p on p.workspace_id = m.workspace_id where p.id = $2 and m.user_id = u.id and m.role in ('owner', 'admin')))`,
      v.kind === 'group' ? [people, v.id] : [people, projectId, v.role])
    const ok = new Set(rows.map(r => r.id))
    return people.filter(p => ok.has(p))
  }
  app.post('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Add a comment (notifies watchers who may read it)', params: keyP, body: commentCreate } }, async req => {
    const b = req.body
    return tx(async d => {
      const i = await issueByKey(d, req, req.params.key, false, 'viewer')                // read-only people can comment, as in Jira
      if (b.visibility?.kind === 'group' && !(await d.query('select 1 from groups where id = $1', [b.visibility.id])).length) throw new HttpError(400, 'No such group', { visibility: 'Unknown group' })
      const [c] = await d.query('insert into comments (id, issue_id, author_id, body, visibility) values (coalesce($4::uuid, uuid_v7()), $1, $2, $3, $5) returning *',
        [i.id, req.me.id, b.body, b.id ?? null, b.visibility ? JSON.stringify(b.visibility) : null])
      // A mention tells that person; everyone already watching hears "commented" (not both); the commenter and the mentioned start watching.
      // A restricted comment reaches only people who may read it.
      const mentioned = await readers(d, i.projectId, await mentionedIn(d, i.projectId, b.body, req.me.id), b.visibility)
      for (const u of mentioned) await note(d, u, req.me, i.id, 'mentioned', 'mentioned you in a comment')
      for (const u of await readers(d, i.projectId, (await watchersOf(d, i)).filter(w => !mentioned.includes(w)), b.visibility)) await note(d, u, req.me, i.id, 'commented', 'commented on a work item')
      for (const u of [req.me.id, ...mentioned]) await d.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, u])
      await publish(d, i.projectId, { type: 'comment.created', key: i.key })
      return c
    })
  })
  app.patch('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Edit your own comment', params: idP, body } }, async req => {
    const args: unknown[] = [req.params.id, req.me.id, req.body.body]
    const see = visible(req.me, 'i.project_id', args)
    const [c] = await db.query(
      `update comments set body = $3, edited_at = now() where id = $1 and author_id = $2
         and exists (select 1 from issues i where i.id = comments.issue_id and ${see}) returning *`, args)
    if (!c) throw new HttpError(404, 'Not found, or not yours')
    return c
  })
  app.delete('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Delete your own comment', params: idP } }, async (req, reply) => {
    const args: unknown[] = [req.params.id, req.me.id]
    const see = visible(req.me, 'i.project_id', args)
    const r = await db.query(`delete from comments where id = $1 and author_id = $2 and exists (select 1 from issues i where i.id = comments.issue_id and ${see}) returning id`, args)
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })

  // ── Work logs (Jira's: people log, change and remove their own; project admins can change and remove anyone's; each
  // adjusts the remaining estimate as `adjustEstimate` says, automatically by default) ──
  const adjust = {
    adjustEstimate: z.enum(['auto', 'leave', 'new', 'manual']).default('auto').describe('auto: count the remaining estimate down (or back up); leave: don\'t touch it; new: set it to newEstimate; manual: change it by reduceBy'),
    newEstimate: z.coerce.number().int().nonnegative().optional().describe('Minutes, with adjustEstimate=new'),
    reduceBy: z.coerce.number().int().nonnegative().optional().describe('Minutes, with adjustEstimate=manual'),
  }
  const adjustOf = (q: { adjustEstimate: string; newEstimate?: number; reduceBy?: number }): Adjust => {
    if (q.adjustEstimate === 'new') { if (q.newEstimate === undefined) throw new HttpError(400, 'Say the new remaining estimate', { newEstimate: 'Required' }); return { adjustEstimate: 'new', newEstimate: q.newEstimate } }
    if (q.adjustEstimate === 'manual') { if (q.reduceBy === undefined) throw new HttpError(400, 'Say how much to change it by', { reduceBy: 'Required' }); return { adjustEstimate: 'manual', reduceBy: q.reduceBy } }
    return { adjustEstimate: q.adjustEstimate as 'auto' | 'leave' }
  }
  /** Count the item's remaining estimate down by `delta` minutes (or up, when negative). */
  const remaining = async (d: Db, issueId: string, delta: number, a: Adjust) => {
    if (a.adjustEstimate === 'leave') return
    const [i] = await d.query<{ timeRemaining: number | null }>('select time_remaining from issues where id = $1 for update', [issueId])
    const next = adjustRemaining(i!.timeRemaining, delta, a)
    if (next !== i!.timeRemaining) await d.query('update issues set time_remaining = $2, version = version + 1, updated_at = now() where id = $1', [issueId, next])
  }
  /** A work log I may change: my own, or anyone's in a project I administer. */
  const worklogFor = async (d: Db, req: { me: Me; method: string }, id: string) => {
    const args: unknown[] = [id]
    const see = visible(req.me, 'i.project_id', args)
    const [w] = await d.query<any>(`select w.*, i.project_id, p.key as project_key from worklogs w join issues i on i.id = w.issue_id join projects p on p.id = i.project_id
                                     where w.id = $1 and ${see} for update of w`, args)
    if (!w) throw new HttpError(404, 'Work log not found')
    if (w.userId !== req.me.id && (await roleOf(d, req.me, w.projectId)) !== 'admin') throw new HttpError(403, 'Only project admins can change other people’s work logs')
    return w
  }
  app.post('/issues/:key/worklogs', { schema: {
    tags: ['Comments & work logs'], summary: 'Log time on an issue (the remaining estimate counts down, unless adjustEstimate says otherwise)', params: keyP,
    body: z.object({ id: uuid.optional().describe('Client-chosen id'), minutes: z.number().int().positive(), date, note: z.string().default(''), ...adjust }),
  } }, async req => {
    const b = req.body
    return tx(async d => {
      const i = await issueByKey(d, req, req.params.key)
      const [w] = await d.query('insert into worklogs (id, issue_id, user_id, minutes, date, note) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5) returning *',
        [i.id, req.me.id, b.minutes, b.date, b.note, b.id ?? null])
      await remaining(d, i.id, b.minutes, adjustOf(b))
      await publish(d, i.projectId, { type: 'issue.updated', id: i.id, key: i.key })
      return w
    })
  })
  app.patch('/worklogs/:id', { schema: {
    tags: ['Comments & work logs'], summary: 'Change a work log: your own, or anyone\'s as a project admin (the remaining estimate follows the change in time)', params: idP,
    body: z.object({ minutes: z.number().int().positive().optional(), date: date.optional(), note: z.string().optional(), ...adjust }),
  } }, async req => {
    const b = req.body
    return tx(async d => {
      const w = await worklogFor(d, req, req.params.id)
      const [row] = await d.query(`update worklogs set minutes = $2, date = $3, note = $4 where id = $1 returning *`, [w.id, b.minutes ?? w.minutes, b.date ?? w.date, b.note ?? w.note])
      if (b.minutes !== undefined && b.minutes !== w.minutes) await remaining(d, w.issueId, b.minutes - w.minutes, adjustOf(b))
      if (w.userId !== req.me.id) await audit(d, req, { action: 'worklog.updated', type: 'worklog', id: w.id, project: { id: w.projectId, key: w.projectKey }, before: { minutes: w.minutes, date: w.date, note: w.note }, after: { minutes: row.minutes, date: row.date, note: row.note } })
      return row
    })
  })
  app.delete('/worklogs/:id', { schema: {
    tags: ['Comments & work logs'], summary: 'Remove a work log: your own, or anyone\'s as a project admin (its time goes back on the remaining estimate)', params: idP,
    querystring: z.object(adjust),
  } }, async (req, reply) => {
    await tx(async d => {
      const w = await worklogFor(d, req, req.params.id)
      await d.query('delete from worklogs where id = $1', [w.id])
      await remaining(d, w.issueId, -w.minutes, adjustOf(req.query))
      if (w.userId !== req.me.id) await audit(d, req, { action: 'worklog.deleted', type: 'worklog', id: w.id, project: { id: w.projectId, key: w.projectKey }, before: { minutes: w.minutes, date: w.date, note: w.note, by: w.userId } })
    })
    reply.code(204).send()
  })
}

export default plugin
