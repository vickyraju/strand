// Authentication methods (spec 0711), as Jira's Administration › Authentication methods: whether the login form shows,
// whether it stays reachable when hidden (fallback), and Microsoft Entra's configuration. One row for the whole system,
// read before anyone signs in; cached on each server for a few seconds, so a change reaches every server quickly.
import { createRemoteJWKSet } from 'jose'
import type { FastifyBaseLogger } from 'fastify'
import { db, type Db } from './db.ts'
import { getSetting, SETTINGS } from './settings.ts'

export interface EntraConfig { enabled: boolean; name: string; tenantId: string; apiClientId: string; webClientId: string; authority: string }
export interface AuthConfig { loginForm: boolean; fallback: boolean; entra: EntraConfig | null }

const CACHE_MS = 10_000
let cached: { at: number; value: AuthConfig } | null = null

export async function getAuthConfig(d: Db = db): Promise<AuthConfig> {
  if (d === db && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const [r] = await d.query<AuthConfig>('select login_form, fallback, entra from auth_config')
  const value = r ?? { loginForm: true, fallback: false, entra: null }
  if (d === db) cached = { at: Date.now(), value }
  return value
}
export const clearAuthConfigCache = () => { cached = null }

export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com'
export const issuerOf = (e: Pick<EntraConfig, 'authority' | 'tenantId'>) => `${e.authority}/${e.tenantId}/v2.0`
export const scopeOf = (e: Pick<EntraConfig, 'apiClientId'>) => `api://${e.apiClientId}/access_as_user openid profile email offline_access`

/** Entra's signing keys, one set per tenant (jose refreshes a set when Entra rotates its keys). */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export function keysFor(e: Pick<EntraConfig, 'authority' | 'tenantId'>) {
  const url = `${e.authority}/${e.tenantId}/discovery/v2.0/keys`
  let set = keySets.get(url)
  if (!set) keySets.set(url, set = createRemoteJWKSet(new URL(url)))
  return set
}

/** Recovery mode (Jira's): on while the server has RECOVERY_PASSWORD, at least 16 characters long. */
export const RECOVERY_USER = 'recovery_admin'
export const recoveryPassword = () => { const p = process.env.RECOVERY_PASSWORD ?? ''; return p.length >= 16 ? p : null }

/** Sign-in limits (System settings › Sign-in), from the workspace; before there is one, the defaults. */
export async function signInSettings(d: Db = db) {
  const [w] = await d.query<{ id: string }>('select id from workspaces order by created_at limit 1')
  return w ? getSetting(w.id, 'signIn', d) : SETTINGS.signIn.default
}

/** At start: an upgraded server keeps signing in as before (Entra from ENTRA_* the first time, then the stored
 *  configuration wins), and recovery_admin is only usable while recovery mode is on. */
export async function startAuth(log: FastifyBaseLogger) {
  const env = process.env
  const [cfg] = await db.query<{ entra: EntraConfig | null }>('select entra from auth_config')
  if (cfg && !cfg.entra && env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID) {
    const entra: EntraConfig = {
      enabled: true, name: 'Microsoft', tenantId: env.ENTRA_TENANT_ID, apiClientId: env.ENTRA_CLIENT_ID,
      webClientId: env.ENTRA_WEB_CLIENT_ID ?? '', authority: (env.ENTRA_AUTHORITY ?? DEFAULT_AUTHORITY).replace(/\/$/, ''),
    }
    await db.query('update auth_config set entra = $1, updated_at = now()', [JSON.stringify(entra)])
    await db.query(`insert into audit_log (workspace_id, actor, action, target_type, target, after)
      values ((select id from workspaces order by created_at limit 1), 'Jira Build POC', 'auth.entra.seeded', 'auth', 'Microsoft Entra', $1)`, [JSON.stringify(entra)])
    if (!entra.webClientId) log.warn('ENTRA_WEB_CLIENT_ID is not set: browsers can’t sign in with Microsoft until an admin sets the web client id (Administration › Authentication methods)')
    clearAuthConfigCache()
  }
  if (recoveryPassword()) {
    log.warn('Jira Build POC is running in recovery mode (RECOVERY_PASSWORD is set): remove it once access is restored')
    await db.query('update users set active = true where lower(username) = $1', [RECOVERY_USER])
  } else {
    // out of recovery mode: recovery_admin can't sign in, and loses what it had
    await db.query(`delete from group_members where user_id in (select id from users where lower(username) = $1)
                      and group_id in (select id from groups where system_role = 'system-admins')`, [RECOVERY_USER])
    await db.query(`delete from user_sessions where via = 'recovery'`)
    await db.query('update users set active = false where lower(username) = $1', [RECOVERY_USER])
  }
}
