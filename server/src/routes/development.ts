import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit } from '../audit.ts'
import { issueByKey } from './issues.ts'
import { requireNoToken } from './authentication.ts'

const keyP = z.object({ key: z.string().describe('Issue key, e.g. PAY-12') })
const idP = z.object({ id: z.string().uuid() })
const T = ['Integrations']

const plugin: FastifyPluginAsyncZod = async app => {
  // Branches, commits and pull requests linked to an issue (what the "Development" panel shows); anyone who can see it (spec 0707 R2)
  app.get('/issues/:key/development', { schema: { tags: T, summary: 'Pull requests, branches and commits linked to an issue', params: keyP } }, async req => {
    const issue = await issueByKey(db, req, req.params.key)
    const rows = await db.query<any>(
      `select e.id, e.kind, e.external_id, e.url, e.title, e.state, e.author, e.branch_from, e.branch_to, e.review_state, e.checks_state, e.payload,
              e.source_updated_at as updated_at, l.closing, r.full_name as repo
         from dev_links l join dev_entities e on e.id = l.entity_id join repositories r on r.id = e.repo_id
        where l.issue_id = $1 and (e.state is distinct from 'deleted') order by e.source_updated_at desc`, [issue.id])
    const pick = (kind: string, limit: number) => rows.filter(r => r.kind === kind).slice(0, limit).map(({ kind, ...r }) => r)
    return { pullRequests: pick('pull_request', 50), branches: pick('branch', 50), commits: pick('commit', 50) }
  })

  // Administration › Development tools (spec 0707 R1): system admins, signed in themselves
  app.get('/admin/development', { schema: { tags: T, summary: 'GitHub accounts, their repositories and the last 50 deliveries (system administrators)' } }, async req => {
    requireNoToken(req)
    const accounts = await db.query<any>(
      `select g.id, g.account_login, g.installation_id, g.status, g.created_at,
              coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'fullName', r.full_name,
                            'projectKeys', (select coalesce(jsonb_agg(p.key order by p.key), '[]') from projects p where p.id = any(r.project_ids))) order by lower(r.full_name))
                          from repositories r where r.integration_id = g.id), '[]') as repositories
         from integrations g where g.workspace_id = $1 and g.provider = 'github' order by g.status = 'pending' desc, lower(g.account_login)`, [req.me.workspaceId])
    const deliveries = await db.query<any>(
      `select delivery_id as id, event, status, error, received_at from webhook_deliveries where provider = 'github' order by received_at desc limit 50`)
    return { receiverPath: '/integrations/github/webhook', secretSet: !!process.env.GITHUB_WEBHOOK_SECRET, accounts, deliveries }
  })

  const account = async (ws: string, id: string) => {
    const [g] = await db.query<{ id: string; accountLogin: string; status: string }>('select id, account_login, status from integrations where workspace_id = $1 and id = $2', [ws, id])
    if (!g) throw new HttpError(404, 'Account not found')
    return g
  }
  app.put('/admin/development/accounts/:id', { schema: { tags: T, summary: 'Connect (active) or pause (suspended) a GitHub account', params: idP,
    body: z.object({ status: z.enum(['active', 'suspended']) }) } }, async (req, reply) => {
    requireNoToken(req)
    const g = await account(req.me.workspaceId, req.params.id)
    if (g.status !== req.body.status) await tx(async d => {
      await d.query('update integrations set status = $2 where id = $1', [g.id, req.body.status])
      await audit(d, req, { action: g.status === 'pending' ? 'development.connected' : 'development.updated', type: 'integration', id: g.id, name: g.accountLogin,
        before: { status: g.status }, after: { status: req.body.status } })
    })
    return reply.code(204).send()
  })
  app.delete('/admin/development/accounts/:id', { schema: { tags: T, summary: 'Remove a GitHub account and everything it sent', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    const g = await account(req.me.workspaceId, req.params.id)
    await tx(async d => {
      await d.query('delete from integrations where id = $1', [g.id])          // its repositories, records and links go with it
      await audit(d, req, { action: 'development.removed', type: 'integration', id: g.id, name: g.accountLogin })
    })
    return reply.code(204).send()
  })
  app.put('/admin/development/repositories/:id', { schema: { tags: T, summary: 'Limit a repository to some projects, by key (empty: any project)', params: idP,
    body: z.object({ projectKeys: z.array(z.string().trim().min(1).max(20)).max(1000) }) } }, async (req, reply) => {
    requireNoToken(req)
    const [r] = await db.query<{ id: string; fullName: string; projectIds: string[] }>(
      `select r.id, r.full_name, r.project_ids from repositories r join integrations g on g.id = r.integration_id where g.workspace_id = $1 and r.id = $2`, [req.me.workspaceId, req.params.id])
    if (!r) throw new HttpError(404, 'Repository not found')
    const keys = [...new Set(req.body.projectKeys.map(k => k.toUpperCase()))]
    const known = await db.query<{ id: string; key: string }>('select id, key from projects where workspace_id = $1 and key = any($2::text[])', [req.me.workspaceId, keys])
    const unknown = keys.filter(k => !known.some(p => p.key === k))
    if (unknown.length) throw new HttpError(400, `No project with the key ${unknown.join(', ')}`, { projectKeys: `Unknown: ${unknown.join(', ')}` })
    await tx(async d => {
      await d.query('update repositories set project_ids = $2 where id = $1', [r.id, known.map(p => p.id)])
      await audit(d, req, { action: 'development.updated', type: 'repository', id: r.id, name: r.fullName, before: { projectIds: r.projectIds }, after: { projectKeys: keys } })
    })
    return reply.code(204).send()
  })
}
export default plugin
