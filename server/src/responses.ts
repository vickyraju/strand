// Response bodies, by route. Attached to each route as it registers (see app.ts), so they both appear in the
// OpenAPI document and are enforced when responses are serialized: a handler that returns the wrong shape fails a test
// instead of leaking an unexpected field. Timestamps are ISO strings (db.ts), dates are YYYY-MM-DD.
import { z } from 'zod'

const id = z.string().describe('uuid')
const ts = z.string().describe('ISO 8601 timestamp')
const day = z.string().describe('YYYY-MM-DD')
const nullable = <T extends z.ZodType>(t: T) => t.nullable()

export const User = z.object({ id, name: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), email: z.string(), role: z.string() })
export const Me = z.object({ id, email: z.string(), name: z.string(), workspaceId: id, role: z.enum(['owner', 'admin', 'member']), admin: z.boolean(), groupIds: z.array(id).describe('Groups I am in (transition rules can name groups)') })

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
export const AvailableTransition = z.object({
  id, name: z.string(), toId: nullable(id), screen: z.array(z.string()).describe('Fields to fill in (and "comment")'),
  problems: z.record(z.string(), z.string()).describe('What would stop the move if made now, by field'),
})
export const Field = z.object({ id, projectId: id, name: z.string(), kind: z.enum(['text', 'number', 'select', 'date']), options: nullable(z.array(z.string())), position: z.number() })
export const Template = z.object({ id, projectId: id, name: z.string(), type: z.string(), title: z.string(), description: z.string(), priority: z.string(), labels: z.array(z.string()), estimate: nullable(z.number()) })
export const Rule = z.object({ id, projectId: id, name: z.string(), enabled: z.boolean(), trigger: z.record(z.string(), z.unknown()), actions: z.array(z.record(z.string(), z.unknown())), runs: z.number(), failures: z.number(), ownerId: nullable(id) })
const Step = z.object({ action: z.string(), outcome: z.enum(['done', 'skipped', 'unchanged', 'failed']), note: z.string().optional() })
export const Release = z.object({ id, workspaceId: id, projectId: id, name: z.string(), description: z.string(), startDate: nullable(day), releaseDate: nullable(day), released: z.boolean(), releasedAt: nullable(ts) })
export const Sprint = z.object({
  id, workspaceId: id, projectId: id, name: z.string(), goal: z.string(), state: z.enum(['planned', 'active', 'closed']),
  startedAt: nullable(ts), endsAt: nullable(ts), completedAt: nullable(ts), committed: nullable(z.number()), completed: nullable(z.number()),
  issueIds: nullable(z.array(id)), createdAt: ts,
})

export const ProjectListItem = z.object({
  id, key: z.string(), name: z.string(), description: z.string(), color: z.string(), template: z.enum(['kanban', 'scrum']),
  leadId: nullable(id), createdAt: ts, archivedAt: nullable(ts), starred: z.boolean(), openCount: z.number(),
})
export const ProjectPage = z.object({ items: z.array(ProjectListItem), next: nullable(z.string()).describe('Pass back as `cursor`; null on the last page') })
export const UserPage = z.object({ items: z.array(User), next: nullable(z.string()) })
export const TypeWorkflow = z.object({ typeKey: z.string(), workflowId: id, workflow: z.string(), statusIds: z.array(id).describe('Statuses an item of this type can be in; new ones start in the first') })
const WfStatus = z.object({ id, name: z.string(), description: z.string(), color: z.string(), category: z.enum(['todo', 'in-progress', 'done']) })
const LibTransition = z.object({ id: z.string(), name: z.string(), fromIds: nullable(z.array(id)), toId: nullable(id), rules: z.record(z.string(), z.unknown()) })
export const Workflow = z.object({
  id, name: z.string(), description: z.string(), version: z.number(), updatedAt: ts, statuses: z.array(WfStatus).describe('In order: new work starts in the first'),
  transitions: z.array(LibTransition), layout: z.record(z.string(), z.unknown()),
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
  moves: z.array(z.object({ from: z.string(), to: z.string(), count: z.number() })).describe('Where items go, over every project, biggest first (at most 10)'),
  top: z.array(Impact).describe('The projects most changed (at most 10)'),
})
const ProjectsPage = z.object({ items: z.array(z.object({ id, key: z.string(), name: z.string(), scheme: z.string() })), next: nullable(z.string()), total: z.number() })
const BoardColumn = z.object({ id: z.string(), name: z.string(), statusIds: z.array(id).describe('Global statuses shown in this column'), min: z.number().optional(), max: z.number().optional() })
const NamedQuery = z.object({ id: z.string(), name: z.string(), jql: z.string() })
export const Board = z.object({
  id, projectId: id, projectKey: z.string(), name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string().describe('The board filter'),
  columns: z.array(BoardColumn), swimlanes: z.object({ by: z.enum(['none', 'assignee', 'epic', 'priority', 'project', 'queries']), queries: z.array(NamedQuery).optional() }),
  quickFilters: z.array(NamedQuery), cardFields: z.record(z.string(), z.boolean()), doneDays: nullable(z.number()), position: z.number(),
  canManage: z.boolean().describe('I may change it'), admins: z.array(z.object({ kind: z.enum(['user', 'group']), id, name: z.string() })),
})
export const ProjectDetail = z.object({
  id, workspaceId: id, key: z.string(), name: z.string(), description: z.string(), color: z.string(), template: z.enum(['kanban', 'scrum']),
  leadId: nullable(id), archivedAt: nullable(ts), nextNumber: z.number(), testing: z.boolean().describe('Test management is on'), requirementTypes: nullable(z.array(z.string())).describe('Work types counted as requirements (null: all but testing types and Bug)'), boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
  sample: z.boolean(), createdAt: ts, role: z.enum(['admin', 'member', 'viewer']).describe('My role in this project'),
  statuses: z.array(Status), transitions: z.array(Transition), types: z.array(WorkType), components: z.array(Component), fields: z.array(Field), templates: z.array(Template),
  rules: z.array(Rule), releases: z.array(Release), sprints: z.array(Sprint),
  workflowSchemeId: id.describe('Its workflow scheme'), workflows: z.array(TypeWorkflow),
  boards: z.array(z.object({ id, name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string(), position: z.number() })).describe('Its boards, in order'),
})

const issueFields = {
  id, key: z.string().describe('e.g. PAY-12'), projectId: id, number: z.number(), type: z.string().describe('Work type key'),
  title: z.string(), description: z.string(), statusId: id, priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  assigneeId: nullable(id), reporterId: nullable(id), labels: z.array(z.string()), estimate: nullable(z.number()), timeEstimate: nullable(z.number()), timeRemaining: nullable(z.number()), componentIds: z.array(id), affectsReleaseIds: z.array(id),
  testSpec: nullable(z.unknown()).describe('Test steps, Gherkin or definition (Tests and Pre-Conditions)'), testFolderId: nullable(id).describe('Test repository folder'),
  testEnvironments: z.array(z.string()).describe('Test Executions: what it ran against'), revision: z.string().describe('Test Executions: build or revision'),
  dueDate: nullable(day), startDate: nullable(day), sprintId: nullable(id), releaseId: nullable(id), parentId: nullable(id),
  custom: z.record(z.string(), z.union([z.string(), z.number()])), rank: z.number(), version: z.number().describe('Send as If-Match to reject stale edits'),
  resolution: nullable(z.enum(['Done', "Won't do", 'Duplicate', 'Cannot reproduce'])).describe('Set while the item is in a Done status'),
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
const CleanupPerson = z.object({ userId: id, email: z.string(), name: z.string(), lastActiveAt: nullable(ts) })
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
  'GET /me/tokens': z.array(AccessToken),
  'POST /me/tokens': AccessTokenCreated,
  'GET /users': z.array(User),
  'GET /users/search': UserPage,
  'GET /projects/search': ProjectPage,
  'POST /projects/:key/archive': ProjectDetail,
  'POST /projects/:key/restore': ProjectDetail,
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
  'POST /projects/:key/sprints/:id/complete': Sprint,
  'POST /projects/:key/releases/:id/release': Release,
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
  'GET /admin/license-cleanup': z.object({
    seats: z.object({ total: z.number().describe('People in users-access'), active30: z.number(), active90: z.number(), never: z.number().describe('Never used Strand') }),
    runs: z.array(z.object({ id, trigger: z.string(), action: z.string(), startedAt: ts, finishedAt: nullable(ts), changedCount: z.number(), warnedCount: z.number(),
      notes: z.string(), startedBy: nullable(z.string()) })).describe('Counts only: open a run for who it changed'),
  }),
  'POST /admin/license-cleanup/preview': z.object({ changeCount: z.number(), warnCount: z.number(),
    change: z.array(CleanupPerson).describe('The first 100, longest away first'), warn: z.array(CleanupPerson).describe('The first 100') }),
  'GET /admin/license-cleanup/runs/:id': z.object({ id, changed: z.array(CleanupPerson), warned: z.array(CleanupPerson) }),
  'POST /admin/license-cleanup/run': z.object({ id, changed: z.number(), warned: z.number(), notes: z.string() }),
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
  'GET /projects/:key/boards': z.array(z.object({ id, name: z.string(), type: z.enum(['kanban', 'scrum']), jql: z.string(), position: z.number(), canManage: z.boolean() })),
  'POST /projects/:key/boards': Board,
  'GET /boards/:id': Board,
  'PATCH /boards/:id': Board,
  'GET /boards/:id/issues': z.object({ items: z.array(IssueRow.extend({ lane: z.string().describe('The swimlane query it falls in ("" for none)'), projectKey: z.string() })),
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
  'GET /settings/public': z.record(z.string(), z.record(z.string(), z.unknown())).describe('attachments, accessTokens, searchAndBulk, dueReminders'),
  'GET /admin/rate-limits/limited': z.array(z.object({
    userId: id, name: z.string(), email: z.string(), firstAt: ts, lastAt: ts, times: z.number().describe('Minutes in which they were refused at least once'),
  })),
  'GET /admin/users': z.object({
    items: z.array(z.object({
      id, name: z.string(), email: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), active: z.boolean(),
      role: z.enum(['owner', 'admin', 'member']), createdAt: ts, projects: z.number().describe('Projects they are a member of'),
      lastActiveAt: nullable(ts).describe('Last used Strand (to the hour)'), lastSignInAt: nullable(ts), groups: z.array(z.object({ id, name: z.string() })),
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
