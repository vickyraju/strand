import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { visible, visibleAs } from '../access.ts'
import { projectByKey } from './projects.ts'

const uuid = z.string().uuid()
const LIST = `
  select i.id, p.key || '-' || i.number as key, i.project_id, p.key as project_key, i.type, i.title, i.status_id, st.category,
         i.priority, i.assignee_id, i.labels, i.due_date, i.estimate, i.updated_at, i.version,
         to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts
    from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id`

const viewFilters = z.object({
  q: z.string().default(''), projectId: uuid.optional(), assignee: z.string().nullable().optional(),
  type: z.string().optional(), priority: z.string().optional(), label: z.string().optional(),
  resolution: z.enum(['open', 'done', 'all']).default('open'),
}).passthrough()

const idP = z.object({ id: uuid })
const pageQ = { cursor: z.string().optional().describe('`next` from the previous page') }

const plugin: FastifyPluginAsyncZod = async app => {
  // Cross-project search / saved-view results. Keyset by (updated_at, id) desc.
  app.get('/search', { schema: {
    tags: ['Search & work'], summary: 'Search issues across projects (text, key like PAY-12, or filters); newest first, keyset-paginated',
    querystring: z.object({
      q: z.string().default('').describe('Free text or an issue key'), project: uuid.optional(), assignee: z.string().optional().describe('User id, "me", or "none" for unassigned work'),
      type: z.string().optional(), priority: z.string().optional(), label: z.string().optional(),
      resolution: z.enum(['open', 'done', 'all']).default('open'), ...pageQ, limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  } }, async req => {
    const q = req.query
    const args: unknown[] = [req.me.workspaceId]
    const where = ['i.workspace_id = $1', 'i.deleted_at is null', visible(req.me, 'i.project_id', args)]
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\?/g, `$${args.length}`)) }
    const text = q.q.trim()
    if (text) {
      const key = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(text)
      if (key) { args.push(key[1]!.toUpperCase(), Number(key[2])); where.push(`(p.key = $${args.length - 1} and i.number = $${args.length})`) }
      else add(`(i.search @@ websearch_to_tsquery('simple', ?) or i.title ilike '%' || ? || '%')`, text.replace(/[%_\\]/g, '\\$&'))
    }
    if (q.project) add('i.project_id = ?', q.project)
    if (q.assignee === 'none') where.push('i.assignee_id is null')
    else if (q.assignee) add('i.assignee_id = ?', q.assignee === 'me' ? req.me.id : q.assignee)
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
    return { items, next: more && last ? Buffer.from(`${last.cursorTs}|${last.id}`).toString('base64url') : null }
  })

  // Labels in use, for the label filter (typing narrows it; names are matched anywhere, case-insensitively)
  app.get('/labels', { schema: { tags: ['Search & work'], summary: 'Labels used in projects I can see, alphabetical (up to 50; type part of a name to narrow)', querystring: z.object({
    query: z.string().max(100).optional().describe('Part of a label, case-insensitive'), limit: z.coerce.number().int().min(1).max(100).default(50),
  }) } }, async req => {
    const like = '%' + (req.query.query ?? '').replace(/[\\%_]/g, '\\$&') + '%'
    const args: unknown[] = [like, req.query.limit]
    const see = visible(req.me, 'l.project_id', args)
    return (await db.query<{ name: string }>(`select l.name from labels l where l.name ilike $1 and ${see} group by l.name order by lower(l.name), l.name limit $2`, args)).map(r => r.name)
  })

  // "Your work": open items assigned to me
  app.get('/me/work', { schema: { tags: ['Search & work'], summary: 'Open issues assigned to me, due soonest first' } }, async req => db.query(
    `${LIST} where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and st.category <> 'done'
      order by i.due_date nulls last, i.updated_at desc limit 200`, [req.me.workspaceId, req.me.id]))

  // "Your work → Worked on": work items I last touched, newest first
  app.get('/me/recent', { schema: { tags: ['Search & work'], summary: 'Work items I last touched (activity, comments or work logs), most recent first' } }, async req => db.query(
    `${LIST} where i.workspace_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)}
      and i.id in (
        select issue_id from activity where actor_id = $2
        union select issue_id from comments where author_id = $2
        union select issue_id from worklogs where user_id = $2)
      order by greatest(
        coalesce((select max(created_at) from activity a where a.issue_id = i.id and a.actor_id = $2), 'epoch'::timestamptz),
        coalesce((select max(created_at) from comments c where c.issue_id = i.id and c.author_id = $2), 'epoch'::timestamptz),
        coalesce((select max(created_at) from worklogs w where w.issue_id = i.id and w.user_id = $2), 'epoch'::timestamptz)) desc
      limit 40`, [req.me.workspaceId, req.me.id]))

  // "Your work": the numbers on the cards, counted by the database so they stay right past the first 200 items
  app.get('/me/work/summary', { schema: { tags: ['Search & work'], summary: 'Counts for the Your work cards: open items assigned to me, due within 3 days (or late), late, and blocked by unfinished work' } }, async req => {
    const [r] = await db.query<any>(
      `select count(*)::int as assigned,
              count(*) filter (where i.due_date is not null and i.due_date <= (now() at time zone 'utc')::date + 3)::int as due_soon,
              count(*) filter (where i.due_date < (now() at time zone 'utc')::date)::int as overdue,
              count(*) filter (where exists (
                select 1 from issue_links l join issues b on b.id = l.issue_id join statuses bs on bs.id = b.status_id
                 where l.target_id = i.id and l.type = 'blocks' and b.deleted_at is null and bs.category <> 'done'))::int as blocked
         from issues i join statuses st on st.id = i.status_id
        where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and i.type <> 'epic' and st.category <> 'done'`, [req.me.workspaceId, req.me.id])
    return r
  })

  // "Your work → Recent projects": where work happened most recently, with my open items and how much is done
  app.get('/me/projects/recent', { schema: { tags: ['Search & work'], summary: 'The 4 most recently active projects, with my open items, done items and total items (epics left out)' } }, async req => db.query(
    `select p.id, p.key, p.name, p.color, p.template,
            count(*) filter (where i.assignee_id = $2 and st.category <> 'done')::int as my_open,
            count(*) filter (where st.category = 'done')::int as done,
            count(i.id)::int as total,
            coalesce(max(i.updated_at), p.created_at) as last_activity
       from projects p
       left join issues i on i.project_id = p.id and i.deleted_at is null and i.type <> 'epic'
       left join statuses st on st.id = i.status_id
      where p.workspace_id = $1 and p.archived_at is null and ${visibleAs(req.me, 'p.id', 2)}
      group by p.id order by coalesce(max(i.updated_at), p.created_at) desc, p.id limit 4`, [req.me.workspaceId, req.me.id]))

  // "Your work → Viewed"
  app.get('/me/viewed', { schema: { tags: ['Search & work'], summary: 'Work items I opened most recently (newest 50), most recent first' } }, async req => db.query(
    `${LIST} join issue_views v on v.issue_id = i.id and v.user_id = $2
      where i.workspace_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} order by v.viewed_at desc limit 50`, [req.me.workspaceId, req.me.id]))

  // Counts for a project's summary without scanning issues in the client
  app.get('/projects/:key/summary', { schema: { tags: ['Search & work'], summary: 'Counts by status, assignee and type; created in the last 7 days; overdue', params: z.object({ key: z.string() }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
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
  // "Due soon" has no scheduler behind it: when someone loads their notifications we add one for each open item assigned to them that is due
  // tomorrow or sooner (up to 3 days late), once per item and due date. Skipped if this person was checked recently.
  const dueScan = new Map<string, number>()
  const DUE_SCAN_MS = Number(process.env.DUE_SCAN_INTERVAL_MS ?? 600_000)
  async function ensureDueNotifications(me: Me) {
    const workspaceId = me.workspaceId, userId = me.id
    const last = dueScan.get(userId)
    if (last !== undefined && Date.now() - last < DUE_SCAN_MS) return
    dueScan.set(userId, Date.now())
    await db.query(
      `insert into notifications (user_id, issue_id, kind, text)
       select $2, i.id, 'due', 'is due on ' || i.due_date::text
         from issues i join statuses st on st.id = i.status_id
        where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(me, 'i.project_id', 2)} and st.category <> 'done'
          and i.due_date between (now() at time zone 'utc')::date - 3 and (now() at time zone 'utc')::date + 1   -- UTC, so the answer does not depend on the server's timezone
          and not exists (select 1 from notifications n where n.user_id = $2 and n.issue_id = i.id and n.kind = 'due' and n.text = 'is due on ' || i.due_date::text)
       on conflict (user_id, issue_id, text) where kind = 'due' do nothing  -- another API pod may have just made it
      `,
      [workspaceId, userId])
  }

  app.get('/notifications', { schema: { tags: ['Notifications'], summary: 'My notifications (newest 200)', querystring: z.object({
    archived: z.enum(['0', '1']).optional().describe('1 = archived ones'),
    kind: z.enum(['assigned', 'mentioned', 'commented', 'status', 'due']).optional().describe('Only this kind'),
    project: uuid.optional().describe('Only notifications for this project'),
  }) } }, async req => {
    await ensureDueNotifications(req.me)
    const args: unknown[] = [req.me.id, req.query.archived === '1']
    const where = ['n.user_id = $1', 'n.archived = $2', visibleAs(req.me, 'i.project_id', 1)]
    if (req.query.kind) { args.push(req.query.kind); where.push(`n.kind = $${args.length}`) }
    if (req.query.project) { args.push(req.query.project); where.push(`i.project_id = $${args.length}`) }
    return db.query(
      `select n.*, p.key || '-' || i.number as issue_key, i.title as issue_title, p.key as project_key
         from notifications n join issues i on i.id = n.issue_id join projects p on p.id = i.project_id
        where ${where.join(' and ')} order by n.created_at desc limit 200`, args)
  })

  app.patch('/notifications/:id', { schema: { tags: ['Notifications'], summary: 'Mark a notification read / archived', params: idP, body: z.object({ read: z.boolean(), archived: z.boolean() }).partial() } }, async req => {
    const b = req.body
    const [n] = await db.query(
      `update notifications set read = coalesce($3, read), archived = coalesce($4, archived)
        where id = $1 and user_id = $2 returning *`, [req.params.id, req.me.id, b.read ?? null, b.archived ?? null])
    if (!n) throw new HttpError(404, 'Not found')
    return n
  })
  app.post('/notifications/read-all', { schema: { tags: ['Notifications'], summary: 'Mark all my notifications read' } }, async (req, reply) => {
    await db.query('update notifications set read = true where user_id = $1 and not read', [req.me.id])
    reply.code(204).send()
  })

  // ── Saved views (owner edits; shared views visible to all) ──
  app.get('/views', { schema: { tags: ['Saved views'], summary: 'My saved views plus shared ones' } }, async req => db.query(
    'select * from saved_views where workspace_id = $1 and (owner_id = $2 or shared) order by name', [req.me.workspaceId, req.me.id]))
  app.post('/views', { schema: { tags: ['Saved views'], summary: 'Save a view', body: z.object({ id: uuid.optional().describe('Client-chosen id'), name: z.string().min(1), shared: z.boolean().default(false), filters: viewFilters }) } }, async req => {
    const b = req.body
    return (await db.query('insert into saved_views (id, workspace_id, owner_id, name, shared, filters) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5) returning *',
      [req.me.workspaceId, req.me.id, b.name, b.shared, JSON.stringify(b.filters), b.id ?? null]))[0]
  })
  app.patch('/views/:id', { schema: { tags: ['Saved views'], summary: 'Edit my saved view', params: idP, body: z.object({ name: z.string().min(1), shared: z.boolean(), filters: viewFilters }).partial() } }, async req => {
    const b = req.body
    const [v] = await db.query(
      `update saved_views set name = coalesce($3, name), shared = coalesce($4, shared), filters = coalesce($5::jsonb, filters)
        where id = $1 and owner_id = $2 returning *`,
      [req.params.id, req.me.id, b.name ?? null, b.shared ?? null, b.filters ? JSON.stringify(b.filters) : null])
    if (!v) throw new HttpError(404, 'Not found, or not yours')
    return v
  })
  app.delete('/views/:id', { schema: { tags: ['Saved views'], summary: 'Delete my saved view', params: idP } }, async (req, reply) => {
    const r = await db.query('delete from saved_views where id = $1 and owner_id = $2 returning id', [req.params.id, req.me.id])
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })
}

export default plugin
