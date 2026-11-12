// Project categories and avatars (spec 0703), as Jira's: categories are made by system administrators and each project
// has at most one; a project's admins give it an avatar (an uploaded image).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireJiraAdmin } from './globalPermissions.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { imageType } from './lookAndFeel.ts'
import { projectByKey } from './projects.ts'

const T = ['Projects']
const AVATAR_MAX = 128 * 1024
const idP = z.object({ id: z.string().uuid() })
const keyP = z.object({ key: z.string().describe('Project key (PAY) or id (uuid)') })
const body = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default('') })

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/project-categories', { schema: { tags: T, summary: 'Project categories, by name, with how many projects each has (spec 0703)' } }, async req =>
    db.query(`select c.id, c.name, c.description, (select count(*)::int from projects p where p.category_id = c.id and p.deleting_at is null) as projects
                from project_categories c where c.workspace_id = $1 order by lower(c.name)`, [req.me.workspaceId]))

  const taken = async (ws: string, name: string, except: string | null = null) => {
    if ((await db.query('select 1 from project_categories where workspace_id = $1 and lower(name) = lower($2) and id is distinct from $3', [ws, name, except])).length)
      throw new HttpError(409, 'A category with this name already exists', { name: 'Already used' })
  }
  app.post('/admin/project-categories', { schema: { tags: T, summary: 'Add a project category (system administrators)', body } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    await taken(req.me.workspaceId, req.body.name)
    const c = await tx(async d => {
      const [c] = await d.query<{ id: string; name: string; description: string }>('insert into project_categories (workspace_id, name, description) values ($1, $2, $3) returning id, name, description', [req.me.workspaceId, req.body.name, req.body.description])
      await audit(d, req, { action: 'project_category.created', type: 'project_category', id: c!.id, name: c!.name, after: req.body })
      return c!
    })
    reply.code(201)
    return { ...c, projects: 0 }
  })
  app.patch('/admin/project-categories/:id', { schema: { tags: T, summary: 'Rename or describe a project category (system administrators)', params: idP, body: body.partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    if (req.body.name) await taken(req.me.workspaceId, req.body.name, req.params.id)
    return tx(async d => {
      const [before] = await d.query<{ name: string; description: string }>('select name, description from project_categories where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!before) throw new HttpError(404, 'Category not found')
      const after = { name: req.body.name ?? before.name, description: req.body.description ?? before.description }
      await d.query('update project_categories set name = $2, description = $3 where id = $1', [req.params.id, after.name, after.description])
      const c = changes(before, after)
      if (c.changed) await audit(d, req, { action: 'project_category.updated', type: 'project_category', id: req.params.id, name: after.name, before: c.before, after: c.after })
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from projects where category_id = $1 and deleting_at is null', [req.params.id]) as any
      return { id: req.params.id, ...after, projects: n }
    })
  })
  app.delete('/admin/project-categories/:id', { schema: { tags: T, summary: 'Delete a project category: its projects have none afterwards (system administrators)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    await tx(async d => {
      const [c] = await d.query<{ name: string }>('delete from project_categories where id = $1 and workspace_id = $2 returning name', [req.params.id, req.me.workspaceId])
      if (!c) throw new HttpError(404, 'Category not found')
      await audit(d, req, { action: 'project_category.deleted', type: 'project_category', id: req.params.id, name: c.name })
    })
    reply.code(204).send()
  })

  // ── Avatars (R8) ──
  app.put('/projects/:key/avatar', { bodyLimit: 512 * 1024, schema: { tags: T, summary: 'Give the project an avatar: PNG, JPEG or WebP up to 128 KB, base64 (project admins)', params: keyP,
    body: z.object({ image: z.string().max(Math.ceil(AVATAR_MAX * 4 / 3) + 64) }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key, 'administer')
    const data = Buffer.from(req.body.image.replace(/^data:[^,]*,/, ''), 'base64')
    const type = imageType(data)
    if (!type) throw new HttpError(400, 'Use a PNG, JPEG or WebP image', { image: 'Not a PNG, JPEG or WebP image' })
    if (data.length > AVATAR_MAX) throw new HttpError(400, 'The avatar can be at most 128 KB', { image: 'Too large' })
    const [r] = await tx(async d => {
      const r = await d.query<{ avatarHash: string }>('update projects set avatar = $2, avatar_type = $3, avatar_hash = $4 where id = $1 returning avatar_hash', [p.id, data, type, createHash('sha256').update(data).digest('hex')])
      await audit(d, req, { action: 'project.avatar_changed', type: 'project', id: p.id, name: p.key, project: p })
      return r
    })
    return { avatar: `/project-avatars/${p.id}/${r!.avatarHash}` }
  })
  app.delete('/projects/:key/avatar', { schema: { tags: T, summary: 'Remove the project’s avatar: its colour and initial show again (project admins)', params: keyP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key, 'administer')
    await tx(async d => {
      await d.query('update projects set avatar = null, avatar_type = null, avatar_hash = null where id = $1', [p.id])
      await audit(d, req, { action: 'project.avatar_removed', type: 'project', id: p.id, name: p.key, project: p })
    })
    reply.code(204).send()
  })
}

/** No sign-in (an <img> can't send one): an avatar's address is its project's id and the image's own hash, which only
 *  someone who sees the project learns. Anything else is 404. */
export const publicAvatars: FastifyPluginAsyncZod = async app => {
  app.get('/project-avatars/:id/:hash', { schema: { tags: T, summary: 'A project’s avatar image, at the address its project gives', hide: true,
    params: z.object({ id: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) }) } }, async (req, reply) => {
    const [r] = await db.query<{ avatar: Buffer; avatarType: string }>('select avatar, avatar_type from projects where id = $1 and avatar_hash = $2 and avatar is not null', [req.params.id, req.params.hash])
    if (!r) throw new HttpError(404, 'No avatar')
    reply.headers({ 'content-type': r.avatarType, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'public, max-age=31536000, immutable' })
    return reply.send(r.avatar)
  })
}

export default plugin
