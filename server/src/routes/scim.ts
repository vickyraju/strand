import type { FastifyPluginAsync } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from '../db.ts'
import { HttpError } from '../auth.ts'

// SCIM 2.0 Users for Microsoft Entra provisioning. Authenticated by one shared bearer token (SCIM_TOKEN).
// Deprovisioning is a soft `active=false`: history stays attributed, and login is refused.
const SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const token = process.env.SCIM_TOKEN ?? ''

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
const asBool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v))

const toScim = (u: any) => ({
  schemas: [SCHEMA], id: u.id, externalId: u.entraOid ?? undefined, userName: u.email, displayName: u.name,
  active: u.active, emails: [{ value: u.email, primary: true }], meta: { resourceType: 'User' },
})

const userBody = z.object({
  userName: z.string().min(3), externalId: z.string().optional(), displayName: z.string().optional(),
  name: z.object({ givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  active: z.union([z.boolean(), z.string()]).optional(),
  title: z.string().optional(),
}).passthrough()

const displayName = (b: z.infer<typeof userBody>) =>
  b.displayName ?? [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ') ?? b.userName

const plugin: FastifyPluginAsync = async app => {
  app.addHook('preHandler', async req => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''))
    const want = Buffer.from(token)
    if (!token || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Invalid SCIM token')
  })
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_r, body, done) => {
    try { done(null, JSON.parse(body as string)) } catch (e: any) { done(e) }
  })
  app.addHook('onSend', async (_req, reply) => { reply.header('content-type', 'application/scim+json') })

  app.get('/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Shared secret' }],
  }))

  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>('/Users', async req => {
    const start = Math.max(1, Number(req.query.startIndex ?? 1))
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)))
    const f = /^userName eq "([^"]+)"$/i.exec(req.query.filter ?? '')   // the only filter Entra sends
    const rows = await db.query<any>(
      `select *, count(*) over ()::int as total from users where ($1::text is null or email = lower($1)) order by created_at limit $2 offset $3`,
      [f?.[1] ?? null, count, start - 1])
    return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: rows[0]?.total ?? 0, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(toScim) }
  })

  app.get<{ Params: { id: string } }>('/Users/:id', async req => {
    const [u] = await db.query('select * from users where id = $1', [z.string().uuid().parse(req.params.id)])
    if (!u) throw new HttpError(404, 'Not found')
    return toScim(u)
  })

  app.post('/Users', async (req, reply) => {
    const b = userBody.parse(req.body)
    const email = b.userName.toLowerCase()
    const name = displayName(b) || email
    const [u] = await db.query<any>(
      `insert into users (entra_oid, email, name, initials, title, active) values ($1, $2, $3, $4, $5, $6) returning *`,
      [b.externalId ?? null, email, name, initials(name), b.title ?? null, b.active === undefined ? true : asBool(b.active)])
    reply.code(201)
    return toScim(u)
  })

  app.put<{ Params: { id: string } }>('/Users/:id', async req => {
    const b = userBody.parse(req.body)
    const name = displayName(b)
    const [u] = await db.query<any>(
      `update users set entra_oid = coalesce($2, entra_oid), email = lower($3), name = $4, initials = $5, title = $6, active = $7 where id = $1 returning *`,
      [z.string().uuid().parse(req.params.id), b.externalId ?? null, b.userName, name, initials(name), b.title ?? null, b.active === undefined ? true : asBool(b.active)])
    if (!u) throw new HttpError(404, 'Not found')
    return toScim(u)
  })

  // Entra mostly sends {op:'Replace', path:'active', value:'False'}; also handle the no-path object form.
  app.patch<{ Params: { id: string } }>('/Users/:id', async req => {
    const { Operations } = z.object({ Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() })) }).parse(req.body)
    const set: Record<string, unknown> = {}
    for (const o of Operations) {
      if (o.op.toLowerCase() === 'remove') continue
      const vals = o.path ? { [o.path]: o.value } : (o.value as Record<string, unknown>) ?? {}
      for (const [p, v] of Object.entries(vals)) {
        if (p === 'active') set.active = asBool(v)
        else if (p === 'displayName') set.name = String(v)
        else if (p === 'userName') set.email = String(v).toLowerCase()
        else if (p === 'externalId') set.entra_oid = String(v)
        else if (p === 'title') set.title = String(v)
      }
    }
    const cols = Object.keys(set)
    if (!cols.length) throw new HttpError(400, 'Nothing to update')
    const [u] = await db.query<any>(
      `update users set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning *`,
      [z.string().uuid().parse(req.params.id), ...cols.map(c => set[c])])
    if (!u) throw new HttpError(404, 'Not found')
    return toScim(u)
  })

  app.delete<{ Params: { id: string } }>('/Users/:id', async (req, reply) => {
    await db.query('update users set active = false where id = $1', [z.string().uuid().parse(req.params.id)])
    reply.code(204).send()
  })
}

export default plugin
