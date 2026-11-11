// What a webhook carries, in Jira DC's representations (spec 0715 R4, R5): the shapes Jira's REST and webhooks use, so an
// integration written for Jira reads Strand's calls without change. Ids are Strand's (Jira's are numbers in strings).
import type { Db } from './db.ts'
import { ISSUE_ROW } from './routes/issues.ts'
import { getSetting } from './settings.ts'

/** `self` links: Strand's API address when the server knows it (STRAND_API_URL), else null. */
const self = (path: string) => { const b = (process.env.STRAND_API_URL ?? '').replace(/\/$/, ''); return b ? `${b}/api/v1${path}` : null }

/** Jira's date-time: 2026-11-10T09:30:00.000+0000. */
export const jiraTime = (t: string | number | Date | null | undefined) => (t == null ? null : new Date(t).toISOString().replace('Z', '+0000'))
/** Jira's time tracking text: 1w 2d 3h 30m (8h days, 5d weeks). */
const duration = (min: number) => {
  const parts: string[] = []
  for (const [n, u] of [[2400, 'w'], [480, 'd'], [60, 'h'], [1, 'm']] as const) if (min >= n) { parts.push(`${Math.floor(min / n)}${u}`); min %= n }
  return parts.join(' ') || '0m'
}

/** Jira's three status categories. */
export const CATEGORY: Record<string, { id: number; key: string; colorName: string; name: string }> = {
  todo: { id: 2, key: 'new', colorName: 'blue-gray', name: 'To Do' },
  'in-progress': { id: 4, key: 'indeterminate', colorName: 'yellow', name: 'In Progress' },
  done: { id: 3, key: 'done', colorName: 'green', name: 'Done' },
}

interface Person { id: string; name: string; email: string; username: string | null; active: boolean }
export const jiraUser = (u?: Person | null) => u
  ? { self: self(`/users/${u.id}`), name: u.username ?? u.email, key: u.id, emailAddress: u.email, displayName: u.name, active: u.active, timeZone: 'UTC' }
  : null

/** Lookups for one body, each row read once. */
export function lookups(d: Db) {
  const memo = new Map<string, Promise<any>>()
  const once = <T>(k: string, f: () => Promise<T>): Promise<T> => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k)! }
  const one = (sql: string, args: unknown[]) => d.query<any>(sql, args).then(r => r[0] ?? null)
  return {
    user: (id?: string | null) => (id ? once(`u${id}`, () => one('select id, name, email, username, active from users where id = $1', [id]).then(jiraUser)) : Promise.resolve(null)),
    status: (id?: string | null) => (id ? once(`s${id}`, () => one('select id, name, category from statuses where id = $1', [id])) : Promise.resolve(null)),
    type: (projectId: string, key: string) => once(`t${projectId}${key}`, () => one('select key, name from work_types where project_id = $1 and key = $2', [projectId, key])),
    priority: (ws: string, key: string) => once(`p${ws}${key}`, () => one('select key, name from priorities where workspace_id = $1 and key = $2', [ws, key])),
    resolution: (ws: string, name: string) => once(`r${ws}${name}`, () => one('select id, name, description from resolutions where workspace_id = $1 and lower(name) = lower($2)', [ws, name])),
    version: (id: string) => once(`v${id}`, () => one('select * from releases where id = $1', [id])),
    component: (id: string) => once(`c${id}`, () => one('select id, name from components where id = $1', [id])),
    sprint: (id: string) => once(`sp${id}`, () => one('select * from sprints where id = $1', [id])),
    issue: (id: string) => once(`i${id}`, () => one(`${ISSUE_ROW.replace('from issues i', ', p.workspace_id from issues i')} where i.id = $1`, [id])),
  }
}
type L = ReturnType<typeof lookups>

const statusOf = (s: any) => s && { self: self(`/statuses/${s.id}`), description: '', name: s.name, id: s.id, statusCategory: { self: null, ...CATEGORY[s.category] } }
const typeOf = async (L: L, projectId: string, key: string, subtask: boolean) => {
  const t = await L.type(projectId, key)
  return { self: null, id: key, description: '', name: t?.name ?? key[0]!.toUpperCase() + key.slice(1).replace(/_/g, ' '), subtask }
}
const priorityOf = async (L: L, ws: string, key: string) => ({ self: null, name: (await L.priority(ws, key))?.name ?? key, id: key })
export const jiraVersion = (v: any) => v && {
  self: self(`/releases/${v.id}`), id: v.id, description: v.description ?? '', name: v.name, archived: !!v.archived, released: !!v.released,
  ...(v.release_date ?? v.releaseDate ? { releaseDate: String(v.release_date ?? v.releaseDate).slice(0, 10) } : {}),
  ...(v.start_date ?? v.startDate ? { startDate: String(v.start_date ?? v.startDate).slice(0, 10) } : {}), projectId: v.project_id ?? v.projectId,
}
const SPRINT_STATE: Record<string, string> = { planned: 'future', active: 'active', closed: 'closed' }
export const jiraSprint = (s: any) => s && {
  id: s.id, self: self(`/sprints/${s.id}`), state: SPRINT_STATE[s.state] ?? s.state, name: s.name, startDate: jiraTime(s.started_at ?? s.startedAt),
  endDate: jiraTime(s.ends_at ?? s.endsAt), completeDate: jiraTime(s.completed_at ?? s.completedAt), originBoardId: s.board_id ?? s.boardId, goal: s.goal ?? '',
}
/** Jira DC's Sprint field value: the sprint as Jira Software prints it. */
const sprintString = (s: any) => `com.atlassian.greenhopper.service.sprint.Sprint@${s.id.slice(0, 8)}[id=${s.id},rapidViewId=${s.boardId ?? s.board_id},state=${(SPRINT_STATE[s.state] ?? s.state).toUpperCase()},`
  + `name=${s.name},startDate=${jiraTime(s.startedAt ?? s.started_at) ?? '<null>'},endDate=${jiraTime(s.endsAt ?? s.ends_at) ?? '<null>'},completeDate=${jiraTime(s.completedAt ?? s.completed_at) ?? '<null>'},sequence=${s.id},goal=${s.goal ?? ''}]`

/** A linked, parent or sub-item, as Jira nests it: key, summary, status, priority, type. */
async function brief(L: L, i: any) {
  if (!i) return null
  return {
    id: i.id, key: i.key, self: self(`/issues/${i.key}`),
    fields: { summary: i.title, status: statusOf(await L.status(i.statusId)), priority: await priorityOf(L, i.workspaceId, i.priority), issuetype: await typeOf(L, i.projectId, i.type, false) },
  }
}

/** Jira's comment. */
export async function jiraComment(L: L, c: any, d: Db) {
  const vis = c.visibility
  const visibility = !vis ? undefined : vis.kind === 'role' ? { type: 'role', value: vis.role }
    : { type: 'group', value: (await d.query<{ name: string }>('select display_name as name from groups where id = $1', [vis.id]))[0]?.name ?? vis.id }
  return {
    self: self(`/comments/${c.id}`), id: c.id, author: await L.user(c.author_id ?? c.authorId), body: c.body ?? '', updateAuthor: await L.user(c.author_id ?? c.authorId),
    created: jiraTime(c.created_at ?? c.createdAt), updated: jiraTime(c.edited_at ?? c.editedAt ?? c.created_at ?? c.createdAt), ...(visibility ? { visibility } : {}),
  }
}
/** Jira's work log. */
export async function jiraWorklog(L: L, w: any) {
  const by = await L.user(w.user_id ?? w.userId)
  return {
    self: self(`/worklogs/${w.id}`), author: by, updateAuthor: by, comment: w.note ?? '', created: jiraTime(w.created_at ?? w.createdAt), updated: jiraTime(w.created_at ?? w.createdAt),
    started: jiraTime(w.date ? `${String(w.date).slice(0, 10)}T09:00:00Z` : w.created_at), timeSpent: duration(w.minutes ?? 0), timeSpentSeconds: (w.minutes ?? 0) * 60, id: w.id, issueId: w.issue_id ?? w.issueId,
  }
}

/** A custom field's value in Jira's REST shape, for its type (spec 0502 R5). */
async function jiraCustom(L: L, d: Db, kind: string, v: any): Promise<unknown> {
  if (v == null || (Array.isArray(v) && !v.length)) return null
  const option = (x: string) => ({ self: null, value: x, id: x })
  const group = async (id: string) => ({ name: (await d.query<{ name: string }>('select display_name as name from groups where id = $1', [id]))[0]?.name ?? id, self: null })
  switch (kind) {
    case 'select': case 'radio': return option(v)
    case 'multiselect': case 'checkboxes': return v.map(option)
    case 'cascading': return { ...option(v[0]), ...(v[1] ? { child: option(v[1]) } : {}) }
    case 'user': return L.user(v)
    case 'users': return Promise.all(v.map((x: string) => L.user(x)))
    case 'group': return group(v)
    case 'groups': return Promise.all(v.map(group))
    case 'project': { const [p] = await d.query<any>('select id, key, name from projects where id = $1', [v]); return p ? { self: null, id: p.id, key: p.key, name: p.name, projectTypeKey: 'software' } : null }
    case 'version': return jiraVersion(await L.version(v))
    case 'versions': return (await Promise.all(v.map((x: string) => L.version(x)))).filter(Boolean).map(jiraVersion)
    case 'datetime': return jiraTime(v)
    default: return v
  }
}

/** Jira Software's custom field ids (System settings › Webhooks). */
const fieldIds = async (ws: string) => (await getSetting(ws, 'webhooks')).fieldIds as Record<'sprint' | 'epicLink' | 'epicName' | 'epicStatus' | 'epicColour' | 'storyPoints' | 'rank' | 'flagged', string>

/** The item as Jira's REST returns it (GET /rest/api/2/issue): id, self, key and its fields under Jira's ids. */
export async function jiraIssue(d: Db, L: L, issueId: string) {
  const [i] = await d.query<any>(`${ISSUE_ROW.replace('from issues i', ', p.name as project_name, p.workspace_id, p.category_id, p.lead_id from issues i')} where i.id = $1`, [issueId])
  if (!i) return null
  const ws = i.workspaceId
  const parent = i.parentId ? await L.issue(i.parentId) : null
  const ids = await fieldIds(ws)
  const many = (sql: string, args: unknown[]) => d.query<any>(sql, args)
  const [spent] = await many('select coalesce(sum(minutes), 0)::int as m from worklogs where issue_id = $1', [i.id])
  const comments = (await many('select * from (select * from comments where issue_id = $1 order by created_at desc limit 100) c order by created_at', [i.id]))
  const commentTotal = (await many('select count(*)::int as n from comments where issue_id = $1', [i.id]))[0]!.n
  const worklogs = await many('select * from (select * from worklogs where issue_id = $1 order by created_at desc limit 100) w order by created_at', [i.id])
  const worklogTotal = (await many('select count(*)::int as n from worklogs where issue_id = $1', [i.id]))[0]!.n
  const links = await many(`select l.issue_id, l.target_id, l.type, t.name, t.inward, t.outward from issue_links l
      left join link_types t on t.workspace_id = $2 and t.id = l.type where (l.issue_id = $1 or l.target_id = $1) limit 100`, [i.id, ws])
  const subs = i.type === 'epic' ? [] : await many(`${ISSUE_ROW.replace('from issues i', ', p.workspace_id from issues i')} where i.parent_id = $1 and i.deleted_at is null order by i.rank limit 100`, [i.id])
  const sprints = await many('select * from sprints where id = $1 or $2::uuid = any(coalesce(issue_ids, \'{}\')) order by created_at', [i.sprintId, i.id])
  const [watchers] = await many('select count(*)::int as n from issue_watchers where issue_id = $1', [i.id])
  const [cat] = i.categoryId ? await many('select id, name, description from project_categories where id = $1', [i.categoryId]) : []
  const res = i.resolution ? await L.resolution(ws, i.resolution) : null
  const versions = async (list: string[] | null) => (await Promise.all((list ?? []).map(v => L.version(v)))).filter(Boolean).map(jiraVersion)
  const custom = await many('select id, name, kind from field_defs where project_id = $1', [i.projectId])
  const fields: Record<string, unknown> = {
    summary: i.title, description: i.description || null,
    issuetype: await typeOf(L, i.projectId, i.type, !!parent && parent.type !== 'epic'),
    project: { self: self(`/projects/${i.key.split('-')[0]}`), id: i.projectId, key: i.key.split('-')[0], name: i.projectName, projectTypeKey: 'software',
      ...(cat ? { projectCategory: { self: null, id: cat.id, name: cat.name, description: cat.description ?? '' } } : {}) },
    status: statusOf(await L.status(i.statusId)), priority: await priorityOf(L, ws, i.priority),
    resolution: res ? { self: null, id: res.id, description: res.description ?? '', name: res.name } : i.resolution ? { self: null, id: i.resolution, description: '', name: i.resolution } : null,
    resolutiondate: jiraTime(i.resolvedAt),
    assignee: await L.user(i.assigneeId), reporter: await L.user(i.reporterId), creator: await L.user(i.reporterId),
    labels: i.labels ?? [], components: (await Promise.all((i.componentIds ?? []).map((c: string) => L.component(c)))).filter(Boolean).map((c: any) => ({ self: null, id: c.id, name: c.name })),
    fixVersions: await versions(i.fixReleaseIds), versions: await versions(i.affectsReleaseIds),
    created: jiraTime(i.createdAt), updated: jiraTime(i.updatedAt), duedate: i.dueDate ?? null,
    timeoriginalestimate: i.timeEstimate != null ? i.timeEstimate * 60 : null, timeestimate: i.timeRemaining != null ? i.timeRemaining * 60 : null,
    timespent: spent!.m ? spent!.m * 60 : null, aggregatetimeoriginalestimate: i.timeEstimate != null ? i.timeEstimate * 60 : null,
    aggregatetimeestimate: i.timeRemaining != null ? i.timeRemaining * 60 : null, aggregatetimespent: spent!.m ? spent!.m * 60 : null,
    timetracking: { ...(i.timeEstimate != null ? { originalEstimate: duration(i.timeEstimate), originalEstimateSeconds: i.timeEstimate * 60 } : {}),
      ...(i.timeRemaining != null ? { remainingEstimate: duration(i.timeRemaining), remainingEstimateSeconds: i.timeRemaining * 60 } : {}),
      ...(spent!.m ? { timeSpent: duration(spent!.m), timeSpentSeconds: spent!.m * 60 } : {}) },
    ...(parent && parent.type !== 'epic' ? { parent: await brief(L, parent) } : {}),
    subtasks: await Promise.all(subs.map(s => brief(L, s))),
    issuelinks: await Promise.all(links.map(async l => {
      const outward = l.issueId === i.id                                     // the database's rows come camelCased
      const other = await L.issue(outward ? l.targetId : l.issueId)
      return { id: `${l.issueId}:${l.targetId}:${l.type}`, self: null, type: { id: l.type, name: l.name ?? l.type, inward: l.inward ?? l.type, outward: l.outward ?? l.type, self: null },
        [outward ? 'outwardIssue' : 'inwardIssue']: await brief(L, other) }
    })),
    comment: { comments: await Promise.all(comments.map(c => jiraComment(L, c, d))), maxResults: comments.length, total: commentTotal, startAt: Math.max(0, commentTotal - comments.length) },
    worklog: { startAt: Math.max(0, worklogTotal - worklogs.length), maxResults: worklogs.length, total: worklogTotal, worklogs: await Promise.all(worklogs.map(w => jiraWorklog(L, w))) },
    watches: { self: null, watchCount: watchers!.n, isWatching: false }, votes: { self: null, votes: (await many('select count(*)::int as n from issue_votes where issue_id = $1', [i.id]))[0]!.n, hasVoted: false },
    // Jira Software's fields, under the ids this instance gives them
    [ids.sprint]: sprints.length ? sprints.map(sprintString) : null,
    [ids.epicLink]: parent?.type === 'epic' ? parent.key : null,
    [ids.storyPoints]: i.estimate ?? null,
    [ids.rank]: String(i.rank),
    [ids.flagged]: i.flagged ? [{ self: null, value: 'Impediment', id: 'impediment' }] : null,
    ...(i.type === 'epic' ? { [ids.epicName]: i.title, [ids.epicStatus]: i.epicStatus ? { self: null, value: i.epicStatus, id: i.epicStatus } : null, [ids.epicColour]: i.epicColor ?? null } : {}),
  }
  for (const f of custom) fields[`customfield_${f.id}`] = await jiraCustom(L, d, f.kind, i.custom?.[f.id])
  return { id: i.id, self: self(`/issues/${i.key}`), key: i.key, fields }
}
export const briefIssue = async (L: L, issueId?: string) => (issueId ? brief(L, await L.issue(issueId)) : null)

/** Strand's field name → Jira's changelog field and fieldtype. */
const JIRA_FIELD: Record<string, [string, 'jira' | 'custom']> = {
  title: ['summary', 'jira'], description: ['description', 'jira'], type: ['issuetype', 'jira'], priority: ['priority', 'jira'], statusId: ['status', 'jira'],
  assigneeId: ['assignee', 'jira'], reporterId: ['reporter', 'jira'], labels: ['labels', 'jira'], dueDate: ['duedate', 'jira'], resolution: ['resolution', 'jira'],
  timeEstimate: ['timeoriginalestimate', 'jira'], timeRemaining: ['timeestimate', 'jira'], sprintId: ['Sprint', 'custom'], estimate: ['Story Points', 'custom'],
  key: ['Key', 'jira'], projectId: ['project', 'jira'], RemoteIssueLink: ['RemoteIssueLink', 'jira'], flagged: ['Flagged', 'custom'], epicStatus: ['Epic Status', 'custom'], epicColor: ['Epic Colour', 'custom'], rank: ['Rank', 'custom'], startDate: ['Start date', 'custom'],
}
const LIST_FIELD: Record<string, string> = { fixReleaseIds: 'Fix Version', affectsReleaseIds: 'Version', componentIds: 'Component' }

export interface Change { field: string; from: unknown; to: unknown }
/** Strand's changes as Jira's changelog items: Jira's field names, `from`/`to` as ids or values, `fromString`/`toString` as people read them. */
export async function jiraChangelog(d: Db, L: L, issueId: string, changes: Change[]) {
  const [i] = await d.query<any>('select i.project_id, p.workspace_id from issues i join projects p on p.id = i.project_id where i.id = $1', [issueId])
  if (!i) return []
  const items: Record<string, unknown>[] = []
  const item = (field: string, fieldtype: string, from: unknown, fromString: unknown, to: unknown, toString: unknown) =>
    items.push({ field, fieldtype, from: from == null ? null : String(from), fromString: fromString == null ? null : String(fromString), to: to == null ? null : String(to), toString: toString == null ? null : String(toString) })
  for (const c of changes) {
    const list = LIST_FIELD[c.field]
    if (list) {                                     // one item per version or component added or removed, as Jira's
      const before = (c.from as string[] | null) ?? [], after = (c.to as string[] | null) ?? []
      const name = async (id: string) => (c.field === 'componentIds' ? (await L.component(id))?.name : (await L.version(id))?.name) ?? id
      for (const id of before.filter(x => !after.includes(x))) item(list, 'jira', id, await name(id), null, null)
      for (const id of after.filter(x => !before.includes(x))) item(list, 'jira', null, null, id, await name(id))
      continue
    }
    if (c.field === 'custom') {                     // Strand's custom fields: one item per field that changed
      const before = (c.from ?? {}) as Record<string, unknown>, after = (c.to ?? {}) as Record<string, unknown>
      const defs = await d.query<{ id: string; name: string }>('select id, name from field_defs where project_id = $1', [i.projectId])
      for (const f of defs) if (JSON.stringify(before[f.id] ?? null) !== JSON.stringify(after[f.id] ?? null)) item(f.name, 'custom', before[f.id], before[f.id], after[f.id], after[f.id])
      continue
    }
    if (c.field === 'parentId') {                   // into or out of an epic is Jira's Epic Link; a sub-item's parent is Parent
      const [a, b] = [c.from ? await L.issue(String(c.from)) : null, c.to ? await L.issue(String(c.to)) : null]
      const epic = a?.type === 'epic' || b?.type === 'epic'
      item(epic ? 'Epic Link' : 'Parent', epic ? 'custom' : 'jira', a?.id, a?.key, b?.id, b?.key)
      continue
    }
    const [field, fieldtype] = JIRA_FIELD[c.field] ?? [c.field, 'custom']
    const shown = async (v: unknown): Promise<[unknown, unknown]> => {
      if (v == null) return [null, null]
      switch (c.field) {
        case 'statusId': return [v, (await L.status(String(v)))?.name]
        case 'assigneeId': case 'reporterId': { const u = await L.user(String(v)); return [u?.name ?? v, u?.displayName] }
        case 'priority': return [v, (await L.priority(i.workspaceId, String(v)))?.name ?? v]
        case 'type': return [v, (await L.type(i.projectId, String(v)))?.name ?? v]
        case 'sprintId': return [v, (await L.sprint(String(v)))?.name]
        case 'labels': return [null, (v as string[]).join(' ')]
        case 'timeEstimate': case 'timeRemaining': return [Number(v) * 60, Number(v) * 60]
        case 'resolution': { const r = await L.resolution(i.workspaceId, String(v)); return [r?.id ?? v, r?.name ?? v] }
        case 'flagged': return v ? ['impediment', 'Impediment'] : [null, null]
        case 'projectId': { const [p] = await d.query<{ name: string }>('select name from projects where id = $1', [v]); return [v, p?.name ?? v] }
        default: return [v, v]
      }
    }
    const [f, fs] = await shown(c.from), [t, ts] = await shown(c.to)
    item(field, fieldtype, f, fs, t, ts)
  }
  return items
}
