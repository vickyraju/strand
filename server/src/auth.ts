import { jwtVerify } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { getSetting } from './settings.ts'
import { db, tx, type Db } from './db.ts'
import { getAuthConfig, issuerOf, keysFor, recoveryPassword, signInSettings } from './authConfig.ts'

export type Role = 'owner' | 'admin' | 'member'
/** `via` is how this request signed in: Microsoft Entra, the login form (a directory's password), recovery mode
 *  (spec 0711), or a personal access token (scripts). */
export interface Me {
  id: string; email: string; name: string; workspaceId: string; role: Role
  /** In the system-administrators group: sees and administers every project, Administration and System settings. */
  admin: boolean
  via: 'entra' | 'password' | 'recovery' | 'pat'
  /** The sign-in carries Entra's Strand.Admin app role (puts the person back in system-administrators at sign-in) */
  adminClaim?: boolean
}

// Personal access tokens look like jbp_<43 url-safe characters>. The prefix lets secret scanners recognise a leaked one.
export const PAT_PREFIX = 'jbp_'
export const PAT_FORMAT = /^jbp_[A-Za-z0-9_-]{43}$/
export const hashToken = (token: string) => createHash('sha256').update(token).digest()   // tokens are 256-bit random: a fast hash is enough
// A sign-in through the login form (spec 0711) is a session token: jbs_<43 url-safe characters>, kept only as a hash
export const SESSION_PREFIX = 'jbs_'
export const SESSION_FORMAT = /^jbs_[A-Za-z0-9_-]{43}$/

declare module 'fastify' { interface FastifyRequest { me: Me } }

export class HttpError extends Error {
  status: number
  /** Per-field messages, for input the schema accepted but the rules refuse */
  errors?: Record<string, string>
  constructor(status: number, message: string, errors?: Record<string, string>) { super(message); this.status = status; if (errors) this.errors = errors }
}

// Strand's dev login (spec 0711 R13): an x-dev-user header, for development only. A shared secret keeps a public dev URL
// from being open to anyone. Fails closed: only an explicit NODE_ENV=development|test may skip the secret.
const devAuth = process.env.AUTH_DEV === '1'
const devSecret = process.env.DEV_AUTH_SECRET ?? ''
const localDev = ['development', 'test'].includes(process.env.NODE_ENV ?? '')
if (devAuth && process.env.ENTRA_TENANT_ID) throw new Error('AUTH_DEV and ENTRA_* are both set; remove AUTH_DEV so dev login cannot bypass Entra')
if (devAuth && !localDev && devSecret.length < 16)
  throw new Error('AUTH_DEV needs DEV_AUTH_SECRET (16+ chars) unless NODE_ENV is development or test')
const sameSecret = (got: unknown) => {
  const a = Buffer.from(String(got ?? '')), b = Buffer.from(devSecret)
  return devSecret !== '' && a.length === b.length && timingSafeEqual(a, b)
}
/** The login page offers the dev login (GET /auth/config). */
export const devLogin = devAuth

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

/** Who signed in: from Entra (with its `oid`), or from the login form (a directory's username, spec 0711). */
export interface Identity { oid?: string; username?: string; email: string; name: string; admin: boolean }

async function identify(req: FastifyRequest): Promise<Identity> {
  if (devAuth && !req.headers.authorization) {
    if ((devSecret || !localDev) && !sameSecret(req.headers['x-dev-secret'])) throw new HttpError(401, 'Missing or wrong dev secret')
    const email = String(req.headers['x-dev-user'] ?? 'dev@strand.local').toLowerCase()
    return { email, name: email.split('@')[0]!, admin: localDev && req.headers['x-dev-admin'] === '1' }   // never self-grantable on a deployed dev server
  }
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  if (!token) throw new HttpError(401, 'Missing bearer token')
  // Entra as configured in Administration › Authentication methods (spec 0711); turned off, its tokens are refused
  const e = (await getAuthConfig()).entra
  if (!e?.enabled) throw new HttpError(401, 'Sign-in with Microsoft is turned off')
  try {
    const { payload } = await jwtVerify(token, keysFor(e), {
      algorithms: ['RS256'],
      audience: [e.apiClientId, `api://${e.apiClientId}`],
      issuer: issuerOf(e),
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
  if (bearer?.startsWith(SESSION_PREFIX)) { req.me = await authenticateSession(bearer); return }
  const who = await identify(req)
  if (!who.email) throw new HttpError(401, 'Token has no email')
  req.me = await signInAs(who, 'entra', req.ip)
}

/** The person an identity is: found by Entra `oid`, then by username (the login form), then by email (which only links
 *  a row with no other oid); created on first sight, with the workspace the very first time. Refuses the deactivated. */
export async function signInAs(who: Identity, via: Me['via'], ip?: string): Promise<Me> {
  let refused: string | null = null
  const me = await tx(async d => {
    type U = { id: string; active: boolean; entraOid: string | null }
    let [u] = who.oid ? await d.query<U>('select id, active, entra_oid from users where entra_oid = $1', [who.oid]) : []
    if (!u && who.username) [u] = await d.query<U>('select id, active, entra_oid from users where lower(username) = lower($1)', [who.username])
    if (!u) {
      [u] = await d.query<U>('select id, active, entra_oid from users where email = $1', [who.email])
      if (u) {
        if (who.oid && u.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        if (who.oid) await d.query('update users set entra_oid = $2 where id = $1', [u.id, who.oid])
      } else {
        // A new person's browser sends several requests at once, so another one may be creating this row right now.
        // `on conflict do nothing` (no target) covers every unique index, not just email; then read the winner's row.
        ;[u] = await d.query<U>(
          `insert into users (entra_oid, email, name, initials, username) values ($1, $2, $3, $4, $5)
           on conflict do nothing returning id, active, entra_oid`,
          [who.oid ?? null, who.email, who.name, initials(who.name), who.username ?? null])
        if (!u) {
          ;[u] = await d.query<U>('select id, active, entra_oid from users where (entra_oid = $1 and $1 is not null) or email = $2', [who.oid ?? null, who.email])
          if (who.oid && u?.entraOid && u.entraOid !== who.oid) throw new HttpError(403, 'Email belongs to a different account')
        }
      }
    }
    if (who.username) await d.query('update users set username = $2 where id = $1 and username is distinct from $2', [u!.id, who.username])
    if (!u!.active) { refused = u!.id; return null as unknown as Me }   // recorded after this (rolled back) transaction
    // last use, at most once an hour
    await d.query(`update users set last_active_at = now() where id = $1 and (last_active_at is null or last_active_at < now() - interval '1 hour')`, [u!.id])
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
    return { id: u!.id, email: who.email, name: who.name, workspaceId: ws!.id, role: roleOf(m!.role, admin), admin, via, adminClaim: who.admin }
  })
  if (refused) { await noteRefused(refused, who.email, ip); throw new HttpError(403, 'Account is deactivated') }
  return me
}

/** A deactivated person tried to sign in: kept in the audit log (at most once an hour each), so admins can see who to
 *  reactivate (Administration › People). */
export async function noteRefused(userId: string, email: string, ip?: string) {
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
  await db.query(`update users set last_active_at = now() where id = $1 and (last_active_at is null or last_active_at < now() - interval '1 hour')`, [t.userId])
  if (!(await getSetting(t.workspaceId, 'accessTokens')).enabled) throw new HttpError(401, 'Personal access tokens are turned off')
  // "last used" is written at most once a minute per token, so a busy script does not turn every call into a write
  await db.query(`update personal_access_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [t.id])
  return { id: t.userId, email: t.email, name: t.name, workspaceId: t.workspaceId, role: roleOf(t.role, t.admin), admin: t.admin, via: 'pat' }
}

/** A login form session (spec 0711): the person, while it is neither expired nor idle too long; each use keeps it
 *  alive (written at most once a minute). A recovery session works only while recovery mode is on. */
async function authenticateSession(token: string): Promise<Me> {
  if (!SESSION_FORMAT.test(token)) throw new HttpError(401, 'Invalid token')
  const [s] = await db.query<{ via: 'password' | 'recovery'; userId: string; email: string; name: string; active: boolean; workspaceId: string; role: Role; admin: boolean; touch: boolean }>(
    `select s.via, u.id as user_id, u.email, u.name, u.active, m.workspace_id, m.role, is_system_admin(u.id) as admin,
            s.last_used_at < now() - interval '1 minute' as touch
       from user_sessions s
       join users u on u.id = s.user_id
       join memberships m on m.user_id = u.id
       join workspaces w on w.id = m.workspace_id
      where s.token_hash = $1 and s.expires_at > now() and s.idle_until > now()
      order by w.created_at limit 1`, [hashToken(token)])
  if (!s || (s.via === 'recovery' && !recoveryPassword())) throw new HttpError(401, 'Your sign-in has ended: sign in again')
  if (!s.active) { await noteRefused(s.userId, s.email); throw new HttpError(403, 'Account is deactivated') }
  if (s.touch) {
    const { sessionIdleMinutes } = await signInSettings()
    await db.query(`update user_sessions set last_used_at = now(), idle_until = least(expires_at, greatest(idle_until, now() + make_interval(mins => $2))) where token_hash = $1`,
      [hashToken(token), sessionIdleMinutes])
    await db.query(`update users set last_active_at = now() where id = $1 and (last_active_at is null or last_active_at < now() - interval '1 hour')`, [s.userId])
  }
  return { id: s.userId, email: s.email, name: s.name, workspaceId: s.workspaceId, role: roleOf(s.role, s.admin), admin: s.admin, via: s.via }
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
  // an app opened again within five minutes is the same sign-in; the one before is lastLogin() (spec 0603 R1)
  await d.query(`update users set previous_sign_in_at = last_sign_in_at, last_sign_in_at = now() where id = $1 and (last_sign_in_at is null or last_sign_in_at < now() - interval '5 minutes')`, [me.id])
}

/** Managing tokens needs a real sign-in: a token (possibly leaked) must not be able to mint more of itself,
 *  and recovery_admin is only there to restore access (spec 0711 R12). */
export function requireSignIn(req: FastifyRequest, what = 'manage access tokens') {
  if (req.me.via === 'pat' || req.me.via === 'recovery') throw new HttpError(403, `Sign in with your account to ${what}`)
}
export function requireAdmin(req: FastifyRequest) {
  if (!req.me.admin) throw new HttpError(403, 'Admin only')
}
