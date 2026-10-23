import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'

// SCIM 2.0 Users and Groups for Microsoft Entra provisioning. Authenticated by one shared bearer token (SCIM_TOKEN).
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

const idP = z.object({ id: z.string().uuid() })
const TAG = ['SCIM (Entra provisioning)']
const sec = [{ scimToken: [] }]

const plugin: FastifyPluginAsyncZod = async app => {
  app.addHook('preHandler', async req => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''))
    const want = Buffer.from(token)
    if (!token || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Invalid SCIM token')
  })
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_r, body, done) => {
    if (!String(body).trim()) return done(null, undefined)   // a DELETE may carry the content type but no body
    try { done(null, JSON.parse(body as string)) } catch (e: any) { done(e) }
  })
  app.addHook('onSend', async (_req, reply) => { reply.header('content-type', 'application/scim+json') })

  app.get('/ServiceProviderConfig', { schema: { tags: TAG, summary: 'SCIM capabilities', security: sec } }, async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Shared secret' }],
  }))

  app.get('/Users', { schema: {
    tags: TAG, summary: 'List users; supports filter=userName eq "x"', security: sec,
    querystring: z.object({ filter: z.string().optional(), startIndex: z.string().optional(), count: z.string().optional() }),
  } }, async req => {
    const start = Math.max(1, Number(req.query.startIndex ?? 1))
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)))
    const f = /^userName eq "([^"]+)"$/i.exec(req.query.filter ?? '')   // the only filter Entra sends
    const rows = await db.query<any>(
      `select *, count(*) over ()::int as total from users where ($1::text is null or email = lower($1)) order by created_at limit $2 offset $3`,
      [f?.[1] ?? null, count, start - 1])
    return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: rows[0]?.total ?? 0, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(toScim) }
  })

  app.get('/Users/:id', { schema: { tags: TAG, summary: 'Get a user', security: sec, params: idP } }, async req => {
    const [u] = await db.query('select * from users where id = $1', [req.params.id])
    if (!u) throw new HttpError(404, 'Not found')
    return toScim(u)
  })

  /** Provisioning changes go to the audit log; the actor is SCIM (the identity provider), not a person. */
  const userBefore = async (id: string) => (await db.query<any>('select * from users where id = $1', [id]))[0] ?? null
  const logUser = async (ip: string, before: any, u: any) => {
    const view = (x: any) => ({ email: x.email, name: x.name, title: x.title ?? null, active: x.active })
    const action = !before ? 'user.provisioned' : before.active && !u.active ? 'user.deactivated' : !before.active && u.active ? 'user.reactivated' : 'user.updated'
    const c = before ? changes(view(before), view(u)) : { before: undefined, after: view(u), changed: true }
    if (c.changed) await audit(db, { system: 'SCIM', ip }, { action, type: 'user', id: u.id, name: u.email, workspaceId: null, before: c.before, after: c.after })
  }

  app.post('/Users', { schema: { tags: TAG, summary: 'Provision a user', security: sec, body: userBody } }, async (req, reply) => {
    const b = req.body
    const email = b.userName.toLowerCase()
    const name = displayName(b) || email
    const [u] = await db.query<any>(
      `insert into users (entra_oid, email, name, initials, title, active) values ($1, $2, $3, $4, $5, $6) returning *`,
      [b.externalId ?? null, email, name, initials(name), b.title ?? null, b.active === undefined ? true : asBool(b.active)])
    await logUser(req.ip, null, u)
    reply.code(201)
    return toScim(u)
  })

  app.put('/Users/:id', { schema: { tags: TAG, summary: 'Replace a user', security: sec, params: idP, body: userBody } }, async req => {
    const b = req.body
    const name = displayName(b)
    const before = await userBefore(req.params.id)
    const [u] = await db.query<any>(
      `update users set entra_oid = coalesce($2, entra_oid), email = lower($3), name = $4, initials = $5, title = $6, active = $7 where id = $1 returning *`,
      [req.params.id, b.externalId ?? null, b.userName, name, initials(name), b.title ?? null, b.active === undefined ? true : asBool(b.active)])
    if (!u) throw new HttpError(404, 'Not found')
    await logUser(req.ip, before, u)
    return toScim(u)
  })

  // Entra mostly sends {op:'Replace', path:'active', value:'False'}; also handle the no-path object form.
  app.patch('/Users/:id', { schema: {
    tags: TAG, summary: 'Patch a user (Entra deactivates with active=false)', security: sec, params: idP,
    body: z.object({ Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() })) }),
  } }, async req => {
    const { Operations } = req.body
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
    const before = await userBefore(req.params.id)
    const [u] = await db.query<any>(
      `update users set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning *`,
      [req.params.id, ...cols.map(c => set[c])])
    if (!u) throw new HttpError(404, 'Not found')
    await logUser(req.ip, before, u)
    return toScim(u)
  })

  app.delete('/Users/:id', { schema: { tags: TAG, summary: 'Deactivate a user (soft)', security: sec, params: idP } }, async (req, reply) => {
    const before = await userBefore(req.params.id)
    const [u] = await db.query<any>('update users set active = false where id = $1 returning *', [req.params.id])
    if (u) await logUser(req.ip, before, u)
    reply.code(204).send()
  })

  // ── Groups (teams from the directory). Projects give roles to groups; membership here decides who has them ──
  const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
  const groupOut = async (g: any, withMembers = true) => ({
    schemas: [GROUP], id: g.id, externalId: g.externalId ?? undefined, displayName: g.displayName, meta: { resourceType: 'Group' },
    ...(withMembers ? { members: (await db.query<{ id: string; email: string }>(
      'select u.id, u.email from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1 order by u.email', [g.id])).map(m => ({ value: m.id, display: m.email })) } : {}),
  })
  const known = async (ids: string[]) => (await db.query<{ id: string }>('select id from users where id = any($1::uuid[])', [ids.filter(x => /^[0-9a-f-]{36}$/i.test(x))])).map(r => r.id)
  const logGroup = (ip: string, action: string, g: { id: string; displayName: string }, after?: unknown) =>
    audit(db, { system: 'SCIM', ip }, { action, type: 'group', id: g.id, name: g.displayName, workspaceId: null, after })
  const groupBody = z.object({ displayName: z.string().min(1).max(256), externalId: z.string().optional(), members: z.array(z.object({ value: z.string() })).optional() }).passthrough()

  app.get('/Groups', { schema: {
    tags: TAG, summary: 'List groups; supports filter=displayName eq "x"', security: sec,
    querystring: z.object({ filter: z.string().optional(), startIndex: z.string().optional(), count: z.string().optional(), excludedAttributes: z.string().optional() }),
  } }, async req => {
    const start = Math.max(1, Number(req.query.startIndex ?? 1))
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)))
    const f = /^displayName eq "([^"]+)"$/i.exec(req.query.filter ?? '')
    const rows = await db.query<any>(
      `select *, count(*) over ()::int as total from groups where ($1::text is null or display_name = $1) order by created_at limit $2 offset $3`,
      [f?.[1] ?? null, count, start - 1])
    const members = !/members/i.test(req.query.excludedAttributes ?? '')
    return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: rows[0]?.total ?? 0, startIndex: start, itemsPerPage: rows.length,
      Resources: await Promise.all(rows.map(g => groupOut(g, members))) }
  })

  app.get('/Groups/:id', { schema: { tags: TAG, summary: 'Get a group with its members', security: sec, params: idP } }, async req => {
    const [g] = await db.query<any>('select * from groups where id = $1', [req.params.id])
    if (!g) throw new HttpError(404, 'Not found')
    return groupOut(g)
  })

  app.post('/Groups', { schema: { tags: TAG, summary: 'Provision a group', security: sec, body: groupBody } }, async (req, reply) => {
    const b = req.body
    const [g] = await db.query<any>('insert into groups (display_name, external_id) values ($1, $2) returning *', [b.displayName, b.externalId ?? null])
    const ids = await known((b.members ?? []).map(m => m.value))
    for (const u of ids) await db.query('insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing', [g.id, u])
    await logGroup(req.ip, 'group.provisioned', g, { members: ids.length })
    reply.code(201)
    return groupOut(g)
  })

  // Entra sends Add/Remove members (by value, or a path filter for one member) and Replace displayName; op names vary in case
  app.patch('/Groups/:id', { schema: {
    tags: TAG, summary: 'Change a group: add or remove members, rename', security: sec, params: idP,
    body: z.object({ Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() })) }),
  } }, async (req, reply) => {
    const [g] = await db.query<any>('select * from groups where id = $1', [req.params.id])
    if (!g) throw new HttpError(404, 'Not found')
    let added = 0, removed = 0
    for (const o of req.body.Operations) {
      const op = o.op.toLowerCase(), path = o.path ?? ''
      const values = (Array.isArray(o.value) ? o.value : []).map((v: any) => String(v?.value ?? ''))
      const one = /^members\[value eq "([^"]+)"\]$/i.exec(path)?.[1]
      if (op === 'add' && /^members$/i.test(path)) {
        for (const u of await known(values)) { await db.query('insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing', [g.id, u]); added++ }
      } else if (op === 'remove' && (one || /^members$/i.test(path))) {
        const r = await db.query('delete from group_members where group_id = $1 and user_id = any($2::uuid[]) returning user_id', [g.id, await known(one ? [one] : values)]); removed += r.length
      } else if (op === 'replace' && /^members$/i.test(path)) {
        const ids = await known(values)
        removed += (await db.query('delete from group_members where group_id = $1 and not (user_id = any($2::uuid[])) returning user_id', [g.id, ids])).length
        for (const u of ids) await db.query('insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing', [g.id, u])
      } else if (op === 'replace' && (/^displayName$/i.test(path) || (!path && (o.value as any)?.displayName))) {
        const name = String(path ? o.value : (o.value as any).displayName)
        await db.query('update groups set display_name = $2 where id = $1', [g.id, name]); g.displayName = name
      } else if (op === 'replace' && /^externalId$/i.test(path)) {
        await db.query('update groups set external_id = $2 where id = $1', [g.id, String(o.value)])
      }
    }
    if (added || removed) await logGroup(req.ip, 'group.members_changed', g, { added, removed })
    reply.code(204).send()
  })

  app.delete('/Groups/:id', { schema: { tags: TAG, summary: 'Delete a group: everyone loses the roles it gave them', security: sec, params: idP } }, async (req, reply) => {
    const [g] = await db.query<any>('delete from groups where id = $1 returning *', [req.params.id])
    if (g) await logGroup(req.ip, 'group.deleted', g)
    reply.code(204).send()
  })
}

export default plugin
