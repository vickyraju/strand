// Response bodies, by route. Attached to each route as it registers (see app.ts), so they both appear in the
// OpenAPI document and are enforced when responses are serialized: a handler that returns the wrong shape fails a test
// instead of leaking an unexpected field. Timestamps are ISO strings (db.ts), dates are YYYY-MM-DD.
import { z } from 'zod'
import { directoryConfig } from './directories.ts'

const id = z.string().describe('uuid')
const ts = z.string().describe('ISO 8601 timestamp')
const day = z.string().describe('YYYY-MM-DD')
const nullable = <T extends z.ZodType>(t: T) => t.nullable()

export const User = z.object({ id, name: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), email: z.string(), role: z.string() })
export const Me = z.object({ id, email: z.string(), name: z.string(), workspaceId: id, role: z.enum(['owner', 'admin', 'member']), admin: z.boolean(), groupIds: z.array(id).describe('Groups I am in (transition rules can name groups)'),
  via: z.enum(['entra', 'password', 'recovery', 'pat']).describe('How this request signed in'),
  recovery: z.boolean().describe('System admins: Strand is running in recovery mode (spec 0711)'),
  hasPassword: z.boolean().describe('Keeps a password in Strand (spec 0714)'), directory: nullable(z.string()).describe('The user directory they come from; null for the internal directory') })

const EntraConfig = z.object({ enabled: z.boolean(), name: z.string(), tenantId: z.string(), apiClientId: z.string(), webClientId: z.string(), authority: z.string() })
const PanelStat = z.object({ issues: z.number(), completed: z.number(), unestimated: z.number(), estimate: z.number(), todo: z.number(), inProgress: z.number(), done: z.number() })
const ProjectCategory = z.object({ id, name: z.string(), description: z.string(), projects: z.number().describe('Projects in it') })
const LookAndFeel = z.object({ siteTitle: z.string(), showTitle: z.boolean(), brandColor: z.string(),
  logo: nullable(z.string()).describe('The logo’s address under the API, or null for Strand’s'), favicon: nullable(z.string()) })
const Webhook = z.object({ id, name: z.string(), description: z.string(), url: z.string(), events: z.array(z.string()).describe('Jira’s event names; empty: every event'),
  jql: nullable(z.string()), excludeBody: z.boolean(), enabled: z.boolean(), createdAt: ts, updatedAt: ts,
  lastCall: nullable(z.object({ event: z.string(), state: z.string(), statusCode: nullable(z.number()), at: ts })) })
export const UserDirectory = z.object({
  id, name: z.string(), type: z.enum(['ad', 'ldap']), position: z.number(), enabled: z.boolean(), config: directoryConfig,
  hasPassword: z.boolean().describe('The service account’s password is stored (it is never returned)'),
  lastSync: z.unknown().describe('When the last synchronisation ran, whether it worked, and what it changed'),
  syncing: z.unknown().describe('The synchronisation running now, with its progress, or null'),
  users: z.number().describe('Active people from this directory'), createdAt: ts, updatedAt: ts,
})
export const AuthMethods = z.object({ loginForm: z.boolean(), fallback: z.boolean(), entra: nullable(EntraConfig), recovery: z.boolean().describe('Recovery mode is on (STRAND_RECOVERY_PASSWORD)') })

export const AccessToken = z.object({ id, name: z.string(), hint: z.string().describe('Last 4 characters of the token'), createdAt: ts, expiresAt: ts, lastUsedAt: nullable(ts), expired: z.boolean() })
export const AccessTokenCreated = AccessToken.extend({ token: z.string().describe('The secret. Shown only in this response') })

export const Member = z.object({ userId: id, name: z.string(), email: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), role: z.enum(['admin', 'member', 'viewer']), addedAt: ts })

export const Status = z.object({ id, projectId: id, globalStatusId: nullable(id).describe('The global status it is (Administration › Workflows)'), name: z.string(), description: z.string(), color: z.string(), category: z.enum(['todo', 'in-progress', 'done']), wipLimit: nullable(z.number()), position: z.number() })
export const Transition = z.object({
  id, projectId: id, name: z.string(), fromIds: nullable(z.array(id)).describe('null: from any status'), toId: nullable(id).describe('null: a loop, the item stays in its status'),
  rules: z.record(z.string(), z.unknown()).describe('restrict, validate, screen, actions'),
  typeKeys: nullable(z.array(z.string())).describe('Work types this transition is for (null: every type)'),
  source: nullable(z.string()).describe('The workflow and transition it comes from (workflow id:transition id)'),
})
export const WorkType = z.object({
  id, projectId: id, key: z.string().describe('What an item\'s `type` holds'), name: z.string(), color: z.string(),
  icon: z.string(), position: z.number(),
})
export const LinkType = z.object({
  id: z.string(), name: z.string(), outward: z.string().describe('How a link reads from its source: "blocks"'), inward: z.string().describe('How it reads from its target: "is blocked by"'),
  builtin: z.boolean().describe('Built in (the app relies on it): can be renamed, not removed'), position: z.number(), uses: nullable(z.number()).describe('Links of this type (with uses=1, for system administrators; null otherwise)'),
})
export const Component = z.object({ id, projectId: id, name: z.string(), description: z.string(), leadId: nullable(id), defaultAssignee: z.enum(['none', 'component_lead', 'project_lead']) })
export const NotificationPrefs = z.object({
  prefs: z.array(z.object({ kind: z.enum(['assigned', 'mentioned', 'commented', 'status', 'due', 'automation']), inbox: z.boolean(), email: z.boolean() })),
  emailEnabled: z.boolean().describe('The workspace sends email (System settings)'),
})
export const SecurityLevel = z.object({
  id, projectId: id, name: z.string(), description: z.string(), items: z.number(),
  members: z.array(z.object({ kind: z.enum(['role', 'group', 'user', 'reporter', 'assignee']), role: z.string().optional(), id: id.optional() })),
})
export const AvailableTransition = z.object({
  id, name: z.string(), toId: nullable(id), screen: z.array(z.string()).describe('Fields to fill in (and "comment")'),
  problems: z.record(z.string(), z.string()).describe('What would stop the move if made now, by field'),
})
export const Field = z.object({ id, projectId: id, name: z.string(), kind: z.enum(['text', 'number', 'select', 'date']), options: nullable(z.array(z.object({ id: z.string(), name: z.string(), disabled: z.boolean() }))), position: z.number() })
export const Template = z.object({ id, projectId: id, name: z.string(), type: z.string(), title: z.string(), description: z.string(), priority: z.string(), labels: z.array(z.string()), estimate: nullable(z.number()) })
export const Rule = z.object({ id, projectId: id, name: z.string(), enabled: z.boolean(), trigger: z.record(z.string(), z.unknown()), actions: z.array(z.record(z.string(), z.unknown())), runs: z.number(), failures: z.number(), ownerId: nullable(id) })
const Step = z.object({ action: z.string(), outcome: z.enum(['done', 'skipped', 'unchanged', 'failed']), note: z.string().optional() })
export const Release = z.object({ id, workspaceId: id, projectId: id, name: z.string(), description: z.string(), startDate: nullable(day), releaseDate: nullable(day), released: z.boolean(), releasedAt: nullable(ts), archived: z.boolean().describe('Hidden from pickers; items keep it') })
export const Sprint = z.object({
  id, workspaceId: id, projectId: id, boardId: id.describe('The board it belongs to'), name: z.string(), goal: z.string(), state: z.enum(['planned', 'active', 'closed']),
  startedAt: nullable(ts), endsAt: nullable(ts), completedAt: nullable(ts), committed: nullable(z.number()), completed: nullable(z.number()),
  issueIds: nullable(z.array(id)), createdAt: ts,
  estimation: nullable(z.enum(['points', 'time', 'count'])).describe('What its totals count, from its board when it started (spec 0404)'),
})

export const ProjectListItem = z.object({
  id, key: z.string(), name: z.string(), description: z.string(), color: z.string(), template: z.enum(['kanban', 'scrum']),
  leadId: nullable(id), createdAt: ts, archivedAt: nullable(ts), starred: z.boolean(), openCount: z.number(),
  categoryId: nullable(id), category: nullable(z.object({ id, name: z.string() })).describe('Its project category (spec 0703)'), avatar: nullable(z.string()).describe('Its avatar’s address under the API'),
})
export const ProjectPage = z.object({ items: z.array(ProjectListItem), next: nullable(z.string()).describe('Pass back as `cursor`; null on the last page') })
export const UserPage = z.object({ items: z.array(User), next: nullable(z.string()) })
export const TypeWorkflow = z.object({ typeKey: z.string(), workflowId: id, workflow: z.string(), statusIds: z.array(id).describe('Statuses an item of this type can be in; new ones start in the first'),
  resolutionOnDone: z.boolean().describe('Reaching Done sets the default resolution (spec 0305)') })
const WfStatus = z.object({ id, name: z.string(), description: z.string(), color: z.string(), category: z.enum(['todo', 'in-progress', 'done']) })
const LibTransition = z.object({ id: z.string(), name: z.string(), fromIds: nullable(z.array(id)), toId: nullable(id), rules: z.record(z.string(), z.unknown()) })
export const Workflow = z.object({
  id, name: z.string(), description: z.string(), version: z.number(), updatedAt: ts, statuses: z.array(WfStatus).describe('In order: new work starts in the first'),
  transitions: z.array(LibTransition), layout: z.record(z.string(), z.unknown()),
  resolutionOnDone: z.boolean().describe('Reaching Done sets the default resolution (else only transition rules set it)'),
  schemes: z.array(z.object({ id, name: z.string() })), projectCount: z.number().describe('Projects using it, through their scheme'),
})
export const WorkflowScheme = z.object({
  id, name: z.string(), description: z.string(), defaultWorkflowId: id, defaultWorkflow: z.string(),
  mappings: z.record(z.string(), id).describe('Work type key → workflow id'), projects: z.number(),
})
export const Impact = z.object({
  project: z.object({ id, key: z.string(), name: z.string() }), added: z.array(z.string()).describe('Statuses the project gains'), removed: z.array(z.string()).describe('Statuses it loses'),
  moves: z.array(z.object({ type: z.string(), from: z.string(), to: z.string(), count: z.number() })).describe('Items that change status, by work type'),
})
export const ApplySummary = z.object({
  projects: z.number().describe('Projects it reaches'), changed: z.number().describe('Projects that gain or lose a status, or have items that move'),
  itemsMoved: z.number(), added: z.array(z.string()), removed: z.array(z.string()),
  blocked: z.array(z.object({ status: z.string(), items: z.number(), projects: z.array(z.string()), more: z.number() })).optional().describe('Statuses that can’t leave the workflow: work items are in them (move them first)'),
  moves: z.array(z.object({ from: z.string(), to: z.string(), count: z.number() })).describe('Where items go, over every project, biggest first (at most 10)'),
  top: z.array(Impact).describe('The projects most changed (at most 10)'),
})
const ProjectsPage = z.object({ items: z.array(z.object({ id, key: z.string(), name: z.string(), scheme: z.string() })), next: nullable(z.string()), total: z.number() })
const BoardColumn = z.object({ id: z.string(), name: z.string(), statusIds: z.array(id).describe('Global statuses shown in this column'), min: z.number().optional(), max: z.number().optional() })
const NamedQuery = z.object({ id: z.string(), name: z.string(), jql: z.string() })
export const Board = z.object({
  id, projectId: id, projectKey: z.string(), name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string().describe('The board filter'),
  columns: z.array(BoardColumn), swimlanes: z.object({ by: z.enum(['none', 'assignee', 'epic', 'priority', 'project', 'queries']), queries: z.array(NamedQuery).optional() }),
  quickFilters: z.array(NamedQuery), cardFields: z.record(z.string(), z.boolean()), doneDays: nullable(z.number()), estimation: z.enum(['points', 'time', 'count']).describe('Scrum: what estimates count (spec 0404)'),
  workingDays: z.object({ weekdays: z.array(z.number()), nonWorking: z.array(z.string()) }).describe('Working weekdays (0 is Sunday) and non-working dates (spec 0405)'),
  cardColors: z.object({ by: z.enum(['none', 'types', 'priorities', 'assignees', 'queries']) }).passthrough().describe('Card colours (spec 0409)'), position: z.number(),
  kanbanBacklog: z.array(id).describe('Kanban: the statuses in the Kanban backlog; empty when it is off (spec 0406)'),
  canManage: z.boolean().describe('I may change it'), canManageSprints: z.boolean().describe('I may create, start, complete and delete its sprints'), admins: z.array(z.object({ kind: z.enum(['user', 'group']), id, name: z.string() })),
})
export const ProjectDetail = z.object({
  id, workspaceId: id, key: z.string(), name: z.string(), description: z.string(), color: z.string(), template: z.enum(['kanban', 'scrum']),
  leadId: nullable(id), archivedAt: nullable(ts), nextNumber: z.number(), testing: z.boolean().describe('Test management is on'), requirementTypes: nullable(z.array(z.string())).describe('Work types counted as requirements (null: all but testing types and Bug)'), boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
  sample: z.boolean(), createdAt: ts, role: z.enum(['admin', 'member', 'viewer']).describe('My role in this project'),
  keys: z.array(z.string()).describe('Its key, then its earlier keys, which still find it (spec 0703)'), categoryId: nullable(id), category: nullable(z.object({ id, name: z.string() })),
  avatar: nullable(z.string()).describe('Its avatar’s address under the API, or null (spec 0703)'),
  statuses: z.array(Status), transitions: z.array(Transition), types: z.array(WorkType), components: z.array(Component), securityLevels: z.array(SecurityLevel.omit({ items: true })), fields: z.array(Field), templates: z.array(Template),
  rules: z.array(Rule), releases: z.array(Release), sprints: z.array(Sprint),
  workflowSchemeId: id.describe('Its workflow scheme'), workflows: z.array(TypeWorkflow),
  boards: z.array(z.object({ id, name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string(), position: z.number(), hasBacklog: z.boolean() })).describe('Its boards, in order'),
})

const issueFields = {
  id, key: z.string().describe('e.g. PAY-12'), projectId: id, number: z.number(), type: z.string().describe('Work type key'),
  title: z.string(), description: z.string(), statusId: id, priority: z.string().describe('A priority key (GET /priorities)'), flagged: z.boolean().describe('Flagged as an impediment (spec 0408)'), epicColor: nullable(z.string()).describe('Epics: Jira’s Epic Colour, ghx-label-1 … 14 (spec 0407)'),
  assigneeId: nullable(id), reporterId: nullable(id), labels: z.array(z.string()), estimate: nullable(z.number()), timeEstimate: nullable(z.number()), timeRemaining: nullable(z.number()), componentIds: z.array(id), affectsReleaseIds: z.array(id), securityLevelId: nullable(id),
  testSpec: nullable(z.unknown()).describe('Test steps, Gherkin or definition (Tests and Pre-Conditions)'), testFolderId: nullable(id).describe('Test repository folder'),
  testEnvironments: z.array(z.string()).describe('Test Executions: what it ran against'), revision: z.string().describe('Test Executions: build or revision'),
  dueDate: nullable(day), startDate: nullable(day), sprintId: nullable(id), fixReleaseIds: z.array(id), parentId: nullable(id),
  custom: z.record(z.string(), z.union([z.string(), z.number()])), rank: z.number(), version: z.number().describe('Send as If-Match to reject stale edits'),
  resolution: nullable(z.string()).describe('A resolution name (GET /resolutions), set while the item is in a Done status'),
  resolvedAt: nullable(ts).describe('When the item last reached a Done status'),
  createdAt: ts, updatedAt: ts,
}
export const IssueRow = z.object(issueFields)
export const TestMember = IssueRow.extend({ folder: z.string().describe('Folder within a Test Plan ("" at the top)'), itemPosition: z.number() })
export const TestStatus = z.object({ kind: z.enum(['run', 'step']), key: z.string(), name: z.string(), description: z.string(), color: z.string(),
  final: z.boolean(), mapsTo: z.string(), rank: z.number(), builtin: z.boolean() })
export const TestRun = z.object({
  id, executionId: id, executionKey: z.string(), executionTitle: z.string(), environments: z.array(z.string()),
  testId: id, testKey: z.string(), testTitle: z.string(), status: z.string(), assigneeId: nullable(id), executedBy: nullable(id),
  startedAt: nullable(ts), finishedAt: nullable(ts), spec: nullable(z.unknown()).describe('The test as it was when the run was made'),
  steps: z.array(z.object({ id: z.string(), status: z.string(), actual: z.string(), comment: z.string(), defectIds: z.array(id), evidenceIds: z.array(id) })),
  comment: z.string(), defectIds: z.array(id), evidenceIds: z.array(id), version: z.number(), createdAt: ts, updatedAt: ts,
  specChanged: z.boolean().describe('The test has changed since this run was made (reset to use the new one)'),
})
const GroupMember = z.object({ id, name: z.string(), email: z.string(), initials: z.string(), color: z.string(), active: z.boolean() })
export const GroupSummary = z.object({
  id, name: z.string(), description: z.string(), kind: z.enum(['system', 'directory', 'strand']).describe('system (users-access, system-administrators), directory (from Entra) or strand (made here)'),
  systemRole: nullable(z.string()), members: z.number(), owners: z.array(z.object({ id, name: z.string() })), isMember: z.boolean(), isOwner: z.boolean(),
  canManage: z.boolean().describe('You may change it'), createdAt: ts,
})
export const TestFolder = z.object({ id, parentId: nullable(id), name: z.string(), position: z.number(), tests: z.number() })
const GroupGrant = z.object({
  groupId: id, name: z.string(), role: z.enum(['admin', 'member', 'viewer']), addedAt: ts, members: z.number().describe('Active people in the group'),
  kind: z.enum(['system', 'directory', 'strand']), owners: z.array(z.string()).describe('Who manages the group (groups made in Strand)') })
const SettingView = z.object({
  key: z.string(), label: z.string(), description: z.string(),
  value: z.record(z.string(), z.unknown()).describe('Current value'), default: z.record(z.string(), z.unknown()).describe('Value when nothing is saved'),
})
const BackupSettings = z.object({
  enabled: z.boolean().describe('Deleting a project backs it up first'), bucket: nullable(z.string()), prefix: z.string(),
  effectiveBucket: nullable(z.string()).describe('Where backups actually go (empty: nowhere configured, so deleting a project is refused)'),
  allowedBuckets: z.array(z.string()).describe('Buckets the operators allow a workspace to choose (BACKUP_BUCKETS)'),
})
export const Comment = z.object({ id, issueId: id, authorId: nullable(id), body: z.string(), createdAt: ts, editedAt: nullable(ts),
  visibility: nullable(z.object({ kind: z.enum(['role', 'group']), role: z.string().optional(), id: id.optional() })).describe('Who can read it; null: everyone who sees the item') })
export const Worklog = z.object({ id, issueId: id, userId: nullable(id), minutes: z.number(), date: day, note: z.string(), createdAt: ts })
export const Activity = z.object({ id, issueId: id, actorId: nullable(id), field: nullable(z.string()), fromValue: nullable(z.string()), toValue: nullable(z.string()), text: z.string(), createdAt: ts })
export const IssueDetail = z.object({
  ...issueFields,
  // present unless left out with ?expand=
  links: z.array(z.object({ type: z.string().describe('Link type id (GET /link-types)'), dir: z.enum(['in', 'out']), issueId: id, key: z.string(), title: z.string() })).optional(),
  watcherIds: z.array(id).optional(), comments: z.array(Comment).optional(), activity: z.array(Activity).optional(), worklogs: z.array(Worklog).optional(),
  attachments: z.array(z.object({ id, name: z.string(), size: z.number(), type: z.string(), addedBy: nullable(id), addedAt: ts })).optional(),
  children: z.array(IssueRow).optional(),
})
export const CommentPage = z.object({ items: z.array(Comment), next: nullable(z.string()) })
export const ActivityPage = z.object({ items: z.array(Activity), next: nullable(z.string()) })
export const BulkEditResult = z.object({ count: z.number(), issues: z.array(IssueRow) })
export const BulkCount = z.object({ count: z.number() })
export const ReportData = z.object({
  issues: z.array(IssueRow),
  statusChanges: z.array(z.object({ issueId: id, fromId: nullable(id), toId: id, at: ts })).describe('Every status change, oldest first'),
  joins: z.array(z.object({ issueId: id, field: z.enum(['parentId', 'fixReleaseIds']), value: z.string().describe('The epic, or the fix versions comma-separated'), at: ts })).describe('When items were put into an epic or versions, oldest first (spec 0411)'),
})
export const IssuePage = z.object({ items: z.array(IssueRow), next: nullable(z.string()).describe('Pass back as `cursor` for the next page; null on the last page') })

const searchRow = z.object({
  id, key: z.string(), projectId: id, projectKey: z.string(), type: z.string(), title: z.string(), statusId: id, category: z.enum(['todo', 'in-progress', 'done']),
  priority: z.string(), assigneeId: nullable(id), labels: z.array(z.string()), dueDate: nullable(day), estimate: nullable(z.number()), updatedAt: ts, version: z.number(),
})
export const SearchPage = z.object({ items: z.array(searchRow), next: nullable(z.string()) })
export const WorkList = z.array(searchRow)
export const Summary = z.object({
  byStatus: z.array(z.object({ statusId: id, name: z.string(), category: z.string(), count: z.number() })),
  byAssignee: z.array(z.object({ assigneeId: nullable(id), open: z.number(), points: z.number() })),
  byType: z.array(z.object({ type: z.string(), count: z.number() })),
  createdLast7Days: z.number(), overdue: z.number(),
})

export const Notification = z.object({ id, userId: id, actorId: nullable(id), issueId: id, kind: z.string(), text: z.string(), read: z.boolean(), archived: z.boolean(), createdAt: ts })
export const NotificationItem = Notification.extend({ issueKey: z.string(), issueTitle: z.string(), projectKey: z.string() })
export const SavedView = z.object({
  id, workspaceId: id, ownerId: id, ownerName: z.string(), ownerActive: z.boolean().describe('False: its owner left; an admin can give it to someone'),
  name: z.string(), shared: z.boolean().describe('Everyone in the workspace can see it'),
  share: z.array(z.object({ kind: z.enum(['project', 'group', 'user']), id, can: z.enum(['view', 'edit']) })),
  canEdit: z.boolean().describe('I can change its name and filters'), filters: z.record(z.string(), z.unknown()),
})

export const AttachmentTicket = z.object({ id, name: z.string(), size: z.number(), type: z.string(), addedAt: ts, uploadUrl: z.string().describe('PUT the file bytes here within 5 minutes') })
export const ImportReport = z.object({ projects: z.number(), issues: z.number(), skippedProjects: z.array(z.string()), skippedAttachments: z.number() })

const DevEntity = z.object({
  id, externalId: z.string(), url: nullable(z.string()), title: z.string(), state: nullable(z.string()),
  author: nullable(z.object({ login: z.string().optional(), name: z.string().optional(), avatarUrl: z.string().optional() })),
  branchFrom: nullable(z.string()), branchTo: nullable(z.string()), reviewState: nullable(z.string()), checksState: nullable(z.string()),
  payload: z.record(z.string(), z.unknown()), updatedAt: ts, closing: z.boolean().describe('Linked with a closing word (fixes / closes / resolves)'), repo: z.string(),
})
export const Development = z.object({ pullRequests: z.array(DevEntity), branches: z.array(DevEntity), commits: z.array(DevEntity) })

// ── Routes. Keys are "METHOD /path" without the /api[/v1] prefix. All answer 200 unless noted. ──
const kindRow = { fields: Field, templates: Template, rules: Rule, releases: Release, components: Component } as const

/** Routes that create something answer 201 Created (Jira and REST convention), not 200. */
export const CREATED = new Set([
  'POST /projects', 'POST /projects/:key/issues', 'POST /issues/:key/comments', 'POST /issues/:key/worklogs', 'POST /projects/:key/sprints',
  'POST /views', 'POST /issues/:key/attachments', 'POST /me/tokens',
  'POST /admin/statuses', 'POST /admin/workflows', 'POST /admin/workflow-schemes', 'POST /projects/:key/boards',
  ...['fields', 'templates', 'rules', 'releases', 'components'].map(k => `POST /projects/:key/${k}`),
])

export const RESPONSES: Record<string, z.ZodType> = {
  'GET /me': Me,
  'GET /auth/config': z.object({ announcement: nullable(z.string()).describe('A Public announcement banner (spec 0701)'), loginForm: z.boolean(), fallback: z.boolean(), dev: z.boolean().describe('Strand’s developer login is on (AUTH_DEV)'),
    entra: nullable(z.object({ name: z.string(), tenantId: z.string(), clientId: z.string(), authority: z.string(), scope: z.string() })).describe('Null when Microsoft sign-in is off') }),
  'POST /auth/login': z.object({ token: z.string().describe('Send as Authorization: Bearer'), expiresAt: ts }),
  'GET /admin/authentication': AuthMethods,
  'PUT /admin/authentication': AuthMethods,
  'PUT /admin/authentication/entra': AuthMethods,
  'GET /admin/directories': z.array(UserDirectory),
  'GET /admin/webhooks': z.array(Webhook), 'GET /admin/webhooks/:id': Webhook, 'PUT /admin/webhooks/:id': Webhook,
  'POST /admin/webhooks': Webhook.extend({ secret: z.string().describe('The signing secret, shown this once') }),
  'POST /admin/webhooks/:id/secret': z.object({ secret: z.string() }),
  'POST /admin/webhooks/:id/test': z.object({ callId: id }), 'POST /admin/webhooks/:id/calls/:callId/redeliver': z.object({ callId: id }),
  'GET /admin/webhooks/:id/calls': z.array(z.object({ id, event: z.string(), deliveryId: id, url: z.string(), state: z.enum(['queued', 'retrying', 'delivered', 'failed']),
    attempts: z.number(), statusCode: nullable(z.number()), error: nullable(z.string()), createdAt: ts, finishedAt: nullable(ts) })),
  'GET /admin/users/:id/anonymise': z.object({
    alias: z.string().describe('The name they will show as'),
    transfer: z.object({ projectsLed: z.array(z.object({ key: z.string(), name: z.string() })), componentsLed: z.number(), sharedViews: z.number(), groupsAloneOwned: z.array(z.object({ name: z.string() })) }),
    change: z.object({ comments: z.number(), reported: z.number(), assigned: z.number(), mentions: z.number() }),
    remove: z.object({ privateViews: z.number() }),
    actionsRequired: z.array(z.object({ id, name: z.string() })).describe('Saved views whose query names them: JQL isn’t rewritten'),
  }),
  'POST /admin/users/:id/anonymise': z.object({ jobId: id }),
  'GET /project-categories': z.array(ProjectCategory), 'POST /admin/project-categories': ProjectCategory, 'PATCH /admin/project-categories/:id': ProjectCategory,
  'PUT /projects/:key/avatar': z.object({ avatar: z.string().describe('The avatar’s address under the API') }),
  'GET /look-and-feel': LookAndFeel, 'PUT /admin/look-and-feel': LookAndFeel, 'DELETE /admin/look-and-feel': LookAndFeel,
  'PUT /admin/look-and-feel/logo': LookAndFeel, 'DELETE /admin/look-and-feel/logo': LookAndFeel,
  'PUT /admin/look-and-feel/favicon': LookAndFeel, 'DELETE /admin/look-and-feel/favicon': LookAndFeel,
  'GET /boards/:id/reports/control': z.object({
    items: z.array(z.object({ id, key: z.string(), title: z.string(), type: z.string(), leftAt: ts.describe('When it last left the chosen columns'), minutes: z.number().describe('Cycle time: minutes spent in the chosen columns, every visit') })),
    truncated: z.boolean().describe('More than 5000 items: the most recent are returned'),
  }),
  'GET /boards/:id/panels': z.object({
    epics: z.array(z.unknown()).describe('The board’s epics that aren’t Done, in rank order (work item rows)'),
    epicStats: z.record(z.string(), PanelStat).describe('Per epic id, and "none" for items without an epic'),
    versionStats: z.record(z.string(), PanelStat).describe('Per version id, and "none" for items without a fix version'),
  }),
  'GET /admin/directories/internal': z.object({ name: z.string(), users: z.number() }),
  'POST /admin/users': z.object({ id, emailed: z.boolean().describe('The notification email was sent') }),
  'PATCH /admin/users/:id': z.object({ ok: z.boolean() }),
  'POST /auth/forgot': z.object({ message: z.string() }),
  'GET /admin/directories/presets': z.object({ ad: z.unknown(), ldap: z.unknown() }).describe('Jira’s defaults for each type, less host, service account and base DN'),
  'GET /admin/directories/:id': UserDirectory,
  'POST /admin/directories': UserDirectory,
  'PUT /admin/directories/:id': UserDirectory,
  'PUT /admin/directories/order': z.array(UserDirectory),
  'POST /admin/directories/test': z.object({ steps: z.array(z.object({ step: z.string(), ok: z.boolean(), detail: z.string() })) }),
  'POST /admin/directories/:id/sync': z.object({ jobId: id }),
  'GET /me/tokens': z.array(AccessToken),
  'POST /me/tokens': AccessTokenCreated,
  'GET /users': z.array(User),
  'GET /users/search': UserPage,
  'GET /projects/search': ProjectPage,
  'POST /projects/:key/archive': ProjectDetail,
  'POST /projects/:key/restore': ProjectDetail,
  'GET /projects/:key/fields/:id/usage': z.object({ options: z.record(z.string(), z.number()).describe('Option id → live work items that have it') }),
  'GET /admin/archived-projects': z.object({ items: z.array(z.object({ id, key: z.string(), name: z.string(), archivedAt: ts, archivedBy: nullable(z.string()).describe('Who archived it') })), next: nullable(z.string()) }),
  'GET /issues/:key/comments': CommentPage,
  'GET /issues/:key/activity': ActivityPage,
  'POST /issues/bulk/edit': BulkEditResult,
  'POST /issues/bulk/delete': BulkCount,
  'POST /issues/bulk/restore': BulkCount,
  'GET /projects': z.array(ProjectListItem),
  'POST /projects': ProjectDetail,
  'GET /projects/:key': ProjectDetail,
  'PATCH /projects/:key': ProjectDetail,
  'GET /projects/:key/issues': IssuePage,
  'GET /projects/:key/report-data': ReportData,
  'POST /projects/:key/issues': IssueRow,
  'GET /projects/:key/summary': Summary,
  'POST /projects/:key/sprints': Sprint,
  'PATCH /projects/:key/sprints/:id': Sprint,
  'POST /projects/:key/sprints/:id/start': Sprint,
  'POST /projects/:key/sprints/:id/complete': Sprint.extend({ newSprint: Sprint.optional().describe('The sprint made for unfinished work (moveTo "new")') }),
  'POST /projects/:key/releases/:id/release': Release,
  'POST /projects/:key/releases/:id/merge': Release,
  'GET /projects/:key/releases/:id/usage': z.object({ fix: z.number().describe('Live work items with it as a fix version'), affects: z.number().describe('…as an affects version') }),
  'GET /projects/:key/components/:id/usage': z.object({ items: z.number().describe('Live work items in it') }),
  'GET /issues/:key': IssueDetail,
  'GET /issues/:key/development': Development,
  'PATCH /issues/:key': IssueRow,
  'POST /issues/:key/clone': IssueRow,
  'GET /link-types': z.array(LinkType),
  'PUT /projects/:key/testing': z.object({ enabled: z.boolean(), requirementTypes: nullable(z.array(z.string())) }),
  'GET /issues/:key/tests': z.array(TestMember),
  'POST /issues/:key/tests': z.object({ added: z.number(), already: z.number().describe('Already in it'), items: z.array(TestMember) }),
  'PATCH /issues/:key/tests/:test': z.array(TestMember),
  'GET /issues/:key/test-containers': z.array(z.object({ id, key: z.string(), type: z.string(), title: z.string(), projectId: id })),
  'GET /projects/:key/test-folders': z.array(TestFolder),
  'GET /test-statuses': z.array(TestStatus),
  'GET /groups': z.object({ items: z.array(GroupSummary), next: nullable(z.string()).describe('Pass back as `cursor`; null on the last page') }),
  'POST /admin/users/bulk': z.object({ changed: z.number(), unchanged: z.number().describe('Already as asked') }),
  'GET /admin/users/refused-sign-ins': z.array(z.object({ at: ts, userId: nullable(z.string()), email: nullable(z.string()), ip: nullable(z.string()), name: nullable(z.string()), active: nullable(z.boolean()) })),
  'GET /groups/:id': GroupSummary.extend({
    people: z.array(GroupMember).describe('The first members by name (GET /groups/:id/members for the rest)'), morePeople: nullable(z.string()).describe('Cursor for the next page of members'),
    projects: z.array(z.object({ key: z.string(), name: z.string(), role: z.string() })).describe('Projects you can see where the group has a role'),
  }),
  'GET /groups/:id/members': z.object({ items: z.array(GroupMember), next: nullable(z.string()) }),
  'POST /groups': GroupSummary,
  'PATCH /groups/:id': GroupSummary,
  'POST /groups/:id/members': z.object({ added: z.number() }),
  'POST /groups/:id/owners': GroupSummary,
  'GET /issues/:key/coverage': z.object({
    status: z.enum(['OK', 'NOK', 'NOTRUN', 'UNKNOWN', 'UNCOVERED']).describe('With sub-requirements'), own: z.enum(['OK', 'NOK', 'NOTRUN', 'UNKNOWN', 'UNCOVERED']).describe('From its own tests only'),
    tests: z.array(z.object({ id, key: z.string(), title: z.string(), status: nullable(z.string()).describe('In the scope; null: not run there') })),
    subRequirements: z.array(z.object({ id, key: z.string(), title: z.string(), status: z.enum(['OK', 'NOK', 'NOTRUN', 'UNKNOWN', 'UNCOVERED']) })),
  }),
  'GET /projects/:key/test-results': z.array(z.object({ testId: id, key: z.string(), status: nullable(z.string()) })),
  'GET /projects/:key/reports/traceability': z.array(z.object({
    id, key: z.string(), title: z.string(), type: z.string(), status: z.enum(['OK', 'NOK', 'NOTRUN', 'UNKNOWN', 'UNCOVERED']),
    tests: z.array(z.object({ id, key: z.string(), title: z.string(), status: nullable(z.string()),
      defects: z.array(z.object({ id, key: z.string(), title: z.string(), done: z.boolean() })) })),
  })),
  'GET /projects/:key/reports/test-runs': z.array(TestRun),
  'POST /admin/test-statuses': TestStatus,
  'PATCH /admin/test-statuses/:kind/:key': TestStatus,
  'GET /issues/:key/runs': z.array(TestRun),
  'POST /issues/:key/runs': z.object({ added: z.number(), already: z.number() }),
  'GET /issues/:key/executions': z.array(TestMember),
  'POST /issues/:key/executions': IssueRow,
  'GET /issues/:key/test-progress': z.object({ total: z.number(), byStatus: z.record(z.string(), z.number()) }),
  'GET /test-runs/:id': TestRun,
  'PATCH /test-runs/:id': TestRun,
  'POST /test-runs/:id/reset': TestRun,
  'POST /test-runs/:id/defects': z.object({ defect: IssueRow, run: TestRun }),
  'DELETE /test-runs/:id/defects/:defect': TestRun,
  'POST /test-runs/:id/evidence': TestRun,
  'POST /projects/:key/test-folders': TestFolder,
  'PATCH /projects/:key/test-folders/:folderId': TestFolder,
  'GET /projects/:key/security-levels': z.array(SecurityLevel),
  'POST /projects/:key/security-levels': SecurityLevel,
  'PATCH /projects/:key/security-levels/:levelId': SecurityLevel,
  'GET /me/notification-prefs': NotificationPrefs,
  'PUT /me/notification-prefs': NotificationPrefs,
  'POST /projects/:key/import': z.object({
    columns: z.array(z.string()), rows: z.number(), ready: z.number().describe('Rows that will become work items'), skipped: z.number().describe('Rows left out (no title…)'),
    report: z.array(z.object({ row: z.number().describe('As a spreadsheet numbers it'), title: z.string(), ok: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) })),
    jobId: nullable(id).describe('The import job (null on a dry run)'), importId: id.optional(),
  }),
  'GET /projects/:key/automation/runs': z.array(z.object({ id, ruleId: id, rule: z.string(), issueId: nullable(id), issueKey: nullable(z.string()), trigger: z.record(z.string(), z.unknown()),
    result: z.enum(['success', 'some_skipped', 'no_change', 'failed']), steps: z.array(Step), error: nullable(z.string()), at: ts })),
  'POST /projects/:key/automation/dry-run': z.object({ steps: z.array(Step), error: nullable(z.string()) }),
  'GET /projects/:key/boards': z.array(z.object({ id, name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string(), position: z.number(), hasBacklog: z.boolean().describe('Kanban: it has a Kanban backlog (spec 0406)'), canManage: z.boolean(), canManageSprints: z.boolean() })),
  'POST /projects/:key/boards': Board,
  'GET /boards/:id': Board,
  'GET /boards/:id/statuses': z.array(z.object({ id, name: z.string(), category: z.enum(['todo', 'in-progress', 'done']), color: z.string() })),
  'PATCH /boards/:id': Board,
  'GET /boards/:id/issues': z.object({ items: z.array(IssueRow.extend({ lane: z.string().describe('The swimlane query it falls in ("" for none)'), color: z.string().describe('The card colour query it matches first ("" for none)'), projectKey: z.string() })),
    total: z.number().describe('Everything the board finds, on every page'), next: nullable(z.string()) }),
  'POST /jql/check': z.object({ count: z.number().describe('Work items it finds among those I may see') }),
  'GET /projects/:key/workflow': z.object({ scheme: z.object({ id, name: z.string(), description: z.string() }), types: z.array(TypeWorkflow) }),
  'PUT /projects/:key/workflow-scheme': Impact,
  'PATCH /projects/:key/statuses/:id': Status,
  'GET /workflow-schemes': z.array(WorkflowScheme),
  'GET /workflows': z.array(z.object({ id, name: z.string(), description: z.string(), version: z.number(), updatedAt: ts, statuses: z.number(), transitions: z.number(), schemes: z.number(), projects: z.number() })),
  'GET /workflows/:id': Workflow,
  'GET /workflows/:id/versions': z.array(z.object({ version: z.number(), note: z.string(), publishedAt: ts, publishedBy: nullable(z.string()), statuses: z.number(), transitions: z.number() })),
  'GET /workflows/:id/versions/:version': z.object({ version: z.number(), note: z.string(), publishedAt: ts, publishedBy: nullable(z.string()), statuses: z.array(WfStatus), transitions: z.array(LibTransition) }),
  'GET /admin/statuses': z.array(WfStatus.extend({ position: z.number(), workflows: z.array(z.string()).describe('Workflows using it') })),
  'POST /admin/statuses': WfStatus.extend({ position: z.number(), workflows: z.array(z.string()) }),
  'PATCH /admin/statuses/:id': WfStatus.extend({ position: z.number(), workflows: z.array(z.string()) }),
  'POST /admin/workflows': Workflow,
  'PATCH /admin/workflows/:id': Workflow,
  'POST /admin/workflows/:id/publish': z.object({ workflow: Workflow, version: z.number(), created: z.boolean().describe('False: nothing but the layout changed'), summary: ApplySummary, jobId: nullable(id).describe('The job applying it to projects (null: a preview, or nothing to apply)') }),
  'GET /admin/workflows/:id/projects': ProjectsPage,
  'GET /admin/workflow-schemes/:id/projects': ProjectsPage,
  'GET /admin/workflows/applying': nullable(z.object({ jobId: id, workflowId: nullable(id), schemeId: nullable(id), name: nullable(z.string()), done: z.number(), total: z.number(), startedAt: ts })),
  'POST /admin/workflow-schemes': WorkflowScheme,
  'PATCH /admin/workflow-schemes/:id': z.object({ scheme: WorkflowScheme, summary: ApplySummary, jobId: nullable(id) }),
  'POST /projects/:key/types': WorkType,
  'PATCH /projects/:key/types/:typeKey': WorkType,
  'POST /admin/link-types': LinkType,
  'PATCH /admin/link-types/:id': LinkType,
  'GET /issues/:key/transitions': z.array(AvailableTransition),
  'POST /issues/:key/transitions': IssueRow,
  'POST /issues/:key/restore': IssueRow,
  'GET /issues/:key/delete-preview': z.object({ subItems: z.number().describe('Sub-items deleted with it'), epicItems: z.number().describe('For an epic: its items, which stay without it') }),
  'GET /projects/:key/deleted': z.object({ items: z.array(z.object({ id, key: z.string(), title: z.string(), type: z.string(), deletedAt: ts, deletedBy: nullable(z.string()), removedAt: ts.describe('When it is removed for good'), subItems: z.number() })), next: nullable(z.string()) }),
  'POST /issues/:key/comments': Comment,
  'PATCH /comments/:id': Comment,
  'POST /issues/:key/worklogs': Worklog,
  'PATCH /worklogs/:id': Worklog,
  'GET /search': SearchPage,
  'GET /me/work': WorkList,
  'GET /me/recent': WorkList,
  'GET /me/viewed': WorkList,
  'GET /projects/:key/members': z.array(Member),
  'POST /projects/:key/members': z.array(Member),
  'PATCH /projects/:key/members/:userId': Member,
  'GET /labels': z.array(z.string()),
  'GET /me/work/summary': z.object({ assigned: z.number(), dueSoon: z.number(), overdue: z.number(), blocked: z.number(), dueSoonDays: z.number().describe('What “due soon” means here, in days') }),
  'GET /me/projects/recent': z.array(z.object({ id, key: z.string(), name: z.string(), color: z.string(), template: z.string(), myOpen: z.number(), done: z.number(), total: z.number(), lastActivity: ts })),
  'GET /notifications': z.array(NotificationItem),
  'PATCH /notifications/:id': Notification,
  'GET /views': z.array(SavedView),
  'POST /views': SavedView,
  'PATCH /views/:id': SavedView,
  'GET /admin/views': z.object({ items: z.array(SavedView), total: z.number(), next: nullable(z.string()) }),
  'POST /issues/:key/attachments': AttachmentTicket,
  'GET /attachments/:id/url': z.object({ url: z.string() }),
  'GET /admin/settings/project-backups': BackupSettings,
  'PUT /admin/settings/project-backups': BackupSettings,
  'GET /projects/:key/groups': z.array(GroupGrant),
  'POST /projects/:key/groups': z.array(GroupGrant),
  'PATCH /projects/:key/groups/:groupId': z.array(GroupGrant),
  'GET /groups/search': z.array(z.object({ id, name: z.string(), members: z.number(), kind: z.enum(['system', 'directory', 'strand']), owners: z.array(z.string()) })),
  'GET /admin/settings': z.array(SettingView),
  'PUT /admin/settings/:key': SettingView,
  'GET /settings/public': z.record(z.string(), z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])).describe('attachments, accessTokens, searchAndBulk, dueReminders, timeTracking, projectKeys…; and the priorities and resolutions lists'),
  'GET /admin/rate-limits/limited': z.array(z.object({
    userId: nullable(id).describe('Null: Anonymous, every request without a sign-in (spec 0706)'), name: z.string(), email: z.string(), firstAt: ts, lastAt: ts, times: z.number().describe('Minutes in which they were refused at least once'),
  })),
  'GET /admin/users': z.object({
    items: z.array(z.object({
      id, name: z.string(), email: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), active: z.boolean(),
      role: z.enum(['owner', 'admin', 'member']), createdAt: ts, projects: z.number().describe('Projects they are a member of'),
      lastActiveAt: nullable(ts).describe('Last used Strand (to the hour)'), lastSignInAt: nullable(ts), directory: nullable(z.string()).describe('The user directory they come from (spec 0712)'), username: nullable(z.string()), hasPassword: z.boolean().describe('Keeps a password in Strand (spec 0714)'), anonymisedAt: nullable(ts).describe('Anonymised (spec 0704)'), groups: z.array(z.object({ id, name: z.string() })),
    })),
    total: z.number().describe('Everyone the filter matches'), next: nullable(z.string()).describe('Pass back as `cursor`; null on the last page'),
  }),
  'GET /admin/project-backups': z.object({ items: z.array(z.object({
    id, projectId: id, projectKey: z.string(), projectName: z.string(), bucket: z.string(), objectKey: z.string(),
    items: z.number(), files: z.number(), bytes: z.number(), createdAt: ts, createdBy: nullable(id), restoredAt: nullable(ts),
  })), total: z.number(), next: nullable(z.string()) }),
  'GET /admin/project-backups/:id/url': z.object({ url: z.string() }),
  'GET /jobs/:id': z.object({
    id, kind: z.string(), status: z.enum(['queued', 'running', 'done', 'failed']), attempts: z.number(), maxAttempts: z.number(),
    lastError: nullable(z.string()), result: z.unknown(), progress: z.unknown().describe('How far a long job has got, when it says (e.g. done and total)'), createdBy: nullable(id), createdAt: ts, finishedAt: nullable(ts),
  }),
  'GET /audit': z.object({
    items: z.array(z.object({
      id, at: ts, actorId: nullable(id), actor: z.string().describe("Who acted: their email at the time, or 'SCIM'"), action: z.string(),
      projectId: nullable(id), projectKey: nullable(z.string()), targetType: z.string(), targetId: nullable(z.string()), target: nullable(z.string()),
      before: z.unknown(), after: z.unknown(), ip: nullable(z.string()),
    })),
    next: nullable(z.string()),
  }),
  'POST /attachments/:id/complete': z.object({ id, name: z.string(), size: z.number(), type: z.string(), addedBy: nullable(id), addedAt: ts }),
  'POST /import': ImportReport,
  ...Object.fromEntries(Object.entries(kindRow).flatMap(([kind, row]) => [
    [`POST /projects/:key/${kind}`, row], [`PATCH /projects/:key/${kind}/:id`, row],
  ])),
}
