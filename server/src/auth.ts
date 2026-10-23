import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { db, tx } from './db.ts'

export type Role = 'owner' | 'admin' | 'member'
/** `via` is how this request signed in: an Entra session (the web app) or a personal access token (scripts). */
export interface Me { id: string; email: string; name: string; workspaceId: string; role: Role; /** Workspace owner or admin: sees and administers every project. */ admin: boolean; via: 'entra' | 'pat' }

// Personal access tokens look like jbp_<43 url-safe characters>. The prefix lets secret scanners recognise a leaked one.
export const PAT_PREFIX = 'jbp_'
export const PAT_FORMAT = /^jbp_[A-Za-z0-9_-]{43}$/
export const hashToken = (token: string) => createHash('sha256').update(token).digest()   // tokens are 256-bit random: a fast hash is enough

declare module 'fastify' { interface FastifyRequest { me: Me } }

export class HttpError extends Error {
  status: number
  /** Per-field messages, for input the schema accepted but the rules refuse */
  errors?: Record<string, string>
  constructor(status: number, message: string, errors?: Record<string, string>) { super(message); this.status = status; if (errors) this.errors = errors }
}

const tenant = process.env.ENTRA_TENANT_ID
const clientId = process.env.ENTRA_CLIENT_ID
if (!tenant || !clientId) throw new Error('Set ENTRA_TENANT_ID and ENTRA_CLIENT_ID (Microsoft Entra ID sign-in is the only login)')
// Public cloud by default; set ENTRA_AUTHORITY for a sovereign cloud (e.g. https://login.microsoftonline.us)
const authority = (process.env.ENTRA_AUTHORITY ?? 'https://login.microsoftonline.com').replace(/\/$/, '')
const jwks = createRemoteJWKSet(new URL(`${authority}/${tenant}/discovery/v2.0/keys`))

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

interface Identity { oid: string; email: string; name: string; admin: boolean }

async function identify(req: FastifyRequest): Promise<Identity> {
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  if (!token) throw new HttpError(401, 'Missing bearer token')
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      audience: [clientId!, `api://${clientId}`],
      issuer: `${authority}/${tenant}/v2.0`,
    })
    if (typeof payload.oid !== 'string') throw new Error('no oid')
    const roles = (payload.roles as string[] | undefined) ?? []
    return {
      oid: payload.oid,
      email: String(payload.preferred_username ?? payload.email ?? '').toLowerCase(),
      name: String(payload.name ?? payload.preferred_username ?? ''),
      admin: roles.includes('Strand.Admin'),
    }
  } catch {
    throw new HttpError(401, 'Invalid token')
  }
}

/** Resolve the caller to a user + role, creating them (and the workspace, once) on first sight.
 *  ponytail: one upsert per request; add a short-lived cache keyed by oid if this shows up in profiles. */
export async function authenticate(req: FastifyRequest) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  if (bearer?.startsWith(PAT_PREFIX)) { req.me = await authenticateToken(bearer); return }
  const who = await identify(req)
  if (!who.email) throw new HttpError(401, 'Token has no email')
  req.me = await tx(async d => {
    // Identity is the Entra `oid`. Email (a mutable claim) only links a row that has no oid yet.
    type U = { id: string; active: boolean; entraOid: string | null }
    let [u] = await d.query<U>('select id, active, entra_oid from users where entra_oid = $1', [who.oid])
    if (!u) {
      [u] = await d.query<U>('select id, active, entra_oid from users where email = $1', [who.email])
      if (u) {
        if (u.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        await d.query('update users set entra_oid = $2 where id = $1', [u.id, who.oid])
      } else {
        // A new person's browser sends several requests at once, so another one may be creating this row right now.
        // `on conflict do nothing` (no target) covers every unique index, not just email; then read the winner's row.
        ;[u] = await d.query<U>(
          `insert into users (entra_oid, email, name, initials) values ($1, $2, $3, $4)
           on conflict do nothing returning id, active, entra_oid`,
          [who.oid, who.email, who.name, initials(who.name)])
        if (!u) {
          ;[u] = await d.query<U>('select id, active, entra_oid from users where entra_oid = $1 or email = $2', [who.oid, who.email])
          if (u?.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        }
      }
    }
    if (!u!.active) throw new HttpError(403, 'Account is deactivated')
    const oldest = () => d.query<{ id: string }>('select id from workspaces order by created_at limit 1')
    let [ws] = await oldest()
    let first = false
    if (!ws) {
      // Only one request may create the workspace; the others wait here and then find it, instead of each making their own.
      await d.query('select pg_advisory_xact_lock(727275)')
      ;[ws] = await oldest()
      if (!ws) { ;[ws] = await d.query<{ id: string }>(`insert into workspaces (name) values ('Strand') returning id`); first = true }
    }
    const want: Role = first ? 'owner' : who.admin ? 'admin' : 'member'
    const [m] = await d.query<{ role: Role }>(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = case
         when memberships.role = 'owner' then 'owner'
         when $4 then 'admin'
         when memberships.role = 'admin' then 'member'   -- the Entra claim is the source of truth
         else memberships.role end
       returning role`,
      [ws!.id, u!.id, want, who.admin])
    return { id: u!.id, email: who.email, name: who.name, workspaceId: ws!.id, role: m!.role, admin: m!.role !== 'member', via: 'entra' as const }
  })
}

/** A personal access token acts as its owner, with the owner's current role. Expired, revoked (deleted) and
 *  unknown tokens are all just "Invalid token"; a deactivated owner is refused like on an Entra login. */
async function authenticateToken(token: string): Promise<Me> {
  if (!PAT_FORMAT.test(token)) throw new HttpError(401, 'Invalid token')
  const [t] = await db.query<{ id: string; lastUsedAt: string | null; userId: string; email: string; name: string; active: boolean; workspaceId: string; role: Role }>(
    `select t.id, t.last_used_at, u.id as user_id, u.email, u.name, u.active, m.workspace_id, m.role
       from personal_access_tokens t
       join users u on u.id = t.user_id
       join memberships m on m.user_id = u.id
       join workspaces w on w.id = m.workspace_id
      where t.token_hash = $1 and t.expires_at > now()
      order by w.created_at limit 1`, [hashToken(token)])
  if (!t) throw new HttpError(401, 'Invalid token')
  if (!t.active) throw new HttpError(403, 'Account is deactivated')
  // "last used" is written at most once a minute per token, so a busy script does not turn every call into a write
  await db.query(`update personal_access_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [t.id])
  return { id: t.userId, email: t.email, name: t.name, workspaceId: t.workspaceId, role: t.role, admin: t.role !== 'member', via: 'pat' }
}

export const isAdmin = (r: Role) => r === 'owner' || r === 'admin'

/** Managing tokens needs a real sign-in: a token (possibly leaked) must not be able to mint more of itself. */
export function requireSignIn(req: FastifyRequest) {
  if (req.me.via !== 'entra') throw new HttpError(403, 'Sign in with your account to manage access tokens')
}
export function requireAdmin(req: FastifyRequest) {
  if (!isAdmin(req.me.role)) throw new HttpError(403, 'Admin only')
}
