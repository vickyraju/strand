// Administration › Jira import (spec 0802): test the connection, start a dry run or an import, and read each run's report.
// System administrators who signed in themselves. The token is write-only: sealed to its run, never returned.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { enqueue, kickJobs } from '../jobs.ts'
import { seal, unseal } from '../secrets.ts'
import { testConnection } from '../jiraImport.ts'
import { requireNoToken } from './authentication.ts'

const T = ['Jira import']
const url = z.string().trim().url().max(500).refine(u => /^https?:\/\//.test(u), 'An http or https address')
const RUN = `select r.id, r.url, r.project_keys, r.dry_run, r.status, r.report, r.created_at, r.finished_at, u.name as created_by_name,
  (select j.progress from jobs j where j.kind = 'jira.import' and j.payload->>'runId' = r.id::text order by j.created_at desc limit 1) as progress
  from jira_imports r left join users u on u.id = r.created_by`

const plugin: FastifyPluginAsyncZod = async app => {
  const guard = (req: { me: Me }) => { requireAdmin(req as any); requireNoToken(req as any) }
  /** The token given, or the last one sealed for this address (so it needn't be typed again). */
  const tokenFor = async (me: Me, address: string, token?: string) => {
    if (token) return token
    const [last] = await db.query<{ id: string; tokenEnc: Buffer }>('select id, token_enc from jira_imports where workspace_id = $1 and url = $2 order by created_at desc limit 1', [me.workspaceId, address])
    if (!last) throw new HttpError(400, 'Enter a personal access token for this Jira', { token: 'Required' })
    return unseal(last.tokenEnc, last.id)
  }
  app.post('/admin/jira-import/test', { schema: { tags: T, summary: 'Test a Jira: its version, and who the token is', body: z.object({ url, token: z.string().min(1).max(4096).optional() }) } }, async req => {
    guard(req)
    try { return { ok: true, ...(await testConnection({ url: req.body.url, token: await tokenFor(req.me, req.body.url, req.body.token) })) } }
    catch (e) { if (e instanceof HttpError) throw e; return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })
  app.get('/admin/jira-imports', { schema: { tags: T, summary: 'Runs, newest first (system administrators)' } }, async req => {
    guard(req); return db.query(`${RUN} where r.workspace_id = $1 order by r.created_at desc limit 50`, [req.me.workspaceId])
  })
  app.get('/admin/jira-imports/:id', { schema: { tags: T, summary: 'A run with its progress and report', params: z.object({ id: z.string().uuid() }) } }, async req => {
    guard(req)
    const [r] = await db.query(`${RUN} where r.id = $1 and r.workspace_id = $2`, [req.params.id, req.me.workspaceId])
    if (!r) throw new HttpError(404, 'Run not found')
    return r
  })
  app.post('/admin/jira-imports', { schema: { tags: T, summary: 'Start a dry run (reads, writes nothing) or an import of these projects', body: z.object({
    url, token: z.string().min(1).max(4096).optional().describe('Left out: the last one given for this address'),
    projectKeys: z.array(z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/, 'A project key')).min(1).max(500), dryRun: z.boolean(),
  }) } }, async (req, reply) => {
    guard(req)
    const b = req.body
    const token = await tokenFor(req.me, b.url, b.token)
    const id = await tx(async d => {
      const [run] = await d.query<{ id: string }>('insert into jira_imports (workspace_id, url, token_enc, project_keys, dry_run, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [req.me.workspaceId, b.url, Buffer.alloc(0), [...new Set(b.projectKeys)], b.dryRun, req.me.id])
      await d.query('update jira_imports set token_enc = $2 where id = $1', [run!.id, seal(token, run!.id)])
      await enqueue(d, 'jira.import', { runId: run!.id }, { workspaceId: req.me.workspaceId, createdBy: req.me.id, maxAttempts: 1 })
      await audit(d, req, { action: b.dryRun ? 'jira_import.dry_run' : 'jira_import.started', type: 'jira_import', id: run!.id, name: b.url, after: { projectKeys: b.projectKeys } })
      return run!.id
    })
    kickJobs(app.log)
    reply.code(202)
    const [r] = await db.query(`${RUN} where r.id = $1`, [id])
    return r
  })
}
export default plugin
