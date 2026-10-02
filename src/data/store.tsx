import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'

// ── Types ──────────────────────────────────────────────────

export type Template  = 'kanban' | 'scrum'
export type IssueType = 'task' | 'story' | 'bug'
export type Priority  = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export interface User {
  id:       string
  name:     string
  initials: string
  color:    string
}

export interface Status {
  id:    string
  name:  string
  color: string
  done?: boolean
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
  nextNumber:  number
  createdAt:   number
}

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
  completedAt?: number
}

export interface Comment {
  id:        string
  issueId:   string
  authorId:  string
  body:      string
  createdAt: number
}

export interface Activity {
  id:        string
  issueId:   string
  actorId:   string
  text:      string
  createdAt: number
}

export interface State {
  me:        User | null
  users:     User[]
  projects:  Project[]
  issues:    Issue[]
  sprints:   Sprint[]
  comments:  Comment[]
  activity:  Activity[]
  starred:   string[]
  viewed:    string[]
}

export type NewIssue = Pick<Issue, 'projectId' | 'title'> & Partial<Pick<Issue,
  'type' | 'description' | 'status' | 'priority' | 'assigneeId' | 'labels' | 'estimate' | 'dueDate' | 'sprintId' | 'parentId'>>

export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'color' | 'leadId' | 'statuses'>>

export type IssuePatch = Partial<Omit<Issue, 'id' | 'key' | 'projectId' | 'reporterId' | 'createdAt'>>

type Action =
  | { type: 'setMe'; name: string }
  | { type: 'addUser'; name: string }
  | { type: 'renameUser'; id: string; name: string }
  | { type: 'reset' }
  | { type: 'createProject'; project: Pick<Project, 'id' | 'name' | 'key' | 'color' | 'template'> }
  | { type: 'updateProject'; id: string; patch: ProjectPatch }
  | { type: 'deleteProject'; id: string }
  | { type: 'toggleStar'; projectId: string }
  | { type: 'createIssue'; id: string; issue: NewIssue }
  | { type: 'updateIssue'; id: string; patch: IssuePatch }
  | { type: 'deleteIssue'; id: string }
  | { type: 'addComment'; issueId: string; body: string }
  | { type: 'markViewed'; issueId: string }
  | { type: 'createSprint'; projectId: string }
  | { type: 'updateSprint'; id: string; patch: Partial<Pick<Sprint, 'name' | 'goal'>> }
  | { type: 'startSprint'; id: string }
  | { type: 'completeSprint'; id: string; moveTo?: string }
  | { type: 'deleteSprint'; id: string }

// ── Constants ──────────────────────────────────────────────

export const PROJECT_COLORS = ['#368727', '#4F46E5', '#0891B2', '#D97706', '#DC2626', '#DB2777', '#7C3AED', '#57534E']
const AVATAR_COLORS = ['#368727', '#7C3AED', '#0891B2', '#EA580C', '#DB2777', '#4F46E5', '#16A34A', '#B45309']

export const DEFAULT_STATUSES: Status[] = [
  { id: 'todo',        name: 'To do',       color: '#A8A29E' },
  { id: 'in-progress', name: 'In progress', color: '#6366F1' },
  { id: 'in-review',   name: 'In review',   color: '#D97706' },
  { id: 'done',        name: 'Done',        color: '#16A34A', done: true },
]

const STORAGE_KEY = 'forge:v1'
const EMPTY: State = {
  me: null, users: [], projects: [], issues: [], sprints: [], comments: [], activity: [], starred: [], viewed: [],
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

export const isDone = (project: Project | undefined, issue: Issue) =>
  !!project?.statuses.find(s => s.id === issue.status)?.done

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
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

function makeUser(name: string, index: number): User {
  return { id: uid(), name: name.trim(), initials: initialsOf(name), color: AVATAR_COLORS[index % AVATAR_COLORS.length] }
}

const FIELD_LABEL: Partial<Record<keyof IssuePatch, string>> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority', assigneeId: 'assignee',
  type: 'type', labels: 'labels', estimate: 'estimate', dueDate: 'due date', sprintId: 'sprint', parentId: 'parent',
}

// ── Reducer ────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  const me = state.me
  const now = Date.now()
  const log = (issueId: string, text: string): Activity =>
    ({ id: uid(), issueId, actorId: me?.id ?? '', text, createdAt: now })

  switch (action.type) {
    case 'setMe': {
      const user = makeUser(action.name, 0)
      return { ...state, me: user, users: [...state.users, user] }
    }
    case 'addUser':
      return { ...state, users: [...state.users, makeUser(action.name, state.users.length)] }
    case 'renameUser': {
      const rename = (u: User) => u.id === action.id ? { ...u, name: action.name.trim(), initials: initialsOf(action.name) } : u
      return { ...state, me: me && rename(me), users: state.users.map(rename) }
    }
    case 'reset':
      return EMPTY

    case 'createProject': {
      if (!me) return state
      const project: Project = {
        ...action.project, description: '', leadId: me.id,
        statuses: DEFAULT_STATUSES, nextNumber: 1, createdAt: now,
      }
      return { ...state, projects: [...state.projects, project] }
    }
    case 'updateProject':
      return { ...state, projects: state.projects.map(p => p.id === action.id ? { ...p, ...action.patch } : p) }
    case 'deleteProject': {
      const issueIds = new Set(state.issues.filter(i => i.projectId === action.id).map(i => i.id))
      return {
        ...state,
        projects: state.projects.filter(p => p.id !== action.id),
        issues:   state.issues.filter(i => !issueIds.has(i.id)),
        sprints:  state.sprints.filter(s => s.projectId !== action.id),
        comments: state.comments.filter(c => !issueIds.has(c.issueId)),
        activity: state.activity.filter(a => !issueIds.has(a.issueId)),
        starred:  state.starred.filter(id => id !== action.id),
        viewed:   state.viewed.filter(id => !issueIds.has(id)),
      }
    }
    case 'toggleStar': {
      const starred = state.starred.includes(action.projectId)
        ? state.starred.filter(id => id !== action.projectId)
        : [...state.starred, action.projectId]
      return { ...state, starred }
    }

    case 'createIssue': {
      const project = state.projects.find(p => p.id === action.issue.projectId)
      if (!project || !me) return state
      const issue: Issue = {
        type: 'task', description: '', status: project.statuses[0].id, priority: 'none', labels: [],
        ...action.issue,
        id: action.id, key: `${project.key}-${project.nextNumber}`,
        reporterId: me.id, createdAt: now, updatedAt: now,
      }
      return {
        ...state,
        projects: state.projects.map(p => p.id === project.id ? { ...p, nextNumber: p.nextNumber + 1 } : p),
        issues:   [...state.issues, issue],
        activity: [...state.activity, log(issue.id, 'created the work item')],
      }
    }
    case 'updateIssue': {
      const prev = state.issues.find(i => i.id === action.id)
      if (!prev) return state
      const changed = (Object.keys(action.patch) as (keyof IssuePatch)[])
        .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(action.patch[k]))
      if (changed.length === 0) return state
      const project = state.projects.find(p => p.id === prev.projectId)
      const describe = (k: keyof IssuePatch) => {
        if (k === 'status') return `changed status to ${project?.statuses.find(s => s.id === action.patch.status)?.name ?? '—'}`
        if (k === 'assigneeId') {
          const u = state.users.find(u => u.id === action.patch.assigneeId)
          return u ? `assigned to ${u.name}` : 'removed the assignee'
        }
        if (k === 'sprintId') {
          const sp = state.sprints.find(s => s.id === action.patch.sprintId)
          return sp ? `moved to ${sp.name}` : 'moved to the backlog'
        }
        if (k === 'priority') return `set priority to ${action.patch.priority === 'none' ? 'none' : action.patch.priority}`
        return `updated the ${FIELD_LABEL[k] ?? k}`
      }
      return {
        ...state,
        issues:   state.issues.map(i => i.id === action.id ? { ...i, ...action.patch, updatedAt: now } : i),
        activity: [...state.activity, ...changed.filter(k => FIELD_LABEL[k]).map(k => log(prev.id, describe(k)))],
      }
    }
    case 'deleteIssue': {
      const ids = new Set([action.id, ...state.issues.filter(i => i.parentId === action.id).map(i => i.id)])
      return {
        ...state,
        issues:   state.issues.filter(i => !ids.has(i.id)),
        comments: state.comments.filter(c => !ids.has(c.issueId)),
        activity: state.activity.filter(a => !ids.has(a.issueId)),
        viewed:   state.viewed.filter(id => !ids.has(id)),
      }
    }
    case 'addComment': {
      if (!me || !action.body.trim()) return state
      const comment: Comment = { id: uid(), issueId: action.issueId, authorId: me.id, body: action.body.trim(), createdAt: now }
      return {
        ...state,
        comments: [...state.comments, comment],
        issues:   state.issues.map(i => i.id === action.issueId ? { ...i, updatedAt: now } : i),
      }
    }
    case 'markViewed':
      if (state.viewed[0] === action.issueId) return state
      return { ...state, viewed: [action.issueId, ...state.viewed.filter(id => id !== action.issueId)].slice(0, 30) }

    case 'createSprint': {
      const n = state.sprints.filter(s => s.projectId === action.projectId).length + 1
      const project = state.projects.find(p => p.id === action.projectId)
      const sprint: Sprint = { id: uid(), projectId: action.projectId, name: `${project?.key ?? ''} Sprint ${n}`, goal: '', state: 'planned' }
      return { ...state, sprints: [...state.sprints, sprint] }
    }
    case 'updateSprint':
      return { ...state, sprints: state.sprints.map(s => s.id === action.id ? { ...s, ...action.patch } : s) }
    case 'startSprint': {
      const sprint = state.sprints.find(s => s.id === action.id)
      if (!sprint || state.sprints.some(s => s.projectId === sprint.projectId && s.state === 'active')) return state
      return { ...state, sprints: state.sprints.map(s => s.id === action.id ? { ...s, state: 'active', startedAt: now } : s) }
    }
    case 'completeSprint': {
      const sprint = state.sprints.find(s => s.id === action.id)
      const project = state.projects.find(p => p.id === sprint?.projectId)
      if (!sprint) return state
      return {
        ...state,
        sprints: state.sprints.map(s => s.id === action.id ? { ...s, state: 'closed', completedAt: now } : s),
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
  }
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY
  } catch {
    return EMPTY
  }
}

// ── Provider ───────────────────────────────────────────────

const StoreContext = createContext<{ state: State; dispatch: (a: Action) => void } | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}

export const projectOf = (state: State, id: string | undefined) => state.projects.find(p => p.id === id)
export const userOf    = (state: State, id: string | undefined) => state.users.find(u => u.id === id)
