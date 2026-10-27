import { createRemoteJWKSet, jwtVerify } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { getSetting } from './settings.ts'
import { db, tx, type Db } from './db.ts'

export type Role = 'owner' | 'admin' | 'member'
/** `via` is how this request signed in: an Entra session (the web app) or a personal access token (scripts). */
export interface Me {
  id: string; email: string; name: string; workspaceId: string; role: Role
  /** In the system-administrators group: sees and administers every project, Administration and System settings. */
  admin: boolean
  via: 'entra' | 'pat'
  /** The sign-in carries Entra's Strand.Admin app role (puts the person back in system-administrators at sign-in) */
  adminClaim?: boolean
}

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
const jwks = tenant ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)) : null
const devAuth = process.env.AUTH_DEV === '1'
if (!devAuth && !jwks) throw new Error('Set ENTRA_TENANT_ID + ENTRA_CLIENT_ID (or AUTH_DEV=1 for development)')
// Dev login without Entra: a shared secret keeps a public dev URL from being open to anyone. Mandatory in production mode.
// Fails closed: only an explicit NODE_ENV=development|test (local runs, tests) may skip the secret; anything else needs one.
const devSecret = process.env.DEV_AUTH_SECRET ?? ''
const localDev = ['development', 'test'].includes(process.env.NODE_ENV ?? '')
if (devAuth && jwks) throw new Error('AUTH_DEV and ENTRA_* are both set; remove AUTH_DEV so dev login cannot bypass Entra')
if (devAuth && !localDev && devSecret.length < 16)
  throw new Error('AUTH_DEV needs DEV_AUTH_SECRET (16+ chars) unless NODE_ENV is development or test')
const sameSecret = (got: unknown) => {
  const a = Buffer.from(String(got ?? '')), b = Buffer.from(devSecret)
  return devSecret !== '' && a.length === b.length && timingSafeEqual(a, b)
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

interface Identity { oid?: string; email: string; name: string; admin: boolean }

async function identify(req: FastifyRequest): Promise<Identity> {
  if (devAuth && !req.headers.authorization) {
    if ((devSecret || !localDev) && !sameSecret(req.headers['x-dev-secret'])) throw new HttpError(401, 'Missing or wrong dev secret')
    const email = String(req.headers['x-dev-user'] ?? 'dev@strand.local').toLowerCase()
    return { email, name: email.split('@')[0]!, admin: localDev && req.headers['x-dev-admin'] === '1' }   // never self-grantable on a deployed dev server
  }
  const token = req.headers.authorization?.replace(/^Bearer /i, '')
  if (!token || !jwks) throw new HttpError(401, 'Missing bearer token')
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: clientId,
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    })
    const roles = (payload.roles as string[] | undefined) ?? []
    return {
      oid: payload.oid as string,
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
  let refused: string | null = null
  req.me = await tx(async d => {
    // Identity is the Entra `oid`. Email (a mutable claim) only links a row that has no oid yet.
    type U = { id: string; active: boolean; entraOid: string | null }
    let [u] = who.oid ? await d.query<U>('select id, active, entra_oid from users where entra_oid = $1', [who.oid]) : []
    if (!u) {
      [u] = await d.query<U>('select id, active, entra_oid from users where email = $1', [who.email])
      if (u) {
        if (who.oid && u.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        if (who.oid) await d.query('update users set entra_oid = $2 where id = $1', [u.id, who.oid])
      } else {
        // A new person's browser sends several requests at once, so another one may be creating this row right now.
        // `on conflict do nothing` (no target) covers every unique index, not just email; then read the winner's row.
        ;[u] = await d.query<U>(
          `insert into users (entra_oid, email, name, initials) values ($1, $2, $3, $4)
           on conflict do nothing returning id, active, entra_oid`,
          [who.oid ?? null, who.email, who.name, initials(who.name)])
        if (!u) {
          ;[u] = await d.query<U>('select id, active, entra_oid from users where entra_oid = $1 or email = $2', [who.oid, who.email])
          if (u?.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        }
      }
    }
    if (!u!.active) { refused = u!.id; return null as unknown as Me }   // recorded after this (rolled back) transaction
    // last use, at most once an hour; using Strand again cancels a pending cleanup warning
    await d.query(`update users set last_active_at = now(), cleanup_warned_at = null where id = $1 and (last_active_at is null or last_active_at < now() - interval '1 hour')`, [u!.id])
    const oldest = () => d.query<{ id: string }>('select id from workspaces order by created_at limit 1')
    let [ws] = await oldest()
    let first = false
    if (!ws) {
      // Only one request may create the workspace; the others wait here and then find it, instead of each making their own.
      await d.query('select pg_advisory_xact_lock(727275)')
      ;[ws] = await oldest()
      if (!ws) { ;[ws] = await d.query<{ id: string }>(`insert into workspaces (name) values ('Strand') returning id`); first = true }
    }
    const [m] = await d.query<{ role: Role; isNew: boolean }>(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = memberships.role returning role, (xmax = 0) as is_new`,
      [ws!.id, u!.id, first ? 'owner' : 'member'])
    // someone new is in the default group from their first request; the very first person administers Strand
    if (m!.isNew) await joinSystemGroup(d, u!.id, 'default-users')
    if (first || (m!.isNew && who.admin)) await joinSystemGroup(d, u!.id, 'system-admins')
    const [{ admin }] = await d.query<{ admin: boolean }>('select is_system_admin($1) as admin', [u!.id]) as any
    return { id: u!.id, email: who.email, name: who.name, workspaceId: ws!.id, role: roleOf(m!.role, admin), admin, via: 'entra' as const, adminClaim: who.admin }
  })
  if (refused) { await noteRefused(refused, who.email, req.ip); throw new HttpError(403, 'Account is deactivated') }
}

/** A deactivated person tried to sign in: kept in the audit log (at most once an hour each), so admins can see who to
 *  reactivate (Administration › People). */
async function noteRefused(userId: string, email: string, ip?: string) {
  await db.query(
    `insert into audit_log (workspace_id, actor_id, actor, action, target_type, target_id, target, ip)
     select (select id from workspaces order by created_at limit 1), $1::uuid, $2::text, 'auth.refused_deactivated', 'user', $1::text, $2::text, $3::text
      where not exists (select 1 from audit_log where action = 'auth.refused_deactivated' and target_id = $1::text and at > now() - interval '1 hour')`,
    [userId, email, ip ?? null]).catch(() => {})
}

/** A personal access token acts as its owner, with the owner's current role. Expired, revoked (deleted) and
 *  unknown tokens are all just "Invalid token"; a deactivated owner is refused like on an Entra login. */
async function authenticateToken(token: string): Promise<Me> {
  if (!PAT_FORMAT.test(token)) throw new HttpError(401, 'Invalid token')
  const [t] = await db.query<{ id: string; lastUsedAt: string | null; userId: string; email: string; name: string; active: boolean; workspaceId: string; role: Role; admin: boolean }>(
    `select t.id, t.last_used_at, u.id as user_id, u.email, u.name, u.active, m.workspace_id, m.role, is_system_admin(u.id) as admin
       from personal_access_tokens t
       join users u on u.id = t.user_id
       join memberships m on m.user_id = u.id
       join workspaces w on w.id = m.workspace_id
      where t.token_hash = $1 and t.expires_at > now()
      order by w.created_at limit 1`, [hashToken(token)])
  if (!t) throw new HttpError(401, 'Invalid token')
  if (!t.active) { await noteRefused(t.userId, t.email); throw new HttpError(403, 'Account is deactivated') }
  await db.query(`update users set last_active_at = now(), cleanup_warned_at = null where id = $1 and (last_active_at is null or last_active_at < now() - interval '1 hour')`, [t.userId])
  if (!(await getSetting(t.workspaceId, 'accessTokens')).enabled) throw new HttpError(401, 'Personal access tokens are turned off')
  // "last used" is written at most once a minute per token, so a busy script does not turn every call into a write
  await db.query(`update personal_access_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [t.id])
  return { id: t.userId, email: t.email, name: t.name, workspaceId: t.workspaceId, role: roleOf(t.role, t.admin), admin: t.admin, via: 'pat' }
}

export const isAdmin = (r: Role) => r === 'owner' || r === 'admin'
/** The role shown for a person: the workspace's owner stays owner; otherwise admin when in system-administrators. */
const roleOf = (r: Role, admin: boolean): Role => (r === 'owner' ? 'owner' : admin ? 'admin' : 'member')

/** Put someone in a system group (users-access, system-administrators) if they aren't in it. */
export const joinSystemGroup = (d: Db, userId: string, role: 'default-users' | 'system-admins') => d.query(
  `insert into group_members (group_id, user_id) select id, $1 from groups where system_role = $2 on conflict do nothing`, [userId, role])

/** A sign-in (the app starting after Entra sign-in; not a script's token): back into the default group if removed, back
 *  into system-administrators with Entra's Strand.Admin role, and the time recorded. */
export async function signedIn(d: Db, me: Me) {
  await joinSystemGroup(d, me.id, 'default-users')
  if (me.adminClaim) await joinSystemGroup(d, me.id, 'system-admins')
  await d.query('update users set last_sign_in_at = now() where id = $1', [me.id])
}

/** Managing tokens needs a real sign-in: a token (possibly leaked) must not be able to mint more of itself. */
export function requireSignIn(req: FastifyRequest) {
  if (req.me.via !== 'entra') throw new HttpError(403, 'Sign in with your account to manage access tokens')
}
export function requireAdmin(req: FastifyRequest) {
  if (!req.me.admin) throw new HttpError(403, 'Admin only')
}
