import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { verifySignature } from '../integrations/github.ts'
import { processDelivery } from '../integrations/ingest.ts'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'

const secret = () => process.env.GITHUB_WEBHOOK_SECRET ?? ''

/** Public endpoint for GitHub (no login): trust comes only from the HMAC signature on the raw body. */
export const githubWebhook: FastifyPluginAsync = async app => {
  // Keep the exact bytes: the signature is computed over them, not over re-serialized JSON. Scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!secret()) return done(new HttpError(503, 'GitHub webhook is not configured'))
    if (!verifySignature(body as string, req.headers['x-hub-signature-256'] as string | undefined, secret())) return done(new HttpError(401, 'Invalid signature'))
    try { done(null, JSON.parse(body as string)) } catch { done(new HttpError(400, 'Body is not valid JSON')) }
  })

  app.post('/', {
    schema: {
      tags: ['Integrations'], summary: 'GitHub webhook receiver (signed with X-Hub-Signature-256; called by GitHub, not by clients)', security: [],
      headers: z.object({ 'x-github-event': z.string(), 'x-github-delivery': z.string() }),
      response: { 200: z.object({ ok: z.boolean(), duplicate: z.boolean().optional(), ignored: z.string().optional(), records: z.number().optional() }) },
    },
  }, async req => {
    const event = req.headers['x-github-event'], delivery = req.headers['x-github-delivery']
    // Seen before? A delivery that was processed is acknowledged and skipped; one that failed is tried again.
    const [fresh] = await db.query(
      `insert into webhook_deliveries (delivery_id, provider, event) values ($1, 'github', $2)
       on conflict (delivery_id) do update set status = 'received', error = null, received_at = now() where webhook_deliveries.status = 'failed'
       returning delivery_id`, [delivery, event])
    if (!fresh) return { ok: true, duplicate: true }
    try {
      const out = await tx(d => processDelivery(d, String(event), req.body))
      await db.query(`update webhook_deliveries set status = 'processed' where delivery_id = $1`, [delivery])
      return { ok: true, ...(out.ok ? { ignored: out.ignored, records: out.records } : {}) }
    } catch (e) {
      await db.query(`update webhook_deliveries set status = 'failed', error = $2 where delivery_id = $1`, [delivery, String((e as Error).message).slice(0, 500)])
      throw e                                              // 500: GitHub shows it as failed and can redeliver
    }
  })
}
