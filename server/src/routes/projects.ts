import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { minFor, need, roleOf, visible, type ProjectRole } from '../access.ts'
import { publish, subscribe } from '../events.ts'
import { audit, changes } from '../audit.ts'
import { enqueue, kickJobs } from '../jobs.ts'
import { backupBucket, backupSettings } from '../backups.ts'
import { rulesSchema } from '../transitions.ts'
import { dryRun } from '../rules.ts'
import { checkImport } from '../csvImport.ts'
import { getSetting } from '../settings.ts'

const uuid = z.string().uuid()
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const category = z.enum(['todo', 'in-progress', 'done'])

const DEFAULT_STATUSES = {
  kanban: [['To do', '#94a3b8', 'todo'], ['In progress', '#3b82f6', 'in-progress'], ['Done', '#22c55e', 'done']],
  scrum: [['To do', '#94a3b8', 'todo'], ['In progress', '#3b82f6', 'in-progress'], ['In review', '#a855f7', 'in-progress'], ['Done', '#22c55e', 'done']],
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Project key (PAY) or id (uuid). A project I cannot see is "not found" (its existence is not revealed). `min` is the role the
 *  request needs; by default reading needs any role and changing things needs member. Returns my role in it. */
export async function projectByKey(d: Db, req: { me: Me; method: string }, ref: string, min?: ProjectRole) {
  const byId = UUID.test(ref)
  const [p] = await d.query<{ id: string; leadId: string | null; key: string }>(
    `select id, lead_id, key from projects where workspace_id = $1 and ${byId ? 'id = $2' : 'key = $2'}`, [req.me.workspaceId, byId ? ref : ref.toUpperCase()])
  const role = p ? await roleOf(d, req.me, p.id) : null
  if (!p || !role) throw new HttpError(404, 'Project not found')
  need(role, min ?? minFor(req.method))
  return { ...p, role }
}

/** Project settings (workflow, fields, rules, people…) are for project admins. */
async function requireProjectAdmin(_req: FastifyRequest, p: { role: ProjectRole }) { need(p.role, 'admin') }

// Child collections of a project. `json` columns are stored as jsonb.
const CHILD = {
  statuses:    { table: 'statuses',       cols: ['name', 'description', 'color', 'category', 'wipLimit', 'position'] },
  transitions: { table: 'transitions',    cols: ['name', 'fromIds', 'toId', 'rules', 'typeKeys'], json: ['rules'] },
  fields:      { table: 'field_defs',     cols: ['name', 'kind', 'options', 'position'] },
  templates:   { table: 'item_templates', cols: ['name', 'type', 'title', 'description', 'priority', 'labels', 'estimate'] },
  rules:       { table: 'rules',          cols: ['name', 'enabled', 'trigger', 'actions'], json: ['trigger', 'actions'] },
  releases:    { table: 'releases',       cols: ['name', 'description', 'startDate', 'releaseDate'], ws: true },
  components:  { table: 'components',     cols: ['name', 'description', 'leadId', 'defaultAssignee'] },
} as const
type Kind = keyof typeof CHILD

const childPatch = {
  statuses: z.object({ name: z.string().min(1), description: z.string().max(500), color, category, wipLimit: z.number().int().positive().nullable(), position: z.number().int() }).partial(),
  transitions: z.object({
    name: z.string().min(1), fromIds: z.array(uuid).nullable().describe('null: from any status'),
    toId: uuid.nullable().describe('null: a loop, the item stays in its status'), rules: rulesSchema.describe('Restrict, validate, screen and actions'),
    typeKeys: z.array(z.string().max(40)).min(1).nullable().describe('Work types this transition is for (Jira\'s workflow per work type); null: every type'),
  }).partial(),
  fields: z.object({ name: z.string().min(1), kind: z.enum(['text', 'number', 'select', 'date']), options: z.array(z.string()).nullable(), position: z.number().int() }).partial(),
  templates: z.object({
    name: z.string().min(1), type: z.string().min(1).max(40), title: z.string(), description: z.string(),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']), labels: z.array(z.string()), estimate: z.number().nullable(),
  }).partial(),
  rules: z.object({
    name: z.string().min(1), enabled: z.boolean(),
    trigger: z.object({ kind: z.enum(['created', 'status', 'assigned']), to: uuid.optional() }),
    actions: z.array(z.object({ kind: z.enum(['assign', 'priority', 'label', 'status', 'comment']) }).passthrough()),
  }).partial(),
  releases: z.object({ name: z.string().min(1), description: z.string(), startDate: z.string().nullable(), releaseDate: z.string().nullable() }).partial(),
  components: z.object({
    name: z.string().trim().min(1).max(100), description: z.string().max(2000), leadId: uuid.nullable(),
    defaultAssignee: z.enum(['none', 'component_lead', 'project_lead']).describe('Who new work in this component goes to when nobody is chosen'),
  }).partial(),
}
const REQUIRED: Record<Kind, string[]> = {
  statuses: ['name', 'color', 'category'], transitions: ['name', 'toId'], fields: ['name', 'kind'],
  templates: ['name', 'type', 'title'], rules: ['name', 'trigger', 'actions'], releases: ['name'], components: ['name'],
}
// Create = the same shape with the required keys enforced
const childCreate = Object.fromEntries((Object.keys(childPatch) as Kind[]).map(k =>
  [k, (childPatch[k] as z.ZodObject<any>).required(Object.fromEntries(REQUIRED[k].map(r => [r, true])) as any)
    .extend({ id: uuid.optional().describe('Client-chosen id') })])) as unknown as typeof childPatch

const projectBody = z.object({
  name: z.string().min(1).max(120), description: z.string(), color, leadId: uuid.nullable(),
  boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
}).partial()

const keyP = z.object({ key: z.string().describe('Project key (PAY) or id (uuid)') })
const keyIdP = keyP.extend({ id: uuid })
const T = { me: ['Account'], projects: ['Projects'], config: ['Project settings'], sprints: ['Sprints'] }

/** The workflow as it is now, in the shape versions keep (camelCase, ordered, so equal workflows compare equal). */
async function workflowNow(d: Db, projectId: string) {
  const [w] = await d.query<any>(`select
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description, 'color', color, 'category', category, 'wipLimit', wip_limit, 'position', position) order by position, id), '[]') from statuses where project_id = $1) as statuses,
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'fromIds', from_ids, 'toId', to_id, 'rules', rules, 'typeKeys', type_keys) order by id), '[]') from transitions where project_id = $1) as transitions,
    (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'name', name, 'color', color, 'icon', icon) order by position, key), '[]') from work_types where project_id = $1) as types`, [projectId])
  return w as { statuses: any[]; transitions: any[]; types: any[] }
}

/** Before a status goes: every item on it (live or deleted) moves to `moveTo`, with a history entry for the live ones,
 *  and transitions stop starting from it. An in-use status needs somewhere to send its items. */
async function moveOffStatus(d: Db, req: { me: Me; ip?: string }, p: { id: string; key: string }, statusId: string, moveTo?: string) {
  const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from issues where status_id = $1', [statusId]) as any
  if (n && !moveTo) throw new HttpError(409, `${n} work items are in this status: choose a status to move them to (moveTo)`)
  if (n && (moveTo === statusId || !(await d.query('select 1 from statuses where id = $1 and project_id = $2', [moveTo, p.id])).length))
    throw new HttpError(400, 'Choose another status of this project to move the work items to')
  if (n) {
    await d.query(`insert into activity (issue_id, actor_id, field, from_value, to_value, text)
                   select id, $3, 'statusId', $1::text, $2::text, 'Changed status (workflow update)' from issues where status_id = $1::uuid and deleted_at is null`, [statusId, moveTo, req.me.id])
    await d.query('update issues set status_id = $2, version = version + 1, updated_at = now() where status_id = $1', [statusId, moveTo])
    await audit(d, req, { action: 'project.status.items_moved', type: 'status', id: statusId, project: p, after: { items: n, to: moveTo } })
    await publish(d, p.id, { type: 'issues.reranked' })
  }
  await d.query(`update transitions set from_ids = array_remove(from_ids, $2::uuid) where project_id = $1 and $2::uuid = any(from_ids)`, [p.id, statusId])
  await d.query(`delete from transitions where project_id = $1 and from_ids = '{}'`, [p.id])
}

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/me', { schema: { tags: T.me, summary: 'Current user and role' } }, async req => ({
    ...req.me, groupIds: (await db.query<{ groupId: string }>('select group_id from group_members where user_id = $1', [req.me.id])).map(g => g.groupId),
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
  app.get('/users', { schema: { tags: T.me, summary: 'Active users in the workspace (first 1000 by name; use /users/search for more)' } }, async req => db.query(
    `select u.id, u.name, u.initials, u.color, u.title, u.email, m.role from users u
     join memberships m on m.user_id = u.id and m.workspace_id = $1 where u.active order by lower(u.name), u.id limit 1000`, [req.me.workspaceId]))

  app.get('/users/search', { schema: { tags: T.me, summary: 'Find users by name or e-mail, in name order (keyset-paginated). With `project`, only people who can work in that project', querystring: searchQ.extend({ project: z.string().optional().describe('Project key or id: only its members (and workspace admins)') }) } }, async req => {
    const { query, limit } = req.query, cur = readCursor(req.query.cursor)
    const args: unknown[] = [req.me.workspaceId]
    const where = ['u.active']
    if (req.query.project) {
      const p = await projectByKey(db, req, req.query.project, 'viewer')
      args.push(p.id)
      where.push(`(m.role in ('owner', 'admin') or exists (select 1 from project_access pa where pa.project_id = $${args.length} and pa.user_id = u.id))`)
    }
    if (query) { args.push(like(query)); where.push(`(u.name ilike $${args.length} or u.email ilike $${args.length})`) }
    if (cur) { args.push(cur[0].toLowerCase(), cur[1]); where.push(`(lower(u.name), u.id) > ($${args.length - 1}, $${args.length}::uuid)`) }
    args.push(limit + 1)
    const rows = await db.query<any>(
      `select u.id, u.name, u.initials, u.color, u.title, u.email, m.role from users u
         join memberships m on m.user_id = u.id and m.workspace_id = $1 where ${where.join(' and ')} order by lower(u.name), u.id limit $${args.length}`, args)
    const more = rows.length > limit, items = more ? rows.slice(0, limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).name, items.at(-1).id) : null }
  })

  const PROJECT_ROW = `p.id, p.key, p.name, p.description, p.color, p.template, p.lead_id, p.created_at, p.archived_at,
            (s.user_id is not null) as starred,
            (select count(*) from issues i join statuses st on st.id = i.status_id
              where i.project_id = p.id and i.deleted_at is null and st.category <> 'done') as open_count`
  // First 1000 only: use /projects/search for more. Archived projects are hidden unless asked for.
  app.get('/projects', { schema: { tags: T.projects, summary: 'List the active projects I can see, with star flag and open-issue count (first 1000 by name; use /projects/search for more)' } }, async req => {
    const args: unknown[] = [req.me.workspaceId, req.me.id]
    const see = visible(req.me, 'p.id', args)
    return db.query(
      `select ${PROJECT_ROW} from projects p left join stars s on s.project_id = p.id and s.user_id = $2
        where p.workspace_id = $1 and p.archived_at is null and ${see} order by lower(p.name), p.id limit 1000`, args)
  })

  app.get('/projects/search', { schema: {
    tags: T.projects, summary: 'Find projects by name or key, in name order (keyset-paginated)',
    querystring: searchQ.extend({ archived: z.enum(['0', '1']).default('0').describe('1 = archived projects instead of active ones'), starred: z.enum(['0', '1']).optional().describe('1 = only my starred projects') }),
  } }, async req => {
    const { query, limit } = req.query, cur = readCursor(req.query.cursor)
    const args: unknown[] = [req.me.workspaceId, req.me.id]
    const where = ['p.workspace_id = $1', req.query.archived === '1' ? 'p.archived_at is not null' : 'p.archived_at is null', visible(req.me, 'p.id', args)]
    if (query) { args.push(like(query)); where.push(`(p.name ilike $${args.length} or p.key ilike $${args.length})`) }
    if (req.query.starred === '1') where.push('s.user_id is not null')
    if (cur) { args.push(cur[0].toLowerCase(), cur[1]); where.push(`(lower(p.name), p.id) > ($${args.length - 1}, $${args.length}::uuid)`) }
    args.push(limit + 1)
    const rows = await db.query<any>(
      `select ${PROJECT_ROW} from projects p left join stars s on s.project_id = p.id and s.user_id = $2
        where ${where.join(' and ')} order by lower(p.name), p.id limit $${args.length}`, args)
    const more = rows.length > limit, items = more ? rows.slice(0, limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).name, items.at(-1).id) : null }
  })

  app.post('/projects/:key/archive', { schema: { tags: T.projects, summary: 'Archive a project: hidden from lists, data kept, can be restored', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    await tx(async d => {
      const [r] = await d.query('update projects set archived_at = now() where id = $1 and archived_at is null returning id', [p.id])
      if (r) await audit(d, req, { action: 'project.archived', type: 'project', id: p.id, name: p.key, project: p })
    })
    return projectDetail(db, req.me.workspaceId, p.key, p.role)
  })
  app.post('/projects/:key/restore', { schema: { tags: T.projects, summary: 'Restore an archived project', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    await tx(async d => {
      const [r] = await d.query('update projects set archived_at = null where id = $1 and archived_at is not null returning id', [p.id])
      if (r) await audit(d, req, { action: 'project.restored', type: 'project', id: p.id, name: p.key, project: p })
    })
    return projectDetail(db, req.me.workspaceId, p.key, p.role)
  })

  const createProject = projectBody.required({ name: true }).extend({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), template: z.enum(['kanban', 'scrum']) })
  app.post('/projects', { schema: { tags: T.projects, summary: 'Create a project with default statuses', body: createProject } }, async req => {
    const b = req.body
    return tx(async d => {
      const [p] = await d.query<{ id: string }>(
        `insert into projects (workspace_id, key, name, description, color, template, lead_id)
         values ($1, $2, $3, $4, coalesce($5, '#6366f1'), $6, $7) returning id`,
        [req.me.workspaceId, b.key, b.name, b.description ?? '', b.color ?? null, b.template, b.leadId ?? req.me.id])
      // The creator administers the project from the start (and so does the lead, if that is someone else)
      for (const u of new Set([req.me.id, b.leadId ?? req.me.id]))
        await d.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, 'admin', $3) on conflict do nothing`, [p!.id, u, req.me.id])
      const st = DEFAULT_STATUSES[b.template]
      // Each status can be reached from any status, as a new workflow starts in Jira (people then narrow it in the editor)
      for (const [i, [name, c, cat]] of st.entries()) {
        const [s] = await d.query<{ id: string }>('insert into statuses (project_id, name, color, category, position) values ($1, $2, $3, $4, $5) returning id', [p!.id, name, c, cat, i])
        await d.query('insert into transitions (project_id, name, from_ids, to_id) values ($1, $2, null, $3)', [p!.id, name, s!.id])
      }
      await audit(d, req, { action: 'project.created', type: 'project', id: p!.id, name: b.key, project: { id: p!.id, key: b.key }, after: { name: b.name, template: b.template } })
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
    const p = await projectByKey(db, req, req.params.key)
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
    const p = await projectByKey(db, req, req.params.key, 'viewer')
    await db.query('insert into stars (user_id, project_id) values ($1, $2) on conflict do nothing', [req.me.id, p.id])
    reply.code(204).send()
  })
  app.delete('/projects/:key/star', { schema: { tags: T.projects, summary: 'Unstar a project', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key, 'viewer')
    await db.query('delete from stars where user_id = $1 and project_id = $2', [req.me.id, p.id])
    reply.code(204).send()
  })

  // Realtime stream of changes in a project (Server-Sent Events)
  app.get('/projects/:key/events', { schema: { tags: T.projects, summary: 'Live change stream (Server-Sent Events)', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    reply.hijack()
    subscribe(p.id, reply, req.me.id)
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
        return row
      })
    })

    app.patch(`/projects/:key/${kind}/:id`, { schema: { tags: T.config, summary: `Update a ${what}`, params: keyIdP, body: childPatch[kind] } }, async req => {
      const p = await projectByKey(db, req, req.params.key)
      await requireProjectAdmin(req, p)
      const w = pick(req.body as Record<string, unknown>, [...cfg.cols], json)
      if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
      return tx(async d => {
        const [before] = await d.query(`select * from ${cfg.table} where id = $1 and project_id = $2 for update`, [req.params.id, p.id])
        if (!before) throw new HttpError(404, 'Not found')
        const [row] = await d.query(
          `update ${cfg.table} set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and project_id = $2 returning *`,
          [req.params.id, p.id, ...w.vals])
        const c = changes(before, req.body as Record<string, unknown>)
        if (c.changed) await audit(d, req, { action: `project.${what.replace(' ', '_')}.updated`, type: what, id: row.id, name: row.name ?? null, project: p, before: c.before, after: c.after })
        return row
      })
    })

    app.delete(`/projects/:key/${kind}/:id`, { schema: {
      tags: T.config, summary: kind === 'statuses' ? 'Remove a status. Its work items (every one, also deleted ones) move to `moveTo`, which an in-use status needs' : `Remove a ${what}`,
      params: keyIdP, ...(kind === 'statuses' ? { querystring: z.object({ moveTo: uuid.optional().describe('Status that receives its work items') }) } : {}),
    } }, async (req, reply) => {
      const p = await projectByKey(db, req, req.params.key)
      await requireProjectAdmin(req, p)
      await tx(async d => {
        if (kind === 'statuses') await moveOffStatus(d, req, p, req.params.id, (req.query as { moveTo?: string }).moveTo)
        const [gone] = await d.query(`delete from ${cfg.table} where id = $1 and project_id = $2 returning *`, [req.params.id, p.id])
        if (!gone) throw new HttpError(404, 'Not found')
        await audit(d, req, { action: `project.${what.replace(' ', '_')}.deleted`, type: what, id: gone.id, name: gone.name ?? null, project: p, before: gone })
        // a deleted custom field takes its values with it, so no item keeps a value for a field that no longer exists
        if (kind === 'fields') await d.query('update issues set custom = custom - $2 where project_id = $1 and custom ? $2', [p.id, req.params.id])
        // …and a deleted component or release lets go of the items that named it
        if (kind === 'components') await d.query('update issues set component_ids = array_remove(component_ids, $2::uuid) where project_id = $1 and $2::uuid = any(component_ids)', [p.id, req.params.id])
        if (kind === 'releases') await d.query('update issues set affects_release_ids = array_remove(affects_release_ids, $2::uuid) where project_id = $1 and $2::uuid = any(affects_release_ids)', [p.id, req.params.id])
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

  // ── Work types (Jira's issue types): the built-in four can be renamed and recoloured; a project can add its own,
  // and removing one moves its items to another type ──
  const ICONS = ['zap', 'bookmark', 'check', 'bug', 'flag', 'star', 'wrench', 'book', 'shield', 'lightbulb', 'rocket', 'circle'] as const
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
      if (['epic', 'story', 'task', 'bug'].includes(t.key)) throw new HttpError(409, `${t.name} is built in: rename it instead`)
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
      // transitions limited to it no longer name it; one left for no type at all is for every type again
      await d.query(`update transitions set type_keys = nullif(array_remove(type_keys, $2), '{}') where project_id = $1 and $2 = any(type_keys)`, [p.id, t.key])
      await d.query('delete from work_types where id = $1', [t.id])
      await audit(d, req, { action: 'project.work_type.deleted', type: 'work type', name: t.name, project: p, before: { name: t.name, items: n }, after: moveTo ? { movedTo: moveTo } : undefined })
    })
    reply.code(204).send()
  })

  // ── Workflow versions: publishing records the workflow as it is now; earlier ones can be read, compared and restored ──
  const versionP = keyP.extend({ version: z.coerce.number().int().positive() })
  app.get('/projects/:key/workflow/versions', { schema: { tags: T.config, summary: 'Published versions of the workflow, newest first', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return db.query(`select v.version, v.note, v.published_at, u.name as published_by, jsonb_array_length(v.statuses) as statuses, jsonb_array_length(v.transitions) as transitions
                       from workflow_versions v left join users u on u.id = v.published_by where v.project_id = $1 order by v.version desc limit 200`, [p.id])
  })
  app.get('/projects/:key/workflow/versions/:version', { schema: { tags: T.config, summary: 'One published version of the workflow, in full', params: versionP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [v] = await db.query(`select v.version, v.note, v.published_at, u.name as published_by, v.statuses, v.transitions, v.types
                                  from workflow_versions v left join users u on u.id = v.published_by where v.project_id = $1 and v.version = $2`, [p.id, req.params.version])
    if (!v) throw new HttpError(404, 'No such version')
    return v
  })
  app.post('/projects/:key/workflow/versions', { schema: {
    tags: T.config, summary: 'Publish the workflow as it is now (project admins). Nothing new is recorded when it hasn\'t changed since the last version',
    params: keyP, body: z.object({ note: z.string().max(500).default('') }).default({ note: '' }),
  } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      await d.query('select 1 from projects where id = $1 for update', [p.id])   // one publish at a time per project
      const now = await workflowNow(d, p.id)
      const [last] = await d.query<any>('select version, statuses, transitions, types from workflow_versions where project_id = $1 order by version desc limit 1', [p.id])
      const same = last && JSON.stringify([last.statuses, last.transitions, last.types]) === JSON.stringify([now.statuses, now.transitions, now.types])
      if (!same) {
        await d.query(`insert into workflow_versions (project_id, version, statuses, transitions, types, note, published_by) values ($1, $2, $3, $4, $5, $6, $7)`,
          [p.id, (last?.version ?? 0) + 1, JSON.stringify(now.statuses), JSON.stringify(now.transitions), JSON.stringify(now.types), req.body.note, req.me.id])
        await audit(d, req, { action: 'project.workflow.published', type: 'workflow', name: `Version ${(last?.version ?? 0) + 1}`, project: p, after: { note: req.body.note, statuses: now.statuses.length, transitions: now.transitions.length } })
        reply.code(201)
      }
      return { version: same ? last.version : (last?.version ?? 0) + 1, created: !same }
    })
  })

  // ── Automation's audit log and dry run (project admins, as in Jira) ──
  app.get('/projects/:key/automation/runs', { schema: {
    tags: T.config, summary: 'Recent automation runs, newest first: what started each, the item, what each action did, and how it ended (90 days)',
    params: keyP, querystring: z.object({ rule: uuid.optional(), result: z.enum(['success', 'some_skipped', 'no_change', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
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
    body: z.object({ issue: z.string().describe('Key of a work item in this project'), actions: childPatch.rules.shape.actions.unwrap() }),
  } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [i] = await d.query<any>(`select i.id, i.reporter_id, pr.lead_id from issues i join projects pr on pr.id = i.project_id
                                       where i.project_id = $1 and pr.key || '-' || i.number = upper($2) and i.deleted_at is null`, [p.id, req.body.issue])
      if (!i) throw new HttpError(404, 'No such work item in this project', { issue: 'Not found here' })
      return dryRun(d, { projectId: p.id, issueId: i.id, reporterId: i.reporterId, leadId: i.leadId }, { actions: req.body.actions })
    })
  })

  // ── CSV import (Jira's importer): check every row first; import in the background; a rerun adds nothing twice ──
  const importMapping = z.record(z.string().regex(/^(title|description|type|status|priority|assignee|labels|estimate|dueDate|startDate|components|fixVersion|custom\.[0-9a-f-]{36})$/), z.number().int().min(0))
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

  // Releasing a version moves its unfinished work to `moveTo` (or clears it)
  app.post('/projects/:key/releases/:id/release', { schema: {
    tags: T.config, summary: 'Mark a release shipped; unfinished work moves to another release', params: keyIdP,
    body: z.object({ moveTo: uuid.nullable().default(null).describe('Release that receives unfinished work') }).default({ moveTo: null }),
  } }, async req => {
    const { moveTo } = req.body
    const p = await projectByKey(db, req, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [r] = await d.query(`update releases set released = true, released_at = now() where id = $1 and project_id = $2 returning *`, [req.params.id, p.id])
      if (!r) throw new HttpError(404, 'Not found')
      await d.query(
        `update issues set release_id = $3, version = version + 1, updated_at = now()
          where release_id = $1 and project_id = $2 and deleted_at is null
            and status_id in (select id from statuses where project_id = $2 and category <> 'done')`, [req.params.id, p.id, moveTo])
      await audit(d, req, { action: 'project.release.released', type: 'release', id: r.id, name: r.name, project: p, after: { moveTo } })
      return r
    })
  })

  // ── Sprints ──
  const sprintBody = z.object({ name: z.string().min(1), goal: z.string(), endsAt: z.string().datetime().nullable() }).partial()
  const sprintCreate = sprintBody.required({ name: true }).extend({ id: uuid.optional().describe('Client-chosen id') })

  app.post('/projects/:key/sprints', { schema: { tags: T.sprints, summary: 'Create a sprint', params: keyP, body: sprintCreate } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const b = req.body
    const [s] = await db.query(
      'insert into sprints (id, workspace_id, project_id, name, goal, ends_at) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5) returning *',
      [req.me.workspaceId, p.id, b.name, b.goal ?? '', b.endsAt ?? null, b.id ?? null])
    return s
  })

  app.patch('/projects/:key/sprints/:id', { schema: { tags: T.sprints, summary: 'Update a sprint', params: keyIdP, body: sprintBody } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const w = pick(req.body, ['name', 'goal', 'endsAt'])
    if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
    const [s] = await db.query(
      `update sprints set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and project_id = $2 returning *`,
      [req.params.id, p.id, ...w.vals])
    if (!s) throw new HttpError(404, 'Not found')
    return s
  })

  app.delete('/projects/:key/sprints/:id', { schema: { tags: T.sprints, summary: 'Delete a planned sprint', params: keyIdP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await db.query(`delete from sprints where id = $1 and project_id = $2 and state = 'planned'`, [req.params.id, p.id])
    reply.code(204).send()
  })

  app.post('/projects/:key/sprints/:id/start', { schema: {
    tags: T.sprints, summary: 'Start a sprint (snapshots committed points)', params: keyIdP, body: z.object({ endsAt: z.string().datetime() }),
  } }, async req => {
    const { endsAt } = req.body
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      const [s] = await d.query(
        `update sprints set state = 'active', started_at = now(), ends_at = $3,
                committed = (select coalesce(sum(estimate), 0) from issues where sprint_id = sprints.id and deleted_at is null)
          where id = $1 and project_id = $2 and state = 'planned' returning *`, [req.params.id, p.id, endsAt])
      if (!s) throw new HttpError(409, 'Sprint is not planned, or another sprint is already active')
      return s
    })
  })

  app.post('/projects/:key/sprints/:id/complete', { schema: {
    tags: T.sprints, summary: 'Complete a sprint; unfinished work moves to another sprint or the backlog', params: keyIdP,
    body: z.object({ moveTo: uuid.nullable().default(null).describe('Sprint that receives unfinished work (null = backlog)') }).default({ moveTo: null }),
  } }, async req => {
    const { moveTo } = req.body
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      const [s] = await d.query(
        `update sprints set state = 'closed', completed_at = now(),
                completed = (select coalesce(sum(i.estimate), 0) from issues i join statuses st on st.id = i.status_id
                              where i.sprint_id = sprints.id and i.deleted_at is null and st.category = 'done'),
                issue_ids = array(select id from issues where sprint_id = sprints.id and deleted_at is null)
          where id = $1 and project_id = $2 and state = 'active' returning *`, [req.params.id, p.id])
      if (!s) throw new HttpError(409, 'Sprint is not active')
      await d.query(
        `update issues set sprint_id = $2, version = version + 1, updated_at = now()
          where sprint_id = $1 and deleted_at is null
            and status_id in (select id from statuses where project_id = $3 and category <> 'done')`, [s.id, moveTo, p.id])
      return s
    })
  })
}

/** Everything the project screens need in one call (workflow, fields, releases, templates, rules, sprints). */
export async function projectDetail(d: Db, ws: string, key: string, role: ProjectRole) {
  const [project] = await d.query<any>('select * from projects where workspace_id = $1 and key = $2', [ws, key.toUpperCase()])
  const p = { id: project.id as string }
  const by = (table: string, order: string) => d.query(`select * from ${table} where project_id = $1 order by ${order}`, [p.id])
  // Sequential: `d` may be a single transaction connection, which can't run queries in parallel
  const statuses = await by('statuses', 'position'), transitions = await by('transitions', 'id'), types = await by('work_types', 'position, name')
  const fields = await by('field_defs', 'position'), templates = await by('item_templates', 'name')
  const rules = await by('rules', 'id'), releases = await by('releases', 'release_date nulls last, id'), components = await by('components', 'lower(name)'), securityLevels = await by('security_levels', 'name')
  const sprints = await by('sprints', 'created_at')
  return { ...project, role, statuses, transitions, types, fields, templates, rules, releases, components, securityLevels, sprints }
}

export default plugin
