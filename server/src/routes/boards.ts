// Boards (Jira's boards): several per project, each with its own filter (JQL, possibly across projects), columns,
// swimlanes, quick filters and card fields. Everyone in the project sees and uses them; the project's admins and each
// board's named administrators (people or groups) create and change them.
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { need, visible } from '../access.ts'
import { audit, changes } from '../audit.ts'
import { projectByKey } from './projects.ts'
import { ISSUE_ROW } from './issues.ts'
import { searchWhere } from './misc.ts'
import { parseJql, type Node } from '../shared/jql.ts'
import { DEFAULT_QUICK, sprintManager, boardFor, boardWhere, checkQueries, colorSql, columnsOf, laneSql, type Board, type CardColors, type Lanes } from '../boards.ts'

const T = ['Boards']
const uuid = z.string().uuid()
const idP = z.object({ id: uuid })
const keyP = z.object({ key: z.string().describe('Project key (PAY) or id') })
const jql = z.string().trim().min(1).max(5000)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #2563EB')
const named = z.object({ id: z.string().min(1).max(64).optional(), name: z.string().trim().min(1).max(60), jql })
const column = z.object({ id: z.string().min(1).max(64).optional(), name: z.string().trim().min(1).max(60), statusIds: z.array(uuid).max(50),
  min: z.number().int().min(0).max(9999).nullable().optional(), max: z.number().int().min(1).max(9999).nullable().optional() })
  .refine(c => c.min == null || c.max == null || c.min <= c.max, 'The minimum can’t be over the maximum')
const settings = {
  name: z.string().trim().min(1).max(100),
  jql: jql.describe('The board filter: which work items it shows (any projects)'),
  columns: z.array(column).min(1).max(30).describe('Statuses mapped to columns, in order'),
  swimlanes: z.object({ by: z.enum(['none', 'assignee', 'epic', 'priority', 'project', 'queries']), queries: z.array(named).max(30).optional() }),
  quickFilters: z.array(named).max(30),
  cardFields: z.record(z.string().max(40), z.boolean()),
  doneDays: z.number().int().min(1).max(3650).nullable().describe('Kanban: leave out Done items not updated for this many days (null: show them all)'),
  estimation: z.enum(['points', 'time', 'count']).describe('Scrum: what estimates count (story points, original time estimate, issue count); spec 0404'),
  cardColors: z.object({
    by: z.enum(['none', 'types', 'priorities', 'assignees', 'queries']),
    types: z.record(z.string().max(40), color).optional(), priorities: z.record(z.string().max(40), color).optional(), assignees: z.record(uuid, color).optional(),
    queries: z.array(z.object({ id: z.string().max(64).optional().describe('Kept when edited; empty or left out for a new query'), jql, color })).max(30).optional(),
  }).describe('Colours based on work types, priorities, assignees or queries (the first match), shown on each card’s left edge (spec 0409)'),
  workingDays: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one working day').max(7).describe('Working weekdays, 0 for Sunday'),
    nonWorking: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(365).describe('Holidays and other dates nobody works (YYYY-MM-DD)'),
  }).describe('The burndown’s guideline falls only on working days (spec 0405)'),
  admins: z.object({ userIds: z.array(uuid).max(100), groupIds: z.array(uuid).max(100) }).describe('The board’s administrators besides the project’s admins'),
  kanbanBacklog: z.array(uuid).max(200).describe('Kanban boards: the statuses in the Kanban backlog, Jira’s leftmost column; none turns it off (spec 0406)'),
}
/** The projects a query names in a `project =` or `project in` clause (keys upper-cased, names lower-cased), anywhere in it. */
const namedProjects = (n: Node | null): string[] =>
  !n ? [] : n.kind === 'not' ? namedProjects(n.item) : n.kind !== 'clause' ? n.items.flatMap(namedProjects)
    : n.field.toLowerCase() === 'project' && (n.op === '=' || n.op === 'in') ? n.values.flatMap(v => v.kind === 'text' ? [v.text.toUpperCase(), v.text.toLowerCase()] : []) : []
const withIds = <X extends { id?: string }>(xs: X[]) => xs.map(x => ({ ...x, id: x.id || randomUUID() }))   // an empty id is a new one
/** Swimlanes with every query given an id. */
const lanesOf = (l: { by: Lanes['by']; queries?: { id?: string; name: string; jql: string }[] }): Lanes => ({ by: l.by, ...(l.queries ? { queries: withIds(l.queries) } : {}) })

/** A board in full, for its page: with its administrators, and whether I may change it. */
async function boardOut(d: Db, me: Me, id: string) {
  const { board: b, canManage } = await boardFor(d, me, id)
  const admins = await d.query<{ kind: string; id: string; name: string }>(
    `select 'user' as kind, u.id, u.name from board_admins a join users u on u.id = a.user_id where a.board_id = $1
     union all select 'group', g.id, g.display_name from board_admins a join groups g on g.id = a.group_id where a.board_id = $1 order by 1, 3`, [b.id])
  const [p] = await d.query<{ key: string }>('select key from projects where id = $1', [b.projectId])
  return { id: b.id, projectId: b.projectId, projectKey: p!.key, name: b.name, type: b.type, jql: b.jql, columns: b.columns, swimlanes: b.swimlanes, quickFilters: b.quickFilters,
    cardFields: b.cardFields, doneDays: b.doneDays, estimation: b.estimation, workingDays: b.workingDays, cardColors: b.cardColors, kanbanBacklog: b.kanbanBacklog, position: b.position, canManage, canManageSprints: (await sprintManager(d, me, b)).ok, admins }
}

/** Every status a column (or the Kanban backlog) names is one of the workspace's; a status in two places is refused. */
async function checkColumns(d: Db, ws: string, columns: { statusIds: string[] }[], backlog: string[] = []) {
  const ids = [...backlog, ...columns.flatMap(c => c.statusIds)]
  if (new Set(ids).size !== ids.length) throw new HttpError(400, backlog.length ? 'A status can be in one column only, or in the Kanban backlog' : 'A status can be in one column only', { columns: 'A status is in two places' })
  if (ids.length && (await d.query('select id from wf_statuses where workspace_id = $1 and id = any($2)', [ws, ids])).length !== ids.length)
    throw new HttpError(400, 'A column names a status that doesn’t exist', { columns: 'Unknown status' })
}

/** A board's administrators: active people of this workspace, and groups that exist. Anyone else is refused, not skipped. */
async function setAdmins(d: Db, ws: string, boardId: string, a: { userIds: string[]; groupIds: string[] }) {
  const users = [...new Set(a.userIds)], groups = [...new Set(a.groupIds)]
  const okUsers = await d.query<{ id: string }>('select u.id from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.active and u.id = any($2::uuid[])', [ws, users])
  if (okUsers.length !== users.length) throw new HttpError(400, 'Board administrators must be active people in this workspace', { admins: 'Unknown or deactivated person' })
  const okGroups = await d.query<{ id: string }>('select id from groups where id = any($1::uuid[])', [groups])
  if (okGroups.length !== groups.length) throw new HttpError(400, 'A group named as an administrator doesn’t exist', { admins: 'Unknown group' })
  await d.query('delete from board_admins where board_id = $1', [boardId])
  for (const u of users) await d.query('insert into board_admins (board_id, user_id) values ($1, $2)', [boardId, u])
  for (const g of groups) await d.query('insert into board_admins (board_id, group_id) values ($1, $2)', [boardId, g])
}

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/projects/:key/boards', { schema: { tags: T, summary: 'A project’s boards, in order, and whether I may change each', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    const rows = await db.query<Board>('select * from boards where project_id = $1 order by position, lower(name), id', [p.id])
    const mine = new Set((await db.query<{ boardId: string }>(
      `select a.board_id from board_admins a join boards b on b.id = a.board_id where b.project_id = $1
         and (a.user_id = $2 or a.group_id in (select group_id from group_members where user_id = $2))`, [p.id, req.me.id])).map(r => r.boardId))
    return Promise.all(rows.map(async b => ({ id: b.id, name: b.name, type: b.type, jql: b.jql, position: b.position, hasBacklog: b.kanbanBacklog.length > 0, canManage: p.role === 'admin' || mine.has(b.id),
      canManageSprints: (await sprintManager(db, req.me, b)).ok })))
  })

  app.post('/projects/:key/boards', { schema: { tags: T, summary: 'Add a board to a project (project admins). Its type (Scrum or Kanban) can’t change later. Without columns, it gets one per project status; without quick filters, Jira’s two',
    params: keyP, body: z.object({ ...settings, type: z.enum(['kanban', 'scrum']) }).partial().required({ name: true, type: true }) } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    need(p.role, 'administer', p.key)
    return tx(async d => {
      const b = req.body
      const [proj] = await d.query<{ key: string }>('select key from projects where id = $1', [p.id])
      const draft = {
        jql: b.jql ?? `project = ${proj!.key}`, columns: withIds(b.columns ?? await columnsOf(d, p.id)), swimlanes: lanesOf(b.swimlanes ?? { by: 'none' }),
        quickFilters: withIds(b.quickFilters ?? DEFAULT_QUICK()), cardFields: b.cardFields ?? {}, doneDays: b.doneDays !== undefined ? b.doneDays : b.type === 'kanban' ? 14 : null,
      }
      await checkQueries(d, req.me, draft)
      await checkColumns(d, req.me.workspaceId, draft.columns)
      const [row] = await d.query<{ id: string }>(
        `insert into boards (workspace_id, project_id, name, type, jql, columns, swimlanes, quick_filters, card_fields, done_days, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (select coalesce(max(position), -1) + 1 from boards where project_id = $2), $11) returning id`,
        [req.me.workspaceId, p.id, b.name, b.type, draft.jql, JSON.stringify(draft.columns), JSON.stringify(draft.swimlanes), JSON.stringify(draft.quickFilters),
          JSON.stringify(draft.cardFields), draft.doneDays, req.me.id])
      await setAdmins(d, req.me.workspaceId, row!.id, b.admins ?? { userIds: [req.me.id], groupIds: [] })
      await audit(d, req, { action: 'board.created', type: 'board', id: row!.id, name: b.name, project: p, after: { type: b.type, jql: draft.jql } })
      reply.code(201)
      return boardOut(d, req.me, row!.id)
    })
  })

  app.get('/boards/:id', { schema: { tags: T, summary: 'A board: its filter, columns, swimlanes, quick filters, card fields and administrators', params: idP } }, async req =>
    boardOut(db, req.me, req.params.id))

  app.patch('/boards/:id', { schema: { tags: T, summary: 'Change a board (its administrators and the project’s admins). Every query is checked; a mistake is a 400 saying where',
    params: idP, body: z.object(settings).partial() } }, async req => tx(async d => {
    const { board: before } = await boardFor(d, req.me, req.params.id, { manage: true, lock: true })
    const b = req.body
    const next = {
      name: b.name ?? before.name, jql: b.jql ?? before.jql, columns: b.columns ? withIds(b.columns) : before.columns,
      swimlanes: b.swimlanes ? lanesOf(b.swimlanes) : before.swimlanes,
      quickFilters: b.quickFilters ? withIds(b.quickFilters) : before.quickFilters, cardFields: b.cardFields ?? before.cardFields,
      doneDays: b.doneDays !== undefined ? b.doneDays : before.doneDays, estimation: b.estimation ?? before.estimation,
      cardColors: b.cardColors ? { ...before.cardColors, ...b.cardColors, ...(b.cardColors.queries ? { queries: withIds(b.cardColors.queries) } : {}) } as CardColors : before.cardColors,   // switching keeps the others' colours
      workingDays: b.workingDays ? { weekdays: [...new Set(b.workingDays.weekdays)].sort(), nonWorking: [...new Set(b.workingDays.nonWorking)].sort() } : before.workingDays,
      kanbanBacklog: b.kanbanBacklog ?? before.kanbanBacklog,
    }
    if (b.estimation && before.type !== 'scrum') throw new HttpError(400, 'Only a Scrum board has an estimation statistic', { estimation: 'Kanban boards don’t estimate' })
    if (b.kanbanBacklog?.length && before.type !== 'kanban') throw new HttpError(400, 'Only a Kanban board has a Kanban backlog', { kanbanBacklog: 'Scrum boards plan in their backlog' })
    await checkQueries(d, req.me, next)
    if (b.columns || b.kanbanBacklog) await checkColumns(d, req.me.workspaceId, next.columns, next.kanbanBacklog)
    await d.query(`update boards set name = $2, jql = $3, columns = $4, swimlanes = $5, quick_filters = $6, card_fields = $7, done_days = $8, estimation = $9, working_days = $10, card_colors = $11, kanban_backlog = $12, updated_at = now() where id = $1`,
      [before.id, next.name, next.jql, JSON.stringify(next.columns), JSON.stringify(next.swimlanes), JSON.stringify(next.quickFilters), JSON.stringify(next.cardFields), next.doneDays, next.estimation, JSON.stringify(next.workingDays), JSON.stringify(next.cardColors), JSON.stringify(next.kanbanBacklog)])
    if (b.admins) await setAdmins(d, req.me.workspaceId, before.id, b.admins)
    const c = changes({ name: before.name, jql: before.jql }, { name: next.name, jql: next.jql })
    const what = Object.keys(b).filter(k => k !== 'name' && k !== 'jql')
    const [p] = await d.query<{ id: string; key: string }>('select id, key from projects where id = $1', [before.projectId])
    if (c.changed || what.length) await audit(d, req, { action: 'board.updated', type: 'board', id: before.id, name: next.name, project: p!, before: c.before, after: { ...c.after, ...(what.length ? { changed: what } : {}) } })
    return boardOut(d, req.me, before.id)
  }))

  app.delete('/boards/:id', { schema: { tags: T, summary: 'Remove a board (its administrators and the project’s admins). A project keeps at least one board; a board with sprints not yet completed can’t go', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const { board: b } = await boardFor(d, req.me, req.params.id, { manage: true, lock: true })
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from boards where project_id = $1', [b.projectId]) as any
      if (n <= 1) throw new HttpError(409, 'A project needs at least one board')
      const [{ open }] = await d.query<{ open: number }>(`select count(*)::int as open from sprints where board_id = $1 and state <> 'closed'`, [b.id]) as any
      if (open) throw new HttpError(409, `This board has ${open} sprint${open === 1 ? '' : 's'} not yet completed: complete or delete ${open === 1 ? 'it' : 'them'} first`)
      // completed sprints and their history stay with the project: they move to its first other board
      await d.query(`update sprints set board_id = (select id from boards where project_id = $2 and id <> $1 order by position, id limit 1) where board_id = $1`, [b.id, b.projectId])
      await d.query('delete from boards where id = $1', [b.id])
      const [p] = await d.query<{ id: string; key: string }>('select id, key from projects where id = $1', [b.projectId])
      await audit(d, req, { action: 'board.deleted', type: 'board', id: b.id, name: b.name, project: p!, before: { jql: b.jql, type: b.type } })
    })
    reply.code(204).send()
  })

  // The board's work items, in rank order, a page at a time: its filter AND the quick filters chosen, among what I may see
  app.get('/boards/:id/issues', { schema: { tags: T,
    summary: 'A board’s work items in rank order, a page at a time: its filter AND the chosen quick filters, among what I may see. Scope `board`: what the board shows (Scrum: the active sprint; Kanban: without old Done items); `backlog` (Scrum): the board’s open sprints and unfinished items in no sprint; `all`: everything its filter finds',
    params: idP, querystring: z.object({
      quick: z.string().max(2000).optional().describe('Comma-separated quick filter ids'), scope: z.enum(['board', 'backlog', 'all']).default('board'),
      cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
    }) } }, async req => {
    const { board: b } = await boardFor(db, req.me, req.params.id)
    const q = req.query
    const { where, args } = await boardWhere(db, req.me, b, { quick: q.quick ? q.quick.split(',').filter(Boolean) : [], scope: q.scope })
    const [{ total }] = await db.query<{ total: number }>(`select count(*)::int as total from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where ${where.join(' and ')}`, args) as any
    const page = [...args]
    const lane = await laneSql(db, req.me, b, page)                     // its parameters only in the page query, which uses them
    const color = await colorSql(db, req.me, b, page)                   // the card colour query each matches (spec 0409)
    if (q.cursor) {
      const [r, id] = Buffer.from(q.cursor, 'base64url').toString().split('|')
      if (!id || !Number.isFinite(Number(r))) throw new HttpError(400, 'Invalid cursor')
      page.push(Number(r), id); where.push(`(i.rank, i.id) > ($${page.length - 1}, $${page.length}::uuid)`)
    }
    page.push(q.limit + 1)
    const rows = await db.query<any>(`${ISSUE_ROW.replace('from issues i', `, ${lane} as lane, ${color} as color, p.key as project_key from issues i`)} join statuses st on st.id = i.status_id
      where ${where.join(' and ')} order by i.rank, i.id limit $${page.length}`, page)
    const more = rows.length > q.limit, items = more ? rows.slice(0, q.limit) : rows
    const last = items.at(-1)
    return { items, total, next: more && last ? Buffer.from(`${last.rank}|${last.id}`).toString('base64url') : null }
  })

  // Reports › Control chart (spec 0410): each item that left the chosen statuses within the timeframe, when it last left
  // them, and the total time it spent in them (every visit). Worked out from the status history in one query.
  app.get('/boards/:id/reports/control', { schema: { tags: T, summary: 'Control chart: cycle time of each item that left the chosen statuses in the timeframe (the board’s filter AND its chosen quick filters); most recent 5000',
    params: idP, querystring: z.object({
      days: z.coerce.number().int().min(1).max(36_500).optional().describe('Timeframe in days; leave out for all time'),
      statuses: z.string().max(4000).describe('Comma-separated global status ids: the columns that make up cycle time'),
      quick: z.string().max(2000).optional().describe('Comma-separated quick filter ids'),
    }) } }, async req => {
    const { board: b } = await boardFor(db, req.me, req.params.id)
    const q = req.query
    const chosen = q.statuses.split(',').filter(Boolean)
    if (!chosen.length || chosen.some(s => !/^[0-9a-f-]{36}$/i.test(s))) throw new HttpError(400, 'Choose at least one column', { statuses: 'Global status ids' })
    const { where, args } = await boardWhere(db, req.me, b, { quick: q.quick ? q.quick.split(',').filter(Boolean) : [], scope: 'all' })
    args.push(chosen); const sel = `$${args.length}::text[]`
    args.push(q.days ?? null); const days = `$${args.length}::int`
    const rows = await db.query<{ id: string; key: string; title: string; type: string; leftAt: string; minutes: number }>(`
      with items as (
        select i.id, p.key || '-' || i.number as key, i.title, i.type, i.status_id, i.created_at
          from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
         where ${where.join(' and ')} and i.type <> 'epic'),
      changes as (
        select a.issue_id, a.created_at as at, a.from_value, a.to_value from activity a join items on items.id = a.issue_id where a.field = 'statusId'),
      visits as (                                                      -- where each item was, from when to when
        select i.id, coalesce((select c.from_value from changes c where c.issue_id = i.id order by c.at limit 1), i.status_id::text) as status, i.created_at as since from items i
        union all select issue_id, to_value, at from changes),
      spans as (
        select v.id, v.since, lead(v.since) over (partition by v.id order by v.since) as until, st.global_status_id::text = any(${sel}) as chosen
          from visits v left join statuses st on st.id::text = v.status)
      select i.id, i.key, i.title, i.type, max(s.until) filter (where s.chosen) as left_at,
             round(sum(extract(epoch from s.until - s.since)) filter (where s.chosen) / 60)::int as minutes
        from items i join spans s on s.id = i.id
       group by i.id, i.key, i.title, i.type
      having bool_or(s.chosen and s.until is not null)                -- it has left them
         and not bool_or(s.chosen and s.until is null)                 -- and isn't back in them now
         and (${days} is null or max(s.until) filter (where s.chosen) > now() - make_interval(days => ${days}))
       order by left_at desc limit 5001`, args)
    return { items: rows.slice(0, 5000), truncated: rows.length > 5000 }
  })

  // The backlog's Epics and Versions panels (spec 0407): the board's epics whose Epic Status isn't Done (spec 0716), and for each epic and each
  // version of the board's project how much of the board's work is in it (all of it, not just what the backlog shows)
  app.get('/boards/:id/panels', { schema: { tags: T, summary: 'The backlog’s Epics and Versions panels: open epics, and per epic and version the board’s items, completed, unestimated and estimate (in the board’s statistic)', params: idP } }, async req => {
    const { board: b } = await boardFor(db, req.me, req.params.id)
    const { where, args } = await boardWhere(db, req.me, b, { scope: 'all' })
    const stat = b.estimation === 'time' ? 'i.time_estimate' : b.estimation === 'count' ? '1' : 'i.estimate'
    const stats = (key: string) => `select ${key} as key, count(*)::int as issues, count(*) filter (where st.category = 'done')::int as completed,
        count(*) filter (where ${stat} is null)::int as unestimated, coalesce(sum(${stat}), 0)::float as estimate,
        coalesce(sum(${stat}) filter (where st.category = 'todo'), 0)::float as todo, coalesce(sum(${stat}) filter (where st.category = 'in-progress'), 0)::float as in_progress,
        coalesce(sum(${stat}) filter (where st.category = 'done'), 0)::float as done
      from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id left join issues par on par.id = i.parent_id and par.deleted_at is null`
    const base = `${where.join(' and ')} and i.type <> 'epic'`
    const byEpic = await db.query<any>(`${stats(`case when par.type = 'epic' then par.id::text else '' end`)} where ${base} and (par.id is null or par.type = 'epic') group by 1`, args)
    const byVersion = await db.query<any>(`${stats(`coalesce(v.id::text, '')`)} left join lateral unnest(i.fix_release_ids) v(id) on true where ${base} group by 1`, args)
    const epics = await db.query<any>(`${ISSUE_ROW.replace('from issues i', ', p.key as project_key from issues i')} join statuses st on st.id = i.status_id
      where ${where.join(' and ')} and i.type = 'epic' and i.epic_status is distinct from 'Done' order by i.rank, i.id limit 500`, args)
    const keyed = (rows: any[]) => Object.fromEntries(rows.map(({ key, ...r }) => [key || 'none', r]))
    return { epics, epicStats: keyed(byEpic), versionStats: keyed(byVersion) }
  })

  // The statuses a board can show, for its Columns settings: those of its own project, of the projects its filter names
  // or finds work in (among those I may see), and any a column already names
  app.get('/boards/:id/statuses', { schema: { tags: T, summary: 'The statuses a board can map to columns: its project’s, those of the projects its filter names or finds work in, and any a column names', params: idP } }, async req => {
    const { board: b } = await boardFor(db, req.me, req.params.id)
    const args: unknown[] = []
    const { where } = await searchWhere(req.me, { q: '', resolution: 'all', jql: b.jql }, args)
    args.push(b.projectId, b.columns.flatMap(c => c.statusIds), namedProjects(parseJql(b.jql).where))
    const n = args.length
    return db.query(`select g.id, g.name, g.category, g.color from wf_statuses g where g.id = any($${n - 1}::uuid[]) or g.id in (
        select s.global_status_id from statuses s where s.project_id = $${n - 2}
          or s.project_id in (select p.id from projects p where p.workspace_id = $1 and (upper(p.key) = any($${n}::text[]) or lower(p.name) = any($${n}::text[])) and ${visible(req.me, 'p.id', args)})
          or s.project_id in (select distinct i.project_id from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where ${where.join(' and ')}))
      order by case g.category when 'todo' then 0 when 'in-progress' then 1 else 2 end, g.name`, args)
  })

  // How many work items a query finds (among what I may see), or what is wrong with it: for the board filter, quick
  // filters and swimlane queries while they are being written
  app.post('/jql/check', { schema: { tags: T, summary: 'Check a JQL query: how many work items it finds among those I may see, or a 400 saying what is wrong and where', body: z.object({ jql }) } }, async req => {
    const args: unknown[] = []
    const { where } = await searchWhere(req.me, { q: '', resolution: 'all', jql: req.body.jql }, args)
    const [{ count }] = await db.query<{ count: number }>(`select count(*)::int as count from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where ${where.join(' and ')}`, args) as any
    return { count }
  })
}

export default plugin
