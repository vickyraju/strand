import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db.ts'
import { HttpError, requireWrite } from '../auth.ts'
import { projectByKey } from './projects.ts'

const uuid = z.string().uuid()
const LIST = `
  select i.id, p.key || '-' || i.number as key, i.project_id, p.key as project_key, i.type, i.title, i.status_id, st.category,
         i.priority, i.assignee_id, i.labels, i.due_date, i.estimate, i.updated_at, i.version
    from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id`

const viewFilters = z.object({
  q: z.string().default(''), projectId: uuid.optional(), assignee: z.string().nullable().optional(),
  type: z.string().optional(), priority: z.string().optional(), label: z.string().optional(),
  resolution: z.enum(['open', 'done', 'all']).default('open'),
}).passthrough()

const plugin: FastifyPluginAsync = async app => {
  // Cross-project search / saved-view results. Keyset by (updated_at, id) desc.
  app.get<{ Querystring: Record<string, string> }>('/search', async req => {
    const q = z.object({
      q: z.string().default(''), project: uuid.optional(), assignee: z.string().optional(), type: z.string().optional(),
      priority: z.string().optional(), label: z.string().optional(), resolution: z.enum(['open', 'done', 'all']).default('open'),
      cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)
    const args: unknown[] = [req.me.workspaceId]
    const where = ['i.workspace_id = $1', 'i.deleted_at is null']
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\?/g, `$${args.length}`)) }
    const text = q.q.trim()
    if (text) {
      const key = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(text)
      if (key) { args.push(key[1]!.toUpperCase(), Number(key[2])); where.push(`(p.key = $${args.length - 1} and i.number = $${args.length})`) }
      else add(`(i.search @@ websearch_to_tsquery('simple', ?) or i.title ilike '%' || ? || '%')`, text.replace(/[%_\\]/g, '\\$&'))
    }
    if (q.project) add('i.project_id = ?', q.project)
    if (q.assignee) add('i.assignee_id = ?', q.assignee === 'me' ? req.me.id : q.assignee)
    if (q.type) add('i.type = ?', q.type)
    if (q.priority) add('i.priority = ?', q.priority)
    if (q.label) add('? = any(i.labels)', q.label)
    if (q.resolution === 'open') where.push(`st.category <> 'done'`)
    if (q.resolution === 'done') where.push(`st.category = 'done'`)
    if (q.cursor) {
      const [t, id] = Buffer.from(q.cursor, 'base64url').toString().split('|')
      args.push(t, id)
      where.push(`(i.updated_at, i.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`)
    }
    args.push(q.limit + 1)
    const rows = await db.query<any>(`${LIST} where ${where.join(' and ')} order by i.updated_at desc, i.id desc limit $${args.length}`, args)
    const more = rows.length > q.limit
    const items = more ? rows.slice(0, q.limit) : rows
    const last = items.at(-1)
    return { items, next: more && last ? Buffer.from(`${new Date(last.updatedAt).toISOString()}|${last.id}`).toString('base64url') : null }
  })

  // "Your work": open items assigned to me
  app.get('/me/work', async req => db.query(
    `${LIST} where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and st.category <> 'done'
      order by i.due_date nulls last, i.updated_at desc limit 200`, [req.me.workspaceId, req.me.id]))

  // Counts for summary/dashboards without scanning issues in the client
  app.get<{ Params: { key: string } }>('/projects/:key/summary', async req => {
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    const [byStatus, byAssignee, byType, created, overdue] = await Promise.all([
      db.query(`select s.id as status_id, s.name, s.category, count(i.id)::int as count from statuses s
                  left join issues i on i.status_id = s.id and i.deleted_at is null where s.project_id = $1 group by s.id order by s.position`, [p.id]),
      db.query(`select i.assignee_id, count(*)::int as open, coalesce(sum(i.estimate), 0) as points from issues i join statuses s on s.id = i.status_id
                 where i.project_id = $1 and i.deleted_at is null and s.category <> 'done' group by i.assignee_id`, [p.id]),
      db.query(`select type, count(*)::int as count from issues where project_id = $1 and deleted_at is null group by type`, [p.id]),
      db.query(`select count(*)::int as count from issues where project_id = $1 and deleted_at is null and created_at > now() - interval '7 days'`, [p.id]),
      db.query(`select count(*)::int as count from issues i join statuses s on s.id = i.status_id
                 where i.project_id = $1 and i.deleted_at is null and s.category <> 'done' and i.due_date < current_date`, [p.id]),
    ])
    return { byStatus, byAssignee, byType, createdLast7Days: (created[0] as any).count, overdue: (overdue[0] as any).count }
  })

  // ── Notifications ──
  app.get<{ Querystring: { archived?: string } }>('/notifications', async req => db.query(
    `select n.*, p.key || '-' || i.number as issue_key, i.title as issue_title
       from notifications n join issues i on i.id = n.issue_id join projects p on p.id = i.project_id
      where n.user_id = $1 and n.archived = $2 order by n.created_at desc limit 200`, [req.me.id, req.query.archived === '1']))

  app.patch<{ Params: { id: string } }>('/notifications/:id', async req => {
    const b = z.object({ read: z.boolean(), archived: z.boolean() }).partial().parse(req.body)
    const [n] = await db.query(
      `update notifications set read = coalesce($3, read), archived = coalesce($4, archived)
        where id = $1 and user_id = $2 returning *`, [uuid.parse(req.params.id), req.me.id, b.read ?? null, b.archived ?? null])
    if (!n) throw new HttpError(404, 'Not found')
    return n
  })
  app.post('/notifications/read-all', async (req, reply) => {
    await db.query('update notifications set read = true where user_id = $1 and not read', [req.me.id])
    reply.code(204).send()
  })

  // ── Saved views & dashboards (owner edits; shared views visible to all) ──
  app.get('/views', async req => db.query(
    'select * from saved_views where workspace_id = $1 and (owner_id = $2 or shared) order by name', [req.me.workspaceId, req.me.id]))
  app.post('/views', async req => {
    requireWrite(req)
    const b = z.object({ name: z.string().min(1), shared: z.boolean().default(false), filters: viewFilters }).parse(req.body)
    return (await db.query('insert into saved_views (workspace_id, owner_id, name, shared, filters) values ($1, $2, $3, $4, $5) returning *',
      [req.me.workspaceId, req.me.id, b.name, b.shared, JSON.stringify(b.filters)]))[0]
  })
  app.patch<{ Params: { id: string } }>('/views/:id', async req => {
    requireWrite(req)
    const b = z.object({ name: z.string().min(1), shared: z.boolean(), filters: viewFilters }).partial().parse(req.body)
    const [v] = await db.query(
      `update saved_views set name = coalesce($3, name), shared = coalesce($4, shared), filters = coalesce($5::jsonb, filters)
        where id = $1 and owner_id = $2 returning *`,
      [uuid.parse(req.params.id), req.me.id, b.name ?? null, b.shared ?? null, b.filters ? JSON.stringify(b.filters) : null])
    if (!v) throw new HttpError(404, 'Not found, or not yours')
    return v
  })
  app.delete<{ Params: { id: string } }>('/views/:id', async (req, reply) => {
    requireWrite(req)
    const r = await db.query('delete from saved_views where id = $1 and owner_id = $2 returning id', [uuid.parse(req.params.id), req.me.id])
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })

  const gadget = z.object({
    id: z.string(), kind: z.enum(['assigned', 'view', 'status', 'created', 'workload', 'burndown', 'due']),
    projectId: uuid.optional(), viewId: uuid.optional(), wide: z.boolean().optional(),
  })
  app.get('/dashboards', async req => db.query(
    'select * from dashboards where workspace_id = $1 and owner_id = $2 order by name', [req.me.workspaceId, req.me.id]))
  app.post('/dashboards', async req => {
    requireWrite(req)
    const b = z.object({ name: z.string().min(1), gadgets: z.array(gadget).default([]) }).parse(req.body)
    return (await db.query('insert into dashboards (workspace_id, owner_id, name, gadgets) values ($1, $2, $3, $4) returning *',
      [req.me.workspaceId, req.me.id, b.name, JSON.stringify(b.gadgets)]))[0]
  })
  app.patch<{ Params: { id: string } }>('/dashboards/:id', async req => {
    requireWrite(req)
    const b = z.object({ name: z.string().min(1), gadgets: z.array(gadget) }).partial().parse(req.body)
    const [d] = await db.query(
      `update dashboards set name = coalesce($3, name), gadgets = coalesce($4::jsonb, gadgets) where id = $1 and owner_id = $2 returning *`,
      [uuid.parse(req.params.id), req.me.id, b.name ?? null, b.gadgets ? JSON.stringify(b.gadgets) : null])
    if (!d) throw new HttpError(404, 'Not found, or not yours')
    return d
  })
  app.delete<{ Params: { id: string } }>('/dashboards/:id', async (req, reply) => {
    requireWrite(req)
    const r = await db.query('delete from dashboards where id = $1 and owner_id = $2 returning id', [uuid.parse(req.params.id), req.me.id])
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })
}

export default plugin
