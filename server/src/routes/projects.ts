import { randomUUID } from 'node:crypto'
import { recoveryPassword } from '../authConfig.ts'
import { globalPermissions, hasGlobal } from './globalPermissions.ts'
import { checkPriority } from '../lists.ts'
import { label, labels } from '../shared/labels.ts'
import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, requireAdmin, signedIn, type Me } from '../auth.ts'
import { ARCHIVED, READS, accessTo, levelOk, minFor, need, visible, type Permission, type ProjectRole } from '../access.ts'
import { publish, subscribe } from '../events.ts'
import { audit, changes } from '../audit.ts'
import { emit } from '../webhooks.ts'
import { enqueue, kickJobs } from '../jobs.ts'
import { backupBucket, backupSettings } from '../backups.ts'
import { applyScheme, previewing, typeWorkflows } from '../workflows.ts'
import { firstBoard, needSprintManager } from '../boards.ts'
import { checkRule, dryRun, scheduleRule } from '../rules.ts'
import { TEST_TYPES } from './issues.ts'
import { checkImport } from '../csvImport.ts'
import { getSetting } from '../settings.ts'
import { describeKeyRule, keyFits } from '../shared/projectKeys.ts'
import { EXTRA_TYPES, TEMPLATES, TEMPLATE_IDS } from '../shared/templates.ts'
import { KIND_LIST, type FieldKind } from '../shared/customFields.ts'
import { carryOptions, clearValues, rulesFor, screensFor, withOptionIds, type Opt } from '../fields.ts'

/** An automation action; a branch (spec 0709 R7) holds actions of its own, but no branch. */
const plainAction = z.object({ kind: z.enum(['assign', 'priority', 'label', 'status', 'comment']) }).passthrough()
export const ruleAction = z.union([
  z.object({ kind: z.literal('branch'), target: z.enum(['children', 'parent', 'linked']).describe('Sub-items or an epic’s items; the parent or epic; linked items'),
    linkType: z.string().max(100).nullable().optional().describe('Linked items: only this link type (its id)'), actions: z.array(plainAction).min(1).max(20) }),
  plainAction.refine(a => (a.kind as string) !== 'branch'),
])
const uuid = z.string().uuid()
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Project key (PAY) or id (uuid). A project I cannot see is "not found" (its existence is not revealed). `min` is the
 *  permission (spec 0201) or role the request needs; by default Browse projects to read, Edit issues to change. Returns my
 *  role in it. An archived project refuses every change (spec 0102) unless `archivedOk` (restoring it, deleting it, starring it). */
export async function projectByKey(d: Db, req: { me: Me; method: string }, ref: string, min?: ProjectRole | Permission, o: { archivedOk?: boolean } = {}) {
  const byId = UUID.test(ref)
  const [p] = await d.query<{ id: string; leadId: string | null; key: string }>(
    `select id, lead_id, key from projects where workspace_id = $1 and ${byId ? 'id = $2'
      : '(key = $2 or id = (select project_id from project_key_history where workspace_id = $1 and key = $2))'}`, [req.me.workspaceId, byId ? ref : ref.toUpperCase()])   // an old key too (spec 0703)
  const a = p ? await accessTo(d, req.me, p.id) : null
  if (!p || !a) throw new HttpError(404, 'Project not found')
  if (a.archived && !READS.has(req.method) && !o.archivedOk) throw new HttpError(403, ARCHIVED)
  need(a.role, min ?? minFor(req.method), p.key)
  return { ...p, role: a.role }
}

// ── A project's own fields (spec 0503 R5): project admins add a field for their project alone, and change or delete the
// fields used by it alone; a shared field (global, or several projects) is a system administrator's, in Administration ──
type ProjectRef = { id: string; key: string; role: ProjectRole }
async function ownField(d: Db, p: ProjectRef, id: string) {
  const [f] = await d.query<any>('select * from field_defs where id = $1 and project_id = $2', [id, p.id])
  if (!f) throw new HttpError(404, 'Not found')
  if (f.shared) throw new HttpError(403, `${f.name} is shared with other projects: a system administrator changes it in Administration › Custom fields`)
  return f
}
async function addProjectField(d: Db, req: any, p: ProjectRef, b: Record<string, any>) {
  const options = b.options ? withOptionIds(b.options as Opt[], b.kind) : null
  const [n] = await d.query<{ next: number }>('select coalesce(max(position), -1) + 1 as next from field_defs where project_id = $1', [p.id])
  const [f] = await d.query<{ id: string }>(
    `insert into custom_fields (id, workspace_id, name, kind, position, created_by) values (coalesce($1::uuid, uuid_v7()), $2, $3, $4, $5, $6) returning id`,
    [b.id ?? null, req.me.workspaceId, b.name, b.kind, b.position ?? n!.next, req.me.id])
  await d.query('insert into field_contexts (field_id, name, project_ids, options) values ($1, $2, $3, $4)', [f!.id, `Default context for ${b.name}`, [p.id], options ? JSON.stringify(options) : null])
  await audit(d, req, { action: 'project.custom_field.created', type: 'custom field', id: f!.id, name: b.name, project: p, after: { ...b, options } })
  return (await d.query('select * from field_defs where id = $1 and project_id = $2', [f!.id, p.id]))[0]
}
async function changeProjectField(d: Db, req: any, p: ProjectRef, id: string, patch: Record<string, any>) {
  const before = await ownField(d, p, id)
  // Jira: a custom field's type can't change once it is made (spec 0105 R1)
  if (patch.kind !== undefined && patch.kind !== before.kind) throw new HttpError(400, 'A field’s type can’t change. Make a new field of the type you need.', { kind: 'Fixed once made' })
  if (!['name', 'options', 'position'].some(k => patch[k] !== undefined)) throw new HttpError(400, 'Nothing to update')
  if (patch.name !== undefined || patch.position !== undefined)
    await d.query('update custom_fields set name = coalesce($2, name), position = coalesce($3, position) where id = $1', [id, patch.name ?? null, patch.position ?? null])
  if (patch.options !== undefined) {
    const options = patch.options ? withOptionIds(patch.options as Opt[], before.kind) : null
    await d.query('update field_contexts set options = $2 where id = $1', [before.contextId, options ? JSON.stringify(options) : null])
    // renamed and deleted options carry through to every item that has them, as in Jira (spec 0105 R3, R5)
    await carryOptions(d, before.contextId, id, before.kind, before.options ?? [], options ?? [])
  }
  const c = changes(before, patch)
  if (c.changed) await audit(d, req, { action: 'project.custom_field.updated', type: 'custom field', id, name: patch.name ?? before.name, project: p, before: c.before, after: c.after })
  return (await d.query('select * from field_defs where id = $1 and project_id = $2', [id, p.id]))[0]
}
async function deleteProjectField(d: Db, req: any, p: ProjectRef, id: string) {
  const gone = await ownField(d, p, id)
  await d.query('delete from custom_fields where id = $1', [id])
  // a deleted custom field takes its values with it, so no item keeps a value for a field that no longer exists
  await clearValues(d, id, [p.id])
  await audit(d, req, { action: 'project.custom_field.deleted', type: 'custom field', id, name: gone.name, project: p, before: gone })
}

/** Project settings (workflow, fields, rules, people…) are for project admins. */
async function requireProjectAdmin(_req: FastifyRequest, p: { role: ProjectRole; key?: string }) { need(p.role, 'administer', p.key) }

// Child collections of a project. `json` columns are stored as jsonb. (Statuses and transitions come from the project's
// workflow scheme: system administrators change them, in Administration.)
const CHILD = {
  fields:      { table: 'field_defs',     cols: ['name', 'kind', 'options', 'position'], json: ['options'] },
  templates:   { table: 'item_templates', cols: ['name', 'type', 'title', 'description', 'priority', 'labels', 'estimate'] },
  rules:       { table: 'rules',          cols: ['name', 'enabled', 'trigger', 'actions', 'condition'], json: ['trigger', 'actions'] },
  releases:    { table: 'releases',       cols: ['name', 'description', 'startDate', 'releaseDate', 'archived', 'released'], ws: true },
  components:  { table: 'components',     cols: ['name', 'description', 'leadId', 'defaultAssignee'] },
} as const
type Kind = keyof typeof CHILD

const childPatch = {
  fields: z.object({ name: z.string().min(1), kind: z.enum(KIND_LIST as [FieldKind, ...FieldKind[]]).describe('Jira’s custom field types (spec 0502); fixed once the field is made'),
    options: z.array(z.object({ id: z.string().min(1).max(64).optional().describe('Kept when renamed; leave out for a new option'), name: z.string().trim().min(1).max(100), disabled: z.boolean().optional().describe('No longer offered; items keep it'),
      parentId: z.string().min(1).max(64).nullable().optional().describe('Cascading fields: the option this one is under') })).max(1000).nullable()
      .describe('The options of a select, radio, multiple choice, checkboxes or cascading field, in order. In a PATCH: one left out is deleted (its value goes from every item); a new name for an id renames it on every item'),
    position: z.number().int() }).partial(),
  templates: z.object({
    name: z.string().min(1), type: z.string().min(1).max(40), title: z.string(), description: z.string(),
    priority: z.string().min(1).max(40), labels, estimate: z.number().nullable(),
  }).partial(),
  rules: z.object({
    name: z.string().min(1), enabled: z.boolean(),
    trigger: z.object({ kind: z.enum(['created', 'status', 'assigned', 'scheduled']), to: uuid.optional(),
      everyMinutes: z.number().int().min(1).max(525_600).optional().describe('Scheduled: how often, in minutes (spec 0709)'),
      jql: z.string().trim().max(2000).optional().describe('Scheduled: the work items it acts on'),
      changedSinceLastRun: z.boolean().optional().describe('Scheduled: only items changed since its last run') }),
    condition: z.string().trim().max(2000).nullable().describe('JQL the item must match for the rule to act (spec 0709)'),
    actions: z.array(ruleAction.refine(a => a.kind !== 'label' || String(a.value).includes('{{') || label.safeParse(a.value).success, 'A label is one word: no spaces')),
  }).partial(),
  releases: z.object({ name: z.string().min(1), description: z.string(), startDate: z.string().nullable(), releaseDate: z.string().nullable(),
    archived: z.boolean().describe('Hidden from pickers and the Releases view; items keep it (spec 0304)'), released: z.literal(false).describe('Unrelease it (release it with POST …/release)') }).partial(),
  components: z.object({
    name: z.string().trim().min(1).max(100), description: z.string().max(2000), leadId: uuid.nullable(),
    defaultAssignee: z.enum(['none', 'component_lead', 'project_lead']).describe('Who new work in this component goes to when nobody is chosen'),
  }).partial(),
}
const REQUIRED: Record<Kind, string[]> = {
  fields: ['name', 'kind'],
  templates: ['name', 'type', 'title'], rules: ['name', 'trigger', 'actions'], releases: ['name'], components: ['name'],
}
// Create = the same shape with the required keys enforced
const childCreate = Object.fromEntries((Object.keys(childPatch) as Kind[]).map(k =>
  [k, (childPatch[k] as z.ZodObject<any>).required(Object.fromEntries(REQUIRED[k].map(r => [r, true])) as any)
    .extend({ id: uuid.optional().describe('Client-chosen id') })])) as unknown as typeof childPatch

const projectBody = z.object({
  name: z.string().min(1).max(120), description: z.string(), color, leadId: uuid.nullable(),
  key: z.string().trim().min(2).max(255).transform(k => k.toUpperCase()).describe('A new key (system administrators): its items take it, the old one still finds them (spec 0703)'),
  categoryId: uuid.nullable().describe('Its project category (system administrators), or null for none (spec 0703)'),
  fieldConfigSchemeId: uuid.nullable().describe('Its field configuration scheme (system administrators), or null for the Default Field Configuration (spec 0504)'),
  issueTypeScreenSchemeId: uuid.nullable().describe('Its issue type screen scheme (system administrators), or null for the Default Screen Scheme (spec 0505)'),
  boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
}).partial()

const keyP = z.object({ key: z.string().describe('Project key (PAY) or id (uuid)') })
const keyIdP = keyP.extend({ id: uuid })

/** An item's value in its sprint's estimation statistic (spec 0404), as SQL over `i` (an issue) inside an update of
 *  `sprints`: story points, minutes of original estimate, or one per item. */
const STAT = `case coalesce(sprints.estimation, (select estimation from boards where id = sprints.board_id), 'points') when 'time' then i.time_estimate when 'count' then 1
  when 'field' then (select case when jsonb_typeof(i.custom -> f.id::text) = 'number' then (i.custom ->> f.id::text)::numeric end
                       from custom_fields f where f.id = coalesce(sprints.estimation_field_id, (select estimation_field_id from boards where id = sprints.board_id)))
  else i.estimate end`

/** Spec 0414: without parallel sprints a board has one active sprint. Checked under a lock on the board. */
async function checkParallel(d: Db, ws: string, boardId: string | null, doing: string) {
  if (!boardId) return
  await d.query('select 1 from boards where id = $1 for update', [boardId])
  if ((await getSetting(ws, 'sprints')).parallel) return
  const [active] = await d.query<{ name: string }>(`select name from sprints where board_id = $1 and state = 'active'`, [boardId])
  if (active) throw new HttpError(409, `${active.name} is active on this board: complete it before ${doing} another sprint, or turn on parallel sprints (System settings › Sprints)`)
}

/** The statuses of a board's rightmost column that has any: what "completed" means for its sprints (Jira's; spec 0401). */
async function doneColumnOf(d: Db, boardId: string | null) {
  const [b] = boardId ? await d.query<{ columns: { statusIds: string[] }[] }>('select columns from boards where id = $1', [boardId]) : []
  return (b && [...b.columns].reverse().find(c => c.statusIds.length)?.statusIds) ?? null
}

/** Templates and automation rules name priorities of the list (spec 0305). */
async function checkPriorities(ws: string, kind: string, body: Record<string, any>) {
  if (kind === 'templates') await checkPriority(db, ws, body.priority)
  if (kind === 'rules') for (const a of (body.actions ?? []) as { kind: string; value?: string }[]) if (a.kind === 'priority') await checkPriority(db, ws, a.value ?? '', 'actions')
}

/** One of the project's versions that work may move to: not archived and not `not` (spec 0304). */
async function usableRelease(d: Db, projectId: string, id: string, not: string | null, field: string) {
  const [r] = await d.query<{ id: string; name: string; archived: boolean }>('select id, name, archived from releases where id = $1 and project_id = $2', [id, projectId])
  if (!r || id === not) throw new HttpError(400, 'Move the work to another of this project’s versions', { [field]: 'Unknown version' })
  if (r.archived) throw new HttpError(400, `Version ${r.name} is archived`, { [field]: 'Archived' })
  return r
}

/** Items of the project with `from` in the list column `col` get `to` in its place (once, keeping the order), or lose it. */
async function replaceIn(d: Db, projectId: string, col: 'fix_release_ids' | 'affects_release_ids' | 'component_ids', from: string, to: string | null) {
  await d.query(
    `update issues set ${col} = array(select x from unnest(array_remove(array_replace(${col}, $2::uuid, $3::uuid), null)) with ordinality u(x, n) group by x order by min(n)),
            version = version + 1, updated_at = now()
      where project_id = $1 and ${col} @> array[$2::uuid]`, [projectId, from, to])
}
const T = { me: ['Account'], projects: ['Projects'], config: ['Project settings'], sprints: ['Sprints'] }

const plugin: FastifyPluginAsyncZod = async app => {
  // A sign-in: the app calls this once when it starts. Puts the person back in users-access (and, with Entra's Strand.Admin
  // role, system-administrators) and records the time. Scripts' tokens aren't sign-ins.
  app.post('/me/sign-in', { schema: { tags: T.me, summary: 'Record a sign-in (the web app calls this when it starts): rejoins the default group, and system-administrators with Entra’s Strand.Admin role' } }, async (req, reply) => {
    if (req.me.via === 'pat') throw new HttpError(400, 'A personal access token isn’t a sign-in')
    await tx(d => signedIn(d, req.me))
    reply.code(204).send()
  })
  app.get('/me', { schema: { tags: T.me, summary: 'Current user and role' } }, async req => ({
    ...req.me, groupIds: (await db.query<{ groupId: string }>('select group_id from group_members where user_id = $1', [req.me.id])).map(g => g.groupId),
    globalPermissions: await globalPermissions(req.me),                 // spec 0717
    recovery: req.me.admin && !!recoveryPassword(),          // admins see a banner while recovery mode is on (spec 0711 R10)
    // where their password lives (spec 0714): Settings › Password shows for the internal directory's people who have one
    ...(await db.query<{ hasPassword: boolean; directory: string | null }>(
      'select password_hash is not null as has_password, (select name from user_directories where id = directory_id) as directory from users where id = $1', [req.me.id]))[0],
  }))

  const searchQ = z.object({
    query: z.string().max(100).optional().describe('Matches anywhere in the name (and e-mail, for users); case-insensitive'),
    cursor: z.string().optional().describe('`next` from the previous page'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  const like = (q: string) => '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
  const cursorOf = (name: string, id: string) => Buffer.from(JSON.stringify([name, id])).toString('base64url')
  const readCursor = (c?: string): [string, string] | null => {
    if (!c) return null
    try { const [n, i] = JSON.parse(Buffer.from(c, 'base64url').toString()); if (typeof n === 'string' && UUID.test(i)) return [n, i] } catch { /* fall through */ }
    throw new HttpError(400, 'Invalid cursor')
  }

  // First 1000 only: use /users/search to find anyone else. (The app's people picker should move to the search.)
  // The app asks for the people it shows by id (`ids`), so a name is never missing; without ids, the first 1000 by name
  // (use /users/search to find anyone).
  app.get('/users', { schema: { tags: T.me, summary: 'People in the workspace: those named in `ids` (also deactivated ones, so old work keeps its names), or the first 1000 active people by name',
    querystring: z.object({ ids: z.string().max(200 * 37).optional().describe('Comma-separated user ids, up to 200') }) } }, async req => {
    const ids = req.query.ids ? req.query.ids.split(',').filter(x => UUID.test(x)).slice(0, 200) : null
    // without Browse users and groups (spec 0717): the people who share a project with me, and me
    const browse = ids || await hasGlobal(req.me, 'browse-users')
    return db.query(
      `select u.id, u.name, u.initials, u.color, u.title, u.email, m.role from users u
       join memberships m on m.user_id = u.id and m.workspace_id = $1 where ${ids ? 'u.id = any($2::uuid[])' : 'u.active'}
       ${browse ? '' : `and (u.id = $2 or exists (select 1 from project_access mine join project_access theirs on theirs.project_id = mine.project_id where mine.user_id = $2 and theirs.user_id = u.id))`}
       order by lower(u.name), u.id limit 1000`,
      ids ? [req.me.workspaceId, ids] : [req.me.workspaceId, ...(browse ? [] : [req.me.id])])
  })

  app.get('/users/search', { schema: { tags: T.me, summary: 'Find users by name or e-mail, in name order (keyset-paginated). With `project`, only people who can work in that project', querystring: searchQ.extend({ project: z.string().optional().describe('Project key or id: only its members (and workspace admins)') }) } }, async req => {
    const { query, limit } = req.query, cur = readCursor(req.query.cursor)
    const args: unknown[] = [req.me.workspaceId]
    const where = ['u.active']
    if (req.query.project) {
      const p = await projectByKey(db, req, req.query.project, 'viewer')
      args.push(p.id)
      where.push(`(is_system_admin(u.id) or exists (select 1 from project_access pa where pa.project_id = $${args.length} and pa.user_id = u.id))`)
    }
    // a project's people are its pickers' (Jira's Assignable and Browse project); anyone else only by exact email without
    // Browse users and groups (spec 0717)
    if (!req.query.project && !(await hasGlobal(req.me, 'browse-users'))) { args.push(query ?? ''); where.push(`lower(u.email) = lower($${args.length})`) }
    else if (query) { args.push(like(query)); where.push(`(u.name ilike $${args.length} or u.email ilike $${args.length})`) }
    if (cur) { args.push(cur[0].toLowerCase(), cur[1]); where.push(`(lower(u.name), u.id) > ($${args.length - 1}, $${args.length}::uuid)`) }
    args.push(limit + 1)
    const rows = await db.query<any>(
      `select u.id, u.name, u.initials, u.color, u.title, u.email, m.role from users u
         join memberships m on m.user_id = u.id and m.workspace_id = $1 where ${where.join(' and ')} order by lower(u.name), u.id limit $${args.length}`, args)
    const more = rows.length > limit, items = more ? rows.slice(0, limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).name, items.at(-1).id) : null }
  })

  /** A project as lists show it; `$2` is me: its open count leaves out items behind a security level I'm not in. */
  const PROJECT_ROW = (me: Me) => `p.id, p.key, p.name, p.description, p.color, p.template, p.lead_id, p.created_at, p.archived_at,
              p.category_id, (select jsonb_build_object('id', c.id, 'name', c.name) from project_categories c where c.id = p.category_id) as category,
              case when p.avatar_hash is not null then '/project-avatars/' || p.id || '/' || p.avatar_hash end as avatar,
            (s.user_id is not null) as starred,
            (select count(*) from issues i join statuses st on st.id = i.status_id
              where i.project_id = p.id and i.deleted_at is null and i.archived_at is null and st.category <> 'done' and ${levelOk(me, 2)}) as open_count`
  // First 1000 only: use /projects/search for more. Archived projects are hidden unless asked for.
  app.get('/projects', { schema: { tags: T.projects, summary: 'List the active projects I can see, with star flag and open-issue count (first 1000 by name; use /projects/search for more)' } }, async req => {
    const args: unknown[] = [req.me.workspaceId, req.me.id]
    const see = visible(req.me, 'p.id', args)
    return db.query(
      `select ${PROJECT_ROW(req.me)} from projects p left join stars s on s.project_id = p.id and s.user_id = $2
        where p.workspace_id = $1 and p.archived_at is null and ${see} order by lower(p.name), p.id limit 1000`, args)
  })

  app.get('/projects/search', { schema: {
    tags: T.projects, summary: 'Find projects by name or key, in name order (keyset-paginated)',
    querystring: searchQ.extend({ starred: z.enum(['0', '1']).optional().describe('1 = only my starred projects'), category: z.string().max(40).optional().describe('A category id, or `none` (spec 0703)') }),
  } }, async req => {
    const { query, limit } = req.query, cur = readCursor(req.query.cursor)
    const args: unknown[] = [req.me.workspaceId, req.me.id]
    const where = ['p.workspace_id = $1', 'p.archived_at is null', visible(req.me, 'p.id', args)]
    if (query) { args.push(like(query)); where.push(`(p.name ilike $${args.length} or p.key ilike $${args.length})`) }
    if (req.query.starred === '1') where.push('s.user_id is not null')
    if (req.query.category === 'none') where.push('p.category_id is null')
    else if (req.query.category) { if (!/^[0-9a-f-]{36}$/i.test(req.query.category)) throw new HttpError(400, 'Invalid category'); args.push(req.query.category); where.push(`p.category_id = $${args.length}::uuid`) }
    if (cur) { args.push(cur[0].toLowerCase(), cur[1]); where.push(`(lower(p.name), p.id) > ($${args.length - 1}, $${args.length}::uuid)`) }
    args.push(limit + 1)
    const rows = await db.query<any>(
      `select ${PROJECT_ROW(req.me)} from projects p left join stars s on s.project_id = p.id and s.user_id = $2
        where ${where.join(' and ')} order by lower(p.name), p.id limit $${args.length}`, args)
    const more = rows.length > limit, items = more ? rows.slice(0, limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).name, items.at(-1).id) : null }
  })

  // Archiving (spec 0102, as in Jira): global admins only. An archived project is read-only for everyone and hidden from
  // lists, search and boards; its items still open by their key. Restoring brings it back as it was.
  app.post('/projects/:key/archive', { schema: { tags: T.projects, summary: 'Archive a project (global admins): read-only and hidden, data kept, can be restored', params: keyP } }, async req => {
    requireAdmin(req)
    const p = await projectByKey(db, req, req.params.key, 'viewer', { archivedOk: true })
    await tx(async d => {
      const [r] = await d.query('update projects set archived_at = now(), archived_by = $2 where id = $1 and archived_at is null returning id', [p.id, req.me.id])
      if (r) await audit(d, req, { action: 'project.archived', type: 'project', id: p.id, name: p.key, project: p })
    })
    return projectDetail(db, req.me.workspaceId, p.key, 'viewer')
  })
  app.post('/projects/:key/restore', { schema: { tags: T.projects, summary: 'Restore an archived project (global admins)', params: keyP } }, async req => {
    requireAdmin(req)
    const p = await projectByKey(db, req, req.params.key, 'viewer', { archivedOk: true })
    await tx(async d => {
      const [r] = await d.query('update projects set archived_at = null, archived_by = null where id = $1 and archived_at is not null returning id', [p.id])
      if (r) await audit(d, req, { action: 'project.restored', type: 'project', id: p.id, name: p.key, project: p })
    })
    return projectDetail(db, req.me.workspaceId, p.key, 'admin')
  })
  app.get('/admin/archived-projects', { schema: { tags: T.projects, summary: 'Archived projects, newest archived first, a page at a time (global admins)',
    querystring: z.object({ query: z.string().max(200).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) } }, async req => {
    requireAdmin(req)
    const { query, limit } = req.query
    const args: unknown[] = [req.me.workspaceId]
    const where = ['p.workspace_id = $1', 'p.archived_at is not null', 'p.deleting_at is null']
    if (query) { args.push(like(query)); where.push(`(p.name ilike $${args.length} or p.key ilike $${args.length})`) }
    if (req.query.cursor) {
      const [at, id] = Buffer.from(req.query.cursor, 'base64url').toString().split('|')
      if (!id || Number.isNaN(Date.parse(at!))) throw new HttpError(400, 'Invalid cursor')
      args.push(at, id); where.push(`(p.archived_at, p.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`)
    }
    args.push(limit + 1)
    const rows = await db.query<any>(
      `select p.id, p.key, p.name, p.archived_at, u.name as archived_by from projects p left join users u on u.id = p.archived_by
        where ${where.join(' and ')} order by p.archived_at desc, p.id desc limit $${args.length}`, args)
    const more = rows.length > limit, items = more ? rows.slice(0, limit) : rows
    const last = items.at(-1)
    return { items, next: more && last ? Buffer.from(`${new Date(last.archivedAt).toISOString()}|${last.id}`).toString('base64url') : null }
  })

  const createProject = projectBody.required({ name: true }).extend({
    key: z.string().trim().min(1).max(255).transform(k => k.toUpperCase()).describe('Checked against System settings › Project keys (Jira’s default: two or more capital letters, at most 10)'), template: z.enum(TEMPLATE_IDS).describe('Software: kanban, scrum, basic; business: task, project, process (spec 0310)'),
    workflowSchemeId: uuid.optional().describe('Its workflow scheme (Administration › Workflows); by default the one named after the template'),
  })
  app.post('/projects', { schema: { tags: T.projects, summary: 'Create a project, with the workflows of a workflow scheme', body: createProject } }, async req => {
    const b = req.body
    // the key follows System settings › Project keys (Jira's project key pattern and maximum size, spec 0308 R2)
    const rule = await getSetting(req.me.workspaceId, 'projectKeys')
    if (!keyFits(b.key, rule))
      throw new HttpError(400, `A project key must match ${rule.pattern} and be at most ${rule.maxLength} characters`, { key: describeKeyRule(rule) })
    return tx(async d => {
      // a key another project had is still its (spec 0703 R1, Jira's rule)
      if ((await d.query('select 1 from project_key_history where workspace_id = $1 and key = $2', [req.me.workspaceId, b.key])).length)
        throw new HttpError(409, `${b.key} was another project’s key`, { key: 'Already used' })
      const [sc] = await d.query<{ id: string }>(`select id from workflow_schemes where workspace_id = $1 and ${b.workflowSchemeId ? 'id = $2' : 'lower(name) = $2'}`,
        [req.me.workspaceId, b.workflowSchemeId ?? TEMPLATES[b.template].scheme.toLowerCase()])
      if (!sc) throw new HttpError(400, 'Choose a workflow scheme', { workflowSchemeId: 'Not found' })
      const [p] = await d.query<{ id: string }>(
        `insert into projects (workspace_id, key, name, description, color, template, lead_id, workflow_scheme_id)
         values ($1, $2, $3, $4, coalesce($5, '#6366f1'), $6, $7, $8) returning id`,
        [req.me.workspaceId, b.key, b.name, b.description ?? '', b.color ?? null, b.template, b.leadId ?? req.me.id, sc.id])
        // a key belongs to one project, also one this person can't see: say so instead of "already exists"
        .catch(e => { if (e?.code === '23505' && e.constraint !== 'projects_name_unique') throw new HttpError(409, `${b.key} is already used by another project`, { key: 'Already used' }); throw e })
      // The creator administers the project from the start (and so does the lead, if that is someone else)
      for (const u of new Set([req.me.id, b.leadId ?? req.me.id]))
        await d.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, 'admin', $3) on conflict do nothing`, [p!.id, u, req.me.id])
      await audit(d, req, { action: 'project.created', type: 'project', id: p!.id, name: b.key, project: { id: p!.id, key: b.key }, after: { name: b.name, template: b.template, workflowSchemeId: sc.id } })
      // the template's work types (spec 0310): Strand's four are seeded; others go, Basic's extra ones come
      const tpl = TEMPLATES[b.template]
      await d.query('delete from work_types where project_id = $1 and not (key = any($2::text[]))', [p!.id, tpl.types])
      for (const [i, k] of tpl.types.entries()) if (EXTRA_TYPES[k])
        await d.query('insert into work_types (project_id, key, name, color, icon, position) values ($1, $2, $3, $4, $5, $6) on conflict do nothing', [p!.id, k, EXTRA_TYPES[k].name, EXTRA_TYPES[k].color, EXTRA_TYPES[k].icon, i])
      await applyScheme(d, req, p!.id)
      await firstBoard(d, { id: p!.id, workspaceId: req.me.workspaceId, key: b.key, template: tpl.board }, req.me.id)
      return projectDetail(d, req.me.workspaceId, b.key, 'admin')
    })
  })

  app.get('/projects/:key', { schema: { tags: T.projects, summary: 'Project with workflow, fields, releases, templates, rules and sprints, and my role in it', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return projectDetail(db, req.me.workspaceId, p.key, p.role)
  })

  app.patch('/projects/:key', { schema: { tags: T.projects, summary: 'Update project details', params: keyP, body: projectBody } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    const b = req.body
    // the key and the category: system administrators (spec 0703 R1, R5); other details never touch the category (R7)
    if ((b.key !== undefined && b.key !== p.key) || b.categoryId !== undefined || b.fieldConfigSchemeId !== undefined || b.issueTypeScreenSchemeId !== undefined) {
      requireAdmin(req)
      await tx(async d => {
        const [before] = await d.query<{ key: string; categoryId: string | null; schemeId: string | null; itsId: string | null }>('select key, category_id, field_config_scheme_id as scheme_id, issue_type_screen_scheme_id as its_id from projects where id = $1 for update', [p.id])
        if (b.issueTypeScreenSchemeId !== undefined && b.issueTypeScreenSchemeId !== before!.itsId) {
          if (b.issueTypeScreenSchemeId && !(await d.query('select 1 from issue_type_screen_schemes where id = $1 and workspace_id = $2', [b.issueTypeScreenSchemeId, req.me.workspaceId])).length)
            throw new HttpError(400, 'No such issue type screen scheme', { issueTypeScreenSchemeId: 'Unknown scheme' })
          await d.query('update projects set issue_type_screen_scheme_id = $2 where id = $1', [p.id, b.issueTypeScreenSchemeId])
          await audit(d, req, { action: 'project.screen_scheme_changed', type: 'project', id: p.id, name: before!.key, project: p, before: { issueTypeScreenSchemeId: before!.itsId }, after: { issueTypeScreenSchemeId: b.issueTypeScreenSchemeId } })
        }
        if (b.fieldConfigSchemeId !== undefined && b.fieldConfigSchemeId !== before!.schemeId) {
          if (b.fieldConfigSchemeId && !(await d.query('select 1 from field_config_schemes where id = $1 and workspace_id = $2', [b.fieldConfigSchemeId, req.me.workspaceId])).length)
            throw new HttpError(400, 'No such field configuration scheme', { fieldConfigSchemeId: 'Unknown scheme' })
          await d.query('update projects set field_config_scheme_id = $2 where id = $1', [p.id, b.fieldConfigSchemeId])
          await audit(d, req, { action: 'project.field_config_scheme_changed', type: 'project', id: p.id, name: before!.key, project: p, before: { fieldConfigSchemeId: before!.schemeId }, after: { fieldConfigSchemeId: b.fieldConfigSchemeId } })
        }
        if (b.categoryId !== undefined && b.categoryId !== before!.categoryId) {
          if (b.categoryId && !(await d.query('select 1 from project_categories where id = $1 and workspace_id = $2', [b.categoryId, req.me.workspaceId])).length)
            throw new HttpError(400, 'No such category', { categoryId: 'Unknown category' })
          await d.query('update projects set category_id = $2 where id = $1', [p.id, b.categoryId])
          await audit(d, req, { action: 'project.category_changed', type: 'project', id: p.id, name: before!.key, project: p, before: { categoryId: before!.categoryId }, after: { categoryId: b.categoryId } })
        }
        if (b.key !== undefined && b.key !== before!.key) {
          const rule = await getSetting(req.me.workspaceId, 'projectKeys', d)
          if (!keyFits(b.key, rule)) throw new HttpError(400, `The key must be ${describeKeyRule(rule)}`, { key: 'Doesn’t fit the key pattern' })
          const [taken] = await d.query<{ key: string }>(
            `select key from projects where workspace_id = $1 and key = $2 union all
             select key from project_key_history where workspace_id = $1 and key = $2 and project_id <> $3`, [req.me.workspaceId, b.key, p.id])
          if (taken) throw new HttpError(409, `${b.key} is or was another project’s key`, { key: 'Already used' })
          // its own earlier key comes back as its key; the key it leaves keeps finding it
          await d.query('delete from project_key_history where workspace_id = $1 and key = $2', [req.me.workspaceId, b.key])
          await d.query('insert into project_key_history (workspace_id, key, project_id, changed_by) values ($1, $2, $3, $4)', [req.me.workspaceId, before!.key, p.id, req.me.id])
          await d.query('update projects set key = $2 where id = $1', [p.id, b.key])
          await audit(d, req, { action: 'project.key_changed', type: 'project', id: p.id, name: b.key, project: { id: p.id, key: b.key }, before: { key: before!.key }, after: { key: b.key } })
        }
      })
      p.key = b.key ?? p.key
    }
    const w = pick(req.body, ['name', 'description', 'color', 'leadId', 'boardPrefs', 'layout'], ['boardPrefs', 'layout'])
    if (w.keys.length) await tx(async d => {
      const [before] = await d.query<Record<string, unknown>>('select name, description, color, lead_id from projects where id = $1 for update', [p.id])
      await d.query(`update projects set ${w.cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [p.id, ...w.vals])
      // board preferences and diagram layout are presentation, not settings: not audited
      const c = changes(before!, Object.fromEntries(['name', 'description', 'color', 'leadId'].filter(k => k in req.body).map(k => [k, (req.body as any)[k]])))
      if (c.changed) await audit(d, req, { action: 'project.updated', type: 'project', id: p.id, name: p.key, project: p, before: c.before, after: c.after })
    })
    return projectDetail(db, req.me.workspaceId, p.key, p.role)
  })

  // Deleting a project backs it up first (when the workspace has backups on), in the background. Meanwhile the project is
  // "being deleted": hidden from everyone and closed to changes.
  app.delete('/projects/:key', { schema: { tags: T.projects, summary: 'Delete a project (global admins). Backs it up first when backups are on; answers 202 with the job to follow', params: keyP,
    response: { 202: z.object({ jobId: z.string().uuid().describe('Follow it at GET /jobs/{id}') }) } } }, async (req, reply) => {
    requireAdmin(req)
    const p = await projectByKey(db, req, req.params.key, 'viewer', { archivedOk: true })   // an archived project can be deleted too
    const jobId = await tx(async d => {
      const settings = await backupSettings(d, req.me.workspaceId)
      if (settings.enabled && !backupBucket(settings))
        throw new HttpError(409, 'Project backups are on, but no storage is set for them. Choose a bucket, or turn backups off, in Administration.')
      const [marked] = await d.query('update projects set deleting_at = now() where id = $1 and deleting_at is null returning id', [p.id])
      if (!marked) throw new HttpError(404, 'Project not found')
      await audit(d, req, { action: 'project.delete_requested', type: 'project', id: p.id, name: p.key, project: p, after: { backup: settings.enabled } })
      return enqueue(d, 'project.delete', { projectId: p.id, actorId: req.me.id, actorEmail: req.me.email, ip: req.ip },
        { workspaceId: req.me.workspaceId, createdBy: req.me.id, dedupeKey: `project.delete:${p.id}`, maxAttempts: 10 })
    })
    kickJobs(app.log)
    reply.code(202)
    return { jobId }
  })

  app.put('/projects/:key/star', { schema: { tags: T.projects, summary: 'Star a project', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key, 'viewer', { archivedOk: true })
    await db.query('insert into stars (user_id, project_id) values ($1, $2) on conflict do nothing', [req.me.id, p.id])
    reply.code(204).send()
  })
  app.delete('/projects/:key/star', { schema: { tags: T.projects, summary: 'Unstar a project', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key, 'viewer', { archivedOk: true })
    await db.query('delete from stars where user_id = $1 and project_id = $2', [req.me.id, p.id])
    reply.code(204).send()
  })

  // Realtime stream of changes in a project (Server-Sent Events)
  app.get('/projects/:key/events', { schema: { tags: T.projects, summary: 'Live change stream (Server-Sent Events)', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    reply.hijack()
    subscribe(p.id, reply, req.me.id)
  })

  // How many live items have each option of a select field: what deleting one would clear (spec 0105 R5)
  app.get('/projects/:key/fields/:id/usage', { schema: { tags: T.config, summary: 'How many work items have each option of a select field (by option id)', params: keyIdP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [f] = await db.query<{ options: Opt[] | null; kind: string }>('select options, kind from field_defs where id = $1 and project_id = $2', [req.params.id, p.id])
    if (!f) throw new HttpError(404, 'Not found')
    // every value counts, in multiple-value fields too; a cascading pair counts its option and its child option (spec 0502)
    const rows = await db.query<{ name: string; at: number; n: number }>(
      `select e.name, e.at, count(*)::int as n from issues i,
              jsonb_array_elements_text(case jsonb_typeof(i.custom -> $2) when 'array' then i.custom -> $2 else jsonb_build_array(i.custom -> $2) end) with ordinality e(name, at)
        where i.project_id = $1 and i.deleted_at is null and i.custom ? $2 group by 1, 2`, [p.id, req.params.id])
    const count = (o: Opt) => rows.filter(r => r.name === o.name && (o.parentId ? r.at === 2 : r.at === 1 || f.kind !== 'cascading')).reduce((n, r) => n + r.n, 0)
    return { options: Object.fromEntries((f.options ?? []).map(o => [o.id!, count(o)])) }
  })

  // ── Child collections: POST/PATCH/DELETE /projects/:key/<kind>[/:id] ──
  for (const kind of Object.keys(CHILD) as Kind[]) {
    const cfg = CHILD[kind] as { table: string; cols: readonly string[]; json?: readonly string[]; ws?: boolean }
    const json = [...(cfg.json ?? [])]

    const what = kind === 'fields' ? 'custom field' : kind.replace(/s$/, '')
    app.post(`/projects/:key/${kind}`, { schema: { tags: T.config, summary: `Add a ${what}`, params: keyP, body: childCreate[kind] } }, async req => {
      const p = await projectByKey(db, req, req.params.key)
      await requireProjectAdmin(req, p)
      const body = req.body as Record<string, unknown>
      if (kind === 'fields') return tx(d => addProjectField(d, req, p, body))
      await checkPriorities(req.me.workspaceId, kind, body)
      if (kind === 'rules') await checkRule(db, req.me, body)
      const w = pick(body, [...cfg.cols], json)
      // Ordered collections (statuses, fields) go to the end unless the caller says where
      if ((cfg.cols as readonly string[]).includes('position') && body.position === undefined) {
        const [n] = await db.query<{ next: number }>(`select coalesce(max(position), -1) + 1 as next from ${cfg.table} where project_id = $1`, [p.id])
        w.cols.push('position'); w.vals.push(n!.next)
      }
      const extra = [...(cfg.ws ? ['workspace_id'] : []), ...(kind === 'rules' ? ['owner_id'] : [])]
      const cid = typeof body.id === 'string' ? ['id'] : []
      const cols = ['project_id', ...extra, ...cid, ...w.cols]
      const vals = [p.id, ...(cfg.ws ? [req.me.workspaceId] : []), ...(kind === 'rules' ? [req.me.id] : []), ...(cid.length ? [body.id] : []), ...w.vals]
      return tx(async d => {
        const [row] = await d.query(
          `insert into ${cfg.table} (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, vals)
        await audit(d, req, { action: `project.${what.replace(' ', '_')}.created`, type: what, id: row.id, name: row.name ?? null, project: p, after: body })
        if (kind === 'rules') await scheduleRule(d, row, req.me.workspaceId)
        return row
      })
    })

    app.patch(`/projects/:key/${kind}/:id`, { schema: { tags: T.config, summary: `Update a ${what}`, params: keyIdP, body: childPatch[kind] } }, async req => {
      const p = await projectByKey(db, req, req.params.key)
      await requireProjectAdmin(req, p)
      const patch = req.body as Record<string, unknown>
      if (kind === 'fields') return tx(d => changeProjectField(d, req, p, req.params.id, patch))
      await checkPriorities(req.me.workspaceId, kind, patch)
      if (kind === 'rules') await checkRule(db, req.me, patch)
      const w = pick(patch, [...cfg.cols], json)
      if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
      return tx(async d => {
        const [before] = await d.query(`select * from ${cfg.table} where id = $1 and project_id = $2 for update`, [req.params.id, p.id])
        if (!before) throw new HttpError(404, 'Not found')
        // Jira: an archived version can't be changed until it is unarchived (spec 0304 R4)
        if (kind === 'releases' && before.archived && patch.archived !== false) throw new HttpError(400, `Version ${before.name} is archived`)
        const [row] = await d.query(   // unreleasing (Jira's Unrelease) clears the release date it was given
          `update ${cfg.table} set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${kind === 'releases' && patch.released === false ? ', released_at = null' : ''} where id = $1 and project_id = $2 returning *`,
          [req.params.id, p.id, ...w.vals])
        const c = changes(before, req.body as Record<string, unknown>)
        if (c.changed) await audit(d, req, { action: `project.${what.replace(' ', '_')}.updated`, type: what, id: row.id, name: row.name ?? null, project: p, before: c.before, after: c.after })
        if (kind === 'rules' && (patch.trigger !== undefined || patch.enabled !== undefined)) await scheduleRule(d, row, req.me.workspaceId)
        return row
      })
    })

    app.delete(`/projects/:key/${kind}/:id`, { schema: {
      tags: T.config, summary: `Remove a ${what}`, params: keyIdP,
      querystring: z.object({
        fixTo: uuid.optional().describe('Releases: the version that replaces it in items’ fix versions (default: removed from them)'),
        affectsTo: uuid.optional().describe('Releases: the version that replaces it in items’ affects versions (default: removed from them)'),
        moveTo: uuid.optional().describe('Components: the component that replaces it on items (default: removed from them)'),
      }),
    } }, async (req, reply) => {
      const p = await projectByKey(db, req, req.params.key)
      await requireProjectAdmin(req, p)
      const q = req.query as { fixTo?: string; affectsTo?: string; moveTo?: string }
      if (kind === 'fields') { await tx(d => deleteProjectField(d, req, p, req.params.id)); return reply.code(204).send() }
      await tx(async d => {
        if (kind === 'releases') {
          for (const [field, to] of [['fixTo', q.fixTo], ['affectsTo', q.affectsTo]] as const) if (to) await usableRelease(d, p.id, to, req.params.id, field)
          await replaceIn(d, p.id, 'fix_release_ids', req.params.id, q.fixTo ?? null)
          await replaceIn(d, p.id, 'affects_release_ids', req.params.id, q.affectsTo ?? null)
        }
        if (kind === 'components') {
          if (q.moveTo && (q.moveTo === req.params.id || !(await d.query('select 1 from components where id = $1 and project_id = $2', [q.moveTo, p.id])).length))
            throw new HttpError(400, 'Move the work to another of this project’s components', { moveTo: 'Unknown component' })
          await replaceIn(d, p.id, 'component_ids', req.params.id, q.moveTo ?? null)
        }
        const [gone] = await d.query(`delete from ${cfg.table} where id = $1 and project_id = $2 returning *`, [req.params.id, p.id])
        if (!gone) throw new HttpError(404, 'Not found')
        await audit(d, req, { action: `project.${what.replace(' ', '_')}.deleted`, type: what, id: gone.id, name: gone.name ?? null, project: p, before: gone })
      })
      reply.code(204).send()
    })
  }

  // ── Security levels (Jira's issue security): who can see an item given a level; project admins manage them ──
  const member = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('role'), role: z.enum(['admin', 'member', 'viewer']) }),
    z.object({ kind: z.literal('group'), id: uuid }), z.object({ kind: z.literal('user'), id: uuid }),
    z.object({ kind: z.literal('reporter') }), z.object({ kind: z.literal('assignee') }),
  ])
  const levelBody = z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(500).default(''), members: z.array(member).min(1).max(50) })
  const levelP = keyP.extend({ levelId: uuid })
  const levels = (d: Db, projectId: string) => d.query(
    `select l.*, (select count(*)::int from issues i where i.security_level_id = l.id) as items from security_levels l where l.project_id = $1 order by l.name`, [projectId])
  app.get('/projects/:key/security-levels', { schema: { tags: T.config, summary: 'The project\'s security levels, with who is in each', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return levels(db, p.id)
  })
  app.post('/projects/:key/security-levels', { schema: { tags: T.config, summary: 'Add a security level (project admins)', params: keyP, body: levelBody } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [row] = await d.query<{ id: string }>('insert into security_levels (project_id, name, description, members) values ($1, $2, $3, $4) returning id',
        [p.id, req.body.name, req.body.description, JSON.stringify(req.body.members)])
      await audit(d, req, { action: 'project.security_level.created', type: 'security level', id: row!.id, name: req.body.name, project: p, after: req.body })
      reply.code(201)
      return (await levels(d, p.id)).find((l: any) => l.id === row!.id)
    })
  })
  app.patch('/projects/:key/security-levels/:levelId', { schema: { tags: T.config, summary: 'Change a security level and who is in it (project admins)', params: levelP, body: levelBody.partial() } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [before] = await d.query<any>('select name, description, members from security_levels where id = $1 and project_id = $2 for update', [req.params.levelId, p.id])
      if (!before) throw new HttpError(404, 'No such security level')
      const next = { ...before, ...req.body }
      await d.query('update security_levels set name = $2, description = $3, members = $4 where id = $1', [req.params.levelId, next.name, next.description, JSON.stringify(next.members)])
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'project.security_level.updated', type: 'security level', id: req.params.levelId, name: next.name, project: p, before: c.before, after: c.after })
      return (await levels(d, p.id)).find((l: any) => l.id === req.params.levelId)
    })
  })
  app.delete('/projects/:key/security-levels/:levelId', { schema: {
    tags: T.config, summary: 'Remove a security level (project admins). Items with it move to `moveTo`, or to no level with `moveTo=none`; one in use needs either',
    params: levelP, querystring: z.object({ moveTo: z.union([uuid, z.literal('none')]).optional() }),
  } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    await tx(async d => {
      const [l] = await d.query<any>('select name from security_levels where id = $1 and project_id = $2 for update', [req.params.levelId, p.id])
      if (!l) throw new HttpError(404, 'No such security level')
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from issues where security_level_id = $1', [req.params.levelId]) as any
      const moveTo = req.query.moveTo
      if (n && !moveTo) throw new HttpError(409, `${n} work items have this level: choose another level for them, or none (moveTo)`)
      if (moveTo && moveTo !== 'none' && (moveTo === req.params.levelId || !(await d.query('select 1 from security_levels where id = $1 and project_id = $2', [moveTo, p.id])).length))
        throw new HttpError(400, 'Choose another level of this project, or none')
      if (n) await d.query('update issues set security_level_id = $2, version = version + 1, updated_at = now() where security_level_id = $1', [req.params.levelId, moveTo === 'none' ? null : moveTo])
      await d.query('delete from security_levels where id = $1', [req.params.levelId])
      await audit(d, req, { action: 'project.security_level.deleted', type: 'security level', id: req.params.levelId, name: l.name, project: p, before: { items: n }, after: { movedTo: moveTo ?? null } })
    })
    reply.code(204).send()
  })

  // ── Testing (what Xray adds): turning it on gives the project Test, Pre-Condition, Test Set, Test Plan and Test
  // Execution work types; turning it off removes them, which needs the project to have no items of those types ──
  app.put('/projects/:key/testing', { schema: { tags: T.config, summary: 'Turn test management on or off for a project, and choose which work types are requirements (project admins)', params: keyP,
    body: z.object({ enabled: z.boolean(), requirementTypes: z.array(z.string().max(40)).max(50).nullable().optional()
      .describe('Work types that count as requirements for coverage; null: every type except the testing ones and Bug') }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [cur] = await d.query<{ testing: boolean; requirementTypes: string[] | null }>('select testing, requirement_types from projects where id = $1 for update', [p.id])
      const rt = req.body.requirementTypes
      if (rt !== undefined && JSON.stringify(rt) !== JSON.stringify(cur!.requirementTypes)) {
        if (rt) {
          const known = new Set((await d.query<{ key: string }>('select key from work_types where project_id = $1', [p.id])).map(r => r.key))
          const bad = rt.filter(k => !known.has(k) || (TEST_TYPES as readonly string[]).includes(k))
          if (bad.length) throw new HttpError(400, 'Requirements must be the project’s own non-testing work types', { requirementTypes: `Not allowed: ${bad.join(', ')}` })
        }
        await d.query('update projects set requirement_types = $2 where id = $1', [p.id, rt])
        await audit(d, req, { action: 'project.requirement_types.updated', type: 'project', id: p.id, name: p.key, project: p, before: { requirementTypes: cur!.requirementTypes }, after: { requirementTypes: rt } })
      }
      if (cur!.testing === req.body.enabled) return { enabled: cur!.testing, requirementTypes: rt !== undefined ? rt : cur!.requirementTypes }
      if (req.body.enabled) await d.query('select seed_testing_types($1)', [p.id])
      else {
        const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from issues where project_id = $1 and type = any($2) and deleted_at is null', [p.id, TEST_TYPES]) as any
        if (n) throw new HttpError(409, `${n} work items are Tests, Test Plans or other testing types: move or delete them first`)
        await d.query('delete from issues where project_id = $1 and type = any($2)', [p.id, TEST_TYPES])                    // in the trash only
        await d.query('delete from work_types where project_id = $1 and key = any($2)', [p.id, TEST_TYPES])
      }
      await applyScheme(d, req, p.id)                                                    // the types it adds or removes have workflows
      await d.query('update projects set testing = $2 where id = $1', [p.id, req.body.enabled])
      await audit(d, req, { action: req.body.enabled ? 'project.testing.enabled' : 'project.testing.disabled', type: 'project', id: p.id, name: p.key, project: p })
      return { enabled: req.body.enabled, requirementTypes: rt !== undefined ? rt : cur!.requirementTypes }
    })
  })

  // Initiatives (spec 0803 R1): the built-in Initiative work type, on or off (off only while the project has none)
  app.put('/projects/:key/initiatives', { schema: { tags: T.config, summary: 'Turn the Initiative work type on or off for a project (project admins)', params: keyP,
    body: z.object({ enabled: z.boolean() }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [cur] = await d.query<{ initiatives: boolean }>('select initiatives from projects where id = $1 for update', [p.id])
      if (cur!.initiatives === req.body.enabled) return { enabled: cur!.initiatives }
      if (req.body.enabled) await d.query('select seed_initiative_type($1)', [p.id])
      else {
        const [{ n }] = await d.query<{ n: number }>(`select count(*)::int as n from issues where project_id = $1 and type = 'initiative' and deleted_at is null`, [p.id]) as any
        if (n) throw new HttpError(409, `${n} work items are initiatives: change their type or delete them first`)
        await d.query(`delete from issues where project_id = $1 and type = 'initiative'`, [p.id])     // in the trash only
        await d.query(`delete from work_types where project_id = $1 and key = 'initiative'`, [p.id])
      }
      await applyScheme(d, req, p.id)                                                    // the type has a workflow
      await d.query('update projects set initiatives = $2 where id = $1', [p.id, req.body.enabled])
      await audit(d, req, { action: req.body.enabled ? 'project.initiatives.enabled' : 'project.initiatives.disabled', type: 'project', id: p.id, name: p.key, project: p })
      return { enabled: req.body.enabled }
    })
  })

  // ── Work types (Jira's issue types): the built-in four can be renamed and recoloured; a project can add its own,
  // and removing one moves its items to another type ──
  const ICONS = ['zap', 'bookmark', 'check', 'bug', 'flag', 'star', 'wrench', 'book', 'shield', 'lightbulb', 'rocket', 'circle', 'flask', 'clipboard', 'layers', 'map', 'play'] as const
  const typeBody = z.object({ name: z.string().trim().min(1).max(40), color, icon: z.enum(ICONS) })
  const typeP = keyP.extend({ typeKey: z.string().max(40) })
  app.post('/projects/:key/types', { schema: { tags: T.config, summary: 'Add a work type (project admins)', params: keyP, body: typeBody } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      if ((await d.query('select 1 from work_types where project_id = $1 and lower(name) = lower($2)', [p.id, req.body.name])).length)
        throw new HttpError(409, 'A work type with that name already exists', { name: 'Already used' })
      const key = 't-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      const [row] = await d.query(`insert into work_types (project_id, key, name, color, icon, position)
        values ($1, $2, $3, $4, $5, (select coalesce(max(position), 0) + 1 from work_types where project_id = $1)) returning *`, [p.id, key, req.body.name, req.body.color, req.body.icon])
      await audit(d, req, { action: 'project.work_type.created', type: 'work type', name: req.body.name, project: p, after: req.body })
      await applyScheme(d, req, p.id)
      reply.code(201)
      return row
    })
  })
  app.patch('/projects/:key/types/:typeKey', { schema: { tags: T.config, summary: 'Rename or restyle a work type (project admins)', params: typeP, body: typeBody.partial() } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [before] = await d.query<any>('select * from work_types where project_id = $1 and key = $2 for update', [p.id, req.params.typeKey])
      if (!before) throw new HttpError(404, 'No such work type')
      if (req.body.name && (await d.query('select 1 from work_types where project_id = $1 and key <> $2 and lower(name) = lower($3)', [p.id, req.params.typeKey, req.body.name])).length)
        throw new HttpError(409, 'A work type with that name already exists', { name: 'Already used' })
      const next = { name: req.body.name ?? before.name, color: req.body.color ?? before.color, icon: req.body.icon ?? before.icon }
      const [row] = await d.query('update work_types set name = $3, color = $4, icon = $5 where project_id = $1 and key = $2 returning *', [p.id, req.params.typeKey, next.name, next.color, next.icon])
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'project.work_type.updated', type: 'work type', name: next.name, project: p, before: c.before, after: c.after })
      return row
    })
  })
  app.delete('/projects/:key/types/:typeKey', { schema: {
    tags: T.config, summary: 'Remove a work type the project added (project admins). Its items, and its templates, move to `moveTo`', params: typeP,
    querystring: z.object({ moveTo: z.string().max(40).optional() }),
  } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    await tx(async d => {
      const [t] = await d.query<any>('select * from work_types where project_id = $1 and key = $2 for update', [p.id, req.params.typeKey])
      if (!t) throw new HttpError(404, 'No such work type')
      if (['epic', 'story', 'task', 'bug', 'initiative', ...TEST_TYPES].includes(t.key)) throw new HttpError(409, `${t.name} is built in: ${t.key === 'initiative' ? 'turn Initiatives off instead' : 'rename it instead'}`)
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from issues where project_id = $1 and type = $2', [p.id, t.key]) as any
      const moveTo = req.query.moveTo
      if (n && !moveTo) throw new HttpError(409, `${n} work items are of this type: choose a type to move them to`)
      if (moveTo && (moveTo === t.key || !(await d.query('select 1 from work_types where project_id = $1 and key = $2', [p.id, moveTo])).length))
        throw new HttpError(400, 'Choose another work type of this project')
      if (n) {
        await d.query(`insert into activity (issue_id, actor_id, field, from_value, to_value, text)
                       select id, $3, 'type', $2, $4, 'Changed type (its work type was removed)' from issues where project_id = $1 and type = $2`, [p.id, t.key, req.me.id, moveTo])
        await d.query('update issues set type = $3, version = version + 1, updated_at = now() where project_id = $1 and type = $2', [p.id, t.key, moveTo])
      }
      await d.query('update item_templates set type = $3 where project_id = $1 and type = $2', [p.id, t.key, moveTo ?? 'task'])
      await d.query('delete from work_types where id = $1', [t.id])
      await applyScheme(d, req, p.id)
      await audit(d, req, { action: 'project.work_type.deleted', type: 'work type', name: t.name, project: p, before: { name: t.name, items: n }, after: moveTo ? { movedTo: moveTo } : undefined })
    })
    reply.code(204).send()
  })

  // ── Workflow: the project's scheme says which workflow each work type uses. Project admins choose the scheme (and
  // where items go from statuses the new one lacks); only system administrators change workflows ──
  app.get('/projects/:key/workflow', { schema: { tags: T.config, summary: 'The project’s workflow scheme, and the workflow each work type uses', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [sc] = await db.query<any>('select sc.id, sc.name, sc.description from workflow_schemes sc join projects p on p.workflow_scheme_id = sc.id where p.id = $1', [p.id])
    return { scheme: sc, types: await typeWorkflowList(db, p.id) }
  })
  app.put('/projects/:key/workflow-scheme', { schema: { tags: T.config,
    summary: 'Use another workflow scheme (global admins, as in Jira). Items in statuses their type’s new workflow lacks move by statusMap, else to the first status of the same category. With dryRun, only reports what would change',
    params: keyP, body: z.object({
      schemeId: uuid, dryRun: z.boolean().default(false),
      statusMap: z.record(uuid, uuid).default({}).describe('The project’s status id (or a global status id) → global status id to move its items to'),
    }) } }, async req => {
    requireAdmin(req)                                                    // spec 0103 R5: Jira administrators switch a project's scheme
    const p = await projectByKey(db, req, req.params.key)
    return previewing(tx, req.body.dryRun, async d => {
      const [sc] = await d.query<{ id: string; name: string }>('select id, name from workflow_schemes where id = $1 and workspace_id = $2', [req.body.schemeId, req.me.workspaceId])
      if (!sc) throw new HttpError(400, 'No such workflow scheme', { schemeId: 'Not found' })
      const [before] = await d.query<{ name: string }>('select sc.name from workflow_schemes sc join projects p on p.workflow_scheme_id = sc.id where p.id = $1', [p.id])
      await d.query('update projects set workflow_scheme_id = $2 where id = $1', [p.id, sc.id])
      const impact = await applyScheme(d, req, p.id, { statusMap: req.body.statusMap })
      if (before!.name !== sc.name) await audit(d, req, { action: 'project.workflow_scheme.changed', type: 'project', id: p.id, name: p.key, project: p, before: { scheme: before!.name }, after: { scheme: sc.name } })
      return impact
    })
  })
  // A WIP limit is the board's, not the workflow's: project admins set it
  app.patch('/projects/:key/statuses/:id', { schema: { tags: T.config, summary: 'Set a status’s WIP limit on this project’s board (project admins)', params: keyIdP,
    body: z.object({ wipLimit: z.number().int().positive().nullable() }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    const [row] = await db.query('update statuses set wip_limit = $3 where id = $1 and project_id = $2 returning *', [req.params.id, p.id, req.body.wipLimit])
    if (!row) throw new HttpError(404, 'Not found')
    return row
  })

  // ── Automation's audit log and dry run (project admins, as in Jira) ──
  app.get('/projects/:key/automation/runs', { schema: {
    tags: T.config, summary: 'Recent automation runs, newest first: what started each, the item, what each action did, and how it ended (90 days)',
    params: keyP, querystring: z.object({ rule: uuid.optional(), result: z.enum(['success', 'some_skipped', 'no_change', 'failed', 'condition_not_met']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    const args: unknown[] = [p.id]
    const where = ['r.project_id = $1']
    if (req.query.rule) { args.push(req.query.rule); where.push(`r.rule_id = $${args.length}`) }
    if (req.query.result) { args.push(req.query.result); where.push(`r.result = $${args.length}`) }
    args.push(req.query.limit)
    return db.query(`select r.id, r.rule_id, ru.name as rule, r.issue_id, case when i.id is null then null else pr.key || '-' || i.number end as issue_key,
                            r.trigger, r.result, r.steps, r.error, r.at
                       from rule_runs r join rules ru on ru.id = r.rule_id left join issues i on i.id = r.issue_id left join projects pr on pr.id = i.project_id
                      where ${where.join(' and ')} order by r.at desc, r.id desc limit $${args.length}`, args)
  })
  app.post('/projects/:key/automation/dry-run', { schema: {
    tags: T.config, summary: 'What these actions would do to a work item, without doing it (project admins)', params: keyP,
    body: z.object({ issue: z.string().describe('Key of a work item in this project'), actions: childPatch.rules.shape.actions.unwrap(),
      condition: z.string().trim().max(2000).nullable().optional().describe('The rule’s JQL condition, checked first (spec 0709)') }),
  } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [i] = await d.query<any>(`select i.id, i.reporter_id, pr.lead_id from issues i join projects pr on pr.id = i.project_id
                                       where i.project_id = $1 and pr.key || '-' || i.number = upper($2) and i.deleted_at is null`, [p.id, req.body.issue])
      if (!i) throw new HttpError(404, 'No such work item in this project', { issue: 'Not found here' })
      return dryRun(d, { projectId: p.id, issueId: i.id, reporterId: i.reporterId, leadId: i.leadId, actorId: req.me.id }, { actions: req.body.actions, condition: req.body.condition })
    })
  })

  // ── CSV import (Jira's importer): check every row first; import in the background; a rerun adds nothing twice ──
  const importMapping = z.record(z.string().regex(/^(title|description|type|status|priority|assignee|labels|estimate|dueDate|startDate|components|fixVersion|flagged|epicColor|custom\.[0-9a-f-]{36})$/), z.number().int().min(0))
    .describe('Field → column number (0 is the first column). Fields: title (required), description, type, status, priority, assignee, labels, estimate, dueDate, startDate, components, fixVersion, custom.<field id>')
  app.post('/projects/:key/import', { schema: {
    tags: T.config, summary: 'Import work items from CSV. With dryRun (the default) nothing is created: every row is checked and reported. Otherwise the import runs as a job (GET /jobs/:id)',
    params: keyP, body: z.object({
      csv: z.string().min(1).max(15 * 1024 * 1024), mapping: importMapping, dryRun: z.boolean().default(true),
      importId: uuid.optional().describe('Same id, same import: running it again only adds rows not yet imported'),
    }),
  } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)                                     // members can import, as they can create
    const b = req.body
    if (b.mapping.title === undefined) throw new HttpError(400, 'Choose which column holds the title', { mapping: 'title is required' })
    const { importMaxRows } = await getSetting(req.me.workspaceId, 'searchAndBulk')
    const { header, items, report } = await checkImport(db, p.id, b.csv, b.mapping)
    if (report.length > importMaxRows) throw new HttpError(400, `A CSV import can have at most ${importMaxRows.toLocaleString('en')} rows (this file has ${report.length.toLocaleString('en')})`, { csv: 'Too many rows' })
    const summary = { columns: header, rows: report.length, ready: items.length, skipped: report.filter(r => !r.ok).length, report }
    if (b.dryRun) return { ...summary, jobId: null }
    if (!items.length) throw new HttpError(400, 'No row can be imported', { csv: 'Nothing to import' })
    const importId = b.importId ?? crypto.randomUUID()
    const jobId = await tx(async d => {
      const id = await enqueue(d, 'csv.import', { importId, projectId: p.id, me: req.me, csv: b.csv, mapping: b.mapping },
        { workspaceId: req.me.workspaceId, createdBy: req.me.id, dedupeKey: `csv.import:${importId}` })
      await audit(d, req, { action: 'project.csv_imported', type: 'import', id: importId, project: p, after: { rows: report.length, ready: items.length } })
      return id
    })
    kickJobs(app.log)                                                                          // once the job is committed
    reply.code(202)
    return { ...summary, jobId, importId }
  })

  // How many work items use a version or a component: what deleting it would move or clear (spec 0304 R5)
  app.get('/projects/:key/releases/:id/usage', { schema: { tags: T.config, summary: 'How many work items have this version as a fix and as an affects version', params: keyIdP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [u] = await db.query<{ fix: number; affects: number }>(
      `select count(*) filter (where fix_release_ids @> array[$2::uuid])::int as fix, count(*) filter (where affects_release_ids @> array[$2::uuid])::int as affects
         from issues where project_id = $1 and deleted_at is null`, [p.id, req.params.id])
    return u
  })
  app.get('/projects/:key/components/:id/usage', { schema: { tags: T.config, summary: 'How many work items are in this component', params: keyIdP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [u] = await db.query<{ items: number }>(`select count(*)::int as items from issues where project_id = $1 and deleted_at is null and component_ids @> array[$2::uuid]`, [p.id, req.params.id])
    return u
  })

  // Merging versions (Jira's): the items of `from` get this version instead, and those versions are deleted (spec 0304 R3)
  app.post('/projects/:key/releases/:id/merge', { schema: {
    tags: T.config, summary: 'Merge versions into this one: their items’ fix and affects versions point here, and they are deleted', params: keyIdP,
    body: z.object({ from: z.array(uuid).min(1).max(50).describe('The versions merged into this one') }),
  } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    const from = [...new Set(req.body.from)]
    if (from.includes(req.params.id)) throw new HttpError(400, 'A version can’t be merged into itself', { from: 'Includes the target' })
    return tx(async d => {
      const target = await usableRelease(d, p.id, req.params.id, null, 'id')
      const gone = await d.query<{ id: string; name: string; archived: boolean }>('select * from releases where project_id = $1 and id = any($2::uuid[]) for update', [p.id, from])
      if (gone.length !== from.length) throw new HttpError(400, 'Every version merged must be one of this project’s', { from: 'Unknown version' })
      const archived = gone.find(g => g.archived)
      if (archived) throw new HttpError(400, `Version ${archived.name} is archived`, { from: 'Archived' })
      for (const g of gone) {
        await replaceIn(d, p.id, 'fix_release_ids', g.id, target.id)
        await replaceIn(d, p.id, 'affects_release_ids', g.id, target.id)
      }
      await d.query('delete from releases where id = any($1::uuid[])', [from])
      await audit(d, req, { action: 'project.release.merged', type: 'release', id: target.id, name: target.name, project: p, before: { versions: gone.map(g => g.name) } })
      // Jira's: each merged version is deleted, with the version it went into (spec 0715 R2)
      for (const g of gone) await emit(d, req.me.workspaceId, 'jira:version_deleted', { projectId: p.id, versionId: g.id, entity: g, mergedToId: target.id }, req.me.id)
      return (await d.query('select * from releases where id = $1', [target.id]))[0]
    })
  })

  // Releasing a version: its unfinished work moves to `moveTo` (the released version is replaced by it, their other fix
  // versions stay), or stays where it is (Jira's "ignore"), spec 0301 R5
  app.post('/projects/:key/releases/:id/release', { schema: {
    tags: T.config, summary: 'Mark a release shipped; unfinished work may move to another release', params: keyIdP,
    body: z.object({ moveTo: uuid.nullable().default(null).describe('Release that receives unfinished work (null: it keeps this one)') }).default({ moveTo: null }),
  } }, async req => {
    const { moveTo } = req.body
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [r] = await d.query(`update releases set released = true, released_at = now() where id = $1 and project_id = $2 returning *`, [req.params.id, p.id])
      if (!r) throw new HttpError(404, 'Not found')
      if (r.archived) throw new HttpError(400, `Version ${r.name} is archived`)
      if (moveTo) {
        await usableRelease(d, p.id, moveTo, req.params.id, 'moveTo')
        await d.query(
          `update issues set fix_release_ids = array(select x from unnest(array_replace(fix_release_ids, $1::uuid, $3::uuid)) with ordinality u(x, n) group by x order by min(n)), version = version + 1, updated_at = now()
            where fix_release_ids @> array[$1::uuid] and project_id = $2 and deleted_at is null
              and status_id in (select id from statuses where project_id = $2 and category <> 'done')`, [req.params.id, p.id, moveTo])
      }
      await audit(d, req, { action: 'project.release.released', type: 'release', id: r.id, name: r.name, project: p, after: { moveTo } })
      return r
    })
  })

  // ── Sprints ──
  // Sprint Report (Jira's, spec 0402): one sprint's completed, not completed, completed outside and removed work, with the
  // points each had at the start (or when added, marked *), among the items I can see
  app.get('/projects/:key/sprints/:id/report', { schema: { tags: T.sprints, summary: 'Sprint Report: completed, not completed, completed outside the sprint, and removed work, with points', params: keyIdP } }, async req => {
    const p = await projectByKey(db, req, req.params.key, 'viewer')
    const [sp] = await db.query<any>('select * from sprints where id = $1 and project_id = $2', [req.params.id, p.id])
    if (!sp) throw new HttpError(404, 'Sprint not found')
    if (sp.state === 'planned') throw new HttpError(400, 'A sprint has a report once it has started')
    const start: Record<string, number | null> | null = sp.startEstimates
    // the items it held: at completion, or now; what was completed: recorded then, or in the board's rightmost column now
    const col = await doneColumnOf(db, sp.boardId)
    const members: string[] = sp.state === 'closed' ? sp.issueIds ?? []
      : (await db.query<{ id: string }>('select id from issues where sprint_id = $1 and deleted_at is null', [sp.id])).map(r => r.id)
    const completed = new Set<string>(sp.state === 'closed' ? sp.completedIds ?? []
      : (await db.query<{ id: string }>(`select i.id from issues i join statuses st on st.id = i.status_id where i.id = any($1::uuid[]) and ${col ? 'st.global_status_id = any($2::uuid[])' : `(st.category = 'done' and $2::uuid[] is null)`}`, [members, col])).map(r => r.id))
    // taken out while it ran (completing it moves work without a history line, so those are "not completed" instead)
    const removed = (await db.query<{ id: string }>(
      `select distinct a.issue_id as id from activity a where a.field = 'sprintId' and a.from_value = $1 and a.created_at >= $2 and a.created_at <= coalesce($3, now())`,
      [sp.id, sp.startedAt, sp.completedAt])).map(r => r.id).filter(id => !members.includes(id))
    const args: unknown[] = [[...members, ...removed], sp.id]
    const rows = await db.query<any>(
      `select i.id, p.key || '-' || i.number as key, i.title, i.type, i.priority, st.name as status, i.estimate, i.time_estimate, i.custom, i.resolved_at,
              coalesce((select max(a.created_at) from activity a where a.issue_id = i.id and a.field = 'sprintId' and a.to_value = $2::text), i.created_at) as joined_at
         from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
        where i.id = any($1::uuid[]) and i.deleted_at is null and ${visible(req.me, 'i.project_id', args)} and ${levelOk(req.me, args.push(req.me.id))} order by i.rank, i.id`, args)   // within my security level too
    const row = (r: any) => {
      const added = !!start && !(r.id in start)
      const now = sp.estimation === 'time' ? r.timeEstimate : sp.estimation === 'count' ? 1 : sp.estimation === 'field' ? (typeof r.custom?.[sp.estimationFieldId] === 'number' ? r.custom[sp.estimationFieldId] : null) : r.estimate   // the sprint's statistic (specs 0404, 0412)
      return { key: r.key, title: r.title, type: r.type, priority: r.priority, status: r.status, points: (start && r.id in start ? start[r.id] : now) ?? null, addedAfterStart: added }
    }
    // already resolved before it joined the sprint (at the start, or when added)
    const outside = (r: any) => !!r.resolvedAt && new Date(r.resolvedAt) < new Date(start && r.id in start ? sp.startedAt : r.joinedAt)
    const sections = {
      completed: rows.filter(r => completed.has(r.id) && !outside(r)).map(row),
      notCompleted: rows.filter(r => members.includes(r.id) && !completed.has(r.id)).map(row),
      completedOutside: rows.filter(r => completed.has(r.id) && outside(r)).map(row),
      removed: rows.filter(r => removed.includes(r.id)).map(row),
    }
    const total = (l: { points: number | null }[]) => l.reduce((n, x) => n + Number(x.points ?? 0), 0)
    return { sprint: sp, ...sections, totals: Object.fromEntries(Object.entries(sections).map(([k, l]) => [k, total(l)])) }
  })

  const sprintBody = z.object({ name: z.string().min(1), goal: z.string(), endsAt: z.string().datetime().nullable() }).partial()
  const sprintCreate = sprintBody.required({ name: true }).extend({ id: uuid.optional().describe('Client-chosen id'), boardId: uuid.optional().describe('The Scrum board it belongs to (one of this project’s; default its first)') })

  /** A sprint of this project, and its board: seeing the project reaches the sprint; managing it is checked on its board
   *  (spec 0101: someone who can change work in every project the board's filter names). */
  const managedSprint = async (d: Db, req: FastifyRequest<{ Params: { key: string; id: string } }>, lock = false) => {
    const p = await projectByKey(d, req, req.params.key, 'viewer')
    const [s] = await d.query<{ id: string; boardId: string; state: string; name: string }>(
      `select id, board_id, state, name from sprints where id = $1 and project_id = $2 ${lock ? 'for update' : ''}`, [req.params.id, p.id])
    if (!s) throw new HttpError(404, 'Not found')
    const [b] = await d.query<{ jql: string; workspaceId: string }>('select jql, workspace_id from boards where id = $1', [s.boardId])
    await needSprintManager(d, req.me, b!)
    return { p, s }
  }

  app.post('/projects/:key/sprints', { schema: { tags: T.sprints, summary: 'Create a sprint (needs the right to change work in every project its board covers)', params: keyP, body: sprintCreate } }, async req => {
    const p = await projectByKey(db, req, req.params.key, 'viewer')
    const b = req.body
    // on a board of this project (sprints belong to boards): the one named, else its first Scrum board, else its first
    const [board] = await db.query<{ id: string; jql: string; workspaceId: string }>(
      `select id, jql, workspace_id from boards where project_id = $1 and ($2::uuid is null or id = $2) order by (type = 'scrum') desc, position, id limit 1`, [p.id, b.boardId ?? null])
    if (!board) throw new HttpError(400, 'That board isn’t one of this project’s', { boardId: 'Unknown board' })
    await needSprintManager(db, req.me, board)
    const [s] = await db.query(
      `insert into sprints (id, workspace_id, project_id, name, goal, ends_at, board_id) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5, $7) returning *`,
      [req.me.workspaceId, p.id, b.name, b.goal ?? '', b.endsAt ?? null, b.id ?? null, board.id])
    await emit(db, req.me.workspaceId, 'sprint_created', { sprintId: s.id, projectId: p.id }, req.me.id)   // webhooks (spec 0705)
    return s
  })

  app.patch('/projects/:key/sprints/:id', { schema: { tags: T.sprints, summary: 'Update a sprint', params: keyIdP, body: sprintBody } }, async req => {
    const w = pick(req.body, ['name', 'goal', 'endsAt'])
    if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
    const { p } = await managedSprint(db, req)
    const [old] = await db.query('select * from sprints where id = $1 and project_id = $2', [req.params.id, p.id])
    const [s] = await db.query(
      `update sprints set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and project_id = $2 returning *`,
      [req.params.id, p.id, ...w.vals])
    if (!s) throw new HttpError(404, 'Not found')
    await emit(db, req.me.workspaceId, 'sprint_updated', { sprintId: s.id, projectId: p.id, old }, req.me.id)   // Jira's oldValue (spec 0715 R4)
    return s
  })

  // Deleting a sprint (Jira's): a planned one sends its work to the backlog; a completed one sends its unfinished work to
  // the board's next planned sprint (else the backlog), and its completed work keeps no sprint (spec 0403 R2, R3)
  app.delete('/projects/:key/sprints/:id', { schema: { tags: T.sprints, summary: 'Delete a planned or completed sprint (an active one: complete it first)', params: keyIdP } }, async (req, reply) => {
    await tx(async d => {
      const { p, s } = await managedSprint(d, req, true)
      const [cur] = await d.query<any>('select state, name, board_id from sprints where id = $1', [s.id])
      if (cur.state === 'active') throw new HttpError(409, 'Complete the sprint before deleting it')
      if (cur.state === 'closed') {
        const col = await doneColumnOf(d, cur.boardId)
        const [next] = await d.query<{ id: string }>(`select id from sprints where board_id = $1 and state = 'planned' order by created_at, id limit 1`, [cur.boardId])
        await d.query(
          `update issues i set sprint_id = $3, version = version + 1, updated_at = now() from statuses st
            where st.id = i.status_id and i.sprint_id = $1 and i.deleted_at is null and not ${col ? 'st.global_status_id = any($2::uuid[])' : `(st.category = 'done' and $2::uuid[] is null)`}`,
          [s.id, col, next?.id ?? null])
        await audit(d, req, { action: 'sprint.deleted', type: 'sprint', id: s.id, name: cur.name, project: p, after: { unfinishedTo: next?.id ?? 'backlog' } })
      }
      await d.query('delete from sprints where id = $1', [s.id])      // what is left in it (completed, or a planned sprint's work) keeps no sprint
    })
    reply.code(204).send()
  })

  // Reopening a completed sprint (Jira's): active again on its board, with the work it held when it closed, except work
  // now in an active sprint (spec 0403 R1)
  app.post('/projects/:key/sprints/:id/reopen', { schema: { tags: T.sprints, summary: 'Reopen a completed sprint: active again, with the work it held (not while another sprint is active on its board)', params: keyIdP } }, async req => {
    return tx(async d => {
      const { p, s } = await managedSprint(d, req, true)
      const [cur] = await d.query<any>('select state, name, board_id, issue_ids from sprints where id = $1', [s.id])
      if (cur.state !== 'closed') throw new HttpError(409, 'Only a completed sprint can be reopened')
      await checkParallel(d, req.me.workspaceId, cur.boardId, 'reopening')
      const [row] = await d.query(`update sprints set state = 'active', completed_at = null, completed = null where id = $1 returning *`, [s.id])
      await d.query(
        `update issues set sprint_id = $1, version = version + 1, updated_at = now()
          where id = any($2::uuid[]) and deleted_at is null and sprint_id is distinct from $1
            and (sprint_id is null or sprint_id in (select id from sprints where state = 'planned'))`, [s.id, cur.issueIds ?? []])
      await audit(d, req, { action: 'sprint.reopened', type: 'sprint', id: s.id, name: cur.name, project: p })
      return row
    })
  })

  app.post('/projects/:key/sprints/:id/start', { schema: {
    tags: T.sprints, summary: 'Start a sprint (snapshots committed points)', params: keyIdP, body: z.object({ endsAt: z.string().datetime() }),
  } }, async req => {
    const { endsAt } = req.body
    return tx(async d => {
      const { p } = await managedSprint(d, req, true)
      const [cur] = await d.query<{ boardId: string | null; state: string }>('select board_id, state from sprints where id = $1 and project_id = $2', [req.params.id, p.id])
      if (cur?.state === 'planned') await checkParallel(d, req.me.workspaceId, cur.boardId, 'starting')
      const [s] = await d.query(
        `update sprints set state = 'active', started_at = now(), ends_at = $3,
                estimation = (select estimation from boards where id = sprints.board_id),
                estimation_field_id = (select estimation_field_id from boards where id = sprints.board_id),
                committed = (select coalesce(sum(${STAT}), 0) from issues i where sprint_id = sprints.id and deleted_at is null),
                start_estimates = (select coalesce(jsonb_object_agg(id, ${STAT}), '{}') from issues i where sprint_id = sprints.id and deleted_at is null)   -- for the Sprint Report (0402)
          where id = $1 and project_id = $2 and state = 'planned' returning *`, [req.params.id, p.id, endsAt])
      if (!s) throw new HttpError(409, 'Sprint is not planned')
      await emit(d, req.me.workspaceId, 'sprint_started', { sprintId: s.id, projectId: p.id }, req.me.id)
      return s
    })
  })

  app.post('/projects/:key/sprints/:id/complete', { schema: {
    tags: T.sprints, summary: 'Complete a sprint; unfinished work moves to a future sprint of its board, a new sprint ("new"), or the backlog (null)', params: keyIdP,
    body: z.object({ moveTo: z.union([uuid, z.literal('new')]).nullable().default(null).describe('A planned sprint of the same board, "new" for a new sprint on it, or null for the backlog') }).default({ moveTo: null }),
  } }, async req => {
    return tx(async d => {
      const { p, s: cur } = await managedSprint(d, req, true)
      if (cur.state !== 'active') throw new HttpError(409, 'Sprint is not active')
      // Jira: an item is completed when its status is in the board's rightmost column (that has statuses), whatever its
      // category; without a board, a Done status (spec 0401). `done(alias)` tests a statuses row, with the column as $2.
      const col = await doneColumnOf(d, cur.boardId)
      const done = (st: string) => (col ? `${st}.global_status_id = any($2::uuid[])` : `(${st}.category = 'done' and $2::uuid[] is null)`)
      const doneArg = col ?? null
      // a completed item whose sub-items in the sprint aren't completed blocks completion; finish the sub-items first
      const blocked = await d.query<{ key: string }>(
        `select distinct pp.key || '-' || par.number as key, par.number from issues par join statuses ps on ps.id = par.status_id join projects pp on pp.id = par.project_id
          where par.sprint_id = $1 and par.deleted_at is null and ${done('ps')}
            and exists (select 1 from issues c join statuses cs on cs.id = c.status_id where c.parent_id = par.id and c.sprint_id = $1 and c.deleted_at is null and not ${done('cs')})
          order by 1 limit 20`, [cur.id, doneArg])
      if (blocked.length) throw new HttpError(409, `Complete the sub-items first: ${blocked.map(b => b.key).join(', ')}`, { moveTo: 'Done items have unfinished sub-items' })
      let moveTo = req.body.moveTo, newSprint: unknown
      if (moveTo === 'new') {
        // named like any new sprint of the project
        const [{ n }] = await d.query<{ n: number }>('select count(*)::int + 1 as n from sprints where project_id = $1', [p.id]) as any
        ;[newSprint] = await d.query<any>(
          `insert into sprints (workspace_id, project_id, name, goal, board_id) values ($1, $2, $3, '', $4) returning *`, [req.me.workspaceId, p.id, `${p.key} Sprint ${n}`, cur.boardId])
        moveTo = (newSprint as { id: string }).id
      } else if (moveTo && !(await d.query(`select 1 from sprints where id = $1 and board_id = $2 and state = 'planned'`, [moveTo, cur.boardId])).length)
        throw new HttpError(400, 'Unfinished work can go to a future sprint of the same board, a new sprint, or the backlog', { moveTo: 'Not a future sprint of this board' })
      const [s] = await d.query(
        `update sprints set state = 'closed', completed_at = now(),
                completed = (select coalesce(sum(${STAT}), 0) from issues i join statuses st on st.id = i.status_id
                              where i.sprint_id = sprints.id and i.deleted_at is null and ${done('st')}),
                issue_ids = array(select id from issues where sprint_id = sprints.id and deleted_at is null),
                completed_ids = array(select i.id from issues i join statuses st on st.id = i.status_id where i.sprint_id = sprints.id and i.deleted_at is null and ${done('st')})
          where id = $1 returning *`, [cur.id, doneArg])
      await d.query(
        `update issues set sprint_id = $3, version = version + 1, updated_at = now()
          where sprint_id = $1 and deleted_at is null
            and status_id in (select st.id from statuses st where not ${done('st')})
            and project_id not in (select id from projects where archived_at is not null)`, [cur.id, doneArg, moveTo])   // unfinished work from every project in it, except archived ones (read-only)
      await emit(d, req.me.workspaceId, 'sprint_closed', { sprintId: s.id, projectId: p.id }, req.me.id)
      return newSprint ? { ...s, newSprint } : s
    })
  })
}

/** Each work type's workflow, and the project statuses it has (in its order: new work starts in the first). */
async function typeWorkflowList(d: Db, projectId: string) {
  const { byType, wfs, def } = await typeWorkflows(d, projectId)
  const status = new Map((await d.query<{ id: string; globalStatusId: string }>('select id, global_status_id from statuses where project_id = $1', [projectId])).map(s => [s.globalStatusId, s.id]))
  return [...byType].map(([typeKey, wid]) => {
    const w = wfs.get(wid) ?? def
    return { typeKey, workflowId: w.id, workflow: w.name, statusIds: w.statuses.map(g => status.get(g)).filter((x): x is string => !!x), resolutionOnDone: w.resolutionOnDone }
  })
}

/** Everything the project screens need in one call (workflow, fields, releases, templates, rules, sprints). */
export async function projectDetail(d: Db, ws: string, key: string, role: ProjectRole) {
  const [row] = await d.query<any>(`select pr.*, (select jsonb_build_object('id', c.id, 'name', c.name) from project_categories c where c.id = pr.category_id) as category,
      array(select h.key from project_key_history h where h.project_id = pr.id order by h.changed_at) as old_keys
    from projects pr where pr.workspace_id = $1 and pr.key = $2`, [ws, key.toUpperCase()])
  const { avatar, avatarType, avatarHash, oldKeys, ...project } = row
  // its keys, current first (spec 0703 R4); the avatar's address, not its bytes (R8)
  Object.assign(project, { keys: [project.key, ...oldKeys], avatar: avatarHash ? `/project-avatars/${project.id}/${avatarHash}` : null })
  void avatar; void avatarType
  const p = { id: project.id as string }
  const by = (table: string, order: string) => d.query(`select * from ${table} where project_id = $1 order by ${order}`, [p.id])
  // Sequential: `d` may be a single transaction connection, which can't run queries in parallel
  const statuses = await by('statuses', 'position'), transitions = await by('transitions', 'id'), types = await by('work_types', 'position, name')
  const fields = await by('field_defs', 'position'), templates = await by('item_templates', 'name')
  const rules = await by('rules', 'id'), releases = await by('releases', 'release_date nulls last, id'), components = await by('components', 'lower(name)'), securityLevels = await by('security_levels', 'name')
  const sprints = await by('sprints', 'created_at'), workflows = await typeWorkflowList(d, p.id)
  const boards = await d.query(`select id, name, type, jql, position, jsonb_array_length(kanban_backlog) > 0 as has_backlog from boards where project_id = $1 order by position, lower(name), id`, [p.id])
  // field configurations (spec 0504): each work type's rules, and the scheme the project uses
  const fieldRules = await rulesFor(d, project.id)
  const screens = await screensFor(d, project.id)
  const [itss] = project.issueTypeScreenSchemeId ? await d.query<{ id: string; name: string }>('select id, name from issue_type_screen_schemes where id = $1', [project.issueTypeScreenSchemeId]) : []
  const [fcs] = project.fieldConfigSchemeId ? await d.query<{ id: string; name: string }>('select id, name from field_config_schemes where id = $1', [project.fieldConfigSchemeId]) : []
  return { ...project, role, statuses, transitions, types, fields, templates, rules, releases, components, securityLevels, sprints, workflows, boards, fieldRules, fieldConfigScheme: fcs ?? null, screens, issueTypeScreenScheme: itss ?? null }
}

export default plugin
