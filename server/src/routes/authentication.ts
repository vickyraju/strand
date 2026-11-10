// Signing in, as Jira's Authentication methods (spec 0711). Public: the login page's configuration, the login form, and
// signing out. Admin: showing or hiding the login form, the fallback, and Microsoft Entra's configuration.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError, SESSION_PREFIX, devLogin, hashToken, requireAdmin, requireSignIn, signInAs, signedIn, joinSystemGroup, type Identity } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { RESET_FORMAT, checkInternal, checkLength, internalPerson, newLink, recentlySent, sendLink, setPassword } from '../localUsers.ts'
import { verifyPassword } from '../passwords.ts'
import {
  DEFAULT_AUTHORITY, RECOVERY_USER, clearAuthConfigCache, getAuthConfig, issuerOf, recoveryPassword, scopeOf, signInSettings, type EntraConfig,
} from '../authConfig.ts'

const T = ['Sign-in']
/** Jira's message, the same for every failure, so it never tells which usernames exist (R9). */
export const WRONG = 'Sorry, your username and password are incorrect - please try again.'
const ONE_WAY_IN = 'At least one authentication method must be shown on the login page'

/** Password checkers besides recovery_admin's: the user directories (spec 0712) add theirs. */
type Checker = (username: string, password: string) => Promise<Identity | null>
const checkers: Checker[] = []
export const addPasswordChecker = (c: Checker) => { checkers.push(c) }

const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

/** Whose password this is, or null. recovery_admin's is the recovery password; then the internal directory's (spec 0714);
 *  then the user directories', in order. The first directory that has the username decides. */
async function checkPassword(username: string, password: string): Promise<Identity | null> {
  if (!password) return null                                                          // an empty password never signs in
  if (username === RECOVERY_USER) {
    const p = recoveryPassword()
    return p && same(password, p) ? { username: RECOVERY_USER, email: RECOVERY_USER, name: 'Recovery admin', admin: true } : null
  }
  const internal = await checkInternal(username, password)
  if (internal !== undefined) return internal
  for (const c of checkers) { const who = await c(username, password); if (who) return who }
  return null
}

/** A wrong password: counted; once there are too many, the username is locked for a while (R9). */
async function countFailure(username: string) {
  const { maxFailures, lockMinutes } = await signInSettings()
  await db.query(
    `insert into login_failures (username, failures, last_at) values ($1, 1, now())
     on conflict (username) do update set
       failures = case when login_failures.last_at < now() - make_interval(mins => $2) then 1 else login_failures.failures + 1 end,
       last_at = now()`, [username, lockMinutes])
  await db.query(`update login_failures set locked_until = now() + make_interval(mins => $3), failures = 0 where username = $1 and failures >= $2`,
    [username, maxFailures, lockMinutes])
}

/** A Public announcement (spec 0701) shows on the login page too. */
async function publicAnnouncement() {
  const [w] = await db.query<{ id: string }>('select id from workspaces order by created_at limit 1')
  if (!w) return null
  const a = await getSetting(w.id, 'announcement')
  return a.visibility === 'public' && a.text.trim() ? a.text : null
}

const publicConfig = async () => {
  const c = await getAuthConfig()
  const e = c.entra?.enabled ? c.entra : null
  return {
    announcement: await publicAnnouncement(), loginForm: c.loginForm, fallback: c.fallback, dev: devLogin,
    entra: e && { name: e.name, tenantId: e.tenantId, clientId: e.webClientId, authority: e.authority, scope: scopeOf(e) },
  }
}

/** No sign-in needed: registered beside SCIM, outside the signed-in API. */
export const publicAuth: FastifyPluginAsyncZod = async app => {
  app.get('/auth/config', { schema: { tags: T, summary: 'How to sign in: whether the login form shows, and Microsoft Entra’s public settings (no sign-in needed)' } }, publicConfig)

  app.post('/auth/login', { schema: {
    tags: T, summary: 'Sign in with a username and password (the login form); returns a session token to send as `Authorization: Bearer`',
    body: z.object({
      username: z.string().trim().min(1).max(256), password: z.string().max(1024),
      remember: z.boolean().default(false).describe('“Remember my login on this computer”'),
      fallback: z.boolean().default(false).describe('Signing in through the authentication fallback (`/?auth_fallback`)'),
    }),
  } }, async (req, reply) => {
    const username = req.body.username.toLowerCase()
    // locked after too many wrong passwords: nothing is checked, so the directory's own lockout is never tripped (R9)
    const [lock] = await db.query<{ seconds: number }>(`select ceil(extract(epoch from locked_until - now()))::int as seconds from login_failures where username = $1 and locked_until > now()`, [username])
    if (lock) {
      reply.header('retry-after', String(lock.seconds))
      throw new HttpError(429, `Too many wrong passwords for this username. Try again in ${Math.ceil(lock.seconds / 60)} minute${lock.seconds > 60 ? 's' : ''}.`)
    }
    const recovery = username === RECOVERY_USER
    const cfg = await getAuthConfig()
    if (!recovery && !cfg.loginForm && !(cfg.fallback && req.body.fallback)) throw new HttpError(403, 'The login form is turned off')
    const who = await checkPassword(username, req.body.password)
    if (!who) { await countFailure(username); throw new HttpError(401, WRONG) }
    // recovery_admin restores access to an existing Strand: it never becomes the first person (the owner)
    if (recovery && !(await db.query('select 1 from workspaces limit 1')).length) throw new HttpError(403, 'Recovery mode needs a Strand that someone has already signed in to')
    const me = await signInAs(who, recovery ? 'recovery' : 'password', req.ip)
    const s = await signInSettings()
    const token = SESSION_PREFIX + randomBytes(32).toString('base64url')
    const [row] = await tx(async d => {
      await signedIn(d, me)
      if (recovery) {
        await joinSystemGroup(d, me.id, 'system-admins')
        await audit(d, { me, ip: req.ip }, { action: 'auth.recovery_sign_in', type: 'user', id: me.id, name: RECOVERY_USER })
      }
      await d.query('delete from login_failures where username = $1', [username])
      // remembered: lasts its days; otherwise ends when unused for a while (and within a day in any case)
      return d.query<{ expiresAt: string }>(
        `insert into user_sessions (token_hash, user_id, via, expires_at, idle_until)
         values ($1, $2, $3, now() + make_interval(days => $4), case when $5 then now() + make_interval(days => $4) else now() + make_interval(mins => $6) end)
         returning expires_at`,
        [hashToken(token), me.id, recovery ? 'recovery' : 'password', req.body.remember ? s.rememberDays : 1, req.body.remember, s.sessionIdleMinutes])
    })
    return { token, expiresAt: row!.expiresAt }
  })

  // "Can't access your account?" (spec 0714 R6): the same answer whoever asks; a link only for internal directory users
  app.post('/auth/forgot', { schema: { tags: T, summary: 'Can’t access your account: email a link to set a new password (the same answer whether or not the account exists)',
    body: z.object({ username: z.string().trim().min(1).max(320).describe('Username or email') }) } }, async (req, reply) => {
    const p = await internalPerson(req.body.username)
    if (p && !(await recentlySent(p.id))) {
      // sent after answering, so how long it takes says nothing about whether the account exists
      setImmediate(() => { void newLink(db, p.id).then(t => sendLink(p, t, 'reset')).catch(e => req.log.warn(`password link not sent: ${(e as Error).message}`)) })
    }
    reply.code(202)
    return { message: 'If that account exists and keeps its password in Strand, we’ve sent it an email with a link to set a new password.' }
  })

  app.post('/auth/reset', { schema: { tags: T, summary: 'Set a password with the link from an email (once, within 24 hours)',
    body: z.object({ token: z.string().max(100), password: z.string().max(1024) }) } }, async (req, reply) => {
    const gone = new HttpError(400, 'This link has expired or was already used. Ask for a new one with “Can’t access your account?”.')
    if (!RESET_FORMAT.test(req.body.token)) throw gone
    await checkLength(req.body.password)
    await tx(async d => {
      const [r] = await d.query<{ userId: string; username: string | null; email: string }>(
        `update password_resets r set used_at = now() from users u
          where r.token_hash = $1 and r.used_at is null and r.expires_at > now() and u.id = r.user_id and u.active and u.directory_id is null
          returning r.user_id, u.username, u.email`, [hashToken(req.body.token)])
      if (!r) throw gone
      await setPassword(d, r.userId, req.body.password)
      if (r.username) await d.query('delete from login_failures where username = lower($1)', [r.username])
      await d.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [r.userId])   // older links stop too
      await audit(d, { system: 'Password link' }, { action: 'user.password_set', type: 'user', id: r.userId, name: r.email, after: { by: 'email link' } })
    })
    reply.code(204).send()
  })

  app.post('/auth/logout', { schema: { tags: T, summary: 'Sign out: the session token sent with it stops working everywhere at once' } }, async (req, reply) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (bearer?.startsWith(SESSION_PREFIX)) await db.query('delete from user_sessions where token_hash = $1', [hashToken(bearer)])
    reply.code(204).send()
  })
}

const entraBody = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(60).default('Microsoft').describe('The sign-in button says “Continue with <name>”'),
  tenantId: z.string().uuid().describe('Directory (tenant) ID'),
  apiClientId: z.string().uuid().describe('The API app registration: the audience of the tokens'),
  webClientId: z.string().uuid().describe('The single-page app registration the browser signs in with'),
  authority: z.string().trim().url().default(DEFAULT_AUTHORITY).transform(a => a.replace(/\/$/, '')).describe('https://login.microsoftonline.com, or a sovereign cloud'),
})

/** Signed in through the login form or Entra, changing one's own password (spec 0714 R8). */
export const ownPassword: FastifyPluginAsyncZod = async app => {
  app.put('/me/password', { schema: { tags: T, summary: 'Change your own password (internal directory users who have one): the current one, then the new one; your other login-form sessions end',
    body: z.object({ current: z.string().max(1024), password: z.string().max(1024) }) } }, async (req, reply) => {
    requireSignIn(req, 'change your password')
    const [u] = await db.query<{ passwordHash: string | null; directoryId: string | null }>('select password_hash, directory_id from users where id = $1', [req.me.id])
    if (!u?.passwordHash || u.directoryId) throw new HttpError(409, 'Your password isn’t kept in Strand')
    if (!(await verifyPassword(req.body.current, u.passwordHash))) throw new HttpError(400, 'That isn’t your current password', { current: 'Wrong password' })
    await checkLength(req.body.password)
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    await tx(async d => {
      await setPassword(d, req.me.id, req.body.password, bearer?.startsWith(SESSION_PREFIX) ? hashToken(bearer) : undefined)
      await audit(d, req, { action: 'user.password_set', type: 'user', id: req.me.id, name: req.me.email, after: { by: 'themselves' } })
    })
    reply.code(204).send()
  })
}

/** Can this Entra configuration sign people in? Entra's discovery document names the same issuer, and its keys load. */
async function checkEntra(e: z.infer<typeof entraBody>) {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(e.authority) && ['development', 'test'].includes(process.env.NODE_ENV ?? '')
  if (!e.authority.startsWith('https://') && !local) throw new HttpError(400, 'The authority must be an https address', { authority: 'Use https://' })
  const get = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null)
    return r?.ok ? r.json().catch(() => null) : null
  }
  const doc = await get(`${issuerOf(e)}/.well-known/openid-configuration`)
  if (!doc) throw new HttpError(400, 'Entra’s sign-in settings couldn’t be read: check the authority and the tenant ID', { tenantId: 'Not found' })
  if (doc.issuer !== issuerOf(e)) throw new HttpError(400, `Entra answered for another issuer (${doc.issuer}): check the tenant ID`, { tenantId: 'Another issuer' })
  if (!(await get(doc.jwks_uri))?.keys) throw new HttpError(400, 'Entra’s signing keys couldn’t be loaded', { tenantId: 'Keys not reachable' })
}

/** Changing how people sign in needs a system admin's sign-in, not an access token (R11); recovery_admin is there to do
 *  exactly this (R10). User directories (spec 0712) use it too. */
export function requireNoToken(req: FastifyRequest) {
  requireAdmin(req)
  if (req.me.via === 'pat') throw new HttpError(403, 'Sign in with your account to change authentication methods')
}

/** Administration › Authentication methods: system admins who signed in themselves (R11). */
const authentication: FastifyPluginAsyncZod = async app => {
  const view = async () => {
    const c = await getAuthConfig(db)
    return { loginForm: c.loginForm, fallback: c.fallback, entra: c.entra, recovery: !!recoveryPassword() }
  }
  app.get('/admin/authentication', { schema: { tags: T, summary: 'Authentication methods: the login form, its fallback, and Microsoft Entra (system administrators)' } }, async req => {
    requireAdmin(req)
    return view()
  })

  app.put('/admin/authentication', { schema: { tags: T, summary: 'Show or hide the login form, and turn the authentication fallback on or off (system administrators)',
    body: z.object({ loginForm: z.boolean(), fallback: z.boolean() }) } }, async req => {
    requireNoToken(req)
    await tx(async d => {
      const [before] = await d.query<{ loginForm: boolean; fallback: boolean; entra: EntraConfig | null }>('select login_form, fallback, entra from auth_config for update')
      if (!req.body.loginForm && !before!.entra?.enabled) throw new HttpError(409, ONE_WAY_IN, { loginForm: 'Nothing else is on' })
      await d.query('update auth_config set login_form = $1, fallback = $2, updated_at = now(), updated_by = $3', [req.body.loginForm, req.body.fallback, req.me.id])
      const c = changes({ loginForm: before!.loginForm, fallback: before!.fallback }, req.body)
      if (c.changed) await audit(d, req, { action: 'auth.methods.updated', type: 'auth', name: 'Authentication methods', before: c.before, after: c.after })
    })
    clearAuthConfigCache()
    return view()
  })

  app.put('/admin/authentication/entra', { schema: { tags: T, summary: 'Configure Microsoft Entra sign-in, and turn it on or off. Turning it on checks that Entra answers for the tenant (system administrators)',
    body: entraBody } }, async req => {
    requireNoToken(req)
    const e = req.body
    if (e.enabled) await checkEntra(e)
    await tx(async d => {
      const [before] = await d.query<{ loginForm: boolean; entra: EntraConfig | null }>('select login_form, entra from auth_config for update')
      if (!e.enabled && !before!.loginForm) throw new HttpError(409, ONE_WAY_IN, { enabled: 'The login form is hidden' })
      await d.query('update auth_config set entra = $1, updated_at = now(), updated_by = $2', [JSON.stringify(e), req.me.id])
      const c = changes((before!.entra ?? {}) as Record<string, unknown>, e)
      if (c.changed) await audit(d, req, { action: 'auth.entra.updated', type: 'auth', name: 'Microsoft Entra', before: c.before, after: c.after })
    })
    clearAuthConfigCache()
    return view()
  })
}

export default authentication
