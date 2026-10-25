// Pure data layer: types, reducer, migration and selectors. No React here so it can be unit-tested with `node --test`.
import { RULE_FIELDS, actionChanges, allows, problems, type Item, type RuleCtx, type TransitionRules } from './transitionRules.ts'
import { adjustRemaining, type Adjust } from '../../server/src/shared/estimates.ts'

// ── Types ──────────────────────────────────────────────────

export type Template  = 'kanban' | 'scrum'
export type LevelMember = { kind: 'role'; role: 'admin' | 'member' | 'viewer' } | { kind: 'group'; id: string } | { kind: 'user'; id: string } | { kind: 'reporter' } | { kind: 'assignee' }
export interface SecurityLevel { id: string; name: string; description: string; members: LevelMember[]; items?: number }
/** Am I in this level, for this item? (The server decides; this hides choices it would refuse.) */
export function inLevel(level: SecurityLevel, me: { id: string; role?: string | null; groupIds: string[] }, item: { reporterId?: string; assigneeId?: string }) {
  return level.members.some(m => m.kind === 'reporter' ? item.reporterId === me.id : m.kind === 'assignee' ? item.assigneeId === me.id
    : m.kind === 'user' ? m.id === me.id : m.kind === 'group' ? me.groupIds.includes(m.id) : me.role === m.role)
}
export interface Component { id: string; name: string; description: string; leadId?: string; defaultAssignee: 'none' | 'component_lead' | 'project_lead' }

/** Jira's component default assignee: new work in a component, with nobody chosen, goes to its lead or the project's. */
export function componentAssignee(p: Project, componentIds: string[] | undefined): string | undefined {
  for (const id of componentIds ?? []) {
    const c = p.components?.find(x => x.id === id)
    const who = c?.defaultAssignee === 'component_lead' ? c.leadId : c?.defaultAssignee === 'project_lead' ? p.leadId : undefined
    if (who) return who
  }
  return undefined
}

/** A work type's key: one of the built-in four, or one a project added ("t-…"). */
export type IssueType = string
export type BuiltinType = 'epic' | 'story' | 'task' | 'bug'
/** A project's work type (Jira's issue type): its name, colour and icon. The built-in four can be renamed, not removed. */
export interface WorkType { key: IssueType; name: string; color: string; icon: string }
export const BUILTIN_TYPES: WorkType[] = [
  { key: 'epic', name: 'Epic', color: '#7C3AED', icon: 'zap' }, { key: 'story', name: 'Story', color: '#16A34A', icon: 'bookmark' },
  { key: 'task', name: 'Task', color: '#2563EB', icon: 'check' }, { key: 'bug', name: 'Bug', color: '#DC2626', icon: 'bug' },
]
export const isBuiltinType = (k: string): k is BuiltinType => k === 'epic' || k === 'story' || k === 'task' || k === 'bug'
/** A project's work types (the built-in ones for a project saved before types were configurable). */
export const typesOf = (p: Pick<Project, 'types'> | undefined) => (p?.types?.length ? p.types : BUILTIN_TYPES)
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
  /** What the status means, shown in the workflow editor and as a tooltip on the board. */
  description?: string
  wipLimit?: number
}

/** A move into `to`. `from: 'any'` means every status may move here. `to: null` is a loop: the item stays in its status
 *  (an action such as "Log progress"). `rules`: who may use it, what it needs and what it does (transitionRules.ts). */
export interface Transition {
  id:     string
  name:   string
  from:   string[] | 'any'
  to:     string | null
  rules?: TransitionRules
  /** The work types it is for (Jira's workflow per work type); unset: every type. */
  types?: string[]
}

export interface BoardPrefs {
  groupBy:        GroupBy
  fields:         Record<CardField, boolean>
  collapsedLanes: string[]
  collapsedCols:  string[]
}

export const RESOLUTIONS = ['Done', "Won't do", 'Duplicate', 'Cannot reproduce'] as const
export type Resolution = typeof RESOLUTIONS[number]

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
  rules:       Rule[]
  fields:      FieldDef[]
  releases:    Release[]
  templates:   ItemTemplate[]
  /** Security levels (Jira's issue security), from the server */
  securityLevels?: SecurityLevel[]
  /** Components (Jira's): parts of the project, each with a lead and a default assignee for new work in it */
  components?: Component[]
  /** Work types (Jira's issue types); missing in a project saved before they were configurable: the built-in four */
  types?:      WorkType[]
  /** What I may do here (from the server; unset for a local workspace, where everyone has full access) */
  role?:       'admin' | 'member' | 'viewer'
}

/** Automation: "When <trigger> then <actions>". */
export type RuleTrigger =
  | { kind: 'created' }
  | { kind: 'status'; to: string }
  | { kind: 'assigned' }
export type RuleAction =
  | { kind: 'assign'; to: 'reporter' | 'lead' | 'unassign' | string }
  | { kind: 'priority'; value: Priority }
  | { kind: 'label'; value: string }
  | { kind: 'status'; value: string }
  | { kind: 'comment'; body: string }
export interface Rule {
  id:      string
  name:    string
  enabled: boolean
  trigger: RuleTrigger
  actions: RuleAction[]
  runs:    number
  /** Runs that failed (from the server) */
  failures?: number
  /** Who made it, and hears when it fails (from the server) */
  ownerId?: string
}

export interface Attachment {
  id:      string
  name:    string
  size:    number
  type:    string
  addedBy: string
  addedAt: number
}

export const AUTOMATION = 'automation'

/** Project-level custom field shown on every work item in the project. */
export interface FieldDef {
  id:       string
  name:     string
  kind:     'text' | 'number' | 'select' | 'date'
  options?: string[]
}

/** A release (Jira "fix version"). */
export interface Release {
  id:           string
  name:         string
  description:  string
  startDate?:   string
  releaseDate?: string
  released:     boolean
  releasedAt?:  number
}

/** Reusable defaults for new work items. */
export interface ItemTemplate {
  id:          string
  name:        string
  type:        IssueType
  title:       string
  description: string
  priority:    Priority
  labels:      string[]
  estimate?:   number
}

export interface Worklog {
  id:      string
  userId:  string
  minutes: number
  date:    string
  note:    string
  at:      number
}

export type ViewResolution = 'open' | 'done' | 'all'
export interface ViewFilters {
  q:          string
  projectId?: string
  /** null = anyone, '' = unassigned, 'me' = whoever is viewing */
  assignee:   string | null
  type?:      IssueType
  priority?:  Priority
  label?:     string
  resolution: ViewResolution
  /** JQL (with a server): replaces the filters above, as switching to JQL does in Jira */
  jql?:       string
}
/** Who else a saved view is shared with (Jira's filter sharing): a project's people, a group, or one person. */
export interface ViewShare { kind: 'project' | 'group' | 'user'; id: string; can: 'view' | 'edit' }
export interface SavedView {
  id:       string
  name:     string
  ownerId:  string
  /** Everyone in the workspace can see it */
  shared:   boolean
  /** …and these, to view or to edit */
  share?:   ViewShare[]
  /** I may change its name and filters (from the server; a view kept in this browser: when it is mine) */
  canEdit?: boolean
  filters:  ViewFilters
}

/** A link from this item to another. `type` is a link type's id (`LinkType`), read from this side with its outward words. */
export interface IssueLink { type: string; issueId: string }

/** A kind of link (Jira's issue link types), and how it reads each way: "blocks" / "is blocked by". */
export interface LinkType { id: string; name: string; outward: string; inward: string; builtin?: boolean }
/** Jira's link types: what a workspace starts with (the server keeps the workspace's own list). */
export const DEFAULT_LINK_TYPES: LinkType[] = [
  { id: 'blocks', name: 'Blocks', outward: 'blocks', inward: 'is blocked by', builtin: true },
  { id: 'clones', name: 'Cloners', outward: 'clones', inward: 'is cloned by', builtin: true },
  { id: 'duplicates', name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by' },
  { id: 'relates', name: 'Relates', outward: 'relates to', inward: 'relates to' },
]
/** How a link reads from one end: `out` from the item it starts at, otherwise from its target. */
export const linkWords = (s: Pick<State, 'linkTypes'>, type: string, out: boolean) => {
  const t = (s.linkTypes ?? DEFAULT_LINK_TYPES).find(x => x.id === type)
  return t ? (out ? t.outward : t.inward) : out ? 'links to' : 'is linked from'
}

/** Someone with this issue open for editing right now (the server's edit-presence table). */
export interface Editor { userId: string; name: string; initials: string; color: string }

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
  startDate?:  string
  sprintId?:   string
  parentId?:   string
  watcherIds:  string[]
  links:       IssueLink[]
  attachments: Attachment[]
  /** Values for the project's custom fields, by field id. */
  custom:      Record<string, string | number>
  releaseId?:  string
  /** How a finished item ended, and when it last reached Done (kept in step with the status). */
  resolution?: Resolution
  resolvedAt?: number
  /** Original time estimate in minutes. */
  timeEstimate?: number
  /** Security level (Jira's issue security): only its members see the item */
  securityLevelId?: string
  /** Remaining estimate in minutes (Jira's): starts at the original estimate, counts down as work is logged. */
  timeRemaining?: number
  /** Components of the project it belongs to (Jira's). */
  componentIds?: string[]
  /** Affects versions: releases where the problem was found (the fix version is `releaseId`). */
  affectsReleaseIds?: string[]
  worklogs:    Worklog[]
  /** Backlog order: lower is higher priority. Fractional so a move touches one item. */
  rank:        number
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

/** Who can read a comment (Jira's comment visibility): a project role or a group. Unset: everyone who sees the item. */
export type CommentVisibility = { kind: 'role'; role: 'admin' | 'member' | 'viewer' } | { kind: 'group'; id: string }
export interface Comment {
  id:        string
  issueId:   string
  authorId:  string
  body:      string
  createdAt: number
  editedAt?: number
  visibility?: CommentVisibility
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

export type NotificationKind = 'assigned' | 'mentioned' | 'commented' | 'status' | 'due' | 'automation'

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
  /** Joined by the API (`GET /notifications`): the issue and project keys, so inbox rows render without the issue loaded. */
  issueKey?:   string
  issueTitle?: string
  projectKey?: string
}

export interface State {
  version:       4
  workspaceName: string
  ownerId:       string | null
  /** Workspace owner or admin: administers every project (from the server; unset for a workspace kept in this browser) */
  isAdmin?:      boolean
  /** Groups I am in (transition rules can name groups). */
  groupIds?:     string[]
  /** The workspace's link types (from the server; Jira's defaults otherwise). */
  linkTypes?:    LinkType[]
  users:         User[]
  projects:      Project[]
  issues:        Issue[]
  sprints:       Sprint[]
  comments:      Comment[]
  activity:      Activity[]
  notifications: Notification[]
  starred:       string[]
  viewed:        string[]
  views:         SavedView[]
  /** Live edit presence, by issue id: who has this issue open right now. */
  editors:       Record<string, Editor[]>
}

export type ProjectPatch = Partial<Pick<Project,
  'name' | 'description' | 'color' | 'leadId' | 'statuses' | 'transitions' | 'layout' | 'boardPrefs' | 'rules' | 'fields' | 'releases' | 'templates' | 'types' | 'components' | 'securityLevels'>>
export type IssuePatch = Partial<Omit<Issue, 'id' | 'key' | 'projectId' | 'reporterId' | 'createdAt' | 'watcherIds' | 'links' | 'attachments' | 'rank' | 'worklogs'>>
export type NewIssue = Pick<Issue, 'projectId' | 'title'> & Partial<Pick<Issue,
  'type' | 'description' | 'status' | 'priority' | 'assigneeId' | 'labels' | 'estimate' | 'dueDate' | 'startDate' | 'sprintId' | 'parentId' | 'custom' | 'releaseId' | 'timeEstimate' | 'componentIds' | 'affectsReleaseIds'>>

export type Action =
  | { type: 'setOwner'; name: string; workspaceName?: string }
  | { type: 'addUser'; name: string; title?: string }
  | { type: 'updateUser'; id: string; name?: string; title?: string }
  | { type: 'removeUser'; id: string }
  | { type: 'setWorkspaceName'; name: string }
  | { type: 'createProject'; project: Pick<Project, 'id' | 'name' | 'key' | 'color' | 'template'> }
  | { type: 'updateProject'; id: string; patch: ProjectPatch }
  | { type: 'deleteProject'; id: string }
  | { type: 'remapStatus'; projectId: string; from: string; to: string }
  | { type: 'toggleStar'; projectId: string }
  | { type: 'createIssue'; id: string; issue: NewIssue }
  | { type: 'updateIssues'; ids: string[]; patch: IssuePatch }
  | { type: 'setLinkTypes'; linkTypes: LinkType[] }
  /** Jira's Clone: a copy in the start status, linked "clones" to the original; optionally its children, links and sprint. */
  | { type: 'cloneIssue'; id: string; sourceId: string; title: string; assigneeId?: string; include: { children: boolean; links: boolean; sprint: boolean } }
  /** Make one transition by its id, with the fields and comment its screen asked for (loops go this way). */
  | { type: 'runTransition'; issueId: string; transitionId: string; patch: IssuePatch; comment?: string }
  | { type: 'deleteIssues'; ids: string[] }
  | { type: 'toggleWatch'; issueId: string }
  | { type: 'moveIssue'; id: string; beforeId?: string; container?: string | null }
  | { type: 'addAttachment'; issueId: string; attachment: Attachment }
  | { type: 'removeAttachment'; issueId: string; attachmentId: string }
  | { type: 'logWork'; issueId: string; minutes: number; date: string; note: string; adjust?: Adjust }
  | { type: 'updateWorklog'; issueId: string; worklogId: string; minutes: number; date: string; note: string }
  | { type: 'deleteWorklog'; issueId: string; worklogId: string }
  | { type: 'releaseVersion'; projectId: string; releaseId: string; moveTo?: string }
  | { type: 'saveView'; view: SavedView }
  | { type: 'deleteView'; id: string }
  | { type: 'addLink'; issueId: string; link: IssueLink }
  | { type: 'removeLink'; issueId: string; otherId: string }
  | { type: 'addComment'; issueId: string; body: string; visibility?: CommentVisibility }
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
  /** Replaces one project's issues with a fresh copy from the server. Not undoable. */
  | { type: 'loadIssues'; projectId: string; issues: Issue[] }
  /** Notifications as the server has them (it creates them when others assign, mention or comment). */
  | { type: 'setNotifications'; notifications: Notification[] }
  /** A project fetched on demand (opened by link or from search): add or replace it, and replace its sprints. */
  | { type: 'loadProject'; project: Project; sprints: Sprint[] }
  /** The server's copy of a sprint (point snapshots, member list). */
  | { type: 'syncSprint'; sprint: Sprint }
  /** The parts of one issue that come with the single-issue call: comments, history, time logs, outgoing links, watchers. */
  | { type: 'loadIssueDetail'; issueId: string; comments: Comment[]; activity: Activity[]; worklogs: Worklog[]; links: IssueLink[]; watcherIds: string[]; attachments?: Attachment[] }
  /** The server's copy of one issue (key, rank, rule effects). Keeps the local-only watchers, links, work logs and attachments. */
  | { type: 'syncIssue'; issue: Issue }
  /** Who has an issue open for editing right now (live `issue.editing` events). Not undoable. */
  | { type: 'setEditors'; issueId: string; editors: Editor[] }
  /** A project the server created or changed. Replaces the local one with the same id, or adds it. */
  | { type: 'upsertProject'; project: Project }
  | { type: 'replace'; state: State }
  | { type: 'reset' }

// ── Constants ──────────────────────────────────────────────

export const PROJECT_COLORS = ['#368727', '#4F46E5', '#0891B2', '#D97706', '#DC2626', '#DB2777', '#7C3AED', '#57534E']
export const AVATAR_COLORS  = ['#2F7A22', '#7C3AED', '#0E7490', '#C2410C', '#BE185D', '#4F46E5', '#B45309', '#0F766E']
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
  version: 4, workspaceName: 'Forge', ownerId: null,
  users: [], projects: [], issues: [], sprints: [], comments: [], activity: [], notifications: [],
  starred: [], viewed: [], views: [], editors: {},
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

const startsAt = (t: Transition, from: string) => t.from === 'any' || t.from.includes(from)
/** Is the transition part of the workflow for the item's work type? (Without a context: any type.) */
const forType = (t: Transition, ctx?: RuleCtx) => !ctx || !t.types?.length || t.types.includes(String(ctx.item.type))

/** Everything a transition's rules look at, for this item and me (the server builds the same from its own data).
 *  A workspace kept in this browser has no roles: everyone there counts as an admin. */
export function moveContext(state: State, issue: Issue): RuleCtx {
  const project = state.projects.find(p => p.id === issue.projectId)
  const parent = issue.parentId ? state.issues.find(i => i.id === issue.parentId) : undefined
  return {
    mover: { id: actorId(state), role: project?.role ?? 'admin', groupIds: state.groupIds ?? [] },
    item: issue as unknown as Item, leadId: project?.leadId || null,
    openChildren: state.issues.filter(c => c.parentId === issue.id && categoryOf(state.projects.find(p => p.id === c.projectId), c.status) !== 'done').length,
    parent: parent ? { ...(parent as unknown as Item), statusId: parent.status } : null,
    statusName: id => statusOf(project, id)?.name ?? 'another status',
    fieldName: f => (f.startsWith('custom.') ? project?.fields.find(x => x.id === f.slice(7))?.name ?? 'A custom field' : RULE_FIELDS[f] ?? f),
  }
}

/** The transition a move from one status to another uses: one that starts there, ends there, and (given a context) whose
 *  Restrict rules let me use it. Undefined when there is none; a project with no transitions at all allows any move. */
export function transitionFor(p: Project, from: string, to: string, ctx?: RuleCtx): Transition | undefined {
  return p.transitions.find(t => t.to === to && startsAt(t, from) && forType(t, ctx) && (!ctx || allows(t.rules?.restrict, ctx)))
}

/** Whether the workflow allows moving from one status to another (for me, given a context). */
export function canTransition(p: Project, from: string, to: string, ctx?: RuleCtx) {
  if (from === to || p.transitions.length === 0) return true
  return !!transitionFor(p, from, to, ctx)
}

/** The transitions available from a status, one per target status (loops are separate: `loopsFrom`). */
export function transitionsFrom(p: Project, from: string, ctx?: RuleCtx) {
  const seen = new Set<string>()
  return p.transitions.filter((t): t is Transition & { to: string } =>
    t.to !== null && t.to !== from && startsAt(t, from) && forType(t, ctx) && (!ctx || allows(t.rules?.restrict, ctx)) && !seen.has(t.to) && !!seen.add(t.to))
}

/** Loops available from a status: actions that leave the item where it is (shown in the item's Actions menu, as in Jira). */
export const loopsFrom = (p: Project, from: string, ctx?: RuleCtx) =>
  p.transitions.filter(t => t.to === null && startsAt(t, from) && forType(t, ctx) && (!ctx || allows(t.rules?.restrict, ctx)))

/** Users mentioned in a comment as `@Full Name`. */
export function mentionedUsers(body: string, users: User[]) {
  return users.filter(u => body.includes(`@${u.name}`))
}

export const actorId = (s: State) => s.ownerId ?? ''

// ── Reducer ────────────────────────────────────────────────

const FIELD_LABEL: Partial<Record<keyof IssuePatch, string>> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority', assigneeId: 'assignee',
  type: 'type', labels: 'labels', estimate: 'estimate', dueDate: 'due date', sprintId: 'sprint', parentId: 'parent',
  releaseId: 'release', timeEstimate: 'time estimate', custom: 'fields', startDate: 'start date', resolution: 'resolution',
}

/** Keeps resolution in step with the status, as the server does: reaching Done resolves (as Done unless chosen), leaving clears. */
export function withResolution(project: Project, prev: Issue, next: Issue, now: number): Issue {
  const doneNow = categoryOf(project, next.status) === 'done', doneBefore = categoryOf(project, prev.status) === 'done'
  if (!doneNow) { const { resolution: _r, resolvedAt: _a, ...rest } = next; return rest }
  return { ...next, resolution: next.resolution ?? 'Done', resolvedAt: doneBefore ? prev.resolvedAt ?? now : now }
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
        projects:      state.projects.map(p => p.leadId === action.id ? { ...p, leadId: fallbackLead } : p),
        issues:        state.issues.map(i => ({
          ...i,
          assigneeId: i.assigneeId === action.id ? undefined : i.assigneeId,
          watcherIds: i.watcherIds.filter(w => w !== action.id),
        })),
        notifications: state.notifications.filter(n => n.userId !== action.id),
      }
    }
    case 'setWorkspaceName':
      return action.name.trim() ? { ...state, workspaceName: action.name.trim() } : state

    // ── Projects ──────────────────────────────────────────
    case 'createProject': {
      if (!actor) return state
      const project: Project = {
        ...action.project, description: '', leadId: actor,
        statuses: DEFAULT_STATUSES, transitions: anyToAny(DEFAULT_STATUSES), layout: {},
        boardPrefs: DEFAULT_BOARD_PREFS, nextNumber: 1, createdAt: now, rules: [], fields: [], releases: [], templates: [], types: BUILTIN_TYPES,
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
        views:    state.views.map(v => v.filters.projectId === action.id ? { ...v, filters: { ...v.filters, projectId: undefined } } : v),
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
        ...(!('assigneeId' in action.issue) && componentAssignee(project, action.issue.componentIds) ? { assigneeId: componentAssignee(project, action.issue.componentIds) } : {}),
        id: action.id, key: `${project.key}-${project.nextNumber}`, reporterId: actor,
        watcherIds: [...new Set([actor, action.issue.assigneeId].filter((x): x is string => !!x))],
        links: [], attachments: [], worklogs: [], custom: action.issue.custom ?? {}, createdAt: now, updatedAt: now,
        ...(action.issue.timeEstimate != null ? { timeRemaining: action.issue.timeEstimate } : {}),
        rank: Math.max(0, ...state.issues.filter(i => i.projectId === project.id).map(i => i.rank)) + 1,
      }
      const next: State = {
        ...state,
        projects: state.projects.map(p => p.id === project.id ? { ...p, nextNumber: p.nextNumber + 1 } : p),
        issues:   [...state.issues, issue],
        activity: [...state.activity, log(issue.id, 'created the work item', 'status', undefined, issue.status)],
        notifications: [...state.notifications,
          ...notify([issue.assigneeId], issue.id, 'assigned', `${userName(actor)} assigned ${issue.key} to you`)],
      }
      return runRules(next, issue.id, [{ kind: 'created' }, ...(issue.assigneeId ? [{ kind: 'assigned' as const }] : [])], now)
    }
    case 'moveIssue': {
      const issue = state.issues.find(i => i.id === action.id)
      if (!issue) return state
      // container: undefined = stay put, null = backlog, string = sprint id
      const sprintId = action.container === undefined ? issue.sprintId : action.container ?? undefined
      const list = state.issues
        .filter(i => i.projectId === issue.projectId && i.id !== issue.id && i.type !== 'epic' && (i.sprintId ?? null) === (sprintId ?? null))
        .sort((a, b) => a.rank - b.rank)
      const at = action.beforeId ? list.findIndex(i => i.id === action.beforeId) : -1
      const rank = at < 0
        ? (list.at(-1)?.rank ?? 0) + 1
        : at === 0 ? list[0].rank - 1 : (list[at - 1].rank + list[at].rank) / 2
      let next: State = { ...state, issues: state.issues.map(i => i.id === issue.id ? { ...i, rank } : i) }
      if ((issue.sprintId ?? null) !== (sprintId ?? null)) next = reducer(next, { type: 'updateIssues', ids: [issue.id], patch: { sprintId } }, now)
      return next
    }
    case 'addAttachment':
      return {
        ...state,
        issues:   state.issues.map(i => i.id === action.issueId ? { ...i, attachments: [...i.attachments, action.attachment], updatedAt: now } : i),
        activity: [...state.activity, log(action.issueId, `attached ${action.attachment.name}`)],
      }
    case 'removeAttachment':
      return { ...state, issues: state.issues.map(i => i.id === action.issueId ? { ...i, attachments: i.attachments.filter(a => a.id !== action.attachmentId) } : i) }
    case 'updateIssues': {
      let next = state
      for (const id of action.ids) {
        const before = next.issues.find(i => i.id === id)
        next = updateOne(next, id, action.patch, log, notify, userName, now)
        const after = next.issues.find(i => i.id === id)
        if (!before || !after || before === after) continue
        const events: RuleTrigger[] = []
        if (after.status !== before.status) events.push({ kind: 'status', to: after.status })
        if (after.assigneeId && after.assigneeId !== before.assigneeId) events.push({ kind: 'assigned' })
        if (events.length) next = runRules(next, id, events, now)
      }
      return next
    }
    case 'cloneIssue': {
      const src = state.issues.find(i => i.id === action.sourceId)
      if (!src) return state
      const fields = (i: Issue): NewIssue => ({
        projectId: i.projectId, title: i.title, type: i.type, description: i.description, priority: i.priority, labels: i.labels,
        estimate: i.estimate, timeEstimate: i.timeEstimate, dueDate: i.dueDate, startDate: i.startDate, releaseId: i.releaseId,
        custom: i.custom, assigneeId: i.assigneeId, sprintId: action.include.sprint ? i.sprintId : undefined,
      })
      let next = reducer(state, { type: 'createIssue', id: action.id, issue: { ...fields(src), title: action.title, assigneeId: action.assigneeId, parentId: src.parentId } })
      if (next === state) return state
      next = reducer(next, { type: 'addLink', issueId: action.id, link: { type: 'clones', issueId: src.id } })
      if (action.include.children)
        for (const c of state.issues.filter(i => i.parentId === src.id)) next = reducer(next, { type: 'createIssue', id: uid(), issue: { ...fields(c), parentId: action.id } })
      if (action.include.links) {
        for (const l of src.links) if (l.type !== 'clones') next = reducer(next, { type: 'addLink', issueId: action.id, link: l })
        for (const o of state.issues) for (const l of o.links) if (l.issueId === src.id && l.type !== 'clones' && o.id !== action.id) next = reducer(next, { type: 'addLink', issueId: o.id, link: { type: l.type, issueId: action.id } })
      }
      return next
    }
    case 'setLinkTypes':
      return { ...state, linkTypes: action.linkTypes }
    case 'runTransition': {
      const issue = state.issues.find(i => i.id === action.issueId)
      const t = state.projects.find(p => p.id === issue?.projectId)?.transitions.find(x => x.id === action.transitionId)
      const tctx = issue && moveContext(state, issue)
      if (!issue || !t || !tctx || !startsAt(t, issue.status) || !forType(t, tctx) || !allows(t.rules?.restrict, tctx)) return state
      const next = updateOne(state, issue.id, t.to ? { ...action.patch, status: t.to } : action.patch, log, notify, userName, now, { transition: t, comment: action.comment })
      return next !== state && t.to && t.to !== issue.status ? runRules(next, issue.id, [{ kind: 'status', to: t.to }], now) : next
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
        activity: [...state.activity, log(action.issueId, `linked ${other?.key ?? 'an item'} (${linkWords(state, action.link.type, true)})`)],
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
      const comment: Comment = { id: uid(), issueId: issue.id, authorId: actor, body, createdAt: now, ...(action.visibility ? { visibility: action.visibility } : {}) }
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

    case 'logWork': {
      if (!actor || action.minutes <= 0) return state
      const w: Worklog = { id: uid(), userId: actor, minutes: Math.round(action.minutes), date: action.date, note: action.note.trim(), at: now }
      const h = Math.floor(w.minutes / 60), m = w.minutes % 60
      return {
        ...state,
        issues:   state.issues.map(i => i.id === action.issueId ? withRemaining({ ...i, worklogs: [...i.worklogs, w], updatedAt: now }, adjustRemaining(i.timeRemaining, w.minutes, action.adjust)) : i),
        activity: [...state.activity, log(action.issueId, `logged ${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''}`)],
      }
    }
    // Your own work logs; a project admin's, anyone's. The remaining estimate follows the change in time.
    case 'updateWorklog': case 'deleteWorklog': {
      const issue = state.issues.find(i => i.id === action.issueId)
      const w = issue?.worklogs.find(x => x.id === action.worklogId)
      const project = state.projects.find(p => p.id === issue?.projectId)
      if (!issue || !w || (w.userId !== actor && project?.role !== undefined && project.role !== 'admin')) return state
      const minutes = action.type === 'updateWorklog' ? Math.round(action.minutes) : 0
      if (action.type === 'updateWorklog' && minutes <= 0) return state
      const worklogs = action.type === 'deleteWorklog' ? issue.worklogs.filter(x => x.id !== w.id)
        : issue.worklogs.map(x => (x.id === w.id ? { ...x, minutes, date: action.date, note: action.note.trim() } : x))
      return { ...state, issues: state.issues.map(i => (i.id === issue.id ? withRemaining({ ...i, worklogs, updatedAt: now }, adjustRemaining(i.timeRemaining, minutes - w.minutes)) : i)) }
    }
    case 'releaseVersion': {
      const project = state.projects.find(p => p.id === action.projectId)
      if (!project) return state
      const open = state.issues.filter(i => i.releaseId === action.releaseId && !isDone(project, i)).map(i => i.id)
      let next: State = {
        ...state,
        projects: state.projects.map(p => p.id !== project.id ? p : {
          ...p, releases: p.releases.map(r => r.id === action.releaseId ? { ...r, released: true, releasedAt: now } : r),
        }),
      }
      if (open.length) next = reducer(next, { type: 'updateIssues', ids: open, patch: { releaseId: action.moveTo } }, now)
      return next
    }
    case 'saveView':
      return { ...state, views: state.views.some(v => v.id === action.view.id) ? state.views.map(v => v.id === action.view.id ? action.view : v) : [...state.views, action.view] }
    case 'deleteView':
      return {
        ...state,
        views: state.views.filter(v => v.id !== action.id),
      }

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
    case 'setNotifications':
      return { ...state, notifications: action.notifications }
    case 'loadProject':
      return {
        ...state,
        projects: state.projects.some(p => p.id === action.project.id)
          ? state.projects.map(p => (p.id === action.project.id ? action.project : p)) : [...state.projects, action.project],
        sprints: [...state.sprints.filter(s => s.projectId !== action.project.id), ...action.sprints],
      }
    case 'syncSprint':
      return state.sprints.some(s => s.id === action.sprint.id)
        ? { ...state, sprints: state.sprints.map(s => (s.id === action.sprint.id ? action.sprint : s)) } : state
    case 'loadIssueDetail':
      return {
        ...state,
        comments: [...state.comments.filter(c => c.issueId !== action.issueId), ...action.comments],
        activity: [...state.activity.filter(a => a.issueId !== action.issueId), ...action.activity],
        issues: state.issues.map(i => i.id === action.issueId
          ? { ...i, links: action.links, watcherIds: action.watcherIds, worklogs: action.worklogs, ...(action.attachments ? { attachments: action.attachments } : {}) } : i),
      }
    case 'syncIssue': {
      const ex = state.issues.find(i => i.id === action.issue.id)
      if (!ex) return state
      const next: Issue = { ...action.issue, watcherIds: ex.watcherIds, links: ex.links, attachments: ex.attachments, worklogs: ex.worklogs }
      if (JSON.stringify(next) === JSON.stringify(ex)) return state
      return { ...state, issues: state.issues.map(i => (i.id === ex.id ? next : i)) }
    }
    case 'upsertProject':
      return { ...state, projects: state.projects.some(p => p.id === action.project.id)
        ? state.projects.map(p => (p.id === action.project.id ? action.project : p))
        : [...state.projects, action.project] }
    case 'loadIssues': {
      // list rows carry no links, watchers, work logs or attachments: keep the ones an item's detail already loaded
      const had = new Map(state.issues.filter(i => i.projectId === action.projectId).map(i => [i.id, i]))
      const issues = action.issues.map(i => {
        const ex = had.get(i.id)
        return ex ? { ...i, watcherIds: ex.watcherIds, links: ex.links, attachments: ex.attachments, worklogs: ex.worklogs } : i
      })
      return { ...state, issues: [...state.issues.filter(i => i.projectId !== action.projectId), ...issues] }
    }
    case 'setEditors': {
      const editors = action.editors
      const editors0 = state.editors[action.issueId] ?? []
      if (JSON.stringify(editors) === JSON.stringify(editors0)) return state
      return { ...state, editors: { ...state.editors, [action.issueId]: editors } }
    }
    case 'replace':
      return action.state
    case 'reset':
      return EMPTY
  }
}

/**
 * Apply the project's enabled automation rules for the events that just happened to one issue.
 * Actions are applied directly (one pass), so a rule can never trigger itself or loop.
 */
export function runRules(state: State, issueId: string, events: RuleTrigger[], now: number): State {
  const issue = state.issues.find(i => i.id === issueId)
  const project = state.projects.find(p => p.id === issue?.projectId)
  if (!issue || !project?.rules?.length) return state
  const matches = project.rules.filter(r => r.enabled && events.some(e =>
    e.kind === r.trigger.kind && (e.kind !== 'status' || (r.trigger.kind === 'status' && r.trigger.to === e.to))))
  if (!matches.length) return state

  let current = issue
  const activity: Activity[] = []
  const comments: Comment[] = []
  const say = (text: string, field?: string, from?: string, to?: string) =>
    activity.push({ id: uid(), issueId, actorId: AUTOMATION, field, from, to, text, createdAt: now })

  for (const rule of matches) {
    for (const a of rule.actions) {
      if (a.kind === 'assign') {
        const to = a.to === 'reporter' ? current.reporterId : a.to === 'lead' ? project.leadId : a.to === 'unassign' ? undefined : a.to
        if (to !== undefined && !state.users.some(u => u.id === to)) continue
        if (to === current.assigneeId) continue
        say(to ? `assigned to ${state.users.find(u => u.id === to)?.name} (rule “${rule.name}”)` : `removed the assignee (rule “${rule.name}”)`, 'assigneeId', current.assigneeId, to)
        current = { ...current, assigneeId: to, watcherIds: to ? [...new Set([...current.watcherIds, to])] : current.watcherIds }
      } else if (a.kind === 'priority' && a.value !== current.priority) {
        say(`set priority to ${a.value} (rule “${rule.name}”)`, 'priority', current.priority, a.value)
        current = { ...current, priority: a.value }
      } else if (a.kind === 'label' && a.value.trim() && !current.labels.includes(a.value.trim())) {
        say(`added label ${a.value.trim()} (rule “${rule.name}”)`)
        current = { ...current, labels: [...current.labels, a.value.trim()] }
      } else if (a.kind === 'status' && a.value !== current.status && project.statuses.some(st => st.id === a.value)
          && canTransition(project, current.status, a.value, { ...moveContext(state, current), mover: null })) {   // automation follows the workflow too
        say(`changed status to ${statusOf(project, a.value)?.name} (rule “${rule.name}”)`, 'status', current.status, a.value)
        current = { ...current, status: a.value }
      } else if (a.kind === 'comment' && a.body.trim()) {
        comments.push({ id: uid(), issueId, authorId: AUTOMATION, body: a.body.trim(), createdAt: now })
      }
    }
  }

  return {
    ...state,
    issues:   state.issues.map(i => i.id === issueId ? { ...current, updatedAt: now } : i),
    activity: [...state.activity, ...activity],
    comments: [...state.comments, ...comments],
    projects: state.projects.map(p => p.id === project.id
      ? { ...p, rules: p.rules.map(r => matches.includes(r) ? { ...r, runs: r.runs + 1 } : r) } : p),
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

/** An item with its remaining estimate set (left out when there is none). */
const withRemaining = (i: Issue, r: number | null): Issue => { const { timeRemaining: _r, ...rest } = i; return r === null ? rest : { ...rest, timeRemaining: r } }

function updateOne(
  state: State, id: string, patch: IssuePatch,
  log: (issueId: string, text: string, field?: string, from?: string, to?: string) => Activity,
  notify: (userIds: (string | undefined)[], issueId: string, kind: NotificationKind, text: string) => Notification[],
  userName: (id?: string) => string | undefined,
  now: number,
  o: { transition?: Transition; comment?: string } = {},
): State {
  const prev = state.issues.find(i => i.id === id)
  if (!prev) return state
  const project = state.projects.find(p => p.id === prev.projectId)
  if (!project) return state
  // The workflow decides which status moves are allowed, and the transition's rules who may make one and what it needs
  // (the server checks the same). Its actions run here only for a workspace kept in this browser: otherwise the server runs them.
  let t = o.transition
  let actionComments: string[] = []
  if ((patch.status && patch.status !== prev.status) || t) {
    const ctx = moveContext(state, prev)
    if (!t && project.transitions.length) { t = transitionFor(project, prev.status, patch.status!, ctx); if (!t) return state }
    const after = { ...prev, ...patch } as unknown as Item
    if (t && Object.keys(problems(t.rules, ctx, prev as unknown as Item, after, o.comment)).length) return state
    if (t && state.isAdmin === undefined) {
      const a = actionChanges(t.rules, ctx, after, new Date(now))
      patch = { ...patch, ...Object.fromEntries(Object.entries(a.patch).map(([k, v]) => [k, v ?? undefined])) } as IssuePatch
      actionComments = a.comments
    }
  }
  const loop = !!t && t.to === null
  // a first original estimate starts the remaining one (Jira's time tracking)
  if (patch.timeEstimate != null && patch.timeRemaining === undefined && prev.timeRemaining === undefined) patch = { ...patch, timeRemaining: patch.timeEstimate }

  const changed = (Object.keys(patch) as (keyof IssuePatch)[])
    .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(patch[k]))
  if (changed.length === 0 && !loop) return state

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

  if (loop) activity.push(log(id, `did “${t!.name}”`))
  const comments: Comment[] = [o.comment, ...actionComments].filter((b): b is string => !!b?.trim())
    .map(body => ({ id: uid(), issueId: id, authorId: actorId(state), body, createdAt: now }))
  return {
    ...state,
    issues:        state.issues.map(i => i.id === id ? withResolution(project, prev, { ...i, ...patch, watcherIds: watchers, updatedAt: now }, now) : i),
    activity:      [...state.activity, ...activity],
    notifications: [...state.notifications, ...notes],
    comments:      comments.length ? [...state.comments, ...comments] : state.comments,
  }
}

// ── Migration ──────────────────────────────────────────────

/** Bring any saved shape up to the current version. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrate(raw: any): State {
  if (!raw || typeof raw !== 'object') return EMPTY
  if (raw.version === 4) return { ...EMPTY, ...raw }
  if (raw.version === 3 || raw.version === 2) return toV4(toV3({ ...EMPTY, ...raw }))

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

  return toV4(toV3({
    ...EMPTY,
    ownerId:   me?.id ?? null,
    users:     raw.users ?? (me ? [me] : []),
    projects, issues, activity,
    sprints:   raw.sprints ?? [],
    comments:  raw.comments ?? [],
    starred:   raw.starred ?? [],
    viewed:    raw.viewed ?? [],
  }))
}

/** v4: custom fields, releases, templates, time tracking, saved views. */
function toV4(s: State): State {
  return {
    ...s,
    version:    4,
    views:      s.views ?? [],
    editors:    {},   // live edit presence is session-only, never persisted
    projects:   s.projects.map(p => ({ ...p, fields: p.fields ?? [], releases: p.releases ?? [], templates: p.templates ?? [] })),
    issues:     s.issues.map(i => ({ ...i, custom: i.custom ?? {}, worklogs: i.worklogs ?? [] })),
  }
}

/** v3: backlog rank (seeded from creation order), attachments and automation rules. */
function toV3(s: State): State {
  const order = [...s.issues].sort((a, b) => a.createdAt - b.createdAt).map(i => i.id)
  return {
    ...s,
    version:  3 as unknown as 4,
    projects: s.projects.map(p => ({ ...p, rules: p.rules ?? [] })),
    issues:   s.issues.map(i => ({ ...i, attachments: i.attachments ?? [], rank: i.rank ?? order.indexOf(i.id) + 1 })),
  }
}

// ── Selectors ──────────────────────────────────────────────

/** Lookups that would otherwise scan every item per row. Built once per change to the item list. */
export interface IssueIndex { byId: Map<string, Issue>; children: Map<string, Issue[]>; blockers: Map<string, Issue[]> }
const indexCache = new WeakMap<Issue[], IssueIndex>()
export function indexOf(state: Pick<State, 'issues' | 'projects'>): IssueIndex {
  const hit = indexCache.get(state.issues)
  if (hit) return hit
  const byId = new Map<string, Issue>()
  const children = new Map<string, Issue[]>()
  const blockers = new Map<string, Issue[]>()
  const projects = new Map(state.projects.map(p => [p.id, p]))
  for (const i of state.issues) {
    byId.set(i.id, i)
    if (i.parentId) children.set(i.parentId, [...(children.get(i.parentId) ?? []), i])
    const open = !isDone(projects.get(i.projectId), i)
    for (const l of i.links) if (l.type === 'blocks' && open) blockers.set(l.issueId, [...(blockers.get(l.issueId) ?? []), i])
  }
  const idx = { byId, children, blockers }
  indexCache.set(state.issues, idx)
  return idx
}

/** Items this one is blocked by (open items that link to it with "blocks"). */
export function blockersOf(state: Pick<State, 'issues' | 'projects'>, issue: Issue) {
  return indexOf(state).blockers.get(issue.id) ?? []
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
