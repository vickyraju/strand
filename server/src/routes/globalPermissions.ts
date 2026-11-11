// Global permissions (spec 0717), as Jira's: granted to groups. System administrators always include the
// system-administrators group; the others start with the default users group, so nothing changes until narrowed.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { requireNoToken } from './authentication.ts'

export const GLOBAL_PERMISSIONS = {
  'system-admin': 'System administrators',
  'browse-users': 'Browse users and groups',
  'shared-objects': 'Create shared objects',
  'group-subscriptions': 'Manage group filter subscriptions',
  'bulk-change': 'Bulk change',
} as const
export type GlobalPermission = keyof typeof GLOBAL_PERMISSIONS

/** The global permissions I hold: all of them as a system administrator, else those granted to a group I'm in. */
export async function globalPermissions(me: Me, d: Db = db): Promise<GlobalPermission[]> {
  if (me.admin) return Object.keys(GLOBAL_PERMISSIONS) as GlobalPermission[]
  return (await d.query<{ permission: GlobalPermission }>(
    `select distinct gp.permission from global_permissions gp join group_members gm on gm.group_id = gp.group_id where gp.workspace_id = $1 and gm.user_id = $2`,
    [me.workspaceId, me.id])).map(r => r.permission)
}
export async function hasGlobal(me: Me, p: GlobalPermission, d: Db = db) {
  return me.admin || (await d.query(`select 1 from global_permissions gp join group_members gm on gm.group_id = gp.group_id
    where gp.workspace_id = $1 and gp.permission = $2 and gm.user_id = $3 limit 1`, [me.workspaceId, p, me.id])).length > 0
}
/** Refuses unless I hold `p`, naming it (Jira's wording). */
export async function needGlobal(me: Me, p: GlobalPermission, d: Db = db) {
  if (!(await hasGlobal(me, p, d))) throw new HttpError(403, `You need the ${GLOBAL_PERMISSIONS[p]} global permission (Administration › Global permissions)`)
}

const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Global permissions']
  app.get('/admin/global-permissions', { schema: { tags: T, summary: 'Every global permission and the groups it is granted to (system administrators)' } }, async req => {
    requireAdmin(req)
    const grants = await db.query<{ id: string; permission: GlobalPermission; groupId: string; groupName: string }>(
      `select gp.id, gp.permission, g.id as group_id, g.display_name as group_name from global_permissions gp join groups g on g.id = gp.group_id
        where gp.workspace_id = $1 order by lower(g.display_name)`, [req.me.workspaceId])
    const [sys] = await db.query<{ id: string; displayName: string }>(`select id, display_name from groups where system_role = 'system-admins'`)
    return (Object.entries(GLOBAL_PERMISSIONS) as [GlobalPermission, string][]).map(([key, name]) => ({
      key, name,
      groups: [...(key === 'system-admin' && sys ? [{ id: null, groupId: sys.id, groupName: sys.displayName, fixed: true }] : []),
        ...grants.filter(g => g.permission === key).map(g => ({ id: g.id, groupId: g.groupId, groupName: g.groupName, fixed: false }))],
    }))
  })
  app.post('/admin/global-permissions', { schema: { tags: T, summary: 'Grant a global permission to a group (system administrators)',
    body: z.object({ permission: z.enum(Object.keys(GLOBAL_PERMISSIONS) as [GlobalPermission, ...GlobalPermission[]]), groupId: z.string().uuid() }) } }, async (req, reply) => {
    requireNoToken(req)                                                   // who administers Strand: not from a script's token
    const { permission, groupId } = req.body
    const row = await tx(async d => {
      const [g] = await d.query<{ id: string; displayName: string; systemRole: string | null }>('select id, display_name, system_role from groups where id = $1', [groupId])
      if (!g) throw new HttpError(400, 'No such group', { groupId: 'Unknown group' })
      if (permission === 'system-admin' && g.systemRole === 'system-admins') throw new HttpError(409, `${g.displayName} always has System administrators`)
      const [r] = await d.query<{ id: string }>('insert into global_permissions (workspace_id, permission, group_id) values ($1, $2, $3) on conflict do nothing returning id', [req.me.workspaceId, permission, groupId])
      if (!r) throw new HttpError(409, `${g.displayName} already has ${GLOBAL_PERMISSIONS[permission]}`)
      await audit(d, req, { action: 'global_permission.granted', type: 'group', id: g.id, name: g.displayName, after: { permission: GLOBAL_PERMISSIONS[permission] } })
      return r
    })
    reply.code(201); return row
  })
  app.delete('/admin/global-permissions/:id', { schema: { tags: T, summary: 'Take a global permission from a group (system administrators)', params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    requireNoToken(req)
    await tx(async d => {
      const [r] = await d.query<{ permission: GlobalPermission; groupId: string; groupName: string }>(
        `delete from global_permissions gp using groups g where gp.id = $1 and gp.workspace_id = $2 and g.id = gp.group_id returning gp.permission, g.id as group_id, g.display_name as group_name`, [req.params.id, req.me.workspaceId])
      if (!r) throw new HttpError(404, 'No such grant')
      await audit(d, req, { action: 'global_permission.revoked', type: 'group', id: r.groupId, name: r.groupName, before: { permission: GLOBAL_PERMISSIONS[r.permission] } })
    })
    reply.code(204).send()
  })
}
export default plugin
