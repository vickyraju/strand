// Signing in from the browser (spec 0711). Two ways, as the server's Authentication methods say (GET /auth/config):
// - Microsoft Entra ID: OAuth 2.0 authorization code flow with PKCE (no client secret, no library). The API receives the
//   access token as a bearer token and checks it against Entra's published signing keys.
// - The login form: a username and password, answered with a Strand session token (`jbs_…`).
// Entra setup (single-page application registration, exposed `access_as_user` scope) is described in the README.
import { API_URL, buildRequest, withPrefix } from './client.ts'

/** Entra's public settings, as the server publishes them. */
export interface EntraClient { name: string; tenantId: string; clientId: string; authority: string; scope: string }
export interface AuthConfig { loginForm: boolean; fallback: boolean; entra: EntraClient | null; /** A Public announcement (spec 0701) */ announcement?: string | null }

// —— Pure helpers (unit-tested) ——

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** PKCE: the challenge is the base64url SHA-256 of the verifier (RFC 7636). */
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export function authorizeUrl(e: EntraClient, o: { redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: e.clientId, response_type: 'code', redirect_uri: o.redirectUri, response_mode: 'query',
    scope: e.scope, state: o.state, code_challenge: o.challenge, code_challenge_method: 'S256',
  })
  return `${e.authority}/${e.tenantId}/oauth2/v2.0/authorize?${q}`
}

/** Entra sessions carry their refresh token and the settings they came from; login-form sessions only the token. */
export interface Session { access: string; refresh?: string; expiresAt: number; entra?: EntraClient; remember?: boolean }
/** Refresh a minute early so a request never leaves with a token that expires in flight. */
export const needsRefresh = (s: Session, now = Date.now()) => s.expiresAt - 60_000 <= now

/** The login form shows when the admin shows it, with `?auth_fallback` (R6, and recovery mode), or when nothing else is on. */
export const showsLoginForm = (c: AuthConfig, search: string) => c.loginForm || !c.entra || new URLSearchParams(search).has('auth_fallback')

// —— Session (browser only) ——

// sessionStorage: gone when the tab closes; a remembered login-form session lives in localStorage
const SESSION = 'jira-build:session', PENDING = 'jira-build:signin'
const redirectUri = () => location.origin + '/'

const read = (s: Storage) => { try { return JSON.parse(s.getItem(SESSION) ?? 'null') as Session | null } catch { return null } }
let session: Session | null = typeof sessionStorage === 'undefined' ? null : read(sessionStorage) ?? read(localStorage)
const save = () => {
  sessionStorage.removeItem(SESSION); localStorage.removeItem(SESSION)
  if (session) (session.remember ? localStorage : sessionStorage).setItem(SESSION, JSON.stringify(session))
}

/** The server turned the token down: forget it and tell the app to show the sign-in screen. */
export function forgetSession() {
  session = null; save()
  window.dispatchEvent(new Event('jira-build:signed-out'))
}
export const hasSession = () => !!session

class RejectedError extends Error {}   // Entra answered and said no (as opposed to the network failing)

async function tokenRequest(e: EntraClient, params: Record<string, string>): Promise<Session> {
  const res = await fetch(`${e.authority}/${e.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, scope: e.scope, ...params }),
  })
  const d = await res.json().catch(() => null)
  if (!res.ok || !d?.access_token) throw new RejectedError(String(d?.error_description ?? 'Sign-in failed').split(/\r?\n/)[0])
  return { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000, entra: e }
}

/** Send the browser to Microsoft to sign in; it comes back to `/` with a code that `completeSignIn` exchanges. */
export async function signIn(entra: EntraClient) {
  const verifier = randomToken(), state = randomToken(16)
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, entra, returnTo: location.pathname + location.search + location.hash }))
  location.assign(authorizeUrl(entra, { redirectUri: redirectUri(), challenge: await challengeOf(verifier), state }))
}

/** On return from Microsoft: check `state`, swap the code for tokens, and put the URL back to where the user was.
 *  Resolves true when a sign-in was completed, false when this page load is not a sign-in return; throws with a message on failure. */
export async function completeSignIn(): Promise<boolean> {
  const q = new URLSearchParams(location.search)
  if (!q.has('state') || !(q.has('code') || q.has('error'))) return false
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { verifier: string; state: string; entra: EntraClient; returnTo: string } | null
  sessionStorage.removeItem(PENDING)
  history.replaceState(null, '', pending?.returnTo ?? '/')                      // the code must not stay in the address bar
  if (q.has('error')) throw new Error(q.get('error_description')?.split(/\r?\n/)[0] ?? 'Sign-in was cancelled')
  if (!pending || q.get('state') !== pending.state) throw new Error('That sign-in was not started in this tab. Please try again.')
  session = await tokenRequest(pending.entra, { grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: redirectUri(), code_verifier: pending.verifier })
  save()
  return true
}

/** The login form signed in: keep the server's session token for the tab or, remembered, on this computer. */
export function passwordSignedIn(token: string, expiresAt: string, remember: boolean) {
  session = { access: token, expiresAt: Date.parse(expiresAt), remember }
  save()
}

let refreshing: Promise<string | null> | null = null

/** A valid access token for the API, refreshed when it is about to expire; null when there is no session. */
export async function accessToken(): Promise<string | null> {
  if (!session) return null
  if (!needsRefresh(session)) return session.access
  const old = session
  if (!old.refresh || !old.entra) { forgetSession(); return null }               // a login-form session simply ends
  refreshing ??= tokenRequest(old.entra, { grant_type: 'refresh_token', refresh_token: old.refresh })
    .then(s => { session = { ...s, refresh: s.refresh ?? old.refresh }; save(); return session.access })
    .catch(e => {
      if (e instanceof RejectedError) { forgetSession(); return null }
      return old.access                                                          // network trouble: try the old token, keep the session
    })
    .finally(() => { refreshing = null })
  return refreshing
}

/** Sign out: a login-form session ends on the server at once; an Entra one signs out at Microsoft too. */
export async function signOut() {
  const s = session
  session = null; save()
  if (s?.entra) { location.assign(`${s.entra.authority}/${s.entra.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri())}`); return }
  if (s && API_URL) await fetch(...buildRequest(API_URL, s.access, 'POST', withPrefix('/api/auth/logout'))).catch(() => {})
  location.assign('/')
}
