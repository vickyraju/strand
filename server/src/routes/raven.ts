// Xray's own REST addresses for importing results (Xray for Jira Data Center: /rest/raven/1.0/import/execution…), so a CI
// pipeline that sends results to Xray keeps working with only a new base address and a Strand access token. They answer as
// Xray does ({ testExecIssue: { id, key, self } }) and behave as the native /api/v1/testing/import routes.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { tx } from '../db.ts'
import { acceptReports, importBatch, importQuery, readBatch } from './testing.ts'

const plugin: FastifyPluginAsyncZod = async app => {
  acceptReports(app)
  const route = (path: string, format: 'xray' | 'junit' | 'cucumber') =>
    app.post(path, { schema: { hide: true, querystring: importQuery, body: z.unknown() } as any }, async req => {
      const batch = await readBatch(format, req)
      return tx(d => importBatch(d, req, batch, req.query as z.infer<typeof importQuery>))
    })
  route('/import/execution', 'xray')
  route('/import/execution/junit', 'junit')
  route('/import/execution/junit/multipart', 'junit')
  route('/import/execution/cucumber', 'cucumber')
  route('/import/execution/cucumber/multipart', 'cucumber')
}
export default plugin
