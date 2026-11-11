import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { canJoinWork, commentShown, levelOk, minFor, need, roleOf, visible, visibleAs, type ProjectRole, ARCHIVED, READS, accessTo, notArchived, type Permission, canSee } from '../access.ts'
import { publish } from '../events.ts'
import { audit } from '../audit.ts'
import { withoutNotifications } from './notificationSchemes.ts'
import { emit, triggerWebhook } from '../webhooks.ts'
import { REF_KINDS, valueProblem, type FieldKind, type FieldValue, type Option } from '../shared/customFields.ts'
import { defaultsFor, enforceRules, enforceScreen, rulesFor } from '../fields.ts'
import { isEmpty } from '../shared/fieldRules.ts'
import { getSetting } from '../settings.ts'
import { holds } from '../shared/permissions.ts'
import { runRules, moveAllowed } from '../rules.ts'
import { available, ruleContext, transitionById, transitionTo, type TransitionRow } from '../transitions.ts'
import { statusesFor } from '../workflows.ts'
import { actionChanges, problems, type RuleCtx } from '../shared/transitionRules.ts'
import { labels } from '../shared/labels.ts'
import { checkPriority, checkResolution, defaultPriority } from '../lists.ts'
import { adjustRemaining, remainingWhenEstimated, type Adjust } from '../shared/estimates.ts'
import { projectByKey } from './projects.ts'

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const type = z.string().min(1).max(40).describe('A work type key of the project (GET /projects/:key: types): epic, story, task, bug, or one the project added')
const priority = z.string().min(1).max(40).describe('A priority key from GET /priorities (urgent, high, medium, low, none, or one an admin added)')

/** A field as the history names it: statusId → status, fixReleaseIds → fix versions. */
const FIELD_WORDS: Record<string, string> = { statusId: 'status', assigneeId: 'assignee', reporterId: 'reporter', sprintId: 'sprint', parentId: 'parent', parentLinkId: 'parent link',
  fixReleaseIds: 'fix versions', affectsReleaseIds: 'affects versions', componentIds: 'components', title: 'summary' }
const fieldWords = (f: string) => FIELD_WORDS[f] ?? f.replace(/([A-Z])/g, ' $1').toLowerCase()

export const ISSUE_ROW = `
  select i.id, p.key || '-' || i.number as key, i.project_id, i.number, i.type, i.title, i.description,
         i.status_id, i.priority, i.flagged, i.epic_color, i.epic_status, i.assignee_id, i.reporter_id, i.labels, i.estimate, i.time_estimate, i.time_remaining, i.component_ids, i.affects_release_ids, i.security_level_id, i.test_spec, i.test_folder_id, i.test_environments, i.revision,
         i.due_date, i.start_date, i.sprint_id, i.fix_release_ids, live_par.id as parent_id, live_pl.id as parent_link_id, i.custom, i.rank, i.version,
         i.resolution, i.resolved_at, i.created_at, i.updated_at, i.archived_at, i.archived_by
    from issues i join projects p on p.id = i.project_id
    left join issues live_par on live_par.id = i.parent_id and live_par.deleted_at is null   -- a deleted parent (an epic) is no parent until restored (spec 0202)
    left join issues live_pl on live_pl.id = i.parent_link_id and live_pl.deleted_at is null`   // nor a deleted initiative (spec 0803)

// What a Test or Pre-Condition says to do (Xray's three kinds of test)
const testStep = z.object({
  id: z.string().min(1).max(40), action: z.string().max(5000), data: z.string().max(5000).default(''), expected: z.string().max(5000).default(''),
  attachmentIds: z.array(uuid).max(20).default([]),
})
export const testSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), steps: z.array(testStep).max(200) }),
  z.object({ kind: z.literal('cucumber'), gherkin: z.string().max(50_000) }),
  z.object({ kind: z.literal('generic'), definition: z.string().max(5000) }),
]).describe('Test steps (manual), a Gherkin scenario (cucumber) or a definition (generic, for automated tests). Tests and Pre-Conditions only')
export const TEST_TYPES = ['test', 'precondition', 'test_set', 'test_plan', 'test_execution'] as const

const patchBody = z.object({
  title: z.string().min(1).max(500), description: z.string(), type, priority, statusId: uuid,
  flagged: z.boolean().describe('Jira’s flag (Flagged = Impediment): blocked or needs attention (spec 0408)'),
  epicColor: z.string().regex(/^ghx-label-([1-9]|1[0-4])$/, 'One of Jira’s epic colours, ghx-label-1 to ghx-label-14').nullable().describe('Epics: Jira’s Epic Colour (spec 0407)'),
  epicStatus: z.enum(['To Do', 'In Progress', 'Done']).nullable().describe('Epics: Jira’s Epic Status, apart from the workflow (spec 0716)'),
  assigneeId: uuid.nullable(), reporterId: uuid.describe('Modify reporter: project admins (spec 0203)'), labels, estimate: z.number().nonnegative().nullable(),
  timeEstimate: z.number().int().nonnegative().nullable(), timeRemaining: z.number().int().nonnegative().nullable().describe('Remaining estimate, minutes (starts at the original estimate)'),
  dueDate: date.nullable(), startDate: date.nullable(),
  sprintId: uuid.nullable(), fixReleaseIds: z.array(uuid).max(50).describe('Fix versions: releases of the project that fix it'), parentId: uuid.nullable(),
  securityLevelId: uuid.nullable().describe('Security level: only its members see the item (null: everyone in the project)'),
  parentLinkId: uuid.nullable().describe('Epics: the initiative it belongs to (Jira’s Parent Link), in any project (spec 0803)'),
  componentIds: z.array(uuid).max(50).describe('Components of the project'), affectsReleaseIds: z.array(uuid).max(50).describe('Affects versions: releases of the project where it was found'),
  custom: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string()).max(100)])).describe('Custom field values by field id: text, a number, or a list (multiple-value fields; a cascading field’s option and child option)'), rank: z.number(), testSpec: testSpec.nullable(),
  testFolderId: uuid.nullable().describe('Test repository folder (Tests only; null: the top)'),
  testEnvironments: z.array(z.string().trim().min(1).max(100)).max(20).describe('What a Test Execution ran against (Test Executions only)'), revision: z.string().max(200).describe('Build or revision a Test Execution ran against'),
  resolution: z.string().min(1).max(100).nullable().describe('How a finished item ended: a name from GET /resolutions. Only for items in a Done status; a workflow that resolves on reaching Done sets the default unless you say otherwise'),
}).partial()
const FIELDS = Object.keys(patchBody.shape)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** "PAY-12" or the issue's uuid → the issue, or 404 when it does not exist or I cannot see its project (Jira calls this issueIdOrKey).
 *  `min` is the project role the request needs: by default reading needs any role and changing things needs member. */
export async function issueByKey(d: Db, req: { me: Me; method: string }, ref: string, includeDeleted = false, min?: ProjectRole | Permission, o: { archivedOk?: boolean } = {}) {
  const live = includeDeleted ? '' : 'and i.deleted_at is null'
  const byId = UUID.test(ref)
  const m = byId ? null : /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref)
  if (!byId && !m) throw new HttpError(404, 'Issue not found')
  const ws = req.me.workspaceId
  const [i] = byId
    ? await d.query<any>(`${ISSUE_ROW} where i.workspace_id = $1 and i.id = $2 ${live}`, [ws, ref])
    : await d.query<any>(`${ISSUE_ROW} where i.workspace_id = $1 ${live} and (
          (i.number = $3 and (p.key = $2 or p.id = (select project_id from project_key_history where workspace_id = $1 and key = $2)))
          or i.id = (select mk.issue_id from moved_issue_keys mk join projects op on op.id = mk.project_id
                      where mk.workspace_id = $1 and mk.number = $3 and (op.key = $2 or op.id = (select project_id from project_key_history where workspace_id = $1 and key = $2))))
        order by (p.key = $2 and i.number = $3) desc limit 1`, [ws, m![1]!.toUpperCase(), Number(m![2])])   // an old project key (spec 0703), or a key it had before a move (spec 0501)
  const a = i ? await accessTo(d, req.me, i.projectId) : null
  if (!i || !a) throw new HttpError(404, 'Issue not found')
  // an item whose security level leaves me out doesn't exist, as far as I can tell
  if (i.securityLevelId && !(await d.query(`select 1 from issues i where i.id = $1 and ${levelOk(req.me, 2)}`, [i.id, req.me.id])).length) throw new HttpError(404, 'Issue not found')
  // an archived project's items open by their key, read-only (spec 0102); opening one may still record the view
  if (a.archived && !READS.has(req.method) && !o.archivedOk) throw new HttpError(403, ARCHIVED)
  // an archived item is read-only until a system administrator restores it (spec 0508)
  if (i.archivedAt && !READS.has(req.method) && !o.archivedOk) throw new HttpError(403, `${i.key} is archived: a system administrator restores it to change it`)
  need(a.role, min ?? minFor(req.method), i.key.split('-')[0])
  return i
}

/** Tell someone about an issue, unless it is me or they cannot see the project (a person removed from a project hears nothing more from it). */
const note = (d: Db, to: string, me: Me, issueId: string, kind: string, text: string) =>
  to === me.id ? null : d.query(
    `insert into notifications (user_id, actor_id, issue_id, kind, text)
     select $1, $2, i.id, $4, $5 from issues i
      where i.id = $3 and (exists (select 1 from project_access pm where pm.project_id = i.project_id and pm.user_id = $1)
                        or is_system_admin($1))
        and issue_visible(i.security_level_id, i.reporter_id, i.assignee_id, i.project_id, $1, is_system_admin($1))`,
    [to, me.id, issueId, kind, text])

/** Jira's Autowatch (spec 0606 R2): creating or commenting makes me a watcher, unless I turned it off (or the default is off). */
async function autowatch(d: Db, me: Me, issueId: string) {
  const [p] = await d.query<{ on: boolean | null }>('select autowatch as on from user_preferences where user_id = $1', [me.id])
  if (p?.on ?? (await getSetting(me.workspaceId, 'userDefaults')).autowatch)
    await d.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [issueId, me.id])
}

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
          or is_system_admin(u.id))`, [projectId, text, authorId])
  return candidates.filter(c => mentions(text, c.name)).map(c => c.id)
}

/** A transition's actions, after the move, in the same transaction: field changes (recorded as made by the transition)
 *  and comments by the mover. An assignee who isn't in the project is skipped, as automation does. */
/** Jira's `transition` in a post function's webhook (spec 0715 R6): the workflow the item's type uses, the transition, and the statuses. */
async function transitionInfo(d: Db, cur: any, t: TransitionRow, toId: string) {
  const [wf] = await d.query<{ id: string; name: string }>(
    `select w.id, w.name from projects p join workflow_schemes s on s.id = p.workflow_scheme_id
       join workflows w on w.id = coalesce((s.mappings->>$2)::uuid, s.default_workflow_id) where p.id = $1`, [cur.projectId, cur.type])
  const name = async (id: string) => (await d.query<{ name: string }>('select name from statuses where id = $1', [id]))[0]?.name ?? null
  return { workflowId: wf?.id ?? null, workflowName: wf?.name ?? null, transitionId: t.id, transitionName: t.name, from_status: await name(cur.statusId), to_status: await name(toId) }
}

export async function runActions(d: Db, me: Me | null, issueId: string, t: TransitionRow, ctx: RuleCtx) {
  if (!t.rules.actions?.length) return
  const [now] = await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [issueId])
  const { patch, comments } = actionChanges(t.rules, ctx, now)
  if (patch.assigneeId && !(await canJoinWork(d, now.projectId, patch.assigneeId as string))) {
    delete patch.assigneeId
    await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, $3)`, [issueId, me?.id ?? null, `“${t.name}” skipped an assignment: that person is not in this project`])
  }
  if (patch.priority && !(await d.query('select 1 from priorities p join issues i on i.workspace_id = p.workspace_id where i.id = $1 and p.key = $2', [issueId, patch.priority])).length) {
    delete patch.priority                                                     // a priority since removed from the list
    await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, $3)`, [issueId, me?.id ?? null, `“${t.name}” skipped setting a priority that is no longer in the list`])
  }
  const changed = Object.keys(patch).filter(k => JSON.stringify(patch[k] ?? null) !== JSON.stringify(now[k] ?? null))
  if (changed.length) {
    const w = pick(Object.fromEntries(changed.map(k => [k, patch[k]])), FIELDS, ['custom'])
    await d.query(`update issues set ${w.cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() where id = $1`, [issueId, ...w.vals])
    for (const f of changed)
      await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
        [issueId, me?.id ?? null, f, now[f] == null ? null : String(now[f]), patch[f] == null ? null : String(patch[f]), `“${t.name}” changed ${fieldWords(f)}`])
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
 *  number, one of a select field's enabled options, or a YYYY-MM-DD date. Only values that change are checked, so an item
 *  keeps an option that was later disabled. A cleared field is simply left out. */
async function checkCustom(d: Db, projectId: string, type: string, next: Record<string, FieldValue>, prev: Record<string, FieldValue> = {}) {
  const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(prev[k]))
  const cleared = Object.keys(prev).filter(k => !(k in next))
  if (!changed.length && !cleared.length) return
  const defs = new Map((await d.query<{ id: string; name: string; kind: FieldKind; options: Option[] | null; typeKeys: string[] | null }>(
    'select id, name, kind, options, type_keys from field_defs where project_id = $1', [projectId])).map(f => [f.id, f]))
  const errors: Record<string, string> = {}
  for (const k of [...changed, ...cleared]) {
    const f = defs.get(k)
    if (!f) { if (changed.includes(k)) errors[k] = 'No such field in this project'; continue }
    if (!changed.includes(k)) continue
    // a field applies to the work types its context names (spec 0503 R2)
    if (f.typeKeys && !f.typeKeys.includes(type)) { errors[k] = `${f.name} isn’t used for this work type`; continue }
    const v = next[k]
    const problem = valueProblem(f, v)
    if (problem) { errors[k] = problem; continue }
    // what a value names must exist: people, groups and projects of the workspace, versions of this project
    const table = REF_KINDS[f.kind]
    if (table) {
      const ids = (Array.isArray(v) ? v : [v]) as string[]
      const where = table === 'releases' ? 'project_id = $2' : table === 'projects' ? 'workspace_id = (select workspace_id from projects where id = $2)' : '$2::uuid is not null'   // one workspace's people and groups
      const found = (await d.query<{ n: number }>(`select count(*)::int as n from ${table} where id = any($1::uuid[]) and ${where}`, [ids, projectId]))[0]!.n
      if (found !== ids.length) errors[k] = `${f.name}: ${table === 'releases' ? 'a version not of this project' : table === 'users' ? 'someone not in Strand' : table === 'groups' ? 'a group not in Strand' : 'a project not in Strand'}`
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Some custom field values are not valid', Object.fromEntries(Object.entries(errors).map(([k, m]) => [`custom.${k}`, m])))
}

/** Ranks are fractions in one order for the whole workspace (spec 0302): a move takes the midpoint of its neighbours, so
 *  a busy spot halves its gap on every move. Long before the numbers run out of precision (about 40 halvings), the items
 *  around the move are spread out again between the nearest ranks still far enough apart: 50 on each side, more if those
 *  are crowded too. Nothing else moves, so the order across projects stays. Renumbering does not change versions, so
 *  nobody's edit conflicts because of it. Returns the projects whose items were respread (their open boards reload). */
async function keepRanksApart(d: Db, workspaceId: string, issueId: string, rank: number): Promise<string[]> {
  const [{ n }] = await d.query<{ n: number }>(
    'select count(*)::int as n from issues where workspace_id = $1 and id <> $2 and abs(rank - $3) < 1e-6', [workspaceId, issueId, rank]) as any
  if (!n) return []
  for (let side = 50; ; side *= 10) {
    const [lo] = await d.query<{ rank: number }>(`select rank from issues where workspace_id = $1 and rank < $2 order by rank desc offset $3 limit 1`, [workspaceId, rank, side])
    const [hi] = await d.query<{ rank: number }>(`select rank from issues where workspace_id = $1 and rank > $2 order by rank offset $3 limit 1`, [workspaceId, rank, side])
    const from = lo?.rank ?? rank - side * 1024, to = hi?.rank ?? rank + side * 1024
    const [{ count }] = await d.query<{ count: number }>('select count(*)::int as count from issues where workspace_id = $1 and rank > $2 and rank < $3', [workspaceId, from, to]) as any
    if ((to - from) / (count + 1) < 1e-3 && (lo || hi)) continue                      // still crowded: take in more neighbours
    const moved = await d.query<{ projectId: string }>(
      `update issues i set rank = $2::float8 + r.n * ($3::float8 - $2::float8) / ($4::int + 1)
         from (select id, row_number() over (order by rank, id) as n from issues where workspace_id = $1 and rank > $2 and rank < $3) r
        where i.id = r.id returning i.project_id`, [workspaceId, from, to, count])
    return [...new Set(moved.map(m => m.projectId))]
  }
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
  // Modify reporter (spec 0203 R6): project admins, to someone who can see the project
  if (patch.reporterId !== undefined && patch.reporterId !== cur.reporterId) {
    need((await roleOf(d, me, cur.projectId)) ?? 'viewer', 'modifyReporter', cur.key.split('-')[0])
    if (!(await canSee(d, cur.projectId, patch.reporterId))) throw new HttpError(400, 'The reporter must be someone who can see this project', { reporterId: 'Can’t see the project' })
  }
  if (patch.assigneeId && patch.assigneeId !== cur.assigneeId && !(await canJoinWork(d, cur.projectId, patch.assigneeId)))
    throw new HttpError(400, 'The assignee must be a member of this project')
  // A status change goes through a transition: its Restrict rules decide whether this person may use it, its Validate
  // rules check the item as it will be after the change, and its Actions run after it
  const moving = patch.statusId !== undefined && patch.statusId !== cur.statusId
  const retyping = patch.type !== undefined && patch.type !== cur.type
  if (retyping) await checkType(d, cur.projectId, patch.type)
  // Jira's Epic Status (spec 0716): epics only; an item made an epic starts at To Do, one that stops being an epic loses it
  if (patch.epicStatus != null && (patch.type ?? cur.type) !== 'epic') throw new HttpError(400, 'Only epics have an Epic Status', { epicStatus: 'Epics only' })
  if (patch.epicStatus === null && (patch.type ?? cur.type) === 'epic') { const { epicStatus: _, ...rest } = patch; patch = rest }   // an epic always has one
  if (retyping) patch = { ...patch, epicStatus: (patch.type === 'epic' ? patch.epicStatus ?? 'To Do' : null) as any }
  let t = o.transition ?? null
  let ctx: RuleCtx | null = null
  // A type change whose workflow lacks the item's status is Jira's Move: the item lands on a status of the same kind in
  // the new workflow (else where it starts), not through a transition, so it can't skip ahead (to Done, say)
  const landing = retyping && moving && !override ? await landingFor(d, cur, patch.type!) : null
  if (landing && !landing.includes(patch.statusId!))
    throw new HttpError(400, 'A type change keeps the item’s kind of status: move it on with a transition afterwards', { statusId: 'Not where a type change lands' })
  if ((moving && !override && !landing) || t) {
    const as = retyping ? { ...cur, type: patch.type } : cur             // the new type's transitions
    ctx = await ruleContext(d, as, me)
    t ??= await transitionTo(d, as, patch.statusId!, ctx)
    const errors = problems(t?.rules, ctx, cur, { ...cur, ...patch }, o.comment)
    if (Object.keys(errors).length) throw new HttpError(400, `“${t!.name}” needs more information`, errors)
  }
  // a move the workflow does not allow, made by a project admin with the override, is recorded
  if (moving && override && !(await moveAllowed(d, cur.projectId, cur.statusId, patch.statusId!, cur.type)))
    await audit(d, { me, ip: o.ip }, { action: 'issue.workflow_overridden', type: 'issue', id: cur.id, name: cur.key, project: { id: cur.projectId, key: cur.key.split('-')[0] },
      before: { statusId: cur.statusId }, after: { statusId: patch.statusId } })
  if (patch.parentId === cur.id) throw new HttpError(400, 'An item cannot be its own parent')
  if ((patch.parentId !== undefined && patch.parentId !== cur.parentId) || retyping)
    await checkLevels(d, me, cur.projectId, cur, patch.type ?? cur.type, patch.parentId !== undefined ? patch.parentId : cur.parentId)
  if ((patch.parentLinkId !== undefined && patch.parentLinkId !== cur.parentLinkId) || retyping)
    await checkParentLink(d, me, patch.type ?? cur.type, patch.parentLinkId !== undefined ? patch.parentLinkId : cur.parentLinkId)
  // a first original estimate starts the remaining one (Jira's time tracking)
  if (patch.timeEstimate != null && patch.timeRemaining === undefined && cur.timeRemaining === null) patch = { ...patch, timeRemaining: patch.timeEstimate }
  // whatever happens, the item ends in a status of its type's workflow (a type change may need a new status)
  if ((moving || retyping) && !(await statusesFor(d, cur.projectId, patch.type ?? cur.type)).includes(patch.statusId ?? cur.statusId))
    throw new HttpError(400, retyping && !moving ? 'Its status isn’t in the workflow for that work type: choose a status too' : 'That status isn’t in the workflow for this work type', { statusId: 'Not in this type’s workflow' })
  await checkParts(d, cur.projectId, patch, cur)
  if (patch.securityLevelId !== undefined && patch.securityLevelId !== cur.securityLevelId)
    await checkLevel(d, me, cur.projectId, patch.securityLevelId, cur.reporterId, patch.assigneeId !== undefined ? patch.assigneeId : cur.assigneeId)
  if (patch.sprintId !== undefined && patch.sprintId !== cur.sprintId) await checkSprint(d, me, patch.sprintId)
  if (patch.custom) await checkCustom(d, cur.projectId, patch.type ?? cur.type, patch.custom, cur.custom)
  checkSpec(patch.type ?? cur.type, patch.testSpec)
  if ((patch.testEnvironments?.length || patch.revision) && (patch.type ?? cur.type) !== 'test_execution') throw new HttpError(400, 'Only Test Executions have environments and a revision')
  await checkFolder(d, cur.projectId, patch.type ?? cur.type, patch.testFolderId)
  if (patch.priority !== undefined && patch.priority !== cur.priority) await checkPriority(d, me.workspaceId, patch.priority)
  if (patch.resolution) {
    await checkResolution(d, me.workspaceId, patch.resolution)
    const [st] = await d.query<{ category: string }>('select category from statuses where id = $1', [patch.statusId ?? cur.statusId])
    if (st?.category !== 'done') throw new HttpError(400, 'Only a finished item has a resolution', { resolution: 'Move the item to a Done status first' })
  }

  const changed = Object.keys(patch).filter(k => k !== 'rank' && JSON.stringify((patch as any)[k]) !== JSON.stringify(cur[k]))
  // field configurations (spec 0504 R4): only what this edit sets is checked, so items that already lack a value are left as they are
  const customChanged = patch.custom ? [...new Set([...Object.keys(patch.custom), ...Object.keys(cur.custom ?? {})])].filter(k => JSON.stringify(patch.custom![k]) !== JSON.stringify(cur.custom?.[k])).map(k => `custom.${k}`) : []
  if (changed.length) await enforceRules(d, cur.projectId, patch.type ?? cur.type, { ...cur, ...patch }, [...changed.filter(k => k !== 'custom'), ...customChanged])
  // the edit screen (spec 0505 R4); a transition's own screen decides what a move sets (spec 0103)
  if (changed.length && !t) await enforceScreen(d, cur.projectId, patch.type ?? cur.type, 'edit', [...changed.filter(k => k !== 'custom'), ...customChanged])
  const w = pick(patch, FIELDS, ['custom', 'testSpec'])
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
    if (f === 'testSpec') { await d.query('insert into activity (issue_id, actor_id, field, text) values ($1, $2, $3, $4)', [cur.id, me.id, f, 'Changed the test steps']); continue }
    await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
      [cur.id, me.id, f, from == null ? null : String(from), to == null ? null : String(to), `Changed ${fieldWords(f)}`])
  }
  if (t) {
    if (!moving) await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [cur.id, me.id, `“${t.name}”`])   // a loop: the action itself is the history
    if (o.comment?.trim()) {
      await d.query('insert into comments (issue_id, author_id, body) values ($1, $2, $3)', [cur.id, me.id, o.comment])
      for (const u of await mentionedIn(d, cur.projectId, o.comment, me.id)) await note(d, u, me, cur.id, 'mentioned', 'mentioned you in a comment')
    }
    await runActions(d, me, cur.id, t, ctx!)
  }
  const rctx = { projectId: cur.projectId, issueId: cur.id, reporterId: cur.reporterId, leadId: lead?.leadId ?? null, actorId: me.id }
  // who hears about it is the project's notification scheme (spec 0605), through emit() below
  if (changed.includes('assigneeId') && patch.assigneeId) await runRules(d, rctx, { kind: 'assigned' })
  if (changed.includes('statusId')) await runRules(d, rctx, { kind: 'status', to: patch.statusId! })
  if (patch.rank !== undefined) for (const p of await keepRanksApart(d, me.workspaceId, cur.id, patch.rank)) await publish(d, p, { type: 'issues.reranked' })
  await publish(d, cur.projectId, { type: 'issue.updated', id: cur.id, key: cur.key, editors: await editorsOf(d, cur.id) })
  // webhooks (spec 0705): Jira's changelog, one item per changed field
  // as Jira's (spec 0715 R3): an assignee change alone is issue_assigned, anything else issue_updated; a transition into a Done status
  // is Issue Resolved, out of one Issue Reopened, otherwise Generic Event (spec 0605 R4)
  const [cat] = moving || t ? await d.query<{ before: string; after: string }>('select (select category from statuses where id = $1) as before, (select category from statuses where id = $2) as after',
    [cur.statusId, patch.statusId ?? cur.statusId]) : []
  const type = cat ? (cat.before !== 'done' && cat.after === 'done' ? 'issue_resolved' as const : cat.before === 'done' && cat.after !== 'done' ? 'issue_reopened' as const : 'issue_generic' as const)
    : changed.length === 1 && changed[0] === 'assigneeId' ? 'issue_assigned' as const : 'issue_updated' as const
  const changelog = changed.map(f => ({ field: f, from: cur[f] ?? null, to: (patch as any)[f] ?? null }))
  if (changed.length || t) await emit(d, me.workspaceId, 'jira:issue_updated', { issueId: cur.id, projectId: cur.projectId, type }, me.id, changelog)
  // a transition's "Trigger a webhook" post functions (spec 0715 R6)
  for (const a of t?.rules.actions ?? []) if (a.kind === 'webhook')
    await triggerWebhook(d, me.workspaceId, a.webhookId, cur.id, cur.projectId, me.id, await transitionInfo(d, cur, t!, patch.statusId ?? cur.statusId), changelog)
  return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [cur.id]))[0]
}

/** Jira's levels (spec 0303): an epic has no parent; an item's parent is an epic, in any project; a sub-item's parent is an
 *  item of the same project. A parent must be one I can see; an item with sub-items stays an item; an epic with items
 *  stays an epic. `item` is the item being changed (null when it is new). */
export async function checkLevels(d: Db, me: Me, projectId: string, item: { id: string; type: string } | null, type: string, parentId: string | null | undefined) {
  const has = async (where: string) => !!item && (await d.query(`select 1 from issues where parent_id = $1 and deleted_at is null and ${where} limit 1`, [item.id])).length > 0
  if (item && item.type === 'epic' && type !== 'epic' && await has('true'))
    throw new HttpError(400, 'An epic with work items stays an epic: move its items to another epic first', { type: 'The epic has items' })
  if (item && type === 'epic' && item.type !== 'epic' && await has('true'))
    throw new HttpError(400, 'An item with sub-items can’t become an epic', { type: 'It has sub-items' })
  // initiatives (spec 0803): above epics, joined only through an epic's Parent Link
  if (item && type === 'initiative' && item.type !== 'initiative' && await has('true'))
    throw new HttpError(400, 'An item with work under it can’t become an initiative', { type: 'It has items' })
  if (item && item.type === 'initiative' && type !== 'initiative' && (await d.query('select 1 from issues where parent_link_id = $1 and deleted_at is null limit 1', [item.id])).length)
    throw new HttpError(400, 'An initiative with epics stays an initiative: take its epics out first', { type: 'The initiative has epics' })
  if (!parentId) return
  if (type === 'epic') throw new HttpError(400, 'An epic has no parent', { parentId: 'Epics have no parent' })
  if (type === 'initiative') throw new HttpError(400, 'An initiative has no parent', { parentId: 'Initiatives have no parent' })
  const args: unknown[] = [parentId, me.workspaceId]
  const [p] = await d.query<{ id: string; type: string; projectId: string; grandType: string | null }>(
    `select i.id, i.type, i.project_id, g.type as grand_type from issues i left join issues g on g.id = i.parent_id
      where i.id = $1 and i.workspace_id = $2 and i.deleted_at is null and ${visible(me, 'i.project_id', args)} and ${levelOk(me, args.push(me.id))}`, args)   // within my security level too
  if (!p) throw new HttpError(400, 'No such parent', { parentId: 'No such parent' })
  if (p.type === 'initiative') throw new HttpError(400, 'Epics join an initiative through their Parent Link; other work goes under an epic', { parentId: 'An initiative' })
  if (p.type === 'epic') return
  if (p.grandType && p.grandType !== 'epic') throw new HttpError(400, 'A sub-item can’t have sub-items', { parentId: 'That item is a sub-item' })
  if (p.projectId !== projectId) throw new HttpError(400, 'A sub-item is in its parent’s project', { parentId: 'In another project' })
  if (await has('true')) throw new HttpError(400, 'An item with sub-items can’t become a sub-item', { parentId: 'It has sub-items' })
}

/** Jira's Parent Link (spec 0803 R1): only an epic has one, and it is an initiative I can see, in any project. An epic in an
 *  initiative stays an epic. */
export async function checkParentLink(d: Db, me: Me, type: string, parentLinkId: string | null | undefined) {
  if (!parentLinkId) return
  if (type !== 'epic') throw new HttpError(400, 'Only an epic has a Parent Link (an epic in an initiative stays an epic: take it out first)', { parentLinkId: 'Epics only' })
  const args: unknown[] = [parentLinkId, me.workspaceId, me.id]
  const [p] = await d.query<{ type: string }>(`select i.type from issues i where i.id = $1 and i.workspace_id = $2 and i.deleted_at is null and ${levelOk(me, 3)} and ${visible(me, 'i.project_id', args)}`, args)
  if (!p) throw new HttpError(400, 'No such initiative', { parentLinkId: 'No such initiative' })
  if (p.type !== 'initiative') throw new HttpError(400, 'An epic’s Parent Link is an initiative', { parentLinkId: 'Not an initiative' })
}

/** Components, fix versions and affects versions must be the project's own. An archived version stays on the items that
 *  have it, but can't be added or removed (Jira's, spec 0304 R4); `prev` is the item before the change. */
async function checkParts(d: Db, projectId: string, b: { componentIds?: string[]; fixReleaseIds?: string[]; affectsReleaseIds?: string[] }, prev: { fixReleaseIds?: string[]; affectsReleaseIds?: string[] } = {}) {
  for (const f of ['fixReleaseIds', 'affectsReleaseIds'] as const) {
    if (!b[f]) continue
    const was = prev[f] ?? [], now = b[f]!
    const touched = [...now.filter(x => !was.includes(x)), ...was.filter(x => !now.includes(x))]
    if (!touched.length) continue
    const [a] = await d.query<{ name: string }>('select name from releases where id = any($1::uuid[]) and archived limit 1', [touched])
    if (a) throw new HttpError(400, `Version ${a.name} is archived`, { [f]: 'Archived version' })
  }
  for (const [ids, table, field, what] of [[b.componentIds, 'components', 'componentIds', 'component'], [b.fixReleaseIds, 'releases', 'fixReleaseIds', 'release'], [b.affectsReleaseIds, 'releases', 'affectsReleaseIds', 'release']] as const) {
    if (!ids?.length) continue
    const [{ n }] = await d.query<{ n: number }>(`select count(*)::int as n from ${table} where project_id = $1 and id = any($2::uuid[])`, [projectId, [...new Set(ids)]]) as any
    if (n !== new Set(ids).size) throw new HttpError(400, `Every ${what} must be one of this project's`, { [field]: `Unknown ${what}` })
  }
}

/** A sprint an item may go into: one of this workspace's, not completed, on a board in a project I can see (a sprint can
 *  hold work from any project, as its board's filter may cover several). */
async function checkSprint(d: Db, me: Me, sprintId: string | null | undefined) {
  if (!sprintId) return
  const args: unknown[] = [sprintId, me.workspaceId]
  const [s] = await d.query<{ state: string }>(`select s.state from sprints s where s.id = $1 and s.workspace_id = $2 and ${visible(me, 's.project_id', args)}`, args)
  if (!s) throw new HttpError(400, 'No such sprint', { sprintId: 'Unknown sprint' })
  if (s.state === 'closed') throw new HttpError(400, 'That sprint is completed: choose an open one', { sprintId: 'Completed sprint' })
}

/** Delete a work item (spec 0202): its sub-items at any depth go with it, at the same moment (so restoring finds them);
 *  an epic's items stay, and have no epic while it is deleted (they keep the link, so restoring it gives it back). An
 *  item already deleted is left as it is. Returns how many went. */
async function deleteItem(d: Db, who: { me: Me; ip?: string }, i: any) {
  if ((await d.query('select 1 from issues where id = $1 and deleted_at is not null', [i.id])).length) return 0
  const gone = await d.query<{ id: string; key: string }>(
    `with recursive t as (select $1::uuid as id union all select c.id from issues c join t on c.parent_id = t.id where c.deleted_at is null and $2 <> 'epic')
     update issues x set deleted_at = now(), deleted_by = $3, version = version + 1 from t join projects p on true
      where x.id = t.id and p.id = x.project_id returning x.id, p.key || '-' || x.number as key`, [i.id, i.type, who.me.id])
  for (const g of gone) await audit(d, who, { action: 'issue.deleted', type: 'issue', id: g.id, name: g.key, project: { id: i.projectId, key: i.key.split('-')[0]! } })
  await publish(d, i.projectId, { type: 'issue.deleted', id: i.id, key: i.key })
  for (const g of gone) await emit(d, who.me.workspaceId, 'jira:issue_deleted', { issueId: g.id, projectId: i.projectId }, who.me.id)
  if (i.type === 'epic') await publish(d, i.projectId, { type: 'issues.reranked' })   // its items lost their epic
  return gone.length
}

/** Restore a deleted work item with the sub-items deleted with it (the same moment); an epic's items that still point to
 *  it (not given another epic or none since) have it again. Returns how many came back. */
async function restoreItem(d: Db, who: { me: Me; ip?: string }, i: any) {
  const back = await d.query<{ id: string }>(
    `with recursive at as (select deleted_at from issues where id = $1 and deleted_at is not null),
       t as (select $1::uuid as id union all select c.id from issues c join t on c.parent_id = t.id where c.deleted_at = (select deleted_at from at))
     update issues x set deleted_at = null, deleted_by = null, version = version + 1 from t where x.id = t.id and x.deleted_at = (select deleted_at from at) returning x.id`, [i.id])
  if (!back.length) return 0
  await audit(d, who, { action: 'issue.restored', type: 'issue', id: i.id, name: i.key, project: { id: i.projectId, key: i.key.split('-')[0]! }, after: back.length > 1 ? { withSubItems: back.length - 1 } : undefined })
  await publish(d, i.projectId, { type: 'issue.created', id: i.id })
  if (i.type === 'epic' || back.length > 1) await publish(d, i.projectId, { type: 'issues.reranked' })
  return back.length
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
  need((await roleOf(d, me, projectId)) ?? 'viewer', 'setIssueSecurity')
  const [ok] = await d.query<{ ok: boolean }>(`select issue_visible($1, $2, $3, $4, $5, $6) as ok from security_levels where id = $1 and project_id = $4`,
    [levelId, reporterId, assigneeId, projectId, me.id, me.admin])
  if (!ok) throw new HttpError(400, 'No such security level in this project', { securityLevelId: 'Unknown level' })
  if (!ok.ok) throw new HttpError(400, 'You can only choose a security level you are in', { securityLevelId: 'You aren’t in this level' })
}

/** Only Tests and Pre-Conditions say what to do. */
function checkSpec(type: string, spec: unknown) {
  if (spec != null && type !== 'test' && type !== 'precondition') throw new HttpError(400, 'Only Tests and Pre-Conditions have test steps', { testSpec: 'Not a Test' })
}

/** A test repository folder: one of the project's, and only for Tests. */
async function checkFolder(d: Db, projectId: string, type: string, folderId: string | null | undefined) {
  if (!folderId) return
  if (type !== 'test') throw new HttpError(400, 'Only Tests go in test repository folders', { testFolderId: 'Not a Test' })
  if (!(await d.query('select 1 from test_folders where id = $1 and project_id = $2', [folderId, projectId])).length)
    throw new HttpError(400, 'No such folder in this project', { testFolderId: 'Unknown folder' })
}

/** Is this one of the project's work types? (400 otherwise) */
export async function checkType(d: Db, projectId: string, type: string | undefined) {
  if (type === undefined) return
  if (!(await d.query('select 1 from work_types where project_id = $1 and key = $2', [projectId, type])).length)
    throw new HttpError(400, 'That work type isn’t in this project', { type: 'Unknown work type' })
}

/** Where a type change may put an item whose status the new type's workflow lacks: a status of the same category
 *  there, else that workflow's start. Null when the workflow has the item's status (then moves follow transitions). */
async function landingFor(d: Db, cur: any, type: string) {
  const allowed = await statusesFor(d, cur.projectId, type)
  if (allowed.includes(cur.statusId)) return null
  const same = (await d.query<{ id: string }>('select id from statuses where id = any($1) and category = (select category from statuses where id = $2)', [allowed, cur.statusId])).map(s => s.id)
  return same.length ? same : allowed.slice(0, 1)
}

/** Create one issue (key, rank and start status from the project unless given), with its first history entry, the
 *  assignee's notification and "created" automation. Returns its id. Shared by create and clone. */
export async function insertIssue(d: Db, me: Me, projectId: string, b: Record<string, any>, created = 'Created this work item') {
  const [pr] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [projectId])
  if (b.assigneeId && !(await canJoinWork(d, projectId, b.assigneeId))) throw new HttpError(400, 'The assignee must be a member of this project')
  if (b.custom) await checkCustom(d, projectId, b.type ?? 'task', b.custom)
  // default values of the fields that apply to it (spec 0503 R3), but not of a hidden field (spec 0504 R4)
  const hiddenNow = Object.entries((await rulesFor(d, projectId))[b.type ?? 'task'] ?? {}).filter(([, r]) => r.hidden).map(([k]) => k)
  const defaults = Object.fromEntries(Object.entries(await defaultsFor(d, projectId, b.type ?? 'task', b.custom ?? {})).filter(([k]) => !hiddenNow.includes(`custom.${k}`)))
  if (Object.keys(defaults).length) b = { ...b, custom: { ...(b.custom ?? {}), ...defaults } }
  await checkType(d, projectId, b.type)
  checkSpec(b.type ?? 'task', b.testSpec)
  await checkFolder(d, projectId, b.type ?? 'task', b.testFolderId)
  await checkParts(d, projectId, b)
  await checkLevel(d, me, projectId, b.securityLevelId, me.id, b.assigneeId ?? null)
  await checkLevels(d, me, projectId, null, b.type ?? 'task', b.parentId)
  await checkParentLink(d, me, b.type ?? 'task', b.parentLinkId)
  // no priority chosen: the list's default (Medium out of the box, as in Jira; spec 0305 R2)
  if (b.priority === undefined) b = { ...b, priority: await defaultPriority(d, me.workspaceId) }
  else await checkPriority(d, me.workspaceId, b.priority)
  await checkSprint(d, me, b.sprintId)
  if (b.assigneeId === undefined && b.componentIds?.length) { const who = await defaultAssignee(d, projectId, b.componentIds); if (who) b = { ...b, assigneeId: who } }
  // new work starts where its type's workflow starts, or in a status of that workflow
  const allowed = await statusesFor(d, projectId, b.type ?? 'task')
  const statusId = b.statusId ?? allowed[0]
  if (!allowed.includes(statusId)) throw new HttpError(400, 'That status isn’t in the workflow for this work type', { statusId: 'Not in this type’s workflow' })
  // field configurations (spec 0504 R4): hidden fields can't be set, required fields need a value
  await enforceRules(d, projectId, b.type ?? 'task', { ...b, reporterId: me.id, statusId }, null)
  const [{ number }] = await d.query<{ number: number }>('select next_issue_number($1) as number', [projectId]) as any
  // a new item goes last, after every item in the workspace (spec 0302 R2): a rank sent with it is not used
  const [{ rank }] = await d.query<{ rank: number }>(
    'select coalesce(max(rank), 0) + 1024 as rank from issues where workspace_id = $1', [me.workspaceId]) as any
  const timeRemaining = b.timeRemaining !== undefined ? b.timeRemaining : remainingWhenEstimated(null, b.timeEstimate)
  if (b.epicStatus != null && b.type !== 'epic') throw new HttpError(400, 'Only epics have an Epic Status', { epicStatus: 'Epics only' })
  const epicStatus = b.type === 'epic' ? b.epicStatus ?? 'To Do' : undefined            // Jira's Epic Status (spec 0716)
  const w = pick({ ...b, statusId, rank, ...(timeRemaining !== null ? { timeRemaining } : {}), ...(epicStatus ? { epicStatus } : {}) }, FIELDS, ['custom', 'testSpec'])
  const cols = ['workspace_id', 'project_id', 'number', 'reporter_id', ...(b.id ? ['id'] : []), ...w.cols]
  const vals = [me.workspaceId, projectId, number, me.id, ...(b.id ? [b.id] : []), ...w.vals]
  const [row] = await d.query<{ id: string }>(
    `insert into issues (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals)
  await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, $3)`, [row!.id, me.id, created])
  await autowatch(d, me, row!.id)
  await runRules(d, { projectId, issueId: row!.id, reporterId: me.id, leadId: pr!.leadId, actorId: me.id }, { kind: 'created' })
  await publish(d, projectId, { type: 'issue.created', id: row!.id })
  await emit(d, me.workspaceId, 'jira:issue_created', { issueId: row!.id, projectId }, me.id)
  return row!.id
}

/** Bulk change's "Send notifications" (spec 0605 R5): on by default; off needs system administrator or project admin rights for every item. */
export const sendNotifications = z.boolean().default(true).describe('Off: nobody is notified of this change (system administrators, or project admins of every item)')
export async function quietly(d: Db, req: Parameters<typeof issueByKey>[1] & { body: { issues: string[]; sendNotifications?: boolean } }) {
  if (req.body.sendNotifications !== false) return
  if (!req.me.admin) for (const ref of new Set(req.body.issues)) await issueByKey(d, req, ref, false, 'administer')
  await withoutNotifications(d)
}

const visibility = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role: z.enum(['admin', 'member', 'viewer']) }), z.object({ kind: z.literal('group'), id: uuid }),
]).nullable().describe('Who can read it (Jira\'s comment visibility): a project role or a group; null or left out: everyone who sees the item')
/** As in Jira, a comment is limited only to a group I belong to or a role I hold (Strand's roles stack: an admin also
 *  holds member); global admins may choose any (spec 0203 R4). */
const checkVisibility = async (d: Db, me: Me, projectId: string, v: z.infer<typeof visibility> | undefined) => {
  if (!v || me.admin) return
  if (v.kind === 'group' && !(await d.query('select 1 from group_members where group_id = $1 and user_id = $2', [v.id, me.id])).length)
    throw new HttpError(400, 'You can limit a comment only to a group you are in', { visibility: 'Not your group' })
  const RANK = { viewer: 1, member: 2, admin: 3 } as const
  if (v.kind === 'role' && RANK[(await roleOf(d, me, projectId)) ?? 'viewer'] < RANK[v.role])
    throw new HttpError(400, 'You can limit a comment only to a role you hold', { visibility: 'Not your role' })
}
/** Who of these people may read a comment with this visibility (the author always can). */
const readers = async (d: Db, projectId: string, people: string[], v: z.infer<typeof visibility> | undefined) => {
  if (!v || !people.length) return people
  const rows = await d.query<{ id: string }>(v.kind === 'group'
    ? 'select user_id as id from group_members where group_id = $2 and user_id = any($1::uuid[])'
    : `select u.id from unnest($1::uuid[]) u(id) where exists (select 1 from project_access pa where pa.project_id = $2 and pa.user_id = u.id and pa.role = $3)
         or ($3 = 'admin' and is_system_admin(u.id))`,
    v.kind === 'group' ? [people, v.id] : [people, projectId, v.role])
  const ok = new Set(rows.map(r => r.id))
  return people.filter(p => ok.has(p))
}
/** Add a comment as `req.me` (the API, and incoming mail, spec 0607): a mention tells that person; the scheme's recipients
 *  hear "commented" (not both, spec 0605 R3); the commenter starts watching (Autowatch, spec 0606). A restricted comment
 *  reaches only people who may read it. */
export async function addComment(d: Db, req: { me: Me; method: string }, key: string, b: { body: string; id?: string; visibility?: z.infer<typeof visibility> }) {
  const i = await issueByKey(d, req, key, false, 'addComments')            // read-only people can comment (Strand's viewers)
  if (b.visibility?.kind === 'group' && !(await d.query('select 1 from groups where id = $1', [b.visibility.id])).length) throw new HttpError(400, 'No such group', { visibility: 'Unknown group' })
  await checkVisibility(d, req.me, i.projectId, b.visibility)
  const [c] = await d.query<any>('insert into comments (id, issue_id, author_id, body, visibility) values (coalesce($4::uuid, uuid_v7()), $1, $2, $3, $5) returning *',
    [i.id, req.me.id, b.body, b.id ?? null, b.visibility ? JSON.stringify(b.visibility) : null])
  const mentioned = await readers(d, i.projectId, await mentionedIn(d, i.projectId, b.body, req.me.id), b.visibility)
  for (const u of mentioned) await note(d, u, req.me, i.id, 'mentioned', 'mentioned you in a comment')
  await autowatch(d, req.me, i.id)
  await publish(d, i.projectId, { type: 'comment.created', key: i.key })
  await emit(d, req.me.workspaceId, 'comment_created', { issueId: i.id, projectId: i.projectId, commentId: c.id }, req.me.id)
  await emit(d, req.me.workspaceId, 'jira:issue_updated', { issueId: i.id, projectId: i.projectId, commentId: c.id, type: 'issue_commented', notifyExcept: mentioned }, req.me.id)   // as Jira's (spec 0715 R2)
  return c
}

const plugin: FastifyPluginAsyncZod = async app => {
  // Board/list page of a project, in backlog order. Keyset-paginated: pass `next` back as `cursor`.
  // Everything the project's reports are calculated from: every item (not just a page) and every status change.
  // ponytail: whole project in one response; move the calculations to SQL when projects outgrow a few tens of thousands of items.
  app.get('/projects/:key/report-data', { schema: { tags: TAG, summary: 'All live items of a project and the full history of their status changes, for reports', params: projKeyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [issues, statusChanges] = await Promise.all([
      db.query(`${ISSUE_ROW} where i.project_id = $1 and i.deleted_at is null and i.archived_at is null and ${levelOk(req.me, 2)} order by i.rank, i.id`, [p.id, req.me.id]),
      db.query(`select a.issue_id, a.from_value as from_id, a.to_value as to_id, a.created_at as at
                  from activity a join issues i on i.id = a.issue_id
                 where i.project_id = $1 and i.deleted_at is null and i.archived_at is null and ${levelOk(req.me, 2)} and a.field = 'statusId' and a.to_value is not null
                 order by a.created_at, a.id`, [p.id, req.me.id]),
    ])
    // when items were put into an epic or a version (spec 0411 R6)
    const joins = await db.query(`select a.issue_id, a.field, a.to_value as value, a.created_at as at
        from activity a join issues i on i.id = a.issue_id
       where i.project_id = $1 and i.deleted_at is null and i.archived_at is null and ${levelOk(req.me, 2)} and a.field in ('parentId', 'fixReleaseIds') and a.to_value is not null
       order by a.created_at, a.id`, [p.id, req.me.id])
    // estimate changes: reports count an item's estimate as it stood at each moment, as Jira's do (spec 0411 R5)
    const estimateChanges = await db.query(`select a.issue_id, a.field, a.from_value as from, a.to_value as to, a.created_at as at
        from activity a join issues i on i.id = a.issue_id
       where i.project_id = $1 and i.deleted_at is null and i.archived_at is null and ${levelOk(req.me, 2)} and a.field in ('estimate', 'timeEstimate')
       order by a.created_at, a.id`, [p.id, req.me.id])
    return { issues, statusChanges, joins, estimateChanges }
  })

  app.get('/projects/:key/issues', { schema: { tags: TAG, summary: 'List a project\'s issues in backlog order (keyset-paginated)', params: projKeyP, querystring: listQuery } }, async req => {
    const q = req.query
    const p = await projectByKey(db, req, req.params.key)
    const args: unknown[] = [p.id, req.me.id]
    const where = ['i.project_id = $1', 'i.deleted_at is null and i.archived_at is null', levelOk(req.me, 2)]
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)) }
    if (q.status) add('i.status_id = ?', q.status)
    if (q.assignee) add('i.assignee_id = ?', q.assignee)
    if (q.type) add('i.type = ?', q.type)
    if (q.release) add('i.fix_release_ids @> array[?::uuid]', q.release)
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

  const createBody = patchBody.omit({ reporterId: true }).required({ title: true }).extend({   // the creator is the reporter
    labels: labels.default([]),
    id: uuid.optional().describe('Client-chosen id: lets the app keep its local id, and makes a retried create a conflict instead of a duplicate'),
  })
  app.post('/projects/:key/issues', { schema: { tags: TAG, summary: 'Create an issue (key and rank are assigned by the server)', params: projKeyP, body: createBody } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      // the create screen (spec 0505 R4): what the request sets must be on it (clones, imports and test tools copy what they copy)
      const b = req.body as Record<string, any>
      const usual = b.priority !== undefined && b.priority === await defaultPriority(d, req.me.workspaceId)    // the default priority isn't a choice the screen must offer
      const defaults = await defaultsFor(d, p.id, b.type ?? 'task')                                          // nor a field's default value
      await enforceScreen(d, p.id, b.type ?? 'task', 'create', [...Object.keys(b).filter(k => k !== 'custom' && !isEmpty(b[k]) && !(k === 'priority' && usual)),
        ...Object.keys(b.custom ?? {}).filter(k => JSON.stringify(b.custom[k]) !== JSON.stringify(defaults[k])).map(k => `custom.${k}`)])
      return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [await insertIssue(d, req.me, p.id, b)]))[0]
    })
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
        timeEstimate: i.timeEstimate, dueDate: i.dueDate, startDate: i.startDate, fixReleaseIds: i.fixReleaseIds, custom: i.custom, securityLevelId: i.securityLevelId,
        assigneeId: i.assigneeId && (await canJoinWork(d, i.projectId, i.assigneeId)) ? i.assigneeId : null,
        sprintId: include.sprint && i.sprintId && (await d.query(`select 1 from sprints where id = $1 and state <> 'closed'`, [i.sprintId])).length ? i.sprintId : null, ...over,   // a completed sprint stays behind
      }, `Cloned from ${i.key}`)
      const id = await copy(src, {
        title: req.body.title ?? `CLONE - ${src.title}`.slice(0, 500), parentId: src.parentId,
        ...(req.body.assigneeId !== undefined ? { assigneeId: req.body.assigneeId } : {}),
      })
      await d.query(`insert into issue_links (issue_id, target_id, type) values ($1, $2, 'clones')`, [id, src.id])
      if (include.children)
        // only children I can see: a copy names me as reporter, so cloning must not hand me an item a level keeps from me
        for (const c of await d.query<any>(`${ISSUE_ROW} where i.parent_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} order by i.rank`, [src.id, req.me.id])) await copy(c, { parentId: id })
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
  app.post('/issues/bulk/edit', { schema: { tags: ['Issues: bulk'], summary: 'Apply the same field changes to many issues (workflow rules apply to each)', body: z.object({ issues: refs, patch: patchBody, sendNotifications }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      await quietly(d, req)
      const out: any[] = []
      for (const ref of [...new Set(req.body.issues)]) out.push(await applyPatch(d, req.me, await issueByKey(d, req, ref), req.body.patch, { ifMatch: null, override: false }))
      return { count: out.length, issues: out }
    })
  })
  app.post('/issues/bulk/delete', { schema: { tags: ['Issues: bulk'], summary: 'Delete many work items with their sub-items (project admins; restorable for the period in System settings)', body: z.object({ issues: refs, sendNotifications }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      await quietly(d, req)
      let n = 0
      for (const ref of [...new Set(req.body.issues)]) n += await deleteItem(d, req, await issueByKey(d, req, ref, true, 'deleteIssues'))
      return bulkResult(n)
    })
  })
  app.post('/issues/bulk/restore', { schema: { tags: ['Issues: bulk'], summary: 'Restore many deleted work items with what was deleted with them (Undo; project admins)', body: z.object({ issues: refs }) } }, async req => {
    await checkBulk(req)
    return tx(async d => {
      let n = 0
      for (const ref of [...new Set(req.body.issues)]) n += await restoreItem(d, req, await issueByKey(d, req, ref, true, 'deleteIssues'))
      return bulkResult(n)
    })
  })

  // Deleting (spec 0202, as in Jira): project admins; an item takes its sub-items with it, an epic leaves its items (they
  // lose their epic). Kept restorable for the period in System settings, then removed for good by a daily job.
  app.delete('/issues/:key', { schema: { tags: TAG, summary: 'Delete a work item with its sub-items (project admins; restorable for the period in System settings). Deleting it again does nothing', params: keyP } }, async (req, reply) => {
    await tx(async d => { await deleteItem(d, req, await issueByKey(d, req, req.params.key, true, 'deleteIssues')) })
    reply.code(204).send()
  })
  app.get('/issues/:key/delete-preview', { schema: { tags: TAG, summary: 'What deleting a work item does: how many sub-items go with it, and for an epic how many items stay without it', params: keyP } }, async req => {
    const i = await issueByKey(db, { ...req, method: 'DELETE' }, req.params.key, false, 'deleteIssues')
    const [{ sub }] = await db.query<{ sub: number }>(`with recursive t as (select id from issues where parent_id = $1 and deleted_at is null and $2 <> 'epic'
      union all select c.id from issues c join t on c.parent_id = t.id where c.deleted_at is null) select count(*)::int as sub from t`, [i.id, i.type]) as any
    const [{ kept }] = await db.query<{ kept: number }>(`select count(*)::int as kept from issues where parent_id = $1 and deleted_at is null and $2 = 'epic'`, [i.id, i.type]) as any
    return { subItems: sub, epicItems: kept }
  })
  // Project settings › Deleted work items (spec 0202): what was deleted, newest first, until it is removed for good
  app.get('/projects/:key/deleted', { schema: { tags: TAG, summary: 'Deleted work items, newest first, a page at a time, with who deleted each and when it goes for good (project admins)', params: z.object({ key: z.string() }),
    querystring: z.object({ query: z.string().max(200).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key, 'deleteIssues')
    const { retentionDays } = await getSetting(req.me.workspaceId, 'deletedItems')
    const args: unknown[] = [p.id]
    let after = ''
    if (req.query.cursor) {
      const [at, id] = Buffer.from(req.query.cursor, 'base64url').toString().split('|')
      if (!id || Number.isNaN(Date.parse(at!))) throw new HttpError(400, 'Invalid cursor')
      args.push(at, id); after = `and (i.deleted_at, i.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`
    }
    if (req.query.query?.trim()) {
      args.push('%' + req.query.query.trim().replace(/[\\%_]/g, '\\$&') + '%')
      after += ` and (i.title ilike $${args.length} or p.key || '-' || i.number ilike $${args.length})`
    }
    args.push(req.me.id); const me = args.length                     // strand: only items my security level lets me see
    args.push(req.query.limit + 1, retentionDays)
    // the items deleted themselves, not the sub-items that went with them (those are counted)
    const rows = await db.query<any>(
      `select i.id, p.key || '-' || i.number as key, i.title, i.type, i.deleted_at, i.deleted_at::text as at_key, u.name as deleted_by,
              i.deleted_at + make_interval(days => $${args.length}) as removed_at,
              (select count(*)::int from issues c where c.parent_id = i.id and c.deleted_at = i.deleted_at) as sub_items
         from issues i join projects p on p.id = i.project_id left join users u on u.id = i.deleted_by
        where i.project_id = $1 and i.deleted_at is not null ${after}
          and not exists (select 1 from issues par where par.id = i.parent_id and par.deleted_at = i.deleted_at)
          and ${levelOk(req.me, me)}
        order by i.deleted_at desc, i.id desc limit $${args.length - 1}`, args)
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    const last = items.at(-1)
    return { items: items.map(({ atKey, ...r }) => r), next: more && last ? Buffer.from(`${last.atKey}|${last.id}`).toString('base64url') : null }   // the exact time, to the microsecond
  })

  // Opening a work item records it for "Your work → Viewed". Anyone who can see the item may record that they did (read-only users too).
  app.post('/issues/:key/view', { schema: { tags: TAG, summary: 'Record that I opened this work item (Your work → Viewed keeps my newest 50)', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer', { archivedOk: true })
    await tx(async d => {
      await d.query('insert into issue_views (user_id, issue_id) values ($1, $2) on conflict (user_id, issue_id) do update set viewed_at = now()', [req.me.id, i.id])
      await d.query('delete from issue_views where user_id = $1 and issue_id in (select issue_id from issue_views where user_id = $1 order by viewed_at desc offset 50)', [req.me.id])
    })
    reply.code(204).send()
  })

  app.post('/issues/:key/restore', { schema: { tags: TAG, summary: 'Restore a deleted work item with what was deleted with it (Undo; project admins)', params: keyP } }, async req => {
    return tx(async d => {
      const i = await issueByKey(d, req, req.params.key, true, 'deleteIssues')
      await restoreItem(d, req, i)
      return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [i.id]))[0]
    })
  })


  // ── Links & watchers ──
  const linkType = z.string().max(40).describe('A link type id (GET /link-types), e.g. blocks, relates, duplicates, clones')
  const linkBody = z.object({ type: linkType, targetKey: z.string() })
  app.post('/issues/:key/links', { schema: { tags: ['Links & watchers'], summary: 'Link two issues: this one <type\'s outward words> the target (blocks, relates to, duplicates…)', params: keyP, body: linkBody } }, async (req, reply) => {
    const b = req.body
    const [a, t] = await Promise.all([issueByKey(db, req, req.params.key, false, 'linkIssues'), issueByKey(db, req, b.targetKey, false, 'browse')])
    if (a.id === t.id) throw new HttpError(400, 'Cannot link an item to itself')
    if (!(await db.query('select 1 from link_types where workspace_id = $1 and id = $2', [req.me.workspaceId, b.type])).length) throw new HttpError(400, 'No such link type', { type: 'Unknown link type' })
    if (b.type === 'tests' && (a.type !== 'test' || (TEST_TYPES as readonly string[]).includes(t.type)))
      throw new HttpError(400, 'A Test tests a requirement: link from the Test to a story, epic or other requirement', { type: 'Not a Test and a requirement' })
    await tx(async d => {
      const [l] = await d.query('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing returning 1', [a.id, t.id, b.type])
      if (l) await emit(d, req.me.workspaceId, 'issuelink_created', { issueId: a.id, projectId: a.projectId, linkId: `${a.id}:${t.id}:${b.type}`,
        entity: { sourceIssueId: a.id, destinationIssueId: t.id, issueLinkType: { name: b.type } } }, req.me.id)
    })
    reply.code(204).send()
  })
  app.delete('/issues/:key/links', { schema: {
    tags: ['Links & watchers'], summary: 'Remove a link', params: keyP,
    querystring: z.object({ type: linkType, target: z.string().describe('Key of the linked issue') }),
  } }, async (req, reply) => {
    const q = { type: req.query.type, targetKey: req.query.target }
    const [a, t] = await Promise.all([issueByKey(db, req, req.params.key), issueByKey(db, req, q.targetKey, false, 'viewer')])
    await tx(async d => {
      const [l] = await d.query('delete from issue_links where issue_id = $1 and target_id = $2 and type = $3 returning 1', [a.id, t.id, q.type])
      if (l) await emit(d, req.me.workspaceId, 'issuelink_deleted', { issueId: a.id, projectId: a.projectId, linkId: `${a.id}:${t.id}:${q.type}`,
        entity: { sourceIssueId: a.id, destinationIssueId: t.id, issueLinkType: { name: q.type } } }, req.me.id)
    })
    reply.code(204).send()
  })
  // Archiving single items (spec 0508), as Jira DC's: system administrators; sub-items go with their parent (an epic's items don't)
  const archive = async (d: Db, req: any, ids: string[], on: boolean) => {
    const rows = await d.query<{ id: string; key: string; projectId: string }>(
      `with recursive t as (select i.id from issues i where i.id = any($1::uuid[])
         union select c.id from issues c join t on c.parent_id = t.id join issues par on par.id = c.parent_id where par.type <> 'epic' and c.deleted_at is null)
       update issues i set archived_at = case when $3 then now() end, archived_by = case when $3 then $2::uuid end, version = version + 1
         from projects p where i.id in (select id from t) and p.id = i.project_id and (i.archived_at is null) = $3
       returning i.id, p.key || '-' || i.number as key, i.project_id`, [ids, req.me.id, on])
    for (const r of rows) {
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [r.id, req.me.id, on ? 'Archived this work item' : 'Restored this work item from the archive'])
      await audit(d, req, { action: on ? 'issue.archived' : 'issue.unarchived', type: 'issue', id: r.id, name: r.key, project: { id: r.projectId, key: r.key.split('-')[0]! } })
    }
    for (const p of new Set(rows.map(r => r.projectId))) await publish(d, p, { type: on ? 'issue.deleted' : 'issue.created', id: ids[0] })
    return rows.map(r => r.key)
  }
  app.post('/issues/:key/archive', { schema: { tags: TAG, summary: 'Archive a work item and its sub-items: read-only, out of lists, boards and search; it still opens by its key (system administrators)', params: keyP } }, async req => {
    requireAdmin(req)
    return tx(async d => ({ archived: await archive(d, req, [(await issueByKey(d, req, req.params.key, false, 'browse')).id], true) }))
  })
  app.post('/issues/:key/unarchive', { schema: { tags: TAG, summary: 'Restore an archived work item with its sub-items (system administrators)', params: keyP } }, async req => {
    requireAdmin(req)
    return tx(async d => ({ restored: await archive(d, req, [(await issueByKey(d, req, req.params.key, false, 'browse', { archivedOk: true })).id], false) }))
  })
  app.post('/issues/bulk/archive', { schema: { tags: ['Issues: bulk'], summary: 'Archive many work items with their sub-items (system administrators)', body: z.object({ issues: z.array(z.string()).min(1).max(5000) }) } }, async req => {
    requireAdmin(req)
    const { bulkMaxItems } = await getSetting(req.me.workspaceId, 'searchAndBulk')
    if (req.body.issues.length > bulkMaxItems) throw new HttpError(400, `At most ${bulkMaxItems} items in one bulk change (System settings)`, { issues: 'Too many' })
    return tx(async d => {
      const ids: string[] = []
      for (const k of [...new Set(req.body.issues)]) ids.push((await issueByKey(d, req, k, false, 'browse')).id)
      return { archived: await archive(d, req, ids, true) }
    })
  })
  app.get('/admin/archived-items', { schema: { tags: TAG, summary: 'Archived work items, most recently archived first, a page at a time (system administrators)',
    querystring: z.object({ query: z.string().max(200).default(''), cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async req => {
    requireAdmin(req)
    const { query, cursor, limit } = req.query
    const args: unknown[] = [req.me.workspaceId]
    const q = query.trim() ? `and (i.title ilike $${args.push(`%${query.trim().replace(/[%_\\]/g, '\\$&')}%`)} or p.key || '-' || i.number = upper($${args.push(query.trim())}))` : ''
    const after = cursor ? `and (i.archived_at, i.id) < ($${args.push(cursor.split('|')[0])}::timestamptz, $${args.push(cursor.split('|')[1])}::uuid)` : ''
    args.push(limit + 1)
    const rows = await db.query<any>(`select i.id, p.key || '-' || i.number as key, i.title, i.type, p.name as project, i.archived_at, u.name as archived_by
        from issues i join projects p on p.id = i.project_id left join users u on u.id = i.archived_by
       where i.workspace_id = $1 and i.archived_at is not null and i.deleted_at is null ${q} ${after} order by i.archived_at desc, i.id desc limit $${args.length}`, args)
    const items = rows.slice(0, limit)
    return { items, next: rows.length > limit ? `${new Date(items.at(-1)!.archivedAt).toISOString()}|${items.at(-1)!.id}` : null }
  })

  // Convert to and from sub-items (spec 0509), as Jira's Convert to sub-task / Convert to issue: the parent decides it
  app.post('/issues/:key/convert', { schema: { tags: TAG, summary: 'Convert an item to a sub-item of another item (parentKey), or a sub-item to an item (parentKey: null); optionally its work type',
    params: keyP, body: z.object({ parentKey: z.string().min(1).nullable(), type: type.optional() }) } }, async req => tx(async d => {
    const cur = await issueByKey(d, req, req.params.key, false, 'editIssues')
    const [par] = cur.parentId ? await d.query<{ type: string }>('select type from issues where id = $1', [cur.parentId]) : []
    const isSub = !!par && par.type !== 'epic'
    if (req.body.parentKey === null) {
      if (!isSub) throw new HttpError(400, `${cur.key} isn’t a sub-item`)
      const out = await applyPatch(d, req.me, cur, { parentId: null, ...(req.body.type ? { type: req.body.type } : {}) }, { ifMatch: null, override: false, ip: req.ip })
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [cur.id, req.me.id, 'Converted to an item'])
      return out
    }
    if (isSub) throw new HttpError(400, `${cur.key} is already a sub-item`)
    if (cur.type === 'epic') throw new HttpError(400, 'An epic can’t become a sub-item')
    const parent = await issueByKey(d, req, req.body.parentKey, false, 'browse')
    if (parent.type === 'epic') throw new HttpError(400, 'A sub-item’s parent is an item, not an epic', { parentKey: 'An epic' })
    const out = await applyPatch(d, req.me, cur, { parentId: parent.id, ...(req.body.type ? { type: req.body.type } : {}) }, { ifMatch: null, override: false, ip: req.ip })
    await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [cur.id, req.me.id, `Converted to a sub-item of ${parent.key}`])
    return out
  }))

  // Voting (spec 0506), as Jira's: once per person, not the reporter, not once resolved; the workspace's switch
  const voteFor = async (req: any) => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    if (!(await getSetting(req.me.workspaceId, 'voting')).enabled) throw new HttpError(403, 'Voting is turned off (System settings › Voting)')
    if (i.reporterId === req.me.id) throw new HttpError(400, 'You can’t vote for a work item you reported')
    if (i.resolution) throw new HttpError(400, 'Votes on a resolved work item can’t change')
    return i
  }
  app.put('/issues/:key/vote', { schema: { tags: ['Links & watchers'], summary: 'Vote for a work item (not one you reported, not a resolved one)', params: keyP } }, async (req, reply) => {
    const i = await voteFor(req)
    await db.query('insert into issue_votes (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, req.me.id])
    reply.code(204).send()
  })
  app.delete('/issues/:key/vote', { schema: { tags: ['Links & watchers'], summary: 'Take back your vote', params: keyP } }, async (req, reply) => {
    const i = await voteFor(req)
    await db.query('delete from issue_votes where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    reply.code(204).send()
  })
  app.get('/issues/:key/votes', { schema: { tags: ['Links & watchers'], summary: 'The votes: how many, whether I voted, and who (with View voters and watchers)', params: keyP } }, async req => {
    const i = await issueByKey(db, req, req.params.key, false, 'viewer')
    const voters = await db.query<{ id: string; name: string }>('select u.id, u.name from issue_votes v join users u on u.id = v.user_id where v.issue_id = $1 order by v.voted_at', [i.id])
    const see = holds(await roleOf(db, req.me, i.projectId), 'viewWatchers')
    return { votes: voters.length, hasVoted: voters.some(v => v.id === req.me.id), voters: see ? voters : [] }
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
  })  // Manage watchers (spec 0203 R8): project admins add and remove other people, who must be able to see the item's project
  const watcherP = z.object({ key: z.string(), userId: uuid })
  app.put('/issues/:key/watchers/:userId', { schema: { tags: ['Links & watchers'], summary: 'Add someone as a watcher (Manage watchers: project admins)', params: watcherP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, req.params.userId === req.me.id ? 'browse' : 'manageWatchers')
    if (!(await canSee(db, i.projectId, req.params.userId))) throw new HttpError(400, 'A watcher must be someone who can see this project', { userId: 'Can’t see the project' })
    await db.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, req.params.userId])
    await publish(db, i.projectId, { type: 'issue.updated', id: i.id, key: i.key })
    reply.code(204).send()
  })
  app.delete('/issues/:key/watchers/:userId', { schema: { tags: ['Links & watchers'], summary: 'Remove someone as a watcher (Manage watchers: project admins)', params: watcherP } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, req.params.userId === req.me.id ? 'browse' : 'manageWatchers')
    await db.query('delete from issue_watchers where issue_id = $1 and user_id = $2', [i.id, req.params.userId])
    await publish(db, i.projectId, { type: 'issue.updated', id: i.id, key: i.key })
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
    const i = await issueByKey(db, req, req.params.key, false, 'viewer', { archivedOk: true })
    await db.query('delete from issue_editors where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    await publish(db, i.projectId, { type: 'issue.editing', key: i.key, editors: await editorsOf(db, i.id) })
    reply.code(204).send()
  })

  // ── Comments (authors edit/delete their own) ──
  const body = z.object({ body: z.string().min(1).max(20000) })
  const commentCreate = body.extend({ id: uuid.optional().describe('Client-chosen id'), visibility: visibility.optional() })
  app.post('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Add a comment (notifies watchers who may read it)', params: keyP, body: commentCreate } }, async req =>
    tx(async d => addComment(d, req, req.params.key, req.body)))
  /** A comment in an archived project can't change (spec 0102). */
  /** A comment I may change: my own (Edit/Delete own comments), or anyone's with Edit/Delete all comments (project admins,
   *  spec 0203); in an archived project, none (0102). Someone else's comment is in the audit log. */
  const commentFor = async (d: Db, req: { me: Me; method: string; ip?: string }, id: string, own: Permission, all: Permission) => {
    const [c] = await d.query<{ id: string; authorId: string; projectId: string; issueId: string; key: string }>(
      `select c.id, c.author_id, i.project_id, i.id as issue_id, p.key || '-' || i.number as key from comments c join issues i on i.id = c.issue_id join projects p on p.id = i.project_id
        where c.id = $1 and i.workspace_id = $2 and i.deleted_at is null for update of c`, [id, req.me.workspaceId])
    const a = c ? await accessTo(d, req.me, c.projectId) : null
    // a comment I can't read doesn't exist, as far as I can tell
    if (!c || !a || !(await d.query(`select 1 from comments c where c.id = $1 and ${commentShown(req.me, c.projectId, 2)}`, [c.id, req.me.id])).length) throw new HttpError(404, 'Comment not found')
    if (a.archived) throw new HttpError(403, ARCHIVED)
    need(a.role, c.authorId === req.me.id ? own : all, c.key.split('-')[0])
    return c
  }
  app.patch('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Edit a comment: your own, or anyone’s as a project admin (audited)', params: idP, body } }, async req => tx(async d => {
    const c = await commentFor(d, req, req.params.id, 'editOwnComments', 'editAllComments')
    const [row] = await d.query('update comments set body = $2, edited_at = now() where id = $1 returning *', [c.id, req.body.body])
    await emit(d, req.me.workspaceId, 'comment_updated', { issueId: c.issueId, projectId: c.projectId, commentId: c.id }, req.me.id)
    await emit(d, req.me.workspaceId, 'jira:issue_updated', { issueId: c.issueId, projectId: c.projectId, commentId: c.id, type: 'issue_comment_edited' }, req.me.id)
    if (c.authorId !== req.me.id) await audit(d, req, { action: 'comment.moderated', type: 'comment', id: c.id, name: c.key, project: { id: c.projectId, key: c.key.split('-')[0]! }, after: { edited: true } })
    return row
  }))
  app.delete('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Delete a comment: your own, or anyone’s as a project admin (audited)', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const c = await commentFor(d, req, req.params.id, 'deleteOwnComments', 'deleteAllComments')
      const [gone] = await d.query('delete from comments where id = $1 returning *', [c.id])
      await emit(d, req.me.workspaceId, 'comment_deleted', { issueId: c.issueId, projectId: c.projectId, commentId: c.id, entity: gone }, req.me.id)
      await emit(d, req.me.workspaceId, 'jira:issue_updated', { issueId: c.issueId, projectId: c.projectId, commentId: c.id, entity: gone, type: 'issue_comment_deleted' }, req.me.id)
      if (c.authorId !== req.me.id) await audit(d, req, { action: 'comment.moderated', type: 'comment', id: c.id, name: c.key, project: { id: c.projectId, key: c.key.split('-')[0]! }, after: { deleted: true } })
    })
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
    const [own] = await d.query<{ projectId: string }>('select i.project_id from worklogs w join issues i on i.id = w.issue_id where w.id = $1', [id])
    if (own) await notArchived(d, own.projectId)
    const args: unknown[] = [id]
    const see = visible(req.me, 'i.project_id', args)
    const [w] = await d.query<any>(`select w.*, i.project_id, p.key as project_key from worklogs w join issues i on i.id = w.issue_id join projects p on p.id = i.project_id
                                     where w.id = $1 and ${see} for update of w`, args)
    if (!w) throw new HttpError(404, 'Work log not found')
    if (w.userId !== req.me.id) need((await roleOf(d, req.me, w.projectId)) ?? 'viewer', req.method === 'DELETE' ? 'deleteAllWorklogs' : 'editAllWorklogs', w.projectKey)
    return w
  }
  app.post('/issues/:key/worklogs', { schema: {
    tags: ['Comments & work logs'], summary: 'Log time on an issue (the remaining estimate counts down, unless adjustEstimate says otherwise)', params: keyP,
    body: z.object({ id: uuid.optional().describe('Client-chosen id'), minutes: z.number().int().positive(), date, note: z.string().default(''), ...adjust }),
  } }, async req => {
    const b = req.body
    return tx(async d => {
      const i = await issueByKey(d, req, req.params.key, false, 'workOnIssues')
      const [w] = await d.query('insert into worklogs (id, issue_id, user_id, minutes, date, note) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5) returning *',
        [i.id, req.me.id, b.minutes, b.date, b.note, b.id ?? null])
      await remaining(d, i.id, b.minutes, adjustOf(b))
      await emit(d, req.me.workspaceId, 'worklog_created', { issueId: i.id, projectId: i.projectId, worklogId: w.id }, req.me.id)
      await emit(d, req.me.workspaceId, 'jira:issue_updated', { issueId: i.id, projectId: i.projectId, type: 'issue_worklogged' }, req.me.id)   // as Jira's (spec 0715 R2)
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
      await emit(d, req.me.workspaceId, 'worklog_updated', { issueId: w.issueId, projectId: w.projectId, worklogId: w.id }, req.me.id)
      await emit(d, req.me.workspaceId, 'jira:worklog_updated', { issueId: w.issueId, projectId: w.projectId, worklogId: w.id, type: 'issue_worklog_updated' }, req.me.id)
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
      const [gone] = await d.query('delete from worklogs where id = $1 returning *', [w.id])
      await remaining(d, w.issueId, -w.minutes, adjustOf(req.query))
      await emit(d, req.me.workspaceId, 'worklog_deleted', { issueId: w.issueId, projectId: w.projectId, worklogId: w.id, entity: gone }, req.me.id)
      await emit(d, req.me.workspaceId, 'jira:worklog_updated', { issueId: w.issueId, projectId: w.projectId, worklogId: w.id, entity: gone, type: 'issue_worklog_deleted' }, req.me.id)
      if (w.userId !== req.me.id) await audit(d, req, { action: 'worklog.deleted', type: 'worklog', id: w.id, project: { id: w.projectId, key: w.projectKey }, before: { minutes: w.minutes, date: w.date, note: w.note, by: w.userId } })
    })
    reply.code(204).send()
  })
}

export default plugin
