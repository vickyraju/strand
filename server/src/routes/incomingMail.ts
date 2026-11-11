// Administration › Incoming mail (spec 0607), as Jira's: mail servers and the handlers that read them. System administrators
// who signed in themselves. A server's password or client secret is write-only: stored sealed, never returned.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { kickJobs } from '../jobs.ts'
import { seal } from '../secrets.ts'
import { mailDir, runHandlerNow, scheduleHandler, testServer, type MailServer } from '../mail.ts'
import { requireNoToken } from './authentication.ts'
import { projectByKey } from './projects.ts'

const T = ['Incoming mail']
const idP = z.object({ id: z.string().uuid() })
const host = z.string().trim().min(1).max(255)
const config = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('imap'), host, port: z.number().int().min(1).max(65535).default(993), secure: z.boolean().default(true), username: z.string().min(1).max(255), folder: z.string().max(255).default('INBOX') }),
  z.object({ kind: z.literal('graph'), tenantId: z.string().min(1).max(100), clientId: z.string().min(1).max(100), mailbox: z.string().email().max(255), folder: z.string().max(255).default('inbox') }),
  z.object({ kind: z.literal('files'), folder: z.string().max(255).default('') }),
])
/** Where the stored secret may go: changing any of these needs it again (as user directories, spec 0712 R3). */
const WHERE = ['kind', 'host', 'port', 'username', 'tenantId', 'clientId', 'mailbox'] as const
const SERVER = `select s.id, s.name, s.kind, s.config, s.secret_enc is not null as has_secret, s.created_at,
  (select count(*)::int from mail_handlers h where h.server_id = s.id) as handlers from mail_servers s`
const HANDLER = `select h.id, h.name, h.kind, h.enabled, h.delay_minutes, h.params, h.server_id, s.name as server_name, h.last_run_at, h.last_result from mail_handlers h join mail_servers s on s.id = h.server_id`

const params = z.object({
  project: z.string().max(100).optional().describe('Project key: where new work items go'), issueType: z.string().max(40).optional().describe('Work type of new items'),
  stripQuotes: z.boolean().optional(), catchEmail: z.string().email().optional().describe('Only email sent to this address (To, Cc or Bcc)'),
  bulk: z.enum(['ignore', 'forward', 'delete', 'accept']).optional().describe('Automatic mail (Precedence: bulk, Auto-Submitted)'), forwardEmail: z.string().email().optional(),
  defaultReporter: z.string().max(255).optional().describe('Email or username of the person used when the sender isn’t in Strand'),
  ccAssignee: z.boolean().optional(), ccWatchers: z.boolean().optional(), splitRegex: z.string().max(500).optional().describe('/regex/: the comment is what comes before it'),
  verifiedSenders: z.boolean().optional().describe('Trust a sender only when the receiving mail server verified them (DMARC or DKIM); on unless false'),
}).strict()
const KINDS = ['create_or_comment', 'comment_non_quoted', 'comment_entire', 'create_each', 'comment_before_marker'] as const
/** The parameters each of Jira's handlers takes (the rest are refused). */
const TAKES: Record<typeof KINDS[number], string[]> = {
  create_or_comment: ['project', 'issueType', 'stripQuotes', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'ccAssignee', 'ccWatchers', 'verifiedSenders'],
  comment_non_quoted: ['catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'verifiedSenders'], comment_entire: ['catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'verifiedSenders'],
  create_each: ['project', 'issueType', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'ccAssignee', 'ccWatchers', 'verifiedSenders'],
  comment_before_marker: ['splitRegex', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'verifiedSenders'],
}

const plugin: FastifyPluginAsyncZod = async app => {
  const guard = (req: { me: Me }) => { requireAdmin(req as any); requireNoToken(req as any) }
  const server = async (d: Db, me: Me, id: string) => {
    const [s] = await d.query<any>(`${SERVER} where s.id = $1 and s.workspace_id = $2`, [id, me.workspaceId])
    if (!s) throw new HttpError(404, 'Mail server not found')
    return s
  }
  const handler = async (d: Db, me: Me, id: string) => {
    const [h] = await d.query<any>(`${HANDLER} where h.id = $1 and h.workspace_id = $2`, [id, me.workspaceId])
    if (!h) throw new HttpError(404, 'Mail handler not found')
    return h
  }
  const checkConfig = (c: z.infer<typeof config>) => { if (c.kind === 'files') mailDir(c.folder) }
  const asServer = (row: { id: string; workspaceId: string; name: string }, c: z.infer<typeof config>, secretEnc: Buffer | null): MailServer =>
    ({ id: row.id, workspaceId: row.workspaceId, name: row.name, kind: c.kind, config: c, secretEnc })

  // —— Mail servers ——
  app.get('/admin/mail-servers', { schema: { tags: T, summary: 'Incoming mail servers (system administrators); secrets are never returned' } }, async req => {
    guard(req); return db.query(`${SERVER} where s.workspace_id = $1 order by lower(s.name)`, [req.me.workspaceId])
  })
  const serverBody = z.object({ name: z.string().trim().min(1).max(100), config, secret: z.string().min(1).max(4096).optional().describe('The IMAP password or the Graph client secret') })
  app.post('/admin/mail-servers', { schema: { tags: T, summary: 'Add a mail server: IMAP, a Microsoft 365 mailbox (Graph), or message files', body: serverBody } }, async (req, reply) => {
    guard(req)
    const b = req.body
    checkConfig(b.config)
    if (b.config.kind !== 'files' && !b.secret) throw new HttpError(400, b.config.kind === 'imap' ? 'Enter the password' : 'Enter the client secret', { secret: 'Required' })
    const s = await tx(async d => {
      const [row] = await d.query<{ id: string }>('insert into mail_servers (workspace_id, name, kind, config) values ($1, $2, $3, $4) returning id',
        [req.me.workspaceId, b.name, b.config.kind, JSON.stringify(b.config)])
      if (b.secret) await d.query('update mail_servers set secret_enc = $2 where id = $1', [row!.id, seal(b.secret, row!.id)])
      await audit(d, req, { action: 'mail_server.created', type: 'mail_server', id: row!.id, name: b.name, after: { ...b.config, ...(b.secret ? { secret: 'set' } : {}) } })
      return server(d, req.me, row!.id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A mail server already has that name', { name: 'Already used' }); throw e })
    reply.code(201); return s
  })
  app.put('/admin/mail-servers/:id', { schema: { tags: T, summary: 'Change a mail server; changing where it connects needs the secret again', params: idP, body: serverBody } }, async req => {
    guard(req)
    const b = req.body
    checkConfig(b.config)
    return tx(async d => {
      const before = await server(d, req.me, req.params.id)
      const was = { kind: before.kind, ...before.config }, now = { ...b.config } as Record<string, unknown>
      if (!b.secret && b.config.kind !== 'files' && WHERE.some(k => was[k] !== now[k])) throw new HttpError(400, 'Enter the secret again: where the server connects changed', { secret: 'Enter it again' })
      await d.query('update mail_servers set name = $2, kind = $3, config = $4 where id = $1', [before.id, b.name, b.config.kind, JSON.stringify(b.config)])
      if (b.secret) await d.query('update mail_servers set secret_enc = $2 where id = $1', [before.id, seal(b.secret, before.id)])
      if (b.config.kind === 'files') await d.query('update mail_servers set secret_enc = null where id = $1', [before.id])
      const c = changes({ name: before.name, ...was }, { name: b.name, ...now })
      if (c.changed || b.secret) await audit(d, req, { action: 'mail_server.updated', type: 'mail_server', id: before.id, name: b.name, before: c.before, after: { ...c.after, ...(b.secret ? { secret: 'changed' } : {}) } })
      return server(d, req.me, before.id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A mail server already has that name', { name: 'Already used' }); throw e })
  })
  app.delete('/admin/mail-servers/:id', { schema: { tags: T, summary: 'Remove a mail server no handler reads', params: idP } }, async (req, reply) => {
    guard(req)
    await tx(async d => {
      const s = await server(d, req.me, req.params.id)
      if (s.handlers) throw new HttpError(409, `${s.handlers} mail handler${s.handlers === 1 ? ' reads' : 's read'} this server: remove ${s.handlers === 1 ? 'it' : 'them'} first`)
      await d.query('delete from mail_servers where id = $1', [s.id])
      await audit(d, req, { action: 'mail_server.deleted', type: 'mail_server', id: s.id, name: s.name })
    })
    reply.code(204).send()
  })
  app.post('/admin/mail-servers/test', { schema: { tags: T, summary: 'Test a mail server: connect, sign in, count unread mail (a saved one’s secret is used when none is given)',
    body: serverBody.partial({ name: true }).extend({ id: z.string().uuid().optional() }) } }, async req => {
    guard(req)
    const b = req.body
    checkConfig(b.config)
    let row = { id: b.id ?? '00000000-0000-0000-0000-000000000000', workspaceId: req.me.workspaceId, name: b.name ?? 'test' }, secretEnc: Buffer | null = null
    if (b.id) {
      const [s] = await db.query<any>('select * from mail_servers where id = $1 and workspace_id = $2', [b.id, req.me.workspaceId])
      if (!s) throw new HttpError(404, 'Mail server not found')
      const was = { kind: s.kind, ...s.config }, now = { ...b.config } as Record<string, unknown>
      if (!b.secret && WHERE.some(k => was[k] !== now[k])) throw new HttpError(400, 'Enter the secret again: where the server connects changed', { secret: 'Enter it again' })
      secretEnc = s.secretEnc
    }
    if (b.secret) secretEnc = seal(b.secret, row.id)
    return testServer(asServer(row, b.config, secretEnc))
  })

  // —— Mail handlers ——
  app.get('/admin/mail-handlers', { schema: { tags: T, summary: 'Mail handlers with their last run (system administrators)' } }, async req => {
    guard(req); return db.query(`${HANDLER} where h.workspace_id = $1 order by lower(h.name)`, [req.me.workspaceId])
  })
  const handlerBody = z.object({ name: z.string().trim().min(1).max(100), serverId: z.string().uuid(), kind: z.enum(KINDS), enabled: z.boolean().default(true),
    delayMinutes: z.number().int().min(1).max(1440).default(1).describe('How often it reads the server'), params })
  const checkHandler = async (d: Db, me: Me, b: z.infer<typeof handlerBody>) => {
    await server(d, me, b.serverId)
    const extra = Object.keys(b.params).filter(k => !TAKES[b.kind].includes(k))
    if (extra.length) throw new HttpError(400, `This handler doesn’t take ${extra.join(', ')}`, { params: `Not for this handler: ${extra.join(', ')}` })
    if (TAKES[b.kind].includes('project')) {
      if (!b.params.project) throw new HttpError(400, 'Choose the project new work items go to', { project: 'Required' })
      const p = await projectByKey(d, { me, method: 'GET' }, b.params.project)
      if (b.params.issueType && !(await d.query('select 1 from work_types where project_id = $1 and key = $2', [p.id, b.params.issueType])).length)
        throw new HttpError(400, `${p.key} has no work type ${b.params.issueType}`, { issueType: 'Not in that project' })
    }
    if (b.params.splitRegex) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(b.params.splitRegex)
      try { if (!m) throw new Error(); new RegExp(m[1]!, m[2]) } catch { throw new HttpError(400, 'The marker is a regular expression between slashes, such as /----\\s*Original Message\\s*----/', { splitRegex: 'Not a /regex/' }) }
    }
  }
  app.post('/admin/mail-handlers', { schema: { tags: T, summary: 'Add a mail handler; it reads its server every few minutes', body: handlerBody } }, async (req, reply) => {
    guard(req)
    const b = req.body
    const h = await tx(async d => {
      await checkHandler(d, req.me, b)
      const [row] = await d.query<{ id: string }>('insert into mail_handlers (workspace_id, server_id, name, kind, enabled, delay_minutes, params) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [req.me.workspaceId, b.serverId, b.name, b.kind, b.enabled, b.delayMinutes, JSON.stringify(b.params)])
      await audit(d, req, { action: 'mail_handler.created', type: 'mail_handler', id: row!.id, name: b.name, after: b })
      if (b.enabled) await scheduleHandler(d, { id: row!.id, workspaceId: req.me.workspaceId, delayMinutes: b.delayMinutes }, true)
      return handler(d, req.me, row!.id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A mail handler already has that name', { name: 'Already used' }); throw e })
    kickJobs(app.log)
    reply.code(201); return h
  })
  app.put('/admin/mail-handlers/:id', { schema: { tags: T, summary: 'Change a mail handler', params: idP, body: handlerBody } }, async req => {
    guard(req)
    const b = req.body
    const h = await tx(async d => {
      const before = await handler(d, req.me, req.params.id)
      await checkHandler(d, req.me, b)
      await d.query('update mail_handlers set server_id = $2, name = $3, kind = $4, enabled = $5, delay_minutes = $6, params = $7 where id = $1',
        [before.id, b.serverId, b.name, b.kind, b.enabled, b.delayMinutes, JSON.stringify(b.params)])
      const c = changes({ name: before.name, serverId: before.serverId, kind: before.kind, enabled: before.enabled, delayMinutes: before.delayMinutes, ...before.params },
        { name: b.name, serverId: b.serverId, kind: b.kind, enabled: b.enabled, delayMinutes: b.delayMinutes, ...b.params })
      if (c.changed) await audit(d, req, { action: 'mail_handler.updated', type: 'mail_handler', id: before.id, name: b.name, before: c.before, after: c.after })
      if (b.enabled && !before.enabled) await scheduleHandler(d, { id: before.id, workspaceId: req.me.workspaceId, delayMinutes: b.delayMinutes }, true)
      return handler(d, req.me, before.id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A mail handler already has that name', { name: 'Already used' }); throw e })
    kickJobs(app.log)
    return h
  })
  app.delete('/admin/mail-handlers/:id', { schema: { tags: T, summary: 'Remove a mail handler', params: idP } }, async (req, reply) => {
    guard(req)
    await tx(async d => {
      const h = await handler(d, req.me, req.params.id)
      await d.query('delete from mail_handlers where id = $1', [h.id])
      await audit(d, req, { action: 'mail_handler.deleted', type: 'mail_handler', id: h.id, name: h.name })
    })
    reply.code(204).send()
  })
  app.post('/admin/mail-handlers/:id/run', { schema: { tags: T, summary: 'Read the server now (the schedule carries on); the result shows on the handler', params: idP } }, async (req, reply) => {
    guard(req)
    const jobId = await tx(async d => runHandlerNow(d, await handler(d, req.me, req.params.id), req.me.id))
    kickJobs(app.log)
    reply.code(202); return { jobId }
  })
}
export default plugin
