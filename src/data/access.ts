// What I may do in a project. The server decides (and enforces) it from the permission table (spec 0201); the screens read
// the same table only to hide what would be refused. A project with no `role` (a workspace kept in this browser) has no
// access control: everyone can do everything.
import type { Project } from './reducer'
import { holds, type Permission } from '../../server/src/shared/permissions.ts'

type Scope = Pick<Project, 'role'> | null | undefined

/** Does my role in this project hold `permission` (Jira's project permissions, spec 0201)? */
export const can = (p: Scope, permission: Permission) => !p?.role || holds(p.role, permission)

/** Create and change work items, move them on the board, plan sprints (Edit issues: members and admins; viewers read and comment). */
export const canEdit = (p: Scope) => can(p, 'editIssues')
/** Workspace administration: delete projects, backups, the audit log (everyone in a workspace kept in this browser). */
export const isGlobalAdmin = (s: { isAdmin?: boolean }) => s.isAdmin !== false

/** Change the project's settings, workflow, rules and people (Administer projects). */
export const canAdmin = (p: Scope) => can(p, 'administer')
