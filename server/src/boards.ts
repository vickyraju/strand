// Boards (Jira's boards): what a board is, who may change it, and the work items it shows. A board's items are its
// filter (JQL, which may name several projects) AND any quick filters chosen, among the items the viewer may see;
// on a Scrum board only its active sprint, on a Kanban board without Done items left untouched for `done_days`.
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { roleOf } from './access.ts'
import { jqlToSql, parseOr400 } from './jqlSql.ts'
import { searchWhere } from './routes/misc.ts'

export interface Column { id: string; name: string; statusIds: string[]; min?: number; max?: number }
export interface Lanes { by: 'none' | 'assignee' | 'epic' | 'priority' | 'project' | 'queries'; queries?: { id: string; name: string; jql: string }[] }
export interface Board {
  id: string; workspaceId: string; projectId: string; name: string; type: 'kanban' | 'scrum'; jql: string
  columns: Column[]; swimlanes: Lanes; quickFilters: { id: string; name: string; jql: string }[]; cardFields: Record<string, boolean>
  doneDays: number | null; position: number; createdBy: string | null
}

/** Jira's two quick filters every new board starts with. */
export const DEFAULT_QUICK = () => [
  { id: randomUUID(), name: 'Only my issues', jql: 'assignee = currentUser()' },
  { id: randomUUID(), name: 'Recently updated', jql: 'updated >= -1d' },
]

/** Columns for a project's statuses as they are now: one per status, in board order, keeping their WIP limits. */
export async function columnsOf(d: Db, projectId: string): Promise<Column[]> {
  const rows = await d.query<{ id: string; name: string; globalStatusId: string; wipLimit: number | null }>(
    'select id, name, global_status_id, wip_limit from statuses where project_id = $1 and global_status_id is not null order by position', [projectId])
  return rows.map(s => ({ id: randomUUID(), name: s.name, statusIds: [s.globalStatusId], ...(s.wipLimit ? { max: s.wipLimit } : {}) }))
}

/** A new project's first board: its own items, its statuses as columns, Jira's two quick filters. */
export async function firstBoard(d: Db, p: { id: string; workspaceId: string; key: string; template: 'kanban' | 'scrum' }, by: string | null) {
  const [b] = await d.query<{ id: string }>(
    `insert into boards (workspace_id, project_id, name, type, jql, columns, quick_filters, done_days, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [p.workspaceId, p.id, `${p.key} board`, p.template, `project = ${p.key}`, JSON.stringify(await columnsOf(d, p.id)), JSON.stringify(DEFAULT_QUICK()),
      p.template === 'kanban' ? 14 : null, by])
  if (by) await d.query('insert into board_admins (board_id, user_id) values ($1, $2) on conflict do nothing', [b!.id, by])
  return b!.id
}

/** A project's boards follow its workflow (Jira: new statuses appear on its boards): a status the project gains gets a
 *  column, after the column of the status before it; on a board of only this project, a status it loses leaves its
 *  column, and a column that leaves empty goes (unless it is the last). A status an admin took off a board stays off. */
export async function followStatuses(d: Db, p: { id: string; key: string }, order: string[], gained: string[], lost: string[]) {
  if (!gained.length && !lost.length) return
  const names = new Map((await d.query<{ globalStatusId: string; name: string }>('select global_status_id, name from statuses where project_id = $1', [p.id])).map(s => [s.globalStatusId, s.name]))
  for (const b of await d.query<Board>('select * from boards where project_id = $1 for update', [p.id])) {
    let cols = b.columns
    if (lost.length && b.jql.trim().toLowerCase() === `project = ${p.key}`.toLowerCase()) {
      const kept = cols.map(c => ({ ...c, statusIds: c.statusIds.filter(g => !lost.includes(g)) }))
      cols = kept.filter((c, i) => c.statusIds.length || !cols[i]!.statusIds.length)
      if (!cols.length) cols = kept.slice(0, 1)
    }
    for (const g of gained) {
      if (cols.some(c => c.statusIds.includes(g))) continue
      const before = order.slice(0, order.indexOf(g)).reverse().map(x => cols.findIndex(c => c.statusIds.includes(x))).find(i => i >= 0) ?? -1
      cols = [...cols.slice(0, before + 1), { id: randomUUID(), name: names.get(g) ?? 'New status', statusIds: [g] }, ...cols.slice(before + 1)]
    }
    if (JSON.stringify(cols) !== JSON.stringify(b.columns)) await d.query('update boards set columns = $2, updated_at = now() where id = $1', [b.id, JSON.stringify(cols)])
  }
}

/** A board I may see (read access to its project), with my role there and whether I may change it. 404 otherwise. */
export async function boardFor(d: Db, me: Me, id: string, opts: { manage?: boolean; lock?: boolean } = {}) {
  const [b] = await d.query<Board>(`select * from boards where id = $1 and workspace_id = $2 ${opts.lock ? 'for update' : ''}`, [id, me.workspaceId])
  const role = b ? await roleOf(d, me, b.projectId) : null
  if (!b || !role) throw new HttpError(404, 'Board not found')
  const canManage = role === 'admin' || (await d.query(
    `select 1 from board_admins a where a.board_id = $1 and (a.user_id = $2 or a.group_id in (select group_id from group_members where user_id = $2))`, [b.id, me.id])).length > 0
  if (opts.manage && !canManage) throw new HttpError(403, 'Only the board’s administrators and the project’s admins can change it')
  return { board: b, role, canManage }
}

/** Every query a board stores, parsed now: a mistake is a 400 that says where, not a board that silently shows nothing. */
export async function checkQueries(d: Db, me: Me, b: Pick<Board, 'jql' | 'swimlanes' | 'quickFilters'>) {
  const check = async (jql: string, field: string) => {
    try { await jqlToSql(d, me, parseOr400(jql), []) }
    catch (e) { if (e instanceof HttpError) throw new HttpError(400, `${field}: ${e.message}`, { [field]: e.message }); throw e }
  }
  await check(b.jql, 'jql')
  for (const q of b.quickFilters) await check(q.jql, `quickFilters.${q.id}`)
  for (const q of b.swimlanes.queries ?? []) await check(q.jql, `swimlanes.${q.id}`)
}

/** The SQL for a board's items as `me` sees them: where, and the parameters (an ORDER BY in the board's JQL is ignored:
 *  a board is in rank order). `quick` are quick-filter ids to AND in; `scope` narrows to the active sprint, the backlog
 *  (Scrum) or everything. */
export async function boardWhere(d: Db, me: Me, b: Board, o: { quick?: string[]; scope: 'board' | 'backlog' | 'all' }) {
  const args: unknown[] = []
  const { where } = await searchWhere(me, { q: '', resolution: 'all', jql: b.jql }, args)
  for (const id of o.quick ?? []) {
    const f = b.quickFilters.find(x => x.id === id)
    if (!f) throw new HttpError(400, 'No such quick filter on this board', { quick: id })
    const sql = await jqlToSql(d, me, parseOr400(f.jql), args)
    if (sql.where) where.push(`(${sql.where})`)
  }
  args.push(b.id)
  const boardArg = `$${args.length}`
  if (o.scope === 'board' && b.type === 'scrum') where.push(`i.sprint_id = (select id from sprints where board_id = ${boardArg} and state = 'active')`)
  // the backlog: the board's open sprints (done work included, as it counts there) and unfinished work in no sprint
  else if (o.scope === 'backlog') where.push(`(i.sprint_id in (select id from sprints where board_id = ${boardArg} and state <> 'closed') or (i.sprint_id is null and st.category <> 'done'))`)
  else where.push(`${boardArg}::uuid is not null`)                                        // keeps the parameter used
  if (o.scope === 'board' && b.type === 'kanban' && b.doneDays)
    { args.push(b.doneDays); where.push(`(st.category <> 'done' or i.updated_at > now() - make_interval(days => $${args.length}))`) }
  return { where, args }
}

/** Which swimlane query each item falls in (the first that matches; "" for none), as one SQL CASE. */
export async function laneSql(d: Db, me: Me, b: Board, args: unknown[]) {
  if (b.swimlanes.by !== 'queries' || !b.swimlanes.queries?.length) return `''`
  const whens: string[] = []
  for (const q of b.swimlanes.queries) {
    const sql = await jqlToSql(d, me, parseOr400(q.jql), args)
    args.push(q.id)
    whens.push(`when ${sql.where ?? 'true'} then $${args.length}`)
  }
  return `case ${whens.join(' ')} else '' end`
}
