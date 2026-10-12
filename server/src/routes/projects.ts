import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, isAdmin, requireAdmin, requireWrite } from '../auth.ts'
import { subscribe } from '../events.ts'

const uuid = z.string().uuid()
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const category = z.enum(['todo', 'in-progress', 'done'])

const DEFAULT_STATUSES = {
  kanban: [['To do', '#94a3b8', 'todo'], ['In progress', '#3b82f6', 'in-progress'], ['Done', '#22c55e', 'done']],
  scrum: [['To do', '#94a3b8', 'todo'], ['In progress', '#3b82f6', 'in-progress'], ['In review', '#a855f7', 'in-progress'], ['Done', '#22c55e', 'done']],
} as const

export async function projectByKey(d: Db, ws: string, key: string) {
  const [p] = await d.query<{ id: string; leadId: string | null; key: string }>(
    'select id, lead_id, key from projects where workspace_id = $1 and key = $2', [ws, key.toUpperCase()])
  if (!p) throw new HttpError(404, 'Project not found')
  return p
}

/** Project settings (workflow, fields, rules…) may be changed by workspace admins or the project lead. */
async function requireProjectAdmin(req: FastifyRequest, p: { leadId: string | null }) {
  if (!isAdmin(req.me.role) && p.leadId !== req.me.id) throw new HttpError(403, 'Project admin only')
}

// Child collections of a project. `json` columns are stored as jsonb.
const CHILD = {
  statuses:    { table: 'statuses',       cols: ['name', 'color', 'category', 'wipLimit', 'position'] },
  transitions: { table: 'transitions',    cols: ['name', 'fromIds', 'toId'] },
  fields:      { table: 'field_defs',     cols: ['name', 'kind', 'options', 'position'] },
  templates:   { table: 'item_templates', cols: ['name', 'type', 'title', 'description', 'priority', 'labels', 'estimate'] },
  rules:       { table: 'rules',          cols: ['name', 'enabled', 'trigger', 'actions'], json: ['trigger', 'actions'] },
  releases:    { table: 'releases',       cols: ['name', 'description', 'startDate', 'releaseDate'], ws: true },
} as const
type Kind = keyof typeof CHILD

const childBody: Record<Kind, z.ZodType<Record<string, unknown>>> = {
  statuses: z.object({ name: z.string().min(1), color, category, wipLimit: z.number().int().positive().nullable(), position: z.number().int() }).partial(),
  transitions: z.object({ name: z.string().min(1), fromIds: z.array(uuid).nullable(), toId: uuid }).partial(),
  fields: z.object({ name: z.string().min(1), kind: z.enum(['text', 'number', 'select', 'date']), options: z.array(z.string()).nullable(), position: z.number().int() }).partial(),
  templates: z.object({
    name: z.string().min(1), type: z.enum(['epic', 'story', 'task', 'bug']), title: z.string(), description: z.string(),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']), labels: z.array(z.string()), estimate: z.number().nullable(),
  }).partial(),
  rules: z.object({
    name: z.string().min(1), enabled: z.boolean(),
    trigger: z.object({ kind: z.enum(['created', 'status', 'assigned']), to: uuid.optional() }),
    actions: z.array(z.object({ kind: z.enum(['assign', 'priority', 'label', 'status', 'comment']) }).passthrough()),
  }).partial(),
  releases: z.object({ name: z.string().min(1), description: z.string(), startDate: z.string().nullable(), releaseDate: z.string().nullable() }).partial(),
}
// Required on create (everything is optional in the shared schema above so PATCH can reuse it)
const REQUIRED: Record<Kind, string[]> = {
  statuses: ['name', 'color', 'category'], transitions: ['name', 'toId'], fields: ['name', 'kind'],
  templates: ['name', 'type', 'title'], rules: ['name', 'trigger', 'actions'], releases: ['name'],
}

const projectBody = z.object({
  name: z.string().min(1).max(120), description: z.string(), color, leadId: uuid.nullable(),
  boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
}).partial()

const plugin: FastifyPluginAsync = async app => {
  app.get('/me', async req => req.me)

  app.get('/users', async req => db.query(
    `select u.id, u.name, u.initials, u.color, u.title, u.email, m.role from users u
     join memberships m on m.user_id = u.id and m.workspace_id = $1 where u.active order by u.name`, [req.me.workspaceId]))

  app.get('/projects', async req => db.query(
    `select p.id, p.key, p.name, p.description, p.color, p.template, p.lead_id, p.created_at,
            (s.user_id is not null) as starred,
            (select count(*) from issues i join statuses st on st.id = i.status_id
              where i.project_id = p.id and i.deleted_at is null and st.category <> 'done') as open_count
       from projects p left join stars s on s.project_id = p.id and s.user_id = $2
      where p.workspace_id = $1 order by p.name`, [req.me.workspaceId, req.me.id]))

  app.post('/projects', async req => {
    requireWrite(req)
    const b = projectBody.required({ name: true }).extend({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), template: z.enum(['kanban', 'scrum']) }).parse(req.body)
    return tx(async d => {
      const [p] = await d.query<{ id: string }>(
        `insert into projects (workspace_id, key, name, description, color, template, lead_id)
         values ($1, $2, $3, $4, coalesce($5, '#6366f1'), $6, $7) returning id`,
        [req.me.workspaceId, b.key, b.name, b.description ?? '', b.color ?? null, b.template, b.leadId ?? req.me.id])
      const st = DEFAULT_STATUSES[b.template]
      for (const [i, [name, c, cat]] of st.entries())
        await d.query('insert into statuses (project_id, name, color, category, position) values ($1, $2, $3, $4, $5)', [p!.id, name, c, cat, i])
      return projectDetail(d, req.me.workspaceId, b.key)
    })
  })

  app.get<{ Params: { key: string } }>('/projects/:key', async req => projectDetail(db, req.me.workspaceId, req.params.key))

  app.patch<{ Params: { key: string } }>('/projects/:key', async req => {
    requireWrite(req)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await requireProjectAdmin(req, p)
    const w = pick(projectBody.parse(req.body), ['name', 'description', 'color', 'leadId', 'boardPrefs', 'layout'], ['boardPrefs', 'layout'])
    if (w.keys.length) await db.query(
      `update projects set ${w.cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [p.id, ...w.vals])
    return projectDetail(db, req.me.workspaceId, req.params.key)
  })

  app.delete<{ Params: { key: string } }>('/projects/:key', async (req, reply) => {
    requireAdmin(req)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await db.query('delete from projects where id = $1', [p.id])
    reply.code(204).send()
  })

  app.put<{ Params: { key: string } }>('/projects/:key/star', async (req, reply) => {
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await db.query('insert into stars (user_id, project_id) values ($1, $2) on conflict do nothing', [req.me.id, p.id])
    reply.code(204).send()
  })
  app.delete<{ Params: { key: string } }>('/projects/:key/star', async (req, reply) => {
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await db.query('delete from stars where user_id = $1 and project_id = $2', [req.me.id, p.id])
    reply.code(204).send()
  })

  // Realtime stream of changes in a project (Server-Sent Events)
  app.get<{ Params: { key: string } }>('/projects/:key/events', async (req, reply) => {
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    reply.hijack()
    subscribe(p.id, reply)
  })

  // ── Child collections: POST/PATCH/DELETE /projects/:key/<kind>[/:id] ──
  for (const kind of Object.keys(CHILD) as Kind[]) {
    const cfg = CHILD[kind] as { table: string; cols: readonly string[]; json?: readonly string[]; ws?: boolean }
    const json = [...(cfg.json ?? [])]

    app.post<{ Params: { key: string } }>(`/projects/:key/${kind}`, async req => {
      requireWrite(req)
      const p = await projectByKey(db, req.me.workspaceId, req.params.key)
      await requireProjectAdmin(req, p)
      const body = childBody[kind].parse(req.body)
      for (const r of REQUIRED[kind]) if (body[r] === undefined) throw new HttpError(400, `${r} is required`)
      const w = pick(body, [...cfg.cols], json)
      const extra = cfg.ws ? ['workspace_id'] : []
      const cols = ['project_id', ...extra, ...w.cols]
      const vals = [p.id, ...(cfg.ws ? [req.me.workspaceId] : []), ...w.vals]
      const [row] = await db.query(
        `insert into ${cfg.table} (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, vals)
      return row
    })

    app.patch<{ Params: { key: string; id: string } }>(`/projects/:key/${kind}/:id`, async req => {
      requireWrite(req)
      const p = await projectByKey(db, req.me.workspaceId, req.params.key)
      await requireProjectAdmin(req, p)
      const w = pick(childBody[kind].parse(req.body), [...cfg.cols], json)
      if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
      const [row] = await db.query(
        `update ${cfg.table} set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and project_id = $2 returning *`,
        [uuid.parse(req.params.id), p.id, ...w.vals])
      if (!row) throw new HttpError(404, 'Not found')
      return row
    })

    app.delete<{ Params: { key: string; id: string } }>(`/projects/:key/${kind}/:id`, async (req, reply) => {
      requireWrite(req)
      const p = await projectByKey(db, req.me.workspaceId, req.params.key)
      await requireProjectAdmin(req, p)
      const r = await db.query(`delete from ${cfg.table} where id = $1 and project_id = $2 returning id`, [uuid.parse(req.params.id), p.id])
      if (!r.length) throw new HttpError(404, 'Not found')
      reply.code(204).send()
    })
  }

  // Releasing a version moves its unfinished work to `moveTo` (or clears it)
  app.post<{ Params: { key: string; id: string } }>('/projects/:key/releases/:id/release', async req => {
    requireWrite(req)
    const { moveTo } = z.object({ moveTo: uuid.nullable().default(null) }).parse(req.body ?? {})
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await requireProjectAdmin(req, p)
    return tx(async d => {
      const [r] = await d.query(`update releases set released = true, released_at = now() where id = $1 and project_id = $2 returning *`, [req.params.id, p.id])
      if (!r) throw new HttpError(404, 'Not found')
      await d.query(
        `update issues set release_id = $3, version = version + 1, updated_at = now()
          where release_id = $1 and project_id = $2 and deleted_at is null
            and status_id in (select id from statuses where project_id = $2 and category <> 'done')`, [req.params.id, p.id, moveTo])
      return r
    })
  })

  // ── Sprints ──
  const sprintBody = z.object({ name: z.string().min(1), goal: z.string(), endsAt: z.string().datetime().nullable() }).partial()

  app.post<{ Params: { key: string } }>('/projects/:key/sprints', async req => {
    requireWrite(req)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    const b = sprintBody.required({ name: true }).parse(req.body)
    const [s] = await db.query(
      'insert into sprints (workspace_id, project_id, name, goal, ends_at) values ($1, $2, $3, $4, $5) returning *',
      [req.me.workspaceId, p.id, b.name, b.goal ?? '', b.endsAt ?? null])
    return s
  })

  app.patch<{ Params: { key: string; id: string } }>('/projects/:key/sprints/:id', async req => {
    requireWrite(req)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    const w = pick(sprintBody.parse(req.body), ['name', 'goal', 'endsAt'])
    if (!w.keys.length) throw new HttpError(400, 'Nothing to update')
    const [s] = await db.query(
      `update sprints set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and project_id = $2 returning *`,
      [uuid.parse(req.params.id), p.id, ...w.vals])
    if (!s) throw new HttpError(404, 'Not found')
    return s
  })

  app.delete<{ Params: { key: string; id: string } }>('/projects/:key/sprints/:id', async (req, reply) => {
    requireWrite(req)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    await db.query(`delete from sprints where id = $1 and project_id = $2 and state = 'planned'`, [uuid.parse(req.params.id), p.id])
    reply.code(204).send()
  })

  app.post<{ Params: { key: string; id: string } }>('/projects/:key/sprints/:id/start', async req => {
    requireWrite(req)
    const { endsAt } = z.object({ endsAt: z.string().datetime() }).parse(req.body)
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    return tx(async d => {
      const [s] = await d.query(
        `update sprints set state = 'active', started_at = now(), ends_at = $3,
                committed = (select coalesce(sum(estimate), 0) from issues where sprint_id = sprints.id and deleted_at is null)
          where id = $1 and project_id = $2 and state = 'planned' returning *`, [uuid.parse(req.params.id), p.id, endsAt])
      if (!s) throw new HttpError(409, 'Sprint is not planned, or another sprint is already active')
      return s
    })
  })

  app.post<{ Params: { key: string; id: string } }>('/projects/:key/sprints/:id/complete', async req => {
    requireWrite(req)
    const { moveTo } = z.object({ moveTo: uuid.nullable().default(null) }).parse(req.body ?? {})
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    return tx(async d => {
      const [s] = await d.query(
        `update sprints set state = 'closed', completed_at = now(),
                completed = (select coalesce(sum(i.estimate), 0) from issues i join statuses st on st.id = i.status_id
                              where i.sprint_id = sprints.id and i.deleted_at is null and st.category = 'done'),
                issue_ids = array(select id from issues where sprint_id = sprints.id and deleted_at is null)
          where id = $1 and project_id = $2 and state = 'active' returning *`, [uuid.parse(req.params.id), p.id])
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
export async function projectDetail(d: Db, ws: string, key: string) {
  const p = await projectByKey(d, ws, key)
  const [project] = await d.query('select * from projects where id = $1', [p.id])
  const by = (table: string, order: string) => d.query(`select * from ${table} where project_id = $1 order by ${order}`, [p.id])
  // Sequential: `d` may be a single transaction connection, which can't run queries in parallel
  const statuses = await by('statuses', 'position'), transitions = await by('transitions', 'id')
  const fields = await by('field_defs', 'position'), templates = await by('item_templates', 'name')
  const rules = await by('rules', 'id'), releases = await by('releases', 'release_date nulls last, id')
  const sprints = await by('sprints', 'created_at')
  return { ...project, statuses, transitions, fields, templates, rules, releases, sprints }
}

export default plugin
