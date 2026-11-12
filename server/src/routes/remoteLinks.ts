// Remote links (spec 0507), as Jira's web links and remote issue links: the app's API, and Jira's at
// /rest/api/2/issue/{key}/remotelink for apps that add them. Link issues to change them; Browse projects to read them.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { issueByKey } from './issues.ts'
import { emit } from '../webhooks.ts'

const httpUrl = z.string().trim().max(2000).refine(u => { try { return ['http:', 'https:'].includes(new URL(u).protocol) } catch { return false } }, 'An http or https address')
const icon = z.object({ url16x16: httpUrl.optional(), title: z.string().max(255).optional(), link: httpUrl.optional() }).partial()
/** Jira's remote link body. */
const jiraLink = z.object({
  globalId: z.string().max(255).optional(), application: z.object({ type: z.string().max(255).optional(), name: z.string().max(255).optional() }).optional(),
  relationship: z.string().max(255).optional(),
  object: z.object({ url: httpUrl, title: z.string().trim().min(1).max(255), summary: z.string().max(2000).optional(), icon: icon.optional(),
    status: z.object({ resolved: z.boolean().optional(), icon: icon.optional() }).optional() }),
})
type JiraLink = z.infer<typeof jiraLink>
/** The app's web link body (a URL and its text, or Jira's whole shape). */
const webLink = z.object({ url: httpUrl, title: z.string().trim().min(1).max(255), globalId: z.string().max(255).optional(), relationship: z.string().max(255).optional(),
  summary: z.string().max(2000).optional() })

const ROW = 'select id, issue_id, global_id, url, title, summary, relationship, application, icon, status, created_by, created_at, updated_at from remote_links'
/** A link as Jira's REST returns it. */
const asJira = (r: any) => ({
  id: r.id, self: null, globalId: r.globalId ?? undefined, ...(r.application ? { application: r.application } : {}), ...(r.relationship ? { relationship: r.relationship } : {}),
  object: { url: r.url, title: r.title, ...(r.summary ? { summary: r.summary } : {}), ...(r.icon ? { icon: r.icon } : {}), ...(r.status ? { status: r.status } : {}) },
})

/** Adds a link, or replaces the one with the same global id (Jira's upsert). History and Jira's issue_updated record it. */
async function save(d: Db, me: Me, issue: { id: string; projectId: string }, l: JiraLink, id?: string) {
  const vals = [l.globalId ?? null, l.object.url, l.object.title, l.object.summary ?? null, l.relationship ?? null, l.application ? JSON.stringify(l.application) : null,
    l.object.icon ? JSON.stringify(l.object.icon) : null, l.object.status ? JSON.stringify(l.object.status) : null]
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Web link not found')
  const [same] = id ? await d.query<{ id: string; title: string }>('select id, title from remote_links where id = $1 and issue_id = $2', [id, issue.id])
    : l.globalId ? await d.query<{ id: string; title: string }>('select id, title from remote_links where issue_id = $1 and global_id = $2', [issue.id, l.globalId]) : []
  if (id && !same) throw new HttpError(404, 'Web link not found')
  let row: any
  if (same) [row] = await d.query(`update remote_links set global_id = $2, url = $3, title = $4, summary = $5, relationship = $6, application = $7, icon = $8, status = $9, updated_at = now() where id = $1 returning *`, [same.id, ...vals])
  else [row] = await d.query(`insert into remote_links (issue_id, global_id, url, title, summary, relationship, application, icon, status, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`, [issue.id, ...vals, me.id])
  await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
    [issue.id, me.id, 'remoteLink', same?.title ?? null, l.object.title, same ? `Changed the web link “${l.object.title}”` : `Added the web link “${l.object.title}”`])
  await d.query('update issues set updated_at = now(), version = version + 1 where id = $1', [issue.id])
  await emit(d, me.workspaceId, 'jira:issue_updated', { issueId: issue.id, projectId: issue.projectId }, me.id, [{ field: 'RemoteIssueLink', from: same?.id ?? null, to: row.id }])
  return row
}
async function remove(d: Db, me: Me, issue: { id: string; projectId: string }, where: { id?: string; globalId?: string }) {
  if (where.id && !/^[0-9a-f-]{36}$/i.test(where.id)) throw new HttpError(404, 'Web link not found')
  const [gone] = await d.query<{ id: string; title: string }>(
    `delete from remote_links where issue_id = $1 and ${where.id ? 'id = $2' : 'global_id = $2'} returning id, title`, [issue.id, where.id ?? where.globalId])
  if (!gone) throw new HttpError(404, 'Web link not found')
  await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, null, $5)', [issue.id, me.id, 'remoteLink', gone.title, `Removed the web link “${gone.title}”`])
  await d.query('update issues set updated_at = now(), version = version + 1 where id = $1', [issue.id])
  await emit(d, me.workspaceId, 'jira:issue_updated', { issueId: issue.id, projectId: issue.projectId }, me.id, [{ field: 'RemoteIssueLink', from: gone.id, to: null }])
}
const list = async (issueId: string) => db.query(`${ROW} where issue_id = $1 order by created_at desc limit 200`, [issueId])
const toJira = (b: z.infer<typeof webLink>): JiraLink => ({ globalId: b.globalId, relationship: b.relationship, object: { url: b.url, title: b.title, summary: b.summary } })

const keyP = z.object({ key: z.string() }), keyIdP = keyP.extend({ id: z.string().uuid() })
const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Links & watchers']
  app.get('/issues/:key/remote-links', { schema: { tags: T, summary: 'An item’s web links, newest first', params: keyP } }, async req => list((await issueByKey(db, req, req.params.key, false, 'browse')).id))
  app.post('/issues/:key/remote-links', { schema: { tags: T, summary: 'Add a web link (a URL and its text); a global id already on the item updates that link', params: keyP, body: webLink } }, async (req, reply) => {
    const r = await tx(async d => save(d, req.me, await issueByKey(d, req, req.params.key, false, 'linkIssues'), toJira(req.body)))
    reply.code(201); return r
  })
  app.put('/issues/:key/remote-links/:id', { schema: { tags: T, summary: 'Change a web link', params: keyIdP, body: webLink } }, async req =>
    tx(async d => save(d, req.me, await issueByKey(d, req, req.params.key, false, 'linkIssues'), toJira(req.body), req.params.id)))
  app.delete('/issues/:key/remote-links/:id', { schema: { tags: T, summary: 'Remove a web link', params: keyIdP } }, async (req, reply) => {
    await tx(async d => remove(d, req.me, await issueByKey(d, req, req.params.key, false, 'linkIssues'), { id: req.params.id }))
    reply.code(204).send()
  })
}
export default plugin

/** Jira's REST (spec 0507 R2), registered at /rest/api/2. */
export const jiraRemoteLinks: FastifyPluginAsyncZod = async app => {
  const hide = { hide: true } as any
  app.get('/issue/:key/remotelink', { schema: { ...hide, querystring: z.object({ globalId: z.string().optional() }) } }, async req => {
    const i = await issueByKey(db, req, (req.params as any).key, false, 'browse')
    const g = (req.query as any).globalId as string | undefined
    if (g) { const [r] = await db.query(`${ROW} where issue_id = $1 and global_id = $2`, [i.id, g]); if (!r) throw new HttpError(404, 'Remote link not found'); return asJira(r) }
    return (await list(i.id)).map(asJira)
  })
  app.get('/issue/:key/remotelink/:id', { schema: hide }, async req => {
    const i = await issueByKey(db, req, (req.params as any).key, false, 'browse')
    const [r] = await db.query(`${ROW} where issue_id = $1 and id::text = $2`, [i.id, (req.params as any).id])
    if (!r) throw new HttpError(404, 'Remote link not found')
    return asJira(r)
  })
  app.post('/issue/:key/remotelink', { schema: { ...hide, body: jiraLink } }, async (req, reply) => {
    const r = await tx(async d => save(d, req.me, await issueByKey(d, req, (req.params as any).key, false, 'linkIssues'), req.body as JiraLink))
    reply.code(201); return { id: r.id, self: null }
  })
  app.put('/issue/:key/remotelink/:id', { schema: { ...hide, body: jiraLink } }, async (req, reply) => {
    await tx(async d => save(d, req.me, await issueByKey(d, req, (req.params as any).key, false, 'linkIssues'), req.body as JiraLink, (req.params as any).id))
    reply.code(204).send()
  })
  app.delete('/issue/:key/remotelink', { schema: { ...hide, querystring: z.object({ globalId: z.string().min(1) }) } }, async (req, reply) => {
    await tx(async d => remove(d, req.me, await issueByKey(d, req, (req.params as any).key, false, 'linkIssues'), { globalId: (req.query as any).globalId }))
    reply.code(204).send()
  })
  app.delete('/issue/:key/remotelink/:id', { schema: hide }, async (req, reply) => {
    await tx(async d => remove(d, req.me, await issueByKey(d, req, (req.params as any).key, false, 'linkIssues'), { id: (req.params as any).id }))
    reply.code(204).send()
  })
}
