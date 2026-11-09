// Local users (spec 0714), as Jira's internal directory: everyone not from a user directory. Their passwords, the links
// that set one, and the emails that carry those links.
import { randomBytes } from 'node:crypto'
import { db, type Db } from './db.ts'
import { HttpError, hashToken, type Identity } from './auth.ts'
import { RECOVERY_USER, signInSettings } from './authConfig.ts'
import { hashPassword, verifyPassword, wasteCheck } from './passwords.ts'
import { getSetting } from './settings.ts'
import { sendEmail } from './email.ts'

export const RESET_PREFIX = 'jbr_'
export const RESET_FORMAT = /^jbr_[A-Za-z0-9_-]{43}$/
const LINK_HOURS = 24

/** The login form's first stop (R1): an internal directory user with this username decides; undefined when there is none. */
export async function checkInternal(username: string, password: string): Promise<Identity | null | undefined> {
  const [u] = await db.query<{ passwordHash: string | null; email: string; name: string; username: string }>(
    'select password_hash, email, name, username from users where lower(username) = lower($1) and directory_id is null', [username])
  if (!u) { await wasteCheck(password); return undefined }                     // the same time either way
  if (!u.passwordHash || !(await verifyPassword(password, u.passwordHash))) return null
  return { username: u.username, email: u.email, name: u.name, admin: false }
}

/** A password long enough for System settings › Sign-in (R5); the field's message otherwise. */
export async function checkLength(password: string, field = 'password') {
  const { passwordMinLength } = await signInSettings()
  if (password.length < passwordMinLength) throw new HttpError(400, `The password needs at least ${passwordMinLength} characters`, { [field]: `At least ${passwordMinLength} characters` })
}

/** A new password for someone in the internal directory; their login-form sessions end, except `keep` (R4, R7, R8). */
export async function setPassword(d: Db, userId: string, password: string, keep?: Buffer) {
  await d.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [userId, await hashPassword(password)])
  await d.query('delete from user_sessions where user_id = $1 and token_hash is distinct from $2', [userId, keep ?? null])
}

/** Someone in the internal directory who may be sent a link: found by username or email, active, not recovery_admin. */
export const internalPerson = async (who: string) => (await db.query<{ id: string; email: string; name: string; username: string | null }>(
  `select id, email, name, username from users where (lower(username) = lower($1) or email = lower($1)) and directory_id is null and active and username is distinct from $2 limit 1`,
  [who, RECOVERY_USER]))[0]

/** Email can carry a link: a sender and the app's address in System settings › Email notifications, and a transport. */
export async function emailSetup(d: Db = db) {
  const [w] = await d.query<{ id: string }>('select id from workspaces order by created_at limit 1')
  if (!w || !process.env.EMAIL_TRANSPORT) return null
  const s = await getSetting(w.id, 'email', d)
  return s.from && s.appUrl ? { from: s.from, appUrl: s.appUrl.replace(/\/$/, '') } : null
}

/** A one-time link to set a password, valid 24 hours (R7). */
export async function newLink(d: Db, userId: string) {
  const token = RESET_PREFIX + randomBytes(32).toString('base64url')
  await d.query(`insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))`, [hashToken(token), userId, LINK_HOURS])
  return token
}

/** The email with the link: "your account" (created by an admin) or "reset your password" (asked for on the login form). */
export async function sendLink(to: { email: string; name: string; username: string | null }, token: string, kind: 'created' | 'reset') {
  const s = await emailSetup()
  if (!s) throw new Error('Email isn’t set up')
  const link = `${s.appUrl}/?reset=${token}`
  const intro = kind === 'created'
    ? `An administrator made you a Strand account${to.username ? ` with the username ${to.username}` : ''}. Set your password here:`
    : `Someone (hopefully you) asked to reset the password of your Strand account${to.username ? ` (${to.username})` : ''}. Set a new one here:`
  const tail = `The link works once, for ${LINK_HOURS} hours.${kind === 'reset' ? ' If you didn’t ask, ignore this email: your password stays as it was.' : ''}`
  const esc = (x: string) => x.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  await sendEmail({
    to: to.email, from: s.from, subject: kind === 'created' ? 'Your Strand account' : 'Reset your Strand password',
    text: `Hi ${to.name},\n\n${intro}\n${link}\n\n${tail}\n`,
    html: `<p>Hi ${esc(to.name)},</p><p>${esc(intro)}</p><p><a href="${esc(link)}">Set your password</a></p><p>${esc(tail)}</p>`,
  })
}

/** At most one link email per person every 5 minutes (R6). */
export const recentlySent = async (userId: string) =>
  (await db.query(`select 1 from password_resets where user_id = $1 and created_at > now() - interval '5 minutes' limit 1`, [userId])).length > 0
