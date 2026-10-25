import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { levelOk, visible, visibleAs } from '../access.ts'
import { projectByKey } from './projects.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { jqlToSql, parseOr400 } from '../jqlSql.ts'
import { csvCell } from '../shared/csv.ts'
import '../email.ts'   // sends notification emails (a background job)
export { csvCell }

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

/** Search filters, shared by the result pages and the CSV export so an export is exactly what the search shows. */
const searchFilters = {
  q: z.string().default('').describe('Free text or an issue key'), project: uuid.optional(), assignee: z.string().optional().describe('User id, "me", or "none" for unassigned work'),
  type: z.string().optional(), priority: z.string().optional(), label: z.string().optional(),
  resolution: z.enum(['open', 'done', 'all']).default('open'),
  jql: z.string().max(5000).optional().describe('JQL, as in Jira: replaces the filters above, e.g. project = PAY AND status != Done ORDER BY priority DESC'),
}
type SearchFilters = { q: string; project?: string; assignee?: string; type?: string; priority?: string; label?: string; resolution: 'open' | 'done' | 'all'; jql?: string }

/** The SQL conditions for a search, limited to projects I can see (the parameters go into `args`), and its JQL ORDER BY.
 *  With JQL, the query replaces the simple filters, as switching to JQL does in Jira. */
async function searchWhere(me: Me, q: SearchFilters, args: unknown[]): Promise<{ where: string[]; order: string | null }> {
  args.push(me.workspaceId)
  const where = [`i.workspace_id = $${args.length}`, 'i.deleted_at is null', visible(me, 'i.project_id', args)]
  args.push(me.id)
  where.push(levelOk(me, args.length))
  if (q.jql?.trim()) {
    const sql = await jqlToSql(db, me, parseOr400(q.jql), args)
    if (sql.where) where.push(sql.where)
    return { where, order: sql.order }
  }
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\?/g, `$${args.length}`)) }
  const text = q.q.trim()
  if (text) {
    const key = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(text)
    if (key) { args.push(key[1]!.toUpperCase(), Number(key[2])); where.push(`(p.key = $${args.length - 1} and i.number = $${args.length})`) }
    else add(`(i.search @@ websearch_to_tsquery('simple', ?) or i.title ilike '%' || ? || '%')`, text.replace(/[%_\\]/g, '\\$&'))
  }
  if (q.project) add('i.project_id = ?', q.project)
  if (q.assignee === 'none') where.push('i.assignee_id is null')
  else if (q.assignee) add('i.assignee_id = ?', q.assignee === 'me' ? me.id : q.assignee)
  if (q.type) add('i.type = ?', q.type)
  if (q.priority) add('i.priority = ?', q.priority)
  if (q.label) add('? = any(i.labels)', q.label)
  if (q.resolution === 'open') where.push(`st.category <> 'done'`)
  if (q.resolution === 'done') where.push(`st.category = 'done'`)
  return { where, order: null }
}



const idP = z.object({ id: uuid })
const pageQ = { cursor: z.string().optional().describe('`next` from the previous page') }

const plugin: FastifyPluginAsyncZod = async app => {
  // Cross-project search / saved-view results. Keyset by (updated_at, id) desc.
  // The same search as a spreadsheet: every matching item (up to the export limit in System settings), readable names
  // instead of ids. Only items the person can see; each export is written to the audit log.
  app.get('/search/export.csv', { schema: {
    tags: ['Search & work'], summary: 'Download a search as CSV (same filters as /search; at most the export limit in System settings, newest first)',
    querystring: z.object(searchFilters),
  } }, async (req, reply) => {
    const args: unknown[] = []
    const { where, order } = await searchWhere(req.me, req.query, args)
    // a larger search is refused, so nobody gets a silently cut-off file
    // ponytail: built in memory; stream it, or write it to storage in a background job, if exports need to be much larger
    const max = (await getSetting(req.me.workspaceId, 'searchAndBulk')).exportMaxRows
    args.push(max + 1)
    const rows = await db.query<any>(
      `select p.key || '-' || i.number as key, p.key as project,
              coalesce((select wt.name from work_types wt where wt.project_id = i.project_id and wt.key = i.type), i.type) as type, i.title, st.name as status, i.priority,
              a.name as assignee, r.name as reporter, i.labels, i.estimate, i.time_estimate, i.start_date, i.due_date,
              sp.name as sprint, rl.name as release, par_p.key || '-' || par.number as parent, i.resolution,
              (select string_agg(c.name, ', ' order by c.name) from components c where c.id = any(i.component_ids)) as components,
              (select string_agg(r.name, ', ' order by r.name) from releases r where r.id = any(i.affects_release_ids)) as affects,
              i.resolved_at, i.created_at, i.updated_at, i.description
         from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
         left join users a on a.id = i.assignee_id left join users r on r.id = i.reporter_id
         left join sprints sp on sp.id = i.sprint_id left join releases rl on rl.id = i.release_id
         left join issues par on par.id = i.parent_id left join projects par_p on par_p.id = par.project_id
        where ${where.join(' and ')} order by ${order ? `${order}, i.id` : 'i.updated_at desc, i.id desc'} limit $${args.length}`, args)
    if (rows.length > max)
      throw new HttpError(400, `More than ${max.toLocaleString('en')} items match. Narrow the search (a project, a type, a label) and export again.`)
    const cols: [string, string][] = [
      ['Key', 'key'], ['Project', 'project'], ['Type', 'type'], ['Title', 'title'], ['Status', 'status'], ['Priority', 'priority'],
      ['Assignee', 'assignee'], ['Reporter', 'reporter'], ['Labels', 'labels'], ['Story points', 'estimate'], ['Time estimate (minutes)', 'timeEstimate'],
      ['Start date', 'startDate'], ['Due date', 'dueDate'], ['Sprint', 'sprint'], ['Fix version', 'release'], ['Affects versions', 'affects'], ['Components', 'components'], ['Parent', 'parent'],
      ['Resolution', 'resolution'], ['Resolved', 'resolvedAt'], ['Created', 'createdAt'], ['Updated', 'updatedAt'], ['Description', 'description'],
    ]
    const csv = [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(c => csvCell(r[c[1]])).join(','))].join('\r\n') + '\r\n'
    await audit(db, req, { action: 'export.csv', type: 'search', name: req.query.q || null, after: { rows: rows.length, filters: req.query } })
    const day = new Date().toISOString().slice(0, 10)
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="strand-export-${day}.csv"`)
      .send('\uFEFF' + csv)   // the byte-order mark tells spreadsheet apps the file is UTF-8
  })

  app.get('/search', { schema: {
    tags: ['Search & work'], summary: 'Search issues across projects (text, key like PAY-12, or filters); newest first, keyset-paginated',
    querystring: z.object({ ...searchFilters, ...pageQ, limit: z.coerce.number().int().min(1).max(200).default(50) }),
  } }, async req => {
    const q = req.query
    const args: unknown[] = []
    const { where, order } = await searchWhere(req.me, q, args)
    // A JQL ORDER BY pages by position (o:<offset>); otherwise newest first, keyset by (updated_at, id)
    if (order) {
      const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString().replace(/^o:/, '')) || 0 : 0
      args.push(q.limit + 1, offset)
      const rows = await db.query<any>(`${LIST} where ${where.join(' and ')} order by ${order}, i.id limit $${args.length - 1} offset $${args.length}`, args)
      const more = rows.length > q.limit
      return { items: more ? rows.slice(0, q.limit) : rows, next: more ? Buffer.from(`o:${offset + q.limit}`).toString('base64url') : null }
    }
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
    `${LIST} where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)} and st.category <> 'done'
      order by i.due_date nulls last, i.updated_at desc limit 200`, [req.me.workspaceId, req.me.id]))

  // "Your work → Worked on": work items I last touched, newest first
  app.get('/me/recent', { schema: { tags: ['Search & work'], summary: 'Work items I last touched (activity, comments or work logs), most recent first' } }, async req => db.query(
    `${LIST} where i.workspace_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)}
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
  app.get('/me/work/summary', { schema: { tags: ['Search & work'], summary: 'Counts for the Your work cards: open items assigned to me, due soon (window in System settings) or late, late, and blocked by unfinished work' } }, async req => {
    const soon = (await getSetting(req.me.workspaceId, 'dueReminders')).dueSoonDays
    const [r] = await db.query<any>(
      `select count(*)::int as assigned,
              count(*) filter (where i.due_date is not null and i.due_date <= (now() at time zone 'utc')::date + $3::int)::int as due_soon,
              count(*) filter (where i.due_date < (now() at time zone 'utc')::date)::int as overdue,
              count(*) filter (where exists (
                select 1 from issue_links l join issues b on b.id = l.issue_id join statuses bs on bs.id = b.status_id
                 where l.target_id = i.id and l.type = 'blocks' and b.deleted_at is null and bs.category <> 'done'))::int as blocked
         from issues i join statuses st on st.id = i.status_id
        where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)} and i.type <> 'epic' and st.category <> 'done'`, [req.me.workspaceId, req.me.id, soon])
    return { ...r, dueSoonDays: soon }
  })

  // "Your work → Recent projects": where work happened most recently, with my open items and how much is done
  app.get('/me/projects/recent', { schema: { tags: ['Search & work'], summary: 'The 4 most recently active projects, with my open items, done items and total items (epics left out)' } }, async req => db.query(
    `select p.id, p.key, p.name, p.color, p.template,
            count(*) filter (where i.assignee_id = $2 and st.category <> 'done')::int as my_open,
            count(*) filter (where st.category = 'done')::int as done,
            count(i.id)::int as total,
            coalesce(max(i.updated_at), p.created_at) as last_activity
       from projects p
       left join issues i on i.project_id = p.id and i.deleted_at is null and i.type <> 'epic' and ${levelOk(req.me, 2)}
       left join statuses st on st.id = i.status_id
      where p.workspace_id = $1 and p.archived_at is null and ${visibleAs(req.me, 'p.id', 2)}
      group by p.id order by coalesce(max(i.updated_at), p.created_at) desc, p.id limit 4`, [req.me.workspaceId, req.me.id]))

  // "Your work → Viewed"
  app.get('/me/viewed', { schema: { tags: ['Search & work'], summary: 'Work items I opened most recently (newest 50), most recent first' } }, async req => db.query(
    `${LIST} join issue_views v on v.issue_id = i.id and v.user_id = $2
      where i.workspace_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)} order by v.viewed_at desc limit 50`, [req.me.workspaceId, req.me.id]))

  // Counts for a project's summary without scanning issues in the client
  app.get('/projects/:key/summary', { schema: { tags: ['Search & work'], summary: 'Counts by status, assignee and type; created in the last 7 days; overdue', params: z.object({ key: z.string() }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const [byStatus, byAssignee, byType, created, overdue] = await Promise.all([
      db.query(`select s.id as status_id, s.name, s.category, count(i.id)::int as count from statuses s
                  left join issues i on i.status_id = s.id and i.deleted_at is null and ${levelOk(req.me, 2)} where s.project_id = $1 group by s.id order by s.position`, [p.id, req.me.id]),
      db.query(`select i.assignee_id, count(*)::int as open, coalesce(sum(i.estimate), 0) as points from issues i join statuses s on s.id = i.status_id
                 where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} and s.category <> 'done' group by i.assignee_id`, [p.id, req.me.id]),
      db.query(`select i.type, count(*)::int as count from issues i where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} group by i.type`, [p.id, req.me.id]),
      db.query(`select count(*)::int as count from issues i where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} and i.created_at > now() - interval '7 days'`, [p.id, req.me.id]),
      db.query(`select count(*)::int as count from issues i join statuses s on s.id = i.status_id
                 where i.project_id = $1 and i.deleted_at is null and ${levelOk(req.me, 2)} and s.category <> 'done' and i.due_date < current_date`, [p.id, req.me.id]),
    ])
    return { byStatus, byAssignee, byType, createdLast7Days: (created[0] as any).count, overdue: (overdue[0] as any).count }
  })

  // ── Notifications ──
  // "Due soon" has no scheduler behind it: when someone loads their notifications we add one for each open item assigned to them that is due
  // within the window set in System settings (days ahead, days late), once per item and due date. Skipped if this person was checked recently.
  const dueScan = new Map<string, number>()
  const DUE_SCAN_MS = Number(process.env.DUE_SCAN_INTERVAL_MS ?? 600_000)
  async function ensureDueNotifications(me: Me) {
    const workspaceId = me.workspaceId, userId = me.id
    const last = dueScan.get(userId)
    if (last !== undefined && Date.now() - last < DUE_SCAN_MS) return
    dueScan.set(userId, Date.now())
    const policy = await getSetting(workspaceId, 'dueReminders')
    if (!policy.enabled) return
    await db.query(
      `insert into notifications (user_id, issue_id, kind, text)
       select $2, i.id, 'due', 'is due on ' || i.due_date::text
         from issues i join statuses st on st.id = i.status_id
        where i.workspace_id = $1 and i.assignee_id = $2 and i.deleted_at is null and ${visibleAs(me, 'i.project_id', 2)} and ${levelOk(me, 2)} and st.category <> 'done'
          and i.due_date between (now() at time zone 'utc')::date - $3::int and (now() at time zone 'utc')::date + $4::int   -- UTC, so the answer does not depend on the server's timezone
          and not exists (select 1 from notifications n where n.user_id = $2 and n.issue_id = i.id and n.kind = 'due' and n.text = 'is due on ' || i.due_date::text)
       on conflict (user_id, issue_id, text) where kind = 'due' do nothing  -- another API pod may have just made it
      `,
      [workspaceId, userId, policy.daysLate, policy.daysAhead])
  }

  app.get('/notifications', { schema: { tags: ['Notifications'], summary: 'My notifications (newest 200)', querystring: z.object({
    archived: z.enum(['0', '1']).optional().describe('1 = archived ones'),
    kind: z.enum(['assigned', 'mentioned', 'commented', 'status', 'due']).optional().describe('Only this kind'),
    project: uuid.optional().describe('Only notifications for this project'),
  }) } }, async req => {
    await ensureDueNotifications(req.me)
    const args: unknown[] = [req.me.id, req.query.archived === '1']
    const where = ['n.user_id = $1', 'n.archived = $2', visibleAs(req.me, 'i.project_id', 1), levelOk(req.me, 1)]
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

  // What I hear about, and how (Jira's notification settings): each kind in the Inbox and/or by email
  const KINDS = ['assigned', 'mentioned', 'commented', 'status', 'due', 'automation'] as const
  const prefsOf = async (userId: string) => {
    const rows = new Map((await db.query<{ kind: string; inbox: boolean; email: boolean }>('select kind, inbox, email from notification_prefs where user_id = $1', [userId])).map(r => [r.kind, r]))
    return KINDS.map(kind => ({ kind, inbox: rows.get(kind)?.inbox ?? true, email: rows.get(kind)?.email ?? true }))
  }
  app.get('/me/notification-prefs', { schema: { tags: ['Notifications'], summary: 'For each kind of notification: whether I get it in my Inbox, and by email (when the workspace sends email)' } }, async req => ({
    prefs: await prefsOf(req.me.id), emailEnabled: (await getSetting(req.me.workspaceId, 'email')).enabled,
  }))
  app.put('/me/notification-prefs', { schema: { tags: ['Notifications'], summary: 'Change what I get, and how', body: z.object({
    prefs: z.array(z.object({ kind: z.enum(KINDS), inbox: z.boolean(), email: z.boolean() })).max(KINDS.length),
  }) } }, async req => {
    await tx(async d => {
      for (const p of req.body.prefs)
        await d.query(`insert into notification_prefs (user_id, kind, inbox, email) values ($1, $2, $3, $4)
                       on conflict (user_id, kind) do update set inbox = excluded.inbox, email = excluded.email`, [req.me.id, p.kind, p.inbox, p.email])
    })
    return { prefs: await prefsOf(req.me.id), emailEnabled: (await getSetting(req.me.workspaceId, 'email')).enabled }
  })

  // ── Saved views (owner edits; shared views visible to all) ──
  // ── Saved views (Jira's filters): mine, those shared with the workspace, and those shared with a project, group or
  // person I am part of. Shared people can view or edit; only the owner (or a workspace admin) changes who can. ──
  const shareEntry = z.object({ kind: z.enum(['project', 'group', 'user']), id: uuid, can: z.enum(['view', 'edit']).default('view') })
  const share = z.array(shareEntry).max(50).describe('Who else can see it (view) or change it (edit): projects, groups, people')
  /** SQL: does a share entry `e` (jsonb) include me? */
  const includesMe = (me: Me, n: number) => `(
      (e->>'kind' = 'user' and e->>'id' = $${n}::text)
   or (e->>'kind' = 'group' and (e->>'id')::uuid in (select group_id from group_members where user_id = $${n}))
   or (e->>'kind' = 'project' and ${me.admin ? 'true' : `(e->>'id')::uuid in (select project_id from project_access where user_id = $${n})`}))`
  const VIEW = (me: Me) => `select v.*, u.name as owner_name, u.active as owner_active,
      (v.owner_id = $2 or $3 or exists (select 1 from jsonb_array_elements(v.share) e where e->>'can' = 'edit' and ${includesMe(me, 2)})) as can_edit
    from saved_views v join users u on u.id = v.owner_id`
  const canSee = (me: Me) => `(v.owner_id = $2 or v.shared or exists (select 1 from jsonb_array_elements(v.share) e where ${includesMe(me, 2)}))`
  const viewArgs = (req: { me: Me }) => [req.me.workspaceId, req.me.id, req.me.admin]
  /** The view, if I can see it (404 otherwise), with whether I can change it. */
  const viewFor = async (d: Db, req: { me: Me }, id: string) => {
    const [v] = await d.query<any>(`${VIEW(req.me)} where v.workspace_id = $1 and v.id = $4 and ${canSee(req.me)}`, [...viewArgs(req), id])
    if (!v) throw new HttpError(404, 'View not found')
    return v
  }
  /** Share entries must name this workspace's projects, groups and people. */
  const checkShare = async (d: Db, ws: string, entries: z.infer<typeof share>) => {
    for (const e of entries) {
      const sql = e.kind === 'project' ? 'select 1 from projects where id = $1 and workspace_id = $2'
        : e.kind === 'group' ? 'select 1 from groups where id = $1 and $2::uuid is not null'
        : 'select 1 from memberships where user_id = $1 and workspace_id = $2'
      if (!(await d.query(sql, [e.id, ws])).length) throw new HttpError(400, `No such ${e.kind} to share with`, { share: `Unknown ${e.kind}` })
    }
  }
  app.get('/views', { schema: { tags: ['Saved views'], summary: 'Saved views I can see: mine, and those shared with me (the workspace, my projects, my groups, me)' } }, async req =>
    db.query(`${VIEW(req.me)} where v.workspace_id = $1 and ${canSee(req.me)} order by v.name`, viewArgs(req)))
  app.post('/views', { schema: { tags: ['Saved views'], summary: 'Save a view', body: z.object({
    id: uuid.optional().describe('Client-chosen id'), name: z.string().min(1), shared: z.boolean().default(false), share: share.default([]), filters: viewFilters,
  }) } }, async (req, reply) => {
    const b = req.body
    return tx(async d => {
      await checkShare(d, req.me.workspaceId, b.share)
      const [row] = await d.query<{ id: string }>('insert into saved_views (id, workspace_id, owner_id, name, shared, share, filters) values (coalesce($7::uuid, uuid_v7()), $1, $2, $3, $4, $5, $6) returning id',
        [req.me.workspaceId, req.me.id, b.name, b.shared, JSON.stringify(b.share), JSON.stringify(b.filters), b.id ?? null])
      reply.code(201)
      return viewFor(d, req, row!.id)
    })
  })
  app.patch('/views/:id', { schema: { tags: ['Saved views'], summary: 'Change a view: its owner and people it is shared with to edit can change its name and filters; only the owner or a workspace admin changes who it is shared with, or its owner',
    params: idP, body: z.object({ name: z.string().min(1), shared: z.boolean(), share, filters: viewFilters, ownerId: uuid.describe('Give it to someone else') }).partial() } }, async req => {
    const b = req.body
    return tx(async d => {
      const v = await viewFor(d, req, req.params.id)
      if (!v.canEdit) throw new HttpError(403, 'Only its owner, or someone it is shared with to edit, can change this view')
      const governs = v.ownerId === req.me.id || req.me.admin
      if ((b.shared !== undefined || b.share !== undefined || b.ownerId !== undefined) && !governs) throw new HttpError(403, 'Only its owner or a workspace admin changes who can see it')
      if (b.share) await checkShare(d, req.me.workspaceId, b.share)
      if (b.ownerId && !(await d.query('select 1 from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.workspace_id = $2 and u.active', [b.ownerId, req.me.workspaceId])).length)
        throw new HttpError(400, 'The new owner must be an active person in the workspace', { ownerId: 'Not an active person here' })
      await d.query(
        `update saved_views set name = coalesce($2, name), shared = coalesce($3, shared), share = coalesce($4::jsonb, share), filters = coalesce($5::jsonb, filters), owner_id = coalesce($6, owner_id)
          where id = $1`, [v.id, b.name ?? null, b.shared ?? null, b.share ? JSON.stringify(b.share) : null, b.filters ? JSON.stringify(b.filters) : null, b.ownerId ?? null])
      if (b.ownerId && b.ownerId !== v.ownerId) await audit(d, req, { action: 'view.owner_changed', type: 'view', id: v.id, name: v.name, before: { ownerId: v.ownerId }, after: { ownerId: b.ownerId } })
      return viewFor(d, req, v.id)
    })
  })
  app.delete('/views/:id', { schema: { tags: ['Saved views'], summary: 'Delete a view (its owner, or a workspace admin)', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const v = await viewFor(d, req, req.params.id)
      if (v.ownerId !== req.me.id && !req.me.admin) throw new HttpError(403, 'Only its owner or a workspace admin can delete this view')
      await d.query('delete from saved_views where id = $1', [v.id])
      if (v.ownerId !== req.me.id) await audit(d, req, { action: 'view.deleted', type: 'view', id: v.id, name: v.name, before: { ownerId: v.ownerId } })
    })
    reply.code(204).send()
  })
  // Administration › Shared views (Jira's "Filters"): every view shared beyond its owner, and any owned by someone who left
  app.get('/admin/views', { schema: { tags: ['Admin'], summary: 'Views shared with anyone, and views whose owner is deactivated (workspace admins)' } }, async req => {
    requireAdmin(req)
    return db.query(`${VIEW(req.me)} where v.workspace_id = $1 and (v.shared or jsonb_array_length(v.share) > 0 or not u.active) order by u.active, v.name`, viewArgs(req))
  })
}

export default plugin
