// Who may see and do what inside a project. Roles are per project (project_access: a person's own role, or one their
// groups give them); workspace owners and admins
// ("global admins", Me.admin) can see and administer every project without being listed.
import { HttpError, type Me } from './auth.ts'
import type { Db } from './db.ts'
import { PERMISSIONS, holds, rolesWith, type Permission } from './shared/permissions.ts'

export type ProjectRole = 'admin' | 'member' | 'viewer'
export type { Permission }
export { rolesWith }

/** Why nothing in an archived project can change (spec 0102: archived projects are read-only for everyone, as in Jira). */
export const ARCHIVED = 'This project is archived. A system administrator can restore it to change it.'

/** My role in a project and whether it is archived, or null when I cannot see it. A project being deleted (its backup is
 *  running) is seen by nobody. In an archived project everyone, global admins included, is at most a viewer. */
export async function accessTo(d: Db, me: Me, projectId: string): Promise<{ role: ProjectRole; archived: boolean } | null> {
  const [r] = await d.query<{ role: ProjectRole | null; archived: boolean }>(
    `select pa.role, p.archived_at is not null as archived from projects p left join project_access pa on pa.project_id = p.id and pa.user_id = $2
      where p.id = $1 and p.deleting_at is null`, [projectId, me.id])
  const role = r && (me.admin ? 'admin' : r.role)
  if (!r || !role) return null
  return { role: r.archived ? 'viewer' : role, archived: r.archived }
}

/** My role in a project, or null when I cannot see it (at most viewer in an archived project). */
export async function roleOf(d: Db, me: Me, projectId: string): Promise<ProjectRole | null> {
  return (await accessTo(d, me, projectId))?.role ?? null
}

/** 403 when the project is archived: for changes that don't go through a project role (a comment, a work log). */
export async function notArchived(d: Db, projectId: string) {
  if ((await d.query('select 1 from projects where id = $1 and archived_at is not null', [projectId])).length) throw new HttpError(403, ARCHIVED)
}

/** Projects that can be seen at all: not being deleted, and not archived (an archived project is hidden from lists, search and
 *  boards; its items open only by their key). */
const LIVE = 'select id from projects where deleting_at is null and archived_at is null'

/** A role named where a permission is meant: what each role stands for in the permission table (spec 0201). */
const AS: Record<ProjectRole, Permission> = { viewer: 'browse', member: 'editIssues', admin: 'administer' }

/** Throws 403 unless `role` holds the permission (or reaches the role) in the project; `key` names the project in the message. */
export function need(role: ProjectRole, what: Permission | ProjectRole, key?: string) {
  const p = (what in AS ? AS[what as ProjectRole] : what) as Permission
  if (!holds(role, p)) throw new HttpError(403, `You need the ${PERMISSIONS[p].name} permission${key ? ` in ${key}` : ''}`)
}

/** Requests that only read. */
export const READS = new Set(['GET', 'HEAD'])

/** What a request needs by default: reading is Browse projects, changing things is Edit issues (spec 0201's table). */
export const minFor = (method: string): Permission => (READS.has(method) ? 'browse' : 'editIssues')

/** An SQL condition limiting `col` (a project id column) to projects I can see; adds its parameter to `args`. */
export function visible(me: Me, col: string, args: unknown[]): string {
  if (me.admin) { args.push(me.workspaceId); return `${col} in (${LIVE} and workspace_id = $${args.length})` }   // admins see their whole workspace, never another's
  args.push(me.id)
  return `${col} in (select project_id from project_access where user_id = $${args.length} and project_id in (${LIVE}))`
}

/** Can this person see the project at all (any role, or a global admin)? */
export async function canSee(d: Db, projectId: string, userId: string): Promise<boolean> {
  return (await d.query(`select 1 from project_access where project_id = $1 and user_id = $2 union all select 1 where is_system_admin($2) limit 1`, [projectId, userId])).length > 0
}

/** Can this person be given work in the project (Assignable user, or a global admin)? */
export async function canJoinWork(d: Db, projectId: string, userId: string): Promise<boolean> {
  const rows = await d.query(
    `select 1 from project_access where project_id = $1 and user_id = $2 and role = any($3)
     union all select 1 where is_system_admin($2) limit 1`, [projectId, userId, rolesWith('assignable')])
  return rows.length > 0
}

/** An SQL condition: comment `c` is shown to me. A comment limited to a project role or a group (Jira's comment
 *  visibility) is shown to the people in that role or group, and to its author. Roles stack as when limiting one
 *  (spec 0203 R4): a project admin is in Members too, and a global admin is a project admin everywhere. */
export const commentShown = (me: Me, projectId: string, userParam: number): string =>
  commentShownIn(me, `'${projectId.replace(/[^0-9a-f-]/gi, '')}'`, userParam)      // a uuid from the database, inlined as a literal
/** Like `commentShown`, with the project as an SQL expression (a search over many projects, spec 0609). */
export const commentShownIn = (me: Me, projectSql: string, userParam: number): string => {
  return `(c.visibility is null or c.author_id = $${userParam}::uuid
    or (c.visibility->>'kind' = 'role' and (${me.admin ? 'true' : `exists (select 1 from project_access pa where pa.project_id = ${projectSql} and pa.user_id = $${userParam}::uuid
          and array_position(array['viewer', 'member', 'admin'], pa.role) >= array_position(array['viewer', 'member', 'admin'], c.visibility->>'role'))`}))
    or (c.visibility->>'kind' = 'group' and exists (select 1 from group_members g where g.group_id = (c.visibility->>'id')::uuid and g.user_id = $${userParam}::uuid)))`
}

/** Like `visible`, for a query that already passes my user id as parameter number `userParam` (so no new parameter is needed). */
export const visibleAs = (me: Me, col: string, userParam: number): string =>
  // an admin's condition still names the parameter, so a query that passes my id for this alone stays valid
  me.admin ? `(${col} in (${LIVE}) and $${userParam}::uuid is not null)` : `${col} in (select project_id from project_access where user_id = $${userParam} and project_id in (${LIVE}))`
