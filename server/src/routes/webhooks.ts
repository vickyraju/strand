// Administration › Webhooks (spec 0705): system administrators, signed in themselves. A webhook's secret is shown when it
// is made or regenerated, never again.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError, requireAdmin } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { kickJobs } from '../jobs.ts'
import { seal } from '../secrets.ts'
import { checkQueries } from '../boards.ts'
import { EVENTS, forgetWebhookCache, newSecret, queueCall, urlProblem } from '../webhooks.ts'
import { requireNoToken } from './authentication.ts'

const T = ['Webhooks']
const idP = z.object({ id: z.string().uuid() })
const body = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(''),
  url: z.string().trim().min(8).max(2000).describe('https://…; {issue.key}, {project.key}, {sprint.id}, {version.id}, {board.id}, {modifiedUser.name} are filled in'),
  events: z.array(z.enum(EVENTS)).max(EVENTS.length).default([]).describe('Jira’s event names; empty: every event'),
  jql: z.string().trim().max(2000).nullable().default(null).describe('Limits issue, comment, work log and link events to matching items'),
  excludeBody: z.boolean().default(false), enabled: z.boolean().default(true),
})
const VIEW = `select w.id, w.name, w.description, w.url, w.events, w.jql, w.exclude_body, w.enabled, w.created_at, w.updated_at,
  (select jsonb_build_object('event', c.event, 'state', c.state, 'statusCode', c.status_code, 'at', c.created_at) from webhook_calls c where c.webhook_id = w.id order by c.created_at desc limit 1) as last_call
  from webhooks w`

const plugin: FastifyPluginAsyncZod = async app => {
  const check = async (req: any, b: z.infer<typeof body>) => {
    const p = urlProblem(b.url)
    if (p) throw new HttpError(400, p, { url: p })
    if (b.jql) await checkQueries(db, req.me, { jql: b.jql, quickFilters: [], swimlanes: { by: 'none' } })   // a mistake says where (R4)
  }
  const one = async (ws: string, id: string) => {
    const [w] = await db.query(`${VIEW} where w.workspace_id = $1 and w.id = $2`, [ws, id])
    if (!w) throw new HttpError(404, 'Webhook not found')
    return w
  }

  app.get('/admin/webhooks', { schema: { tags: T, summary: 'Webhooks, with each one’s last call (system administrators)' } }, async req => {
    requireNoToken(req)
    return db.query(`${VIEW} where w.workspace_id = $1 order by lower(w.name)`, [req.me.workspaceId])
  })
  app.get('/admin/webhooks/:id', { schema: { tags: T, summary: 'One webhook (its secret is never shown again)', params: idP } }, async req => {
    requireNoToken(req)
    return one(req.me.workspaceId, req.params.id)
  })
  app.post('/admin/webhooks', { schema: { tags: T, summary: 'Add a webhook; the answer carries its signing secret, shown this once', body } }, async (req, reply) => {
    requireNoToken(req)
    const b = req.body
    await check(req, b)
    const secret = newSecret()
    const id = await tx(async d => {
      const [w] = await d.query<{ id: string }>(
        `insert into webhooks (workspace_id, name, description, url, events, jql, exclude_body, enabled, secret_enc, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, '\\x00', $9) returning id`,
        [req.me.workspaceId, b.name, b.description, b.url, b.events, b.jql || null, b.excludeBody, b.enabled, req.me.id])
      await d.query('update webhooks set secret_enc = $2 where id = $1', [w!.id, seal(secret, w!.id)])
      await audit(d, req, { action: 'webhook.created', type: 'webhook', id: w!.id, name: b.name, after: { url: b.url, events: b.events, jql: b.jql, excludeBody: b.excludeBody, enabled: b.enabled } })
      return w!.id
    })
    forgetWebhookCache()
    reply.code(201)
    return { ...(await one(req.me.workspaceId, id)), secret }
  })
  app.put('/admin/webhooks/:id', { schema: { tags: T, summary: 'Change a webhook', params: idP, body } }, async req => {
    requireNoToken(req)
    const b = req.body
    await check(req, b)
    await tx(async d => {
      const [before] = await d.query<any>('select name, description, url, events, jql, exclude_body, enabled from webhooks where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!before) throw new HttpError(404, 'Webhook not found')
      await d.query('update webhooks set name = $2, description = $3, url = $4, events = $5, jql = $6, exclude_body = $7, enabled = $8, updated_at = now() where id = $1',
        [req.params.id, b.name, b.description, b.url, b.events, b.jql || null, b.excludeBody, b.enabled])
      const c = changes(before, { ...b, jql: b.jql || null })
      if (c.changed) await audit(d, req, { action: 'webhook.updated', type: 'webhook', id: req.params.id, name: b.name, before: c.before, after: c.after })
    })
    forgetWebhookCache()
    return one(req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/webhooks/:id', { schema: { tags: T, summary: 'Remove a webhook and its calls', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    await tx(async d => {
      const [w] = await d.query<{ name: string }>('delete from webhooks where id = $1 and workspace_id = $2 returning name', [req.params.id, req.me.workspaceId])
      if (!w) throw new HttpError(404, 'Webhook not found')
      await audit(d, req, { action: 'webhook.deleted', type: 'webhook', id: req.params.id, name: w.name })
    })
    forgetWebhookCache()
    reply.code(204).send()
  })
  app.post('/admin/webhooks/:id/secret', { schema: { tags: T, summary: 'A new signing secret, shown this once; the old one stops at once', params: idP } }, async req => {
    requireNoToken(req)
    const w = await one(req.me.workspaceId, req.params.id)
    const secret = newSecret()
    await tx(async d => {
      await d.query('update webhooks set secret_enc = $2, updated_at = now() where id = $1', [req.params.id, seal(secret, req.params.id)])
      await audit(d, req, { action: 'webhook.secret_regenerated', type: 'webhook', id: req.params.id, name: w.name })
    })
    return { secret }
  })
  app.post('/admin/webhooks/:id/test', { schema: { tags: T, summary: 'Send a ping now (even when the webhook is disabled)', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    const w = await one(req.me.workspaceId, req.params.id)
    const callId = await tx(d => queueCall(d, { id: w.id, workspaceId: req.me.workspaceId, url: w.url, excludeBody: w.excludeBody }, 'ping',
      { webhookEvent: 'ping', timestamp: Date.now(), user: { name: req.me.email, displayName: req.me.name, emailAddress: req.me.email } }))
    kickJobs(app.log)
    reply.code(202)
    return { callId }
  })
  app.get('/admin/webhooks/:id/calls', { schema: { tags: T, summary: 'The webhook’s last 50 calls, newest first', params: idP } }, async req => {
    requireNoToken(req)
    await one(req.me.workspaceId, req.params.id)
    return db.query('select id, event, delivery_id, url, state, attempts, status_code, error, created_at, finished_at from webhook_calls where webhook_id = $1 order by created_at desc limit 50', [req.params.id])
  })
  app.post('/admin/webhooks/:id/calls/:callId/redeliver', { schema: { tags: T, summary: 'Send a call again, as it was', params: idP.extend({ callId: z.string().uuid() }) } }, async (req, reply) => {
    requireNoToken(req)
    const w = await one(req.me.workspaceId, req.params.id)
    const [c] = await db.query<{ event: string; body: any }>('select event, body from webhook_calls where id = $1 and webhook_id = $2', [req.params.callId, w.id])
    if (!c) throw new HttpError(404, 'Call not found')
    const callId = await tx(d => queueCall(d, { id: w.id, workspaceId: req.me.workspaceId, url: w.url, excludeBody: w.excludeBody }, c.event as any, c.body ?? { webhookEvent: c.event, timestamp: Date.now() }))
    kickJobs(app.log)
    reply.code(202)
    return { callId }
  })
}

export default plugin

// —— Jira's own webhook REST (spec 0715 R7): /rest/webhooks/1.0/webhook, in Jira 9's shape and Jira 10's, so integrations that
// register their webhooks themselves keep working. System administrators, with an access token too (Jira's admins use basic auth).
const jiraBody = z.object({
  name: z.string().trim().min(1).max(100), url: z.string().trim().min(8).max(2000), events: z.array(z.enum(EVENTS)).max(EVENTS.length).default([]),
  filters: z.object({ 'issue-related-events-section': z.string().max(2000).optional() }).partial().optional(),
  excludeBody: z.boolean().optional(), excludeIssueDetails: z.boolean().optional(), enabled: z.boolean().optional(), active: z.boolean().optional(),
  configuration: z.object({ FILTERS: z.string().max(2000).optional(), DESCRIPTION: z.string().max(1000).optional(), EXCLUDE_BODY: z.string().optional() }).partial().optional(),
  description: z.string().max(1000).optional(),
}).passthrough()
/** Jira's request, either version, as Strand's webhook. */
const fromJira = (b: z.infer<typeof jiraBody>) => ({
  name: b.name, url: b.url, events: b.events, description: b.configuration?.DESCRIPTION ?? b.description ?? '',
  jql: (b.configuration?.FILTERS ?? b.filters?.['issue-related-events-section'] ?? '').trim() || null,
  excludeBody: b.configuration?.EXCLUDE_BODY !== undefined ? b.configuration.EXCLUDE_BODY === 'true' : b.excludeBody ?? b.excludeIssueDetails ?? false,
  enabled: b.active ?? b.enabled ?? true,
})
/** Strand's webhook as Jira returns it (both versions' fields). */
const asJira = (w: any) => ({
  self: null, id: w.id, name: w.name, url: w.url, events: w.events, excludeBody: w.excludeBody, filters: { 'issue-related-events-section': w.jql ?? '' },
  enabled: w.enabled, active: w.enabled, configuration: { FILTERS: w.jql ?? '', DESCRIPTION: w.description ?? '', EXCLUDE_BODY: String(w.excludeBody) },
  lastUpdatedUser: w.byKey ?? null, lastUpdatedDisplayName: w.byName ?? null, lastUpdated: new Date(w.updatedAt).getTime(),
})
const JIRA_VIEW = `select w.id, w.name, w.description, w.url, w.events, w.jql, w.exclude_body, w.enabled, w.updated_at, coalesce(u.username, u.email) as by_key, u.name as by_name
  from webhooks w left join users u on u.id = w.created_by`

export const jiraRest: FastifyPluginAsyncZod = async app => {
  const hide = { hide: true } as any
  const check = async (req: any, b: ReturnType<typeof fromJira>) => {
    const p = urlProblem(b.url)
    if (p) throw new HttpError(400, p, { url: p })
    if (b.jql) await checkQueries(db, req.me, { jql: b.jql, quickFilters: [], swimlanes: { by: 'none' } })
  }
  const one = async (ws: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Webhook not found')
    const [w] = await db.query(`${JIRA_VIEW} where w.workspace_id = $1 and w.id = $2`, [ws, id])
    if (!w) throw new HttpError(404, 'Webhook not found')
    return asJira(w)
  }
  app.get('/webhook', { schema: hide }, async req => {
    requireAdmin(req)
    return (await db.query(`${JIRA_VIEW} where w.workspace_id = $1 order by lower(w.name)`, [req.me.workspaceId])).map(asJira)
  })
  app.get('/webhook/:id', { schema: hide }, async req => { requireAdmin(req); return one(req.me.workspaceId, (req.params as any).id) })
  app.post('/webhook', { schema: { ...hide, body: jiraBody } }, async (req, reply) => {
    requireAdmin(req)
    const b = fromJira(req.body as z.infer<typeof jiraBody>)
    await check(req, b)
    const secret = newSecret()
    const id = await tx(async d => {
      const [w] = await d.query<{ id: string }>(
        `insert into webhooks (workspace_id, name, description, url, events, jql, exclude_body, enabled, secret_enc, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, '\\x00', $9) returning id`,
        [req.me.workspaceId, b.name, b.description, b.url, b.events, b.jql, b.excludeBody, b.enabled, req.me.id])
      await d.query('update webhooks set secret_enc = $2 where id = $1', [w!.id, seal(secret, w!.id)])
      await audit(d, req, { action: 'webhook.created', type: 'webhook', id: w!.id, name: b.name, after: { url: b.url, events: b.events, jql: b.jql, excludeBody: b.excludeBody, enabled: b.enabled, via: 'Jira REST' } })
      return w!.id
    })
    forgetWebhookCache()
    reply.code(201)
    return { ...(await one(req.me.workspaceId, id)), secret }
  })
  app.put('/webhook/:id', { schema: { ...hide, body: jiraBody } }, async req => {
    requireAdmin(req)
    const id = (req.params as any).id as string
    await one(req.me.workspaceId, id)
    const b = fromJira(req.body as z.infer<typeof jiraBody>)
    await check(req, b)
    await tx(async d => {
      const [before] = await d.query<any>('select name, description, url, events, jql, exclude_body, enabled from webhooks where id = $1 for update', [id])
      await d.query('update webhooks set name = $2, description = $3, url = $4, events = $5, jql = $6, exclude_body = $7, enabled = $8, updated_at = now() where id = $1',
        [id, b.name, b.description, b.url, b.events, b.jql, b.excludeBody, b.enabled])
      const c = changes(before, b)
      if (c.changed) await audit(d, req, { action: 'webhook.updated', type: 'webhook', id, name: b.name, before: c.before, after: { ...c.after, via: 'Jira REST' } })
    })
    forgetWebhookCache()
    return one(req.me.workspaceId, id)
  })
  app.delete('/webhook/:id', { schema: hide }, async (req, reply) => {
    requireAdmin(req)
    const id = (req.params as any).id as string
    const w = await one(req.me.workspaceId, id)
    await tx(async d => {
      await d.query('delete from webhooks where id = $1', [id])
      await audit(d, req, { action: 'webhook.deleted', type: 'webhook', id, name: w.name, after: { via: 'Jira REST' } })
    })
    forgetWebhookCache()
    reply.code(204).send()
  })
}

