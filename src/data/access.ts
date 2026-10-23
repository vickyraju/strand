// What I may do in a project. The server decides (and enforces) it; the screens only use it to hide what would be refused.
// A project with no `role` (a workspace kept in this browser) has no access control: everyone can do everything.
import type { Project } from './reducer'

type Scope = Pick<Project, 'role'> | null | undefined

/** Create and change work items, move them on the board, plan sprints (members and admins; viewers only read and comment). */
export const canEdit = (p: Scope) => p?.role !== 'viewer'
/** Workspace administration: delete projects, backups, the audit log (everyone in a workspace kept in this browser). */
export const isGlobalAdmin = (s: { isAdmin?: boolean }) => s.isAdmin !== false

/** Change the project's settings, workflow, rules and people. */
export const canAdmin = (p: Scope) => !p?.role || p.role === 'admin'
