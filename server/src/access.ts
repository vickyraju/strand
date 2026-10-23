// Who may see and do what inside a project. Roles are per project (project_members); workspace owners and admins
// ("global admins", Me.admin) can see and administer every project without being listed.
import { HttpError, type Me } from './auth.ts'
import type { Db } from './db.ts'

export type ProjectRole = 'admin' | 'member' | 'viewer'
const RANK: Record<ProjectRole, number> = { viewer: 1, member: 2, admin: 3 }

/** My role in a project, or null when I cannot see it. */
export async function roleOf(d: Db, me: Me, projectId: string): Promise<ProjectRole | null> {
  if (me.admin) return 'admin'
  const [r] = await d.query<{ role: ProjectRole }>('select role from project_members where project_id = $1 and user_id = $2', [projectId, me.id])
  return r?.role ?? null
}

/** Throws 403 unless `role` is at least `min`. */
export function need(role: ProjectRole, min: ProjectRole) {
  if (RANK[role] < RANK[min]) throw new HttpError(403, min === 'admin' ? 'Project admin only' : 'Read-only access')
}

/** What a request needs by default: reading is for anyone who can see the project, changing things is for members and admins. */
export const minFor = (method: string): ProjectRole => (method === 'GET' || method === 'HEAD' ? 'viewer' : 'member')

/** An SQL condition limiting `col` (a project id column) to projects I can see; adds its parameter to `args`. */
export function visible(me: Me, col: string, args: unknown[]): string {
  if (me.admin) { args.push(me.workspaceId); return `${col} in (select id from projects where workspace_id = $${args.length})` }   // admins see their whole workspace, never another's
  args.push(me.id)
  return `${col} in (select project_id from project_members where user_id = $${args.length})`
}

/** Can this person be given work in the project (a member, or a global admin)? */
export async function canJoinWork(d: Db, projectId: string, userId: string): Promise<boolean> {
  const rows = await d.query(
    `select 1 from project_members where project_id = $1 and user_id = $2
     union all select 1 from memberships m join projects p on p.workspace_id = m.workspace_id
      where p.id = $1 and m.user_id = $2 and m.role in ('owner', 'admin') limit 1`, [projectId, userId])
  return rows.length > 0
}

/** Like `visible`, for a query that already passes my user id as parameter number `userParam` (so no new parameter is needed). */
export const visibleAs = (me: Me, col: string, userParam: number): string =>
  me.admin ? 'true' : `${col} in (select project_id from project_members where user_id = $${userParam})`
