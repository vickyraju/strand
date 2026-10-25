// Groups (Jira's groups, with one difference the product asked for: anyone may make one, if System settings allow it).
// Three kinds:
//   system     users-access and system-administrators: only system administrators change them; they can't be deleted
//   directory  provisioned by Entra over SCIM: members and name come from the directory (read-only here, as in Atlassian Cloud)
//   strand     made here: managed by their owners and by system administrators
// A project admin gives a group a role in their project (members.ts); a group's owners then decide who has that role,
// which is why everyone can see who owns a group.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { visible } from '../access.ts'
import { audit, changes } from '../audit.ts'
import { getSetting } from '../settings.ts'

const T = ['Groups']
const uuid = z.string().uuid()
const idP = z.object({ id: uuid })
const name = z.string().trim().min(1).max(100)

interface G { id: string; displayName: string; description: string; systemRole: string | null; externalId: string | null }
const kindOf = (g: G) => (g.systemRole ? 'system' : g.externalId ? 'directory' : 'strand')
/** May this person manage the group (members, name, owners)? */
async function canManage(d: Db, me: Me, g: G) {
  if (g.externalId && !g.systemRole) return false                                    // the directory manages it
  if (me.admin) return true
  if (g.systemRole) return false
  return (await d.query('select 1 from group_owners where group_id = $1 and user_id = $2', [g.id, me.id])).length > 0
}
async function groupFor(d: Db, me: Me, id: string, manage: boolean, lock = false) {
  const [g] = await d.query<G>(`select id, display_name, description, system_role, external_id from groups where id = $1 ${lock ? 'for update' : ''}`, [id])
  if (!g) throw new HttpError(404, 'No such group')
  if (manage && !(await canManage(d, me, g)))
    throw new HttpError(403, g.externalId && !g.systemRole ? 'This group comes from the directory (Entra): change it there'
      : g.systemRole ? 'Only system administrators can change this group' : 'Only the group’s owners and system administrators can change it')
  return g
}
const ROW = `select g.id, g.display_name as name, g.description, g.system_role, (g.external_id is not null) as directory, g.created_at,
  (select count(*)::int from group_members gm join users u on u.id = gm.user_id where gm.group_id = g.id and u.active) as members,
  coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) order by lower(u.name)) from group_owners o join users u on u.id = o.user_id where o.group_id = g.id), '[]') as owners,
  exists (select 1 from group_members gm where gm.group_id = g.id and gm.user_id = $1) as is_member,
  exists (select 1 from group_owners o where o.group_id = g.id and o.user_id = $1) as is_owner
  from groups g`
const shape = (me: Me) => (r: any) => ({
  id: r.id, name: r.name, description: r.description, kind: r.systemRole ? 'system' : r.directory ? 'directory' : 'strand',
  systemRole: r.systemRole, members: r.members, owners: r.owners, isMember: r.isMember, isOwner: r.isOwner,
  canManage: !(r.directory && !r.systemRole) && (me.admin || (!r.systemRole && r.isOwner)), createdAt: r.createdAt,
})

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/groups', { schema: { tags: T, summary: 'Groups, with their owners and how many people are in each; `mine` for those I’m in or own', querystring: z.object({
    query: z.string().max(100).default(''), mine: z.coerce.boolean().default(false),
  }) } }, async req => {
    const like = '%' + req.query.query.replace(/[%_\\]/g, '\\$&') + '%'
    const rows = await db.query<any>(`${ROW} where g.display_name ilike $2 ${req.query.mine ? `and (exists (select 1 from group_members gm where gm.group_id = g.id and gm.user_id = $1)
      or exists (select 1 from group_owners o where o.group_id = g.id and o.user_id = $1))` : ''}
      order by g.system_role is null, lower(g.display_name) limit 500`, [req.me.id, like])
    return rows.map(shape(req.me))
  })

  app.get('/groups/:id', { schema: { tags: T, summary: 'A group: its members, owners, and the roles it has in projects you can see', params: idP } }, async req => {
    const [row] = await db.query<any>(`${ROW} where g.id = $2`, [req.me.id, req.params.id])
    if (!row) throw new HttpError(404, 'No such group')
    const members = await db.query(`select u.id, u.name, u.email, u.initials, u.color, u.active from group_members gm join users u on u.id = gm.user_id
                                     where gm.group_id = $1 order by u.active desc, lower(u.name) limit 5000`, [req.params.id])
    const args: unknown[] = [req.params.id]
    const projects = await db.query(`select p.key, p.name, pg.role from project_group_roles pg join projects p on p.id = pg.project_id
                                      where pg.group_id = $1 and ${visible(req.me, 'p.id', args)} order by p.key`, args)
    return { ...shape(req.me)(row), people: members, projects }
  })

  app.post('/groups', { schema: { tags: T, summary: 'Make a group (everyone, or system administrators only, as System settings say). You become its owner and a member', body: z.object({
    name, description: z.string().max(500).default(''),
  }) } }, async (req, reply) => {
    const { whoCanCreate } = await getSetting(req.me.workspaceId, 'groups')
    if (whoCanCreate === 'admins' && !req.me.admin) throw new HttpError(403, 'Only system administrators can make groups (System settings › Groups)')
    return tx(async d => {
      if ((await d.query('select 1 from groups where lower(display_name) = lower($1)', [req.body.name])).length)
        throw new HttpError(409, 'There is already a group with that name', { name: 'Already used' })
      const [g] = await d.query<{ id: string }>('insert into groups (display_name, description, created_by) values ($1, $2, $3) returning id', [req.body.name, req.body.description, req.me.id])
      await d.query('insert into group_owners (group_id, user_id) values ($1, $2)', [g!.id, req.me.id])
      await d.query('insert into group_members (group_id, user_id) values ($1, $2)', [g!.id, req.me.id])
      await audit(d, req, { action: 'group.created', type: 'group', id: g!.id, name: req.body.name, after: req.body })
      reply.code(201)
      return shape(req.me)((await d.query<any>(`${ROW} where g.id = $2`, [req.me.id, g!.id]))[0])
    })
  })

  app.patch('/groups/:id', { schema: { tags: T, summary: 'Rename a group or change its description (its owners and system administrators)', params: idP,
    body: z.object({ name, description: z.string().max(500) }).partial() } }, async req => {
    return tx(async d => {
      const g = await groupFor(d, req.me, req.params.id, true, true)
      const next = { name: req.body.name ?? g.displayName, description: req.body.description ?? g.description }
      if (req.body.name && (await d.query('select 1 from groups where lower(display_name) = lower($1) and id <> $2', [req.body.name, g.id])).length)
        throw new HttpError(409, 'There is already a group with that name', { name: 'Already used' })
      await d.query('update groups set display_name = $2, description = $3 where id = $1', [g.id, next.name, next.description])
      const c = changes({ name: g.displayName, description: g.description }, next)
      if (c.changed) await audit(d, req, { action: 'group.updated', type: 'group', id: g.id, name: next.name, before: c.before, after: c.after })
      return shape(req.me)((await d.query<any>(`${ROW} where g.id = $2`, [req.me.id, g.id]))[0])
    })
  })

  app.delete('/groups/:id', { schema: { tags: T, summary: 'Delete a group made here (its owners and system administrators): everyone loses the project roles it gave them', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const g = await groupFor(d, req.me, req.params.id, true, true)
      if (g.systemRole) throw new HttpError(409, `${g.displayName} is a system group and can’t be deleted`)
      await guardProjectAdmins(d, g.id, null)
      await d.query('delete from groups where id = $1', [g.id])
      await audit(d, req, { action: 'group.deleted', type: 'group', id: g.id, name: g.displayName })
    })
    reply.code(204).send()
  })

  // ── members ──
  app.post('/groups/:id/members', { schema: { tags: T, summary: 'Add people to a group (its owners and system administrators)', params: idP,
    body: z.object({ userIds: z.array(uuid).min(1).max(500) }) } }, async req => {
    return tx(async d => {
      const g = await groupFor(d, req.me, req.params.id, true, true)
      const ok = await d.query<{ id: string; email: string }>(
        'select u.id, u.email from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.active and u.id = any($2::uuid[])', [req.me.workspaceId, req.body.userIds])
      if (ok.length !== new Set(req.body.userIds).size) throw new HttpError(400, 'Everyone added must be an active person in this workspace', { userIds: 'Unknown or deactivated' })
      const added = await d.query<{ userId: string }>(`insert into group_members (group_id, user_id) select $1, x from unnest($2::uuid[]) x on conflict do nothing returning user_id`, [g.id, ok.map(u => u.id)])
      if (added.length) await audit(d, req, { action: 'group.members_added', type: 'group', id: g.id, name: g.displayName, after: { added: ok.filter(u => added.some(a => a.userId === u.id)).map(u => u.email) } })
      return { added: added.length }
    })
  })
  app.delete('/groups/:id/members/:userId', { schema: { tags: T, summary: 'Take someone out of a group (its owners and system administrators; anyone may leave a group made here)', params: idP.extend({ userId: uuid }) } }, async (req, reply) => {
    await tx(async d => {
      const self = req.params.userId === req.me.id
      const g = await groupFor(d, req.me, req.params.id, false, true)
      const leaving = self && kindOf(g) === 'strand'
      if (!leaving && !(await canManage(d, req.me, g))) await groupFor(d, req.me, req.params.id, true)     // throws the right refusal
      if (g.systemRole === 'system-admins') {
        const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1 and u.active', [g.id]) as any
        if (n <= 1) throw new HttpError(409, 'Strand needs at least one system administrator')
      }
      await guardProjectAdmins(d, g.id, req.params.userId)
      const [gone] = await d.query<{ email: string }>(`with del as (delete from group_members where group_id = $1 and user_id = $2 returning user_id)
                                                       select u.email from del join users u on u.id = del.user_id`, [g.id, req.params.userId])
      if (!gone) throw new HttpError(404, 'They aren’t in this group')
      await audit(d, req, { action: 'group.member_removed', type: 'group', id: g.id, name: g.displayName, before: { member: gone.email } })
    })
    reply.code(204).send()
  })

  // ── owners (groups made here) ──
  app.post('/groups/:id/owners', { schema: { tags: T, summary: 'Make people owners of a group made here (its owners and system administrators)', params: idP,
    body: z.object({ userIds: z.array(uuid).min(1).max(50) }) } }, async req => {
    return tx(async d => {
      const g = await groupFor(d, req.me, req.params.id, true, true)
      if (kindOf(g) !== 'strand') throw new HttpError(400, 'Only groups made in Strand have owners')
      const ok = await d.query<{ id: string; email: string }>(
        'select u.id, u.email from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.active and u.id = any($2::uuid[])', [req.me.workspaceId, req.body.userIds])
      if (ok.length !== new Set(req.body.userIds).size) throw new HttpError(400, 'Owners must be active people in this workspace', { userIds: 'Unknown or deactivated' })
      await d.query(`insert into group_owners (group_id, user_id) select $1, x from unnest($2::uuid[]) x on conflict do nothing`, [g.id, ok.map(u => u.id)])
      await audit(d, req, { action: 'group.owners_added', type: 'group', id: g.id, name: g.displayName, after: { owners: ok.map(u => u.email) } })
      return shape(req.me)((await d.query<any>(`${ROW} where g.id = $2`, [req.me.id, g.id]))[0])
    })
  })
  app.delete('/groups/:id/owners/:userId', { schema: { tags: T, summary: 'Stop someone owning a group (its owners and system administrators). A group keeps at least one owner unless a system administrator removes the last', params: idP.extend({ userId: uuid }) } }, async (req, reply) => {
    await tx(async d => {
      const g = await groupFor(d, req.me, req.params.id, true, true)
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from group_owners where group_id = $1', [g.id]) as any
      if (n <= 1 && !req.me.admin) throw new HttpError(409, 'A group needs an owner: add another owner first, or delete the group')
      const [gone] = await d.query<{ email: string }>(`with del as (delete from group_owners where group_id = $1 and user_id = $2 returning user_id)
                                                       select u.email from del join users u on u.id = del.user_id`, [g.id, req.params.userId])
      if (!gone) throw new HttpError(404, 'They don’t own this group')
      await audit(d, req, { action: 'group.owner_removed', type: 'group', id: g.id, name: g.displayName, before: { owner: gone.email } })
    })
    reply.code(204).send()
  })
}

/** A project must keep an admin: refuse a change to a group (deleting it, or taking `userId` out) that would leave a project
 *  it administers with nobody who can administer it. */
async function guardProjectAdmins(d: Db, groupId: string, userId: string | null) {
  const stuck = await d.query<{ key: string }>(
    `select p.key from project_group_roles pg join projects p on p.id = pg.project_id
      where pg.group_id = $1 and pg.role = 'admin' and p.deleting_at is null
        and not exists (
          select 1 from project_access pa where pa.project_id = p.id and pa.role = 'admin' and (
            case when $2::uuid is not null then pa.user_id <> $2::uuid             -- one person leaves: anyone else still an admin there
            else exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = pa.user_id and pm.role = 'admin')
              or exists (select 1 from project_group_roles g2 join group_members gm on gm.group_id = g2.group_id
                          where g2.project_id = p.id and g2.role = 'admin' and gm.user_id = pa.user_id and g2.group_id <> $1)
            end))`,
    [groupId, userId])
  if (stuck.length) throw new HttpError(409, `${stuck.map(s => s.key).join(', ')} would have no admin left: give someone else the admin role there first`)
}

export default plugin
