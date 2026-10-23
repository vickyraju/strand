import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { need } from '../access.ts'
import { audit } from '../audit.ts'
import { projectByKey } from './projects.ts'

// Who is in a project and what they may do there (Jira's "Access" page). One role per person:
//   admin  - project settings, workflow and people; delete any work
//   member - create, edit, comment on and move work
//   viewer - see the project and comment
// Workspace owners and admins see and administer every project without being listed here.
const TAG = ['Project people']
const role = z.enum(['admin', 'member', 'viewer'])
const keyP = z.object({ key: z.string().describe('Project key (PAY) or id (uuid)') })
const memberP = keyP.extend({ userId: z.string().uuid() })

const list = (d: Db, projectId: string) => d.query(
  `select u.id as user_id, u.name, u.email, u.initials, u.color, u.title, pm.role, pm.added_at
     from project_members pm join users u on u.id = pm.user_id
    where pm.project_id = $1 and u.active order by lower(u.name), u.id`, [projectId])

const emailOf = async (d: Db, userId: string) => (await d.query<{ email: string }>('select email from users where id = $1', [userId]))[0]?.email ?? null

/** A project must keep at least one admin. Call inside a transaction that already holds the project row. */
async function keepAnAdmin(d: Db, projectId: string, leaving: string) {
  const [{ n }] = await d.query<{ n: number }>(
    `select count(*)::int as n from project_members pm join users u on u.id = pm.user_id
      where pm.project_id = $1 and pm.role = 'admin' and pm.user_id <> $2 and u.active`, [projectId, leaving]) as any
  if (!n) throw new HttpError(409, 'A project needs at least one admin. Make someone else an admin first.')
}

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/projects/:key/members', { schema: { tags: TAG, summary: 'People in the project and their roles (workspace admins, who can see every project, are not listed)', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return list(db, p.id)
  })

  app.post('/projects/:key/members', { schema: {
    tags: TAG, summary: 'Add people to the project with a role (project admins only). Someone already in the project keeps their current role',
    params: keyP, body: z.object({ userIds: z.array(z.string().uuid()).min(1).max(100), role }),
  } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    need(p.role, 'admin')
    const ids = [...new Set(req.body.userIds)]
    return tx(async d => {
      const ok = await d.query<{ id: string }>(
        `select u.id from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.active and u.id = any($2::uuid[])`, [req.me.workspaceId, ids])
      if (ok.length !== ids.length) throw new HttpError(400, 'Everyone you add must be an active member of the workspace')
      for (const u of ids) {
        const [added] = await d.query<{ email: string }>(
          `with ins as (insert into project_members (project_id, user_id, role, added_by) values ($1, $2, $3, $4) on conflict do nothing returning user_id)
           select u.email from ins join users u on u.id = ins.user_id`, [p.id, u, req.body.role, req.me.id])
        if (added) await audit(d, req, { action: 'project.member.added', type: 'member', id: u, name: added.email, project: p, after: { role: req.body.role } })
      }
      return list(d, p.id)
    })
  })

  app.patch('/projects/:key/members/:userId', { schema: { tags: TAG, summary: 'Change someone\'s role (project admins only)', params: memberP, body: z.object({ role }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    need(p.role, 'admin')
    return tx(async d => {
      await d.query('select id from projects where id = $1 for update', [p.id])
      const [cur] = await d.query<{ role: string }>('select role from project_members where project_id = $1 and user_id = $2', [p.id, req.params.userId])
      if (!cur) throw new HttpError(404, 'That person is not in this project')
      if (cur.role === 'admin' && req.body.role !== 'admin') await keepAnAdmin(d, p.id, req.params.userId)
      await d.query('update project_members set role = $3 where project_id = $1 and user_id = $2', [p.id, req.params.userId, req.body.role])
      if (cur.role !== req.body.role) await audit(d, req, { action: 'project.member.role_changed', type: 'member', id: req.params.userId, name: await emailOf(d, req.params.userId), project: p, before: { role: cur.role }, after: { role: req.body.role } })
      return (await list(d, p.id)).find((m: any) => m.userId === req.params.userId)
    })
  })

  app.delete('/projects/:key/members/:userId', { schema: { tags: TAG, summary: 'Remove someone from the project (project admins), or leave it yourself', params: memberP } }, async (req, reply) => {
    const leaving = req.params.userId === req.me.id
    const p = await projectByKey(db, req, req.params.key, leaving ? 'viewer' : 'admin')
    await tx(async d => {
      await d.query('select id from projects where id = $1 for update', [p.id])
      const [cur] = await d.query<{ role: string }>('select role from project_members where project_id = $1 and user_id = $2', [p.id, req.params.userId])
      if (!cur) throw new HttpError(404, 'That person is not in this project')
      if (cur.role === 'admin') await keepAnAdmin(d, p.id, req.params.userId)
      await d.query('delete from project_members where project_id = $1 and user_id = $2', [p.id, req.params.userId])
      await audit(d, req, { action: leaving ? 'project.member.left' : 'project.member.removed', type: 'member', id: req.params.userId, name: await emailOf(d, req.params.userId), project: p, before: { role: cur.role } })
      // They can no longer see the project: its stars and "recently viewed" entries go with their access
      await d.query('delete from stars where project_id = $1 and user_id = $2', [p.id, req.params.userId])
      await d.query('delete from issue_views where user_id = $2 and issue_id in (select id from issues where project_id = $1)', [p.id, req.params.userId])
    })
    reply.code(204).send()
  })
}

export default plugin
