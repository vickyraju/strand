// Converts API payloads (camelCased rows, ISO dates, nullable columns) into the app's own types
// (epoch-millisecond numbers, optional fields). Pure: no React, no fetch, so it is unit-tested.
import {
  DEFAULT_BOARD_PREFS, type Project, type Sprint, type State, type User,
  type Dashboard, type Notification, type SavedView, type Activity, type Comment, type IssueLink, type Worklog, type Issue, type Status, type Transition, type Rule, type FieldDef, type Release, type ItemTemplate,
} from '../data/reducer.ts'

export type Row = Record<string, any>

const ms = (iso: unknown): number | undefined => (iso ? new Date(String(iso)).getTime() : undefined)

export const mapUser = (u: Row): User => ({
  id: u.id, name: u.name, initials: u.initials, color: u.color, ...(u.title ? { title: u.title } : {}),
})

const mapStatus = (s: Row): Status => ({ id: s.id, name: s.name, color: s.color, category: s.category, ...(s.wipLimit ? { wipLimit: s.wipLimit } : {}) })
const mapTransition = (t: Row): Transition => ({ id: t.id, name: t.name, from: t.fromIds ?? 'any', to: t.toId })
const mapRule = (r: Row): Rule => ({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, actions: r.actions, runs: r.runs ?? 0 })
const mapField = (f: Row): FieldDef => ({ id: f.id, name: f.name, kind: f.kind, ...(f.options ? { options: f.options } : {}) })
const mapRelease = (r: Row): Release => ({
  id: r.id, name: r.name, description: r.description ?? '', released: !!r.released,
  ...(r.startDate ? { startDate: r.startDate } : {}), ...(r.releaseDate ? { releaseDate: r.releaseDate } : {}),
  ...(r.releasedAt ? { releasedAt: ms(r.releasedAt) } : {}),
})
const mapTemplate = (t: Row): ItemTemplate => ({
  id: t.id, name: t.name, type: t.type, title: t.title, description: t.description ?? '', priority: t.priority,
  labels: t.labels ?? [], ...(t.estimate != null ? { estimate: t.estimate } : {}),
})

export const mapSprint = (s: Row): Sprint => ({
  id: s.id, projectId: s.projectId, name: s.name, goal: s.goal ?? '', state: s.state,
  startedAt: ms(s.startedAt), endsAt: ms(s.endsAt), completedAt: ms(s.completedAt),
  ...(s.committed != null ? { committed: s.committed } : {}), ...(s.completed != null ? { completed: s.completed } : {}),
  ...(s.issueIds ? { issueIds: s.issueIds } : {}),
})

/** `GET /api/projects/:key` → Project. Server-side `{}` board prefs fall back to the app defaults. */
export function mapProject(p: Row): Project {
  const prefs = p.boardPrefs ?? {}
  return {
    id: p.id, key: p.key, name: p.name, description: p.description ?? '', color: p.color, template: p.template,
    leadId: p.leadId ?? '',
    statuses: (p.statuses ?? []).map(mapStatus),
    transitions: (p.transitions ?? []).map(mapTransition),
    layout: p.layout ?? {},
    boardPrefs: { ...DEFAULT_BOARD_PREFS, ...prefs, fields: { ...DEFAULT_BOARD_PREFS.fields, ...(prefs.fields ?? {}) } },
    nextNumber: p.nextNumber ?? 1,
    createdAt: ms(p.createdAt) ?? Date.now(),
    rules: (p.rules ?? []).map(mapRule),
    fields: (p.fields ?? []).map(mapField),
    releases: (p.releases ?? []).map(mapRelease),
    templates: (p.templates ?? []).map(mapTemplate),
    ...(p.sample ? { sample: true } : {}),
  }
}

/** Everything slice 2 loads: who you are, the people, and the projects with their sprints. */
export function mapWorkspace(me: Row, users: Row[], projects: Row[], starredIds: string[], extras: { views?: Row[]; dashboards?: Row[]; notifications?: Row[] } = {}): State {
  return {
    version: 4, workspaceName: 'Strand',
    ownerId: me.id, actingAsId: null,
    users: users.map(mapUser),
    projects: projects.map(mapProject),
    sprints: projects.flatMap(p => (p.sprints ?? []).map(mapSprint)),
    issues: [], comments: [], activity: [], notifications: (extras.notifications ?? []).map(mapNotification),
    starred: starredIds, viewed: [], sampleIds: [],
    views: (extras.views ?? []).map(mapView), dashboards: (extras.dashboards ?? []).map(mapDashboard),
  }
}

/** One row of `GET /api/projects/:key/issues` or the list endpoints that return issue rows
 *  (search, my work, my recent): no description/created, status is the row's `statusId`.
 *  Watchers, links, work logs and attachments start empty. */
export const mapIssue = (i: Row): Issue => ({
  id: i.id, key: i.key, projectId: i.projectId, type: i.type, title: i.title, description: i.description ?? '',
  status: i.statusId, priority: i.priority, reporterId: i.reporterId ?? '', labels: i.labels ?? [],
  ...(i.assigneeId ? { assigneeId: i.assigneeId } : {}),
  ...(i.estimate != null ? { estimate: i.estimate } : {}),
  ...(i.timeEstimate != null ? { timeEstimate: i.timeEstimate } : {}),
  ...(i.dueDate ? { dueDate: i.dueDate } : {}), ...(i.startDate ? { startDate: i.startDate } : {}),
  ...(i.sprintId ? { sprintId: i.sprintId } : {}), ...(i.releaseId ? { releaseId: i.releaseId } : {}),
  ...(i.parentId ? { parentId: i.parentId } : {}),
  watcherIds: [], links: [], attachments: [], worklogs: [],
  custom: i.custom ?? {}, rank: i.rank ?? 0, createdAt: ms(i.createdAt) ?? Date.now(), updatedAt: ms(i.updatedAt) ?? Date.now(),
})

/** A search-list row: no description/created, status is the row's `statusId`. Unknown keys (cursorTs…) are dropped. */
export const mapSearchRow = (i: Row): Issue => ({
  id: i.id, key: i.key, projectId: i.projectId, type: i.type, title: i.title, description: '',
  status: i.statusId, priority: i.priority, reporterId: '', labels: i.labels ?? [],
  ...(i.assigneeId ? { assigneeId: i.assigneeId } : {}),
  ...(i.estimate != null ? { estimate: i.estimate } : {}),
  ...(i.dueDate ? { dueDate: i.dueDate } : {}),
  watcherIds: [], links: [], attachments: [], worklogs: [],
  custom: {}, rank: 0, createdAt: 0, updatedAt: ms(i.updatedAt) ?? Date.now(),
})

/** `GET /api/notifications` rows: the server joins the issue's key, title and project key, so inbox rows
 *  never need the issue itself loaded. */
export const mapNotification = (n: Row): Notification => ({
  id: n.id, userId: n.userId, actorId: n.actorId ?? '', issueId: n.issueId, kind: n.kind, text: n.text,
  read: !!n.read, archived: !!n.archived, createdAt: ms(n.createdAt) ?? Date.now(),
  ...(n.issueKey ? { issueKey: n.issueKey } : {}),
  ...(n.issueTitle ? { issueTitle: n.issueTitle } : {}),
  ...(n.projectKey ? { projectKey: n.projectKey } : {}),
})

export const mapComment = (c: Row): Comment => ({
  id: c.id, issueId: c.issueId, authorId: c.authorId ?? '', body: c.body, createdAt: ms(c.createdAt) ?? Date.now(),
  ...(c.editedAt ? { editedAt: ms(c.editedAt) } : {}),
})
export const mapActivity = (a: Row): Activity => ({
  id: a.id, issueId: a.issueId, actorId: a.actorId ?? 'automation', text: a.text, createdAt: ms(a.createdAt) ?? Date.now(),
  ...(a.field ? { field: a.field } : {}), ...(a.fromValue != null ? { from: a.fromValue } : {}), ...(a.toValue != null ? { to: a.toValue } : {}),
})
export const mapWorklog = (w: Row): Worklog => ({
  id: w.id, userId: w.userId ?? '', minutes: w.minutes, date: w.date, note: w.note ?? '', at: ms(w.createdAt) ?? Date.now(),
})

/** `GET /api/issues/:key` → the pieces the reducer keeps next to an issue. Links are the issue's own (outgoing) ones. */
export function mapIssueDetail(d: Row) {
  return {
    comments: (d.comments ?? []).map(mapComment),
    activity: (d.activity ?? []).map(mapActivity),
    worklogs: (d.worklogs ?? []).map(mapWorklog),
    links: (d.links ?? []).filter((l: Row) => l.dir === 'out').map((l: Row): IssueLink => ({ type: l.type, issueId: l.issueId })),
    watcherIds: (d.watcherIds ?? []) as string[],
  }
}

export const mapView = (v: Row): SavedView => ({ id: v.id, name: v.name, ownerId: v.ownerId, shared: !!v.shared, filters: v.filters })
export const mapDashboard = (d: Row): Dashboard => ({ id: d.id, name: d.name, ownerId: d.ownerId, gadgets: d.gadgets ?? [] })
