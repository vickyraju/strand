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

export const Status = z.object({ id, projectId: id, name: z.string(), description: z.string(), color: z.string(), category: z.enum(['todo', 'in-progress', 'done']), wipLimit: nullable(z.number()), position: z.number() })
export const Transition = z.object({
  id, projectId: id, name: z.string(), fromIds: nullable(z.array(id)).describe('null: from any status'), toId: nullable(id).describe('null: a loop, the item stays in its status'),
  rules: z.record(z.string(), z.unknown()).describe('restrict, validate, screen, actions'),
})
export const LinkType = z.object({
  id: z.string(), name: z.string(), outward: z.string().describe('How a link reads from its source: "blocks"'), inward: z.string().describe('How it reads from its target: "is blocked by"'),
  builtin: z.boolean().describe('Built in (the app relies on it): can be renamed, not removed'), position: z.number(), uses: z.number().describe('Links of this type'),
})
export const AvailableTransition = z.object({
  id, name: z.string(), toId: nullable(id), screen: z.array(z.string()).describe('Fields to fill in (and "comment")'),
  problems: z.record(z.string(), z.string()).describe('What would stop the move if made now, by field'),
})
export const Field = z.object({ id, projectId: id, name: z.string(), kind: z.enum(['text', 'number', 'select', 'date']), options: nullable(z.array(z.string())), position: z.number() })
export const Template = z.object({ id, projectId: id, name: z.string(), type: z.string(), title: z.string(), description: z.string(), priority: z.string(), labels: z.array(z.string()), estimate: nullable(z.number()) })
export const Rule = z.object({ id, projectId: id, name: z.string(), enabled: z.boolean(), trigger: z.record(z.string(), z.unknown()), actions: z.array(z.record(z.string(), z.unknown())), runs: z.number() })
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
export const ProjectDetail = z.object({
  id, workspaceId: id, key: z.string(), name: z.string(), description: z.string(), color: z.string(), template: z.enum(['kanban', 'scrum']),
  leadId: nullable(id), archivedAt: nullable(ts), nextNumber: z.number(), boardPrefs: z.record(z.string(), z.unknown()), layout: z.record(z.string(), z.unknown()),
  sample: z.boolean(), createdAt: ts, role: z.enum(['admin', 'member', 'viewer']).describe('My role in this project'),
  statuses: z.array(Status), transitions: z.array(Transition), fields: z.array(Field), templates: z.array(Template),
  rules: z.array(Rule), releases: z.array(Release), sprints: z.array(Sprint),
})

const issueFields = {
  id, key: z.string().describe('e.g. PAY-12'), projectId: id, number: z.number(), type: z.enum(['epic', 'story', 'task', 'bug']),
  title: z.string(), description: z.string(), statusId: id, priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  assigneeId: nullable(id), reporterId: nullable(id), labels: z.array(z.string()), estimate: nullable(z.number()), timeEstimate: nullable(z.number()),
  dueDate: nullable(day), startDate: nullable(day), sprintId: nullable(id), releaseId: nullable(id), parentId: nullable(id),
  custom: z.record(z.string(), z.union([z.string(), z.number()])), rank: z.number(), version: z.number().describe('Send as If-Match to reject stale edits'),
  resolution: nullable(z.enum(['Done', "Won't do", 'Duplicate', 'Cannot reproduce'])).describe('Set while the item is in a Done status'),
  resolvedAt: nullable(ts).describe('When the item last reached a Done status'),
  createdAt: ts, updatedAt: ts,
}
export const IssueRow = z.object(issueFields)
const GroupGrant = z.object({
  groupId: id, name: z.string(), role: z.enum(['admin', 'member', 'viewer']), addedAt: ts, members: z.number().describe('Active people in the group'),
})
const SettingView = z.object({
  key: z.string(), label: z.string(), description: z.string(),
  value: z.record(z.string(), z.unknown()).describe('Current value'), default: z.record(z.string(), z.unknown()).describe('Value when nothing is saved'),
})
const BackupSettings = z.object({
  enabled: z.boolean().describe('Deleting a project backs it up first'), bucket: nullable(z.string()), prefix: z.string(),
  effectiveBucket: nullable(z.string()).describe('Where backups actually go (empty: nowhere configured, so deleting a project is refused)'),
  allowedBuckets: z.array(z.string()).describe('Buckets the operators allow a workspace to choose (BACKUP_BUCKETS)'),
})
export const Comment = z.object({ id, issueId: id, authorId: nullable(id), body: z.string(), createdAt: ts, editedAt: nullable(ts) })
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
export const SavedView = z.object({ id, workspaceId: id, ownerId: id, name: z.string(), shared: z.boolean(), filters: z.record(z.string(), z.unknown()) })

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
const kindRow = { statuses: Status, transitions: Transition, fields: Field, templates: Template, rules: Rule, releases: Release } as const

/** Routes that create something answer 201 Created (Jira and REST convention), not 200. */
export const CREATED = new Set([
  'POST /projects', 'POST /projects/:key/issues', 'POST /issues/:key/comments', 'POST /issues/:key/worklogs', 'POST /projects/:key/sprints',
  'POST /views', 'POST /issues/:key/attachments', 'POST /me/tokens',
  ...['statuses', 'transitions', 'fields', 'templates', 'rules', 'releases'].map(k => `POST /projects/:key/${k}`),
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
  'POST /admin/link-types': LinkType,
  'PATCH /admin/link-types/:id': LinkType,
  'GET /issues/:key/transitions': z.array(AvailableTransition),
  'POST /issues/:key/transitions': IssueRow,
  'POST /issues/:key/restore': IssueRow,
  'POST /issues/:key/comments': Comment,
  'PATCH /comments/:id': Comment,
  'POST /issues/:key/worklogs': Worklog,
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
  'POST /issues/:key/attachments': AttachmentTicket,
  'GET /attachments/:id/url': z.object({ url: z.string() }),
  'GET /admin/settings/project-backups': BackupSettings,
  'PUT /admin/settings/project-backups': BackupSettings,
  'GET /projects/:key/groups': z.array(GroupGrant),
  'POST /projects/:key/groups': z.array(GroupGrant),
  'PATCH /projects/:key/groups/:groupId': z.array(GroupGrant),
  'GET /groups/search': z.array(z.object({ id, name: z.string(), members: z.number() })),
  'GET /admin/settings': z.array(SettingView),
  'PUT /admin/settings/:key': SettingView,
  'GET /settings/public': z.record(z.string(), z.record(z.string(), z.unknown())).describe('attachments, accessTokens, searchAndBulk, dueReminders'),
  'GET /admin/rate-limits/limited': z.array(z.object({
    userId: id, name: z.string(), email: z.string(), firstAt: ts, lastAt: ts, times: z.number().describe('Minutes in which they were refused at least once'),
  })),
  'GET /admin/users': z.array(z.object({
    id, name: z.string(), email: z.string(), initials: z.string(), color: z.string(), title: nullable(z.string()), active: z.boolean(),
    role: z.enum(['owner', 'admin', 'member']), createdAt: ts, projects: z.number().describe('Projects they are a member of'),
  })),
  'GET /admin/project-backups': z.array(z.object({
    id, projectId: id, projectKey: z.string(), projectName: z.string(), bucket: z.string(), objectKey: z.string(),
    items: z.number(), files: z.number(), bytes: z.number(), createdAt: ts, createdBy: nullable(id), restoredAt: nullable(ts),
  })),
  'GET /admin/project-backups/:id/url': z.object({ url: z.string() }),
  'GET /jobs/:id': z.object({
    id, kind: z.string(), status: z.enum(['queued', 'running', 'done', 'failed']), attempts: z.number(), maxAttempts: z.number(),
    lastError: nullable(z.string()), result: z.unknown(), createdBy: nullable(id), createdAt: ts, finishedAt: nullable(ts),
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
