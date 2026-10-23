import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db.ts'
import { issueByKey } from './issues.ts'

const keyP = z.object({ key: z.string().describe('Issue key, e.g. PAY-12') })

const plugin: FastifyPluginAsyncZod = async app => {
  // Branches, commits and pull requests linked to an issue (what the "Development" panel shows)
  app.get('/issues/:key/development', { schema: { tags: ['Integrations'], summary: 'Pull requests, branches and commits linked to an issue', params: keyP } }, async req => {
    const issue = await issueByKey(db, req, req.params.key)
    const rows = await db.query<any>(
      `select e.id, e.kind, e.external_id, e.url, e.title, e.state, e.author, e.branch_from, e.branch_to, e.review_state, e.checks_state, e.payload,
              e.source_updated_at as updated_at, l.closing, r.full_name as repo
         from dev_links l join dev_entities e on e.id = l.entity_id join repositories r on r.id = e.repo_id
        where l.issue_id = $1 and (e.state is distinct from 'deleted') order by e.source_updated_at desc`, [issue.id])
    const pick = (kind: string, limit: number) => rows.filter(r => r.kind === kind).slice(0, limit).map(({ kind, ...r }) => r)
    return { pullRequests: pick('pull_request', 50), branches: pick('branch', 50), commits: pick('commit', 50) }
  })
}
export default plugin
