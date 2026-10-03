// Pure data layer: types, reducer, migration and selectors. No React here so it can be unit-tested with `node --test`.

// ── Types ──────────────────────────────────────────────────

export type Template  = 'kanban' | 'scrum'
export type IssueType = 'epic' | 'story' | 'task' | 'bug'
export type Priority  = 'urgent' | 'high' | 'medium' | 'low' | 'none'
export type Category  = 'todo' | 'in-progress' | 'done'
export type GroupBy   = 'none' | 'assignee' | 'epic' | 'priority'
export type CardField = 'type' | 'key' | 'epic' | 'labels' | 'due' | 'estimate' | 'priority' | 'assignee' | 'subitems'

export interface User {
  id:       string
  name:     string
  initials: string
  color:    string
  title?:   string
}

export interface Status {
  id:        string
  name:      string
  color:     string
  category:  Category
  wipLimit?: number
}

/** A move into `to`. `from: 'any'` means every status may move here. */
export interface Transition {
  id:   string
  name: string
  from: string[] | 'any'
  to:   string
}

export interface BoardPrefs {
  groupBy:        GroupBy
  fields:         Record<CardField, boolean>
  collapsedLanes: string[]
  collapsedCols:  string[]
}

export interface Project {
  id:          string
  key:         string
  name:        string
  description: string
  color:       string
  template:    Template
  leadId:      string
  statuses:    Status[]
  transitions: Transition[]
  layout:      Record<string, { x: number; y: number }>
  boardPrefs:  BoardPrefs
  nextNumber:  number
  createdAt:   number
  sample?:     boolean
}

export interface IssueLink { type: 'blocks' | 'relates'; issueId: string }

export interface Issue {
  id:          string
  key:         string
  projectId:   string
  type:        IssueType
  title:       string
  description: string
  status:      string
  priority:    Priority
  assigneeId?: string
  reporterId:  string
  labels:      string[]
  estimate?:   number
  dueDate?:    string
  sprintId?:   string
  parentId?:   string
  watcherIds:  string[]
  links:       IssueLink[]
  createdAt:   number
  updatedAt:   number
}

export interface Sprint {
  id:           string
  projectId:    string
  name:         string
  goal:         string
  state:        'planned' | 'active' | 'closed'
  startedAt?:   number
  endsAt?:      number
  completedAt?: number
  /** Snapshot taken at start: estimate points committed. */
  committed?:   number
  /** Snapshot taken at completion. */
  completed?:   number
  issueIds?:    string[]
}

export interface Comment {
  id:        string
  issueId:   string
  authorId:  string
  body:      string
  createdAt: number
  editedAt?: number
}

export interface Activity {
  id:        string
  issueId:   string
  actorId:   string
  field?:    string
  from?:     string
  to?:       string
  text:      string
  createdAt: number
}

export type NotificationKind = 'assigned' | 'mentioned' | 'commented' | 'status' | 'due'

export interface Notification {
  id:        string
  userId:    string
  actorId:   string
  issueId:   string
  kind:      NotificationKind
  text:      string
  read:      boolean
  archived:  boolean
  createdAt: number
}

export interface State {
  version:       2
  workspaceName: string
  ownerId:       string | null
  actingAsId:    string | null
  users:         User[]
  projects:      Project[]
  issues:        Issue[]
  sprints:       Sprint[]
  comments:      Comment[]
  activity:      Activity[]
  notifications: Notification[]
  starred:       string[]
  viewed:        string[]
  sampleIds:     string[]
}

export type ProjectPatch = Partial<Pick<Project,
  'name' | 'description' | 'color' | 'leadId' | 'statuses' | 'transitions' | 'layout' | 'boardPrefs'>>
export type IssuePatch = Partial<Omit<Issue, 'id' | 'key' | 'projectId' | 'reporterId' | 'createdAt' | 'watcherIds' | 'links'>>
export type NewIssue = Pick<Issue, 'projectId' | 'title'> & Partial<Pick<Issue,
  'type' | 'description' | 'status' | 'priority' | 'assigneeId' | 'labels' | 'estimate' | 'dueDate' | 'sprintId' | 'parentId'>>

export type Action =
  | { type: 'setOwner'; name: string; workspaceName?: string }
  | { type: 'addUser'; name: string; title?: string }
  | { type: 'updateUser'; id: string; name?: string; title?: string }
  | { type: 'removeUser'; id: string }
  | { type: 'actAs'; userId: string | null }
  | { type: 'setWorkspaceName'; name: string }
  | { type: 'createProject'; project: Pick<Project, 'id' | 'name' | 'key' | 'color' | 'template'> }
  | { type: 'updateProject'; id: string; patch: ProjectPatch }
  | { type: 'deleteProject'; id: string }
  | { type: 'remapStatus'; projectId: string; from: string; to: string }
  | { type: 'toggleStar'; projectId: string }
  | { type: 'createIssue'; id: string; issue: NewIssue }
  | { type: 'updateIssues'; ids: string[]; patch: IssuePatch }
  | { type: 'deleteIssues'; ids: string[] }
  | { type: 'toggleWatch'; issueId: string }
  | { type: 'addLink'; issueId: string; link: IssueLink }
  | { type: 'removeLink'; issueId: string; otherId: string }
  | { type: 'addComment'; issueId: string; body: string }
  | { type: 'editComment'; id: string; body: string }
  | { type: 'deleteComment'; id: string }
  | { type: 'markViewed'; issueId: string }
  | { type: 'createSprint'; projectId: string }
  | { type: 'updateSprint'; id: string; patch: Partial<Pick<Sprint, 'name' | 'goal' | 'endsAt'>> }
  | { type: 'startSprint'; id: string; endsAt: number }
  | { type: 'completeSprint'; id: string; moveTo?: string }
  | { type: 'deleteSprint'; id: string }
  | { type: 'markRead'; ids: string[]; read?: boolean }
  | { type: 'archive'; ids: string[] }
  | { type: 'checkDue'; now: number }
  | { type: 'merge'; data: Partial<State> }
  | { type: 'removeSample' }
  | { type: 'replace'; state: State }
  | { type: 'reset' }

// ── Constants ──────────────────────────────────────────────

export const PROJECT_COLORS = ['#368727', '#4F46E5', '#0891B2', '#D97706', '#DC2626', '#DB2777', '#7C3AED', '#57534E']
export const AVATAR_COLORS  = ['#368727', '#7C3AED', '#0891B2', '#EA580C', '#DB2777', '#4F46E5', '#B45309', '#0D9488']
export const CATEGORY_COLOR: Record<Category, string> = { todo: '#A8A29E', 'in-progress': '#3B82F6', done: '#16A34A' }

export const DEFAULT_STATUSES: Status[] = [
  { id: 'todo',        name: 'To do',       color: '#A8A29E', category: 'todo' },
  { id: 'in-progress', name: 'In progress', color: '#3B82F6', category: 'in-progress' },
  { id: 'in-review',   name: 'In review',   color: '#D97706', category: 'in-progress' },
  { id: 'done',        name: 'Done',        color: '#16A34A', category: 'done' },
]

export const DEFAULT_FIELDS: Record<CardField, boolean> = {
  type: true, key: true, epic: true, labels: true, due: true, estimate: true, priority: true, assignee: true, subitems: true,
}

export const DEFAULT_BOARD_PREFS: BoardPrefs = { groupBy: 'none', fields: DEFAULT_FIELDS, collapsedLanes: [], collapsedCols: [] }

export const EMPTY: State = {
  version: 2, workspaceName: 'Forge', ownerId: null, actingAsId: null,
  users: [], projects: [], issues: [], sprints: [], comments: [], activity: [], notifications: [],
  starred: [], viewed: [], sampleIds: [],
}

// ── Helpers ────────────────────────────────────────────────

export const uid = () => crypto.randomUUID()

export function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

/** "Payments Platform" → "PP", "Payments" → "PAY". Letters only, 2–10 chars. */
export function suggestKey(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z\s]/g, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  return (words.length > 1 ? words.map(w => w[0]).join('') : words[0].slice(0, 3)).slice(0, 10)
}

export const isValidKey = (key: string) => /^[A-Z]{2,10}$/.test(key)

export const makeUser = (name: string, index: number, title?: string): User =>
  ({ id: uid(), name: name.trim(), initials: initialsOf(name), color: AVATAR_COLORS[index % AVATAR_COLORS.length], title })

export const anyToAny = (statuses: Status[]): Transition[] =>
  statuses.map(s => ({ id: uid(), name: s.name, from: 'any', to: s.id }))

export const statusOf   = (p: Project | undefined, statusId: string) => p?.statuses.find(s => s.id === statusId)
export const categoryOf = (p: Project | undefined, statusId: string): Category => statusOf(p, statusId)?.category ?? 'todo'
export const isDone     = (p: Project | undefined, issue: Issue) => categoryOf(p, issue.status) === 'done'

/** Whether the workflow allows moving from one status to another. */
export function canTransition(p: Project, from: string, to: string) {
  if (from === to) return true
  return p.transitions.some(t => t.to === to && (t.from === 'any' || t.from.includes(from)))
}

/** The transitions available from a status, one per target status. */
export function transitionsFrom(p: Project, from: string) {
  const seen = new Set<string>()
  return p.transitions.filter(t =>
    t.to !== from && (t.from === 'any' || t.from.includes(from)) && !seen.has(t.to) && seen.add(t.to))
}

/** Users mentioned in a comment as `@Full Name`. */
export function mentionedUsers(body: string, users: User[]) {
  return users.filter(u => body.includes(`@${u.name}`))
}

export const actorId = (s: State) => s.actingAsId ?? s.ownerId ?? ''

// ── Reducer ────────────────────────────────────────────────

const FIELD_LABEL: Partial<Record<keyof IssuePatch, string>> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority', assigneeId: 'assignee',
  type: 'type', labels: 'labels', estimate: 'estimate', dueDate: 'due date', sprintId: 'sprint', parentId: 'parent',
}

export function reducer(state: State, action: Action, now = Date.now()): State {
  const actor = actorId(state)
  const userName = (id?: string) => state.users.find(u => u.id === id)?.name
  const log = (issueId: string, text: string, field?: string, from?: string, to?: string): Activity =>
    ({ id: uid(), issueId, actorId: actor, field, from, to, text, createdAt: now })
  const notify = (userIds: (string | undefined)[], issueId: string, kind: NotificationKind, text: string): Notification[] =>
    [...new Set(userIds)].filter((id): id is string => !!id && id !== actor && state.users.some(u => u.id === id))
      .map(userId => ({ id: uid(), userId, actorId: actor, issueId, kind, text, read: false, archived: false, createdAt: now }))

  switch (action.type) {
    // ── People & workspace ────────────────────────────────
    case 'setOwner': {
      const user = makeUser(action.name, 0)
      return { ...state, ownerId: user.id, users: [user, ...state.users], workspaceName: action.workspaceName?.trim() || state.workspaceName }
    }
    case 'addUser':
      return { ...state, users: [...state.users, makeUser(action.name, state.users.length, action.title)] }
    case 'updateUser':
      return {
        ...state,
        users: state.users.map(u => u.id !== action.id ? u : {
          ...u,
          ...(action.name?.trim() ? { name: action.name.trim(), initials: initialsOf(action.name) } : {}),
          ...(action.title !== undefined ? { title: action.title.trim() || undefined } : {}),
        }),
      }
    case 'removeUser': {
      if (action.id === state.ownerId) return state
      const fallbackLead = state.ownerId ?? ''
      return {
        ...state,
        users:         state.users.filter(u => u.id !== action.id),
        actingAsId:    state.actingAsId === action.id ? null : state.actingAsId,
        projects:      state.projects.map(p => p.leadId === action.id ? { ...p, leadId: fallbackLead } : p),
        issues:        state.issues.map(i => ({
          ...i,
          assigneeId: i.assigneeId === action.id ? undefined : i.assigneeId,
          watcherIds: i.watcherIds.filter(w => w !== action.id),
        })),
        notifications: state.notifications.filter(n => n.userId !== action.id),
      }
    }
    case 'actAs':
      return { ...state, actingAsId: action.userId === state.ownerId ? null : action.userId }
    case 'setWorkspaceName':
      return action.name.trim() ? { ...state, workspaceName: action.name.trim() } : state

    // ── Projects ──────────────────────────────────────────
    case 'createProject': {
      if (!actor) return state
      const project: Project = {
        ...action.project, description: '', leadId: actor,
        statuses: DEFAULT_STATUSES, transitions: anyToAny(DEFAULT_STATUSES), layout: {},
        boardPrefs: DEFAULT_BOARD_PREFS, nextNumber: 1, createdAt: now,
      }
      return { ...state, projects: [...state.projects, project] }
    }
    case 'updateProject':
      return { ...state, projects: state.projects.map(p => p.id === action.id ? { ...p, ...action.patch } : p) }
    case 'deleteProject': {
      const issueIds = new Set(state.issues.filter(i => i.projectId === action.id).map(i => i.id))
      return dropIssues({
        ...state,
        projects: state.projects.filter(p => p.id !== action.id),
        sprints:  state.sprints.filter(s => s.projectId !== action.id),
        starred:  state.starred.filter(id => id !== action.id),
      }, issueIds)
    }
    case 'remapStatus': {
      // Workflow edits: move items off a deleted status regardless of transitions
      const p = state.projects.find(x => x.id === action.projectId)
      const name = p?.statuses.find(st => st.id === action.to)?.name ?? ''
      const moved = state.issues.filter(i => i.projectId === action.projectId && i.status === action.from)
      return {
        ...state,
        issues:   state.issues.map(i => moved.includes(i) ? { ...i, status: action.to, updatedAt: now } : i),
        activity: [...state.activity, ...moved.map(i => log(i.id, `changed status to ${name} (workflow update)`, 'status', action.from, action.to))],
      }
    }
    case 'toggleStar': {
      const starred = state.starred.includes(action.projectId)
        ? state.starred.filter(id => id !== action.projectId)
        : [...state.starred, action.projectId]
      return { ...state, starred }
    }

    // ── Work items ────────────────────────────────────────
    case 'createIssue': {
      const project = state.projects.find(p => p.id === action.issue.projectId)
      if (!project || !actor) return state
      const issue: Issue = {
        type: 'task', description: '', status: project.statuses[0].id, priority: 'none', labels: [],
        ...action.issue,
        id: action.id, key: `${project.key}-${project.nextNumber}`, reporterId: actor,
        watcherIds: [...new Set([actor, action.issue.assigneeId].filter((x): x is string => !!x))],
        links: [], createdAt: now, updatedAt: now,
      }
      return {
        ...state,
        projects: state.projects.map(p => p.id === project.id ? { ...p, nextNumber: p.nextNumber + 1 } : p),
        issues:   [...state.issues, issue],
        activity: [...state.activity, log(issue.id, 'created the work item', 'status', undefined, issue.status)],
        notifications: [...state.notifications,
          ...notify([issue.assigneeId], issue.id, 'assigned', `${userName(actor)} assigned ${issue.key} to you`)],
      }
    }
    case 'updateIssues': {
      let next = state
      for (const id of action.ids) next = updateOne(next, id, action.patch, log, notify, userName, now)
      return next
    }
    case 'deleteIssues': {
      const ids = new Set(action.ids)
      for (const i of state.issues) if (i.parentId && ids.has(i.parentId)) ids.add(i.id)
      return dropIssues(state, ids)
    }
    case 'toggleWatch':
      return {
        ...state,
        issues: state.issues.map(i => i.id !== action.issueId ? i : {
          ...i, watcherIds: i.watcherIds.includes(actor) ? i.watcherIds.filter(w => w !== actor) : [...i.watcherIds, actor],
        }),
      }
    case 'addLink': {
      if (action.issueId === action.link.issueId) return state
      const exists = (a: string, b: string) => state.issues.find(i => i.id === a)?.links.some(l => l.issueId === b)
      if (exists(action.issueId, action.link.issueId) || exists(action.link.issueId, action.issueId)) return state
      const other = state.issues.find(i => i.id === action.link.issueId)
      return {
        ...state,
        issues:   state.issues.map(i => i.id === action.issueId ? { ...i, links: [...i.links, action.link], updatedAt: now } : i),
        activity: [...state.activity, log(action.issueId, `linked ${other?.key ?? 'an item'} (${action.link.type === 'blocks' ? 'blocks' : 'relates to'})`)],
      }
    }
    case 'removeLink':
      return {
        ...state,
        issues: state.issues.map(i =>
          i.id === action.issueId || i.id === action.otherId
            ? { ...i, links: i.links.filter(l => l.issueId !== action.otherId && l.issueId !== action.issueId) }
            : i),
      }

    // ── Comments ──────────────────────────────────────────
    case 'addComment': {
      const issue = state.issues.find(i => i.id === action.issueId)
      if (!issue || !actor || !action.body.trim()) return state
      const body = action.body.trim()
      const mentioned = mentionedUsers(body, state.users).map(u => u.id)
      const comment: Comment = { id: uid(), issueId: issue.id, authorId: actor, body, createdAt: now }
      const who = userName(actor)
      return {
        ...state,
        comments: [...state.comments, comment],
        issues:   state.issues.map(i => i.id === issue.id
          ? { ...i, updatedAt: now, watcherIds: [...new Set([...i.watcherIds, actor, ...mentioned])] } : i),
        notifications: [...state.notifications,
          ...notify(mentioned, issue.id, 'mentioned', `${who} mentioned you on ${issue.key}`),
          ...notify(issue.watcherIds.filter(w => !mentioned.includes(w)), issue.id, 'commented', `${who} commented on ${issue.key}`)],
      }
    }
    case 'editComment':
      return {
        ...state,
        comments: state.comments.map(c => c.id === action.id && c.authorId === actor && action.body.trim()
          ? { ...c, body: action.body.trim(), editedAt: now } : c),
      }
    case 'deleteComment':
      return { ...state, comments: state.comments.filter(c => !(c.id === action.id && c.authorId === actor)) }

    case 'markViewed':
      if (state.viewed[0] === action.issueId) return state
      return { ...state, viewed: [action.issueId, ...state.viewed.filter(id => id !== action.issueId)].slice(0, 30) }

    // ── Sprints ───────────────────────────────────────────
    case 'createSprint': {
      const project = state.projects.find(p => p.id === action.projectId)
      if (!project) return state
      const n = state.sprints.filter(s => s.projectId === action.projectId).length + 1
      const sprint: Sprint = { id: uid(), projectId: action.projectId, name: `${project.key} Sprint ${n}`, goal: '', state: 'planned' }
      return { ...state, sprints: [...state.sprints, sprint] }
    }
    case 'updateSprint':
      return { ...state, sprints: state.sprints.map(s => s.id === action.id ? { ...s, ...action.patch } : s) }
    case 'startSprint': {
      const sprint = state.sprints.find(s => s.id === action.id)
      if (!sprint || state.sprints.some(s => s.projectId === sprint.projectId && s.state === 'active')) return state
      const committed = state.issues.filter(i => i.sprintId === sprint.id).reduce((n, i) => n + (i.estimate ?? 0), 0)
      return {
        ...state,
        sprints: state.sprints.map(s => s.id === action.id ? { ...s, state: 'active', startedAt: now, endsAt: action.endsAt, committed } : s),
      }
    }
    case 'completeSprint': {
      const sprint = state.sprints.find(s => s.id === action.id)
      const project = state.projects.find(p => p.id === sprint?.projectId)
      if (!sprint || !project) return state
      const items = state.issues.filter(i => i.sprintId === sprint.id)
      const completed = items.filter(i => isDone(project, i)).reduce((n, i) => n + (i.estimate ?? 0), 0)
      return {
        ...state,
        sprints: state.sprints.map(s => s.id === action.id
          ? { ...s, state: 'closed', completedAt: now, completed, issueIds: items.map(i => i.id) } : s),
        // Unfinished work moves to the chosen sprint, or back to the backlog
        issues: state.issues.map(i =>
          i.sprintId === sprint.id && !isDone(project, i) ? { ...i, sprintId: action.moveTo, updatedAt: now } : i),
      }
    }
    case 'deleteSprint':
      return {
        ...state,
        sprints: state.sprints.filter(s => s.id !== action.id),
        issues:  state.issues.map(i => i.sprintId === action.id ? { ...i, sprintId: undefined } : i),
      }

    // ── Notifications ─────────────────────────────────────
    case 'markRead': {
      const ids = new Set(action.ids)
      return { ...state, notifications: state.notifications.map(n => ids.has(n.id) ? { ...n, read: action.read ?? true } : n) }
    }
    case 'archive': {
      const ids = new Set(action.ids)
      return { ...state, notifications: state.notifications.map(n => ids.has(n.id) ? { ...n, archived: true, read: true } : n) }
    }
    case 'checkDue': {
      // One reminder per item per due date, for open items due within the next 24h
      const fresh: Notification[] = []
      for (const i of state.issues) {
        if (!i.assigneeId || !i.dueDate) continue
        const due = new Date(i.dueDate + 'T23:59').getTime()
        if (due - action.now > 86_400_000 || isDone(state.projects.find(p => p.id === i.projectId), i)) continue
        const text = due < action.now ? `${i.key} is overdue` : `${i.key} is due ${i.dueDate}`
        if (state.notifications.some(n => n.kind === 'due' && n.issueId === i.id && n.userId === i.assigneeId && n.text === text)) continue
        fresh.push({ id: uid(), userId: i.assigneeId, actorId: i.reporterId, issueId: i.id, kind: 'due', text, read: false, archived: false, createdAt: action.now })
      }
      return fresh.length ? { ...state, notifications: [...state.notifications, ...fresh] } : state
    }

    // ── Bulk data ─────────────────────────────────────────
    case 'merge': {
      const d = action.data
      const ids = [
        ...(d.users ?? []), ...(d.projects ?? []), ...(d.issues ?? []), ...(d.sprints ?? []),
        ...(d.comments ?? []), ...(d.activity ?? []), ...(d.notifications ?? []),
      ].map(x => x.id)
      return {
        ...state,
        users:         [...state.users, ...(d.users ?? [])],
        projects:      [...state.projects, ...(d.projects ?? [])],
        issues:        [...state.issues, ...(d.issues ?? [])],
        sprints:       [...state.sprints, ...(d.sprints ?? [])],
        comments:      [...state.comments, ...(d.comments ?? [])],
        activity:      [...state.activity, ...(d.activity ?? [])],
        notifications: [...state.notifications, ...(d.notifications ?? [])],
        starred:       [...state.starred, ...(d.starred ?? [])],
        sampleIds:     [...state.sampleIds, ...ids],
      }
    }
    case 'removeSample': {
      const ids = new Set(state.sampleIds)
      const keep = <T extends { id: string }>(xs: T[]) => xs.filter(x => !ids.has(x.id))
      const users = keep(state.users)
      const userIds = new Set(users.map(u => u.id))
      const issues = keep(state.issues).map(i => ({
        ...i,
        assigneeId: i.assigneeId && userIds.has(i.assigneeId) ? i.assigneeId : undefined,
        watcherIds: i.watcherIds.filter(w => userIds.has(w)),
      }))
      return {
        ...state,
        users, issues,
        actingAsId:    state.actingAsId && userIds.has(state.actingAsId) ? state.actingAsId : null,
        projects:      keep(state.projects),
        sprints:       keep(state.sprints),
        comments:      keep(state.comments),
        activity:      keep(state.activity),
        notifications: keep(state.notifications).filter(n => userIds.has(n.userId)),
        starred:       state.starred.filter(id => !ids.has(id)),
        viewed:        state.viewed.filter(id => !ids.has(id)),
        sampleIds:     [],
      }
    }
    case 'replace':
      return action.state
    case 'reset':
      return EMPTY
  }
}

function dropIssues(state: State, ids: Set<string>): State {
  return {
    ...state,
    issues:        state.issues.filter(i => !ids.has(i.id)).map(i => ({
      ...i,
      parentId: i.parentId && ids.has(i.parentId) ? undefined : i.parentId,
      links:    i.links.filter(l => !ids.has(l.issueId)),
    })),
    comments:      state.comments.filter(c => !ids.has(c.issueId)),
    activity:      state.activity.filter(a => !ids.has(a.issueId)),
    notifications: state.notifications.filter(n => !ids.has(n.issueId)),
    viewed:        state.viewed.filter(id => !ids.has(id)),
  }
}

function updateOne(
  state: State, id: string, patch: IssuePatch,
  log: (issueId: string, text: string, field?: string, from?: string, to?: string) => Activity,
  notify: (userIds: (string | undefined)[], issueId: string, kind: NotificationKind, text: string) => Notification[],
  userName: (id?: string) => string | undefined,
  now: number,
): State {
  const prev = state.issues.find(i => i.id === id)
  if (!prev) return state
  const project = state.projects.find(p => p.id === prev.projectId)
  if (!project) return state
  // The workflow decides which status moves are allowed
  if (patch.status && !canTransition(project, prev.status, patch.status)) return state

  const changed = (Object.keys(patch) as (keyof IssuePatch)[])
    .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(patch[k]))
  if (changed.length === 0) return state

  const who = userName(actorId(state))
  const activity: Activity[] = []
  const notes: Notification[] = []
  let watchers = prev.watcherIds

  for (const k of changed) {
    if (!FIELD_LABEL[k]) continue
    if (k === 'status') {
      const name = statusOf(project, patch.status!)?.name ?? '—'
      activity.push(log(id, `changed status to ${name}`, 'status', prev.status, patch.status))
      notes.push(...notify(prev.watcherIds, id, 'status', `${who} moved ${prev.key} to ${name}`))
    } else if (k === 'assigneeId') {
      const u = userName(patch.assigneeId)
      activity.push(log(id, u ? `assigned to ${u}` : 'removed the assignee', 'assigneeId', prev.assigneeId, patch.assigneeId))
      notes.push(...notify([patch.assigneeId], id, 'assigned', `${who} assigned ${prev.key} to you`))
      if (patch.assigneeId) watchers = [...new Set([...watchers, patch.assigneeId])]
    } else if (k === 'sprintId') {
      const sp = state.sprints.find(s => s.id === patch.sprintId)
      activity.push(log(id, sp ? `moved to ${sp.name}` : 'moved to the backlog', 'sprintId', prev.sprintId, patch.sprintId))
    } else if (k === 'priority') {
      activity.push(log(id, `set priority to ${patch.priority}`, 'priority', prev.priority, patch.priority))
    } else {
      activity.push(log(id, `updated the ${FIELD_LABEL[k]}`, k))
    }
  }

  return {
    ...state,
    issues:        state.issues.map(i => i.id === id ? { ...i, ...patch, watcherIds: watchers, updatedAt: now } : i),
    activity:      [...state.activity, ...activity],
    notifications: [...state.notifications, ...notes],
  }
}

// ── Migration ──────────────────────────────────────────────

/** Bring any saved shape up to the current version. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrate(raw: any): State {
  if (!raw || typeof raw !== 'object') return EMPTY
  if (raw.version === 2) return { ...EMPTY, ...raw }

  // v1: `me` object, statuses with a `done` flag, no transitions/watchers/links/notifications
  const me = raw.me as User | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projects: Project[] = (raw.projects ?? []).map((p: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statuses: Status[] = (p.statuses ?? DEFAULT_STATUSES).map((s: any) => ({
      id: s.id, name: s.name, color: s.color,
      category: s.category ?? (s.done ? 'done' : s.id === 'todo' ? 'todo' : 'in-progress'),
    }))
    return {
      ...p, description: p.description ?? '', statuses, transitions: p.transitions ?? anyToAny(statuses),
      layout: p.layout ?? {}, boardPrefs: p.boardPrefs ?? DEFAULT_BOARD_PREFS,
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues: Issue[] = (raw.issues ?? []).map((i: any) => ({
    ...i, watcherIds: i.watcherIds ?? [...new Set([i.reporterId, i.assigneeId].filter(Boolean))], links: i.links ?? [],
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activity: Activity[] = (raw.activity ?? []).map((a: any) =>
    a.text === 'created the work item' && !a.field
      ? { ...a, field: 'status', to: issues.find(i => i.id === a.issueId)?.status }
      : a)

  return {
    ...EMPTY,
    ownerId:   me?.id ?? null,
    users:     raw.users ?? (me ? [me] : []),
    projects, issues, activity,
    sprints:   raw.sprints ?? [],
    comments:  raw.comments ?? [],
    starred:   raw.starred ?? [],
    viewed:    raw.viewed ?? [],
  }
}

// ── Selectors ──────────────────────────────────────────────

/** Items this one is blocked by (open items that link to it with "blocks"). */
export function blockersOf(state: State, issue: Issue) {
  return state.issues.filter(o =>
    o.links.some(l => l.type === 'blocks' && l.issueId === issue.id) &&
    !isDone(state.projects.find(p => p.id === o.projectId), o))
}

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.round((now - ts) / 1000)
  if (s < 60)  return 'just now'
  const m = Math.round(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 30)  return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
