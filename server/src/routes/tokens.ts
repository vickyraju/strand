import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { db, tx } from '../db.ts'
import { HttpError, PAT_PREFIX, hashToken, requireSignIn } from '../auth.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'

// Personal access tokens (modelled on Atlassian's): created from your profile, shown once, sent as
// `Authorization: Bearer <token>`, act with your permissions, expire and can be revoked at any time.
// Whether tokens are allowed, how many each person may have and how long they may live are System settings.
const TAG = ['Access tokens']
const COLUMNS = `id, name, hint, created_at, expires_at, last_used_at, expires_at <= now() as expired`

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/me/tokens', { schema: {
    tags: TAG, summary: 'Your personal access tokens (never the secret); newest first. Needs a sign-in, not a token',
  } }, async req => {
    requireSignIn(req)
    return db.query(`select ${COLUMNS} from personal_access_tokens where user_id = $1 order by created_at desc, id desc`, [req.me.id])
  })

  app.post('/me/tokens', { schema: {
    tags: TAG, summary: 'Create a personal access token. The secret is returned once and cannot be shown again. Needs a sign-in, not a token; limits are in System settings',
    body: z.object({
      name: z.string().trim().min(1).max(40).describe('What the token is for, e.g. "Release script"'),
      expiresInDays: z.number().int().min(1).max(3650).optional().describe('Days until it stops working; default and longest allowed are in System settings'),
    }),
  } }, async req => {
    requireSignIn(req)
    const policy = await getSetting(req.me.workspaceId, 'accessTokens')
    if (!policy.enabled) throw new HttpError(403, 'Personal access tokens are turned off in System settings')
    const name = req.body.name, expiresInDays = req.body.expiresInDays ?? policy.defaultExpiryDays
    if (expiresInDays > policy.maxExpiryDays)
      throw new HttpError(400, `A token can last at most ${policy.maxExpiryDays} days`, { expiresInDays: `At most ${policy.maxExpiryDays}` })
    const token = PAT_PREFIX + randomBytes(32).toString('base64url')
    return tx(async d => {
      await d.query('select id from users where id = $1 for update', [req.me.id])          // serializes two creates by the same person
      await d.query(`delete from personal_access_tokens where expires_at < now() - interval '30 days'`)   // expired tokens are kept 30 days so they can be seen, then dropped
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from personal_access_tokens where user_id = $1 and expires_at > now()', [req.me.id])
      if (n >= policy.maxPerUser) throw new HttpError(409, `You can have at most ${policy.maxPerUser} active tokens; revoke one first`)
      const [row] = await d.query(
        `insert into personal_access_tokens (user_id, name, token_hash, hint, expires_at)
         values ($1, $2, $3, $4, now() + make_interval(days => $5)) returning ${COLUMNS}`,
        [req.me.id, name, hashToken(token), token.slice(-4), expiresInDays])
      await audit(d, req, { action: 'token.created', type: 'token', id: row.id, name, after: { expiresInDays } })
      return { ...row, token }
    })
  })

  app.delete('/me/tokens/:id', { schema: {
    tags: TAG, summary: 'Revoke a token. It stops working at once and is removed. Needs a sign-in, not a token',
    params: z.object({ id: z.string().uuid() }),
  } }, async (req, reply) => {
    requireSignIn(req)
    await tx(async d => {
      const [gone] = await d.query('delete from personal_access_tokens where id = $1 and user_id = $2 returning id, name', [req.params.id, req.me.id])
      if (!gone) throw new HttpError(404, 'Token not found')
      await audit(d, req, { action: 'token.revoked', type: 'token', id: gone.id, name: gone.name })
    })
    reply.code(204).send()
  })
}

export default plugin
