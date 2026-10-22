// Microsoft Entra ID sign-in for the browser: OAuth 2.0 authorization code flow with PKCE (no client secret, no library).
// The API receives the access token as a bearer token and checks it against Entra's published signing keys.
// Entra setup (single-page application registration, exposed `access_as_user` scope) is described in the README.

const TENANT: string | undefined = import.meta.env?.VITE_ENTRA_TENANT_ID ?? (typeof process !== 'undefined' ? process.env.VITE_ENTRA_TENANT_ID : undefined)
const CLIENT: string | undefined = import.meta.env?.VITE_ENTRA_CLIENT_ID ?? (typeof process !== 'undefined' ? process.env.VITE_ENTRA_CLIENT_ID : undefined)
const authorityEnv: string | undefined = import.meta.env?.VITE_ENTRA_AUTHORITY ?? (typeof process !== 'undefined' ? process.env.VITE_ENTRA_AUTHORITY : undefined)
// Public cloud by default; set VITE_ENTRA_AUTHORITY for a sovereign cloud (e.g. https://login.microsoftonline.us)
const AUTHORITY = (authorityEnv ?? 'https://login.microsoftonline.com').replace(/\/$/, '')

export const authConfigured = !!TENANT && !!CLIENT

// —— Pure helpers (unit-tested) ——

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** PKCE: the challenge is the base64url SHA-256 of the verifier (RFC 7636). */
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export const scopeFor = (clientId: string) => `api://${clientId}/access_as_user openid profile email offline_access`

export function authorizeUrl(o: { authority: string; tenant: string; clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, response_type: 'code', redirect_uri: o.redirectUri, response_mode: 'query',
    scope: scopeFor(o.clientId), state: o.state, code_challenge: o.challenge, code_challenge_method: 'S256',
  })
  return `${o.authority}/${o.tenant}/oauth2/v2.0/authorize?${q}`
}

export interface Session { access: string; refresh?: string; expiresAt: number }
/** Refresh a minute early so a request never leaves with a token that expires in flight. */
export const needsRefresh = (s: Session, now = Date.now()) => s.expiresAt - 60_000 <= now

// —— Session (browser only) ——

const SESSION = 'jira-build:session', PENDING = 'jira-build:signin'   // sessionStorage: gone when the tab closes
const redirectUri = () => location.origin + '/'

const load = (): Session | null => { try { return JSON.parse(sessionStorage.getItem(SESSION) ?? 'null') } catch { return null } }
let session: Session | null = typeof sessionStorage === 'undefined' ? null : load()
const save = () => (session ? sessionStorage.setItem(SESSION, JSON.stringify(session)) : sessionStorage.removeItem(SESSION))

/** The server turned the token down: forget it and tell the app to show the sign-in screen. */
export function forgetSession() {
  session = null; save()
  window.dispatchEvent(new Event('jira-build:signed-out'))
}
export const hasSession = () => !!session

class RejectedError extends Error {}   // Entra answered and said no (as opposed to the network failing)

async function tokenRequest(params: Record<string, string>): Promise<Session> {
  const res = await fetch(`${AUTHORITY}/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT!, scope: scopeFor(CLIENT!), ...params }),
  })
  const d = await res.json().catch(() => null)
  if (!res.ok || !d?.access_token) throw new RejectedError(String(d?.error_description ?? 'Sign-in failed').split(/\r?\n/)[0])
  return { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 }
}

/** Send the browser to Microsoft to sign in; it comes back to `/` with a code that `completeSignIn` exchanges. */
export async function signIn() {
  const verifier = randomToken(), state = randomToken(16)
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, returnTo: location.pathname + location.search + location.hash }))
  location.assign(authorizeUrl({ authority: AUTHORITY, tenant: TENANT!, clientId: CLIENT!, redirectUri: redirectUri(), challenge: await challengeOf(verifier), state }))
}

/** On return from Microsoft: check `state`, swap the code for tokens, and put the URL back to where the user was.
 *  Resolves true when a sign-in was completed, false when this page load is not a sign-in return; throws with a message on failure. */
export async function completeSignIn(): Promise<boolean> {
  const q = new URLSearchParams(location.search)
  if (!q.has('state') || !(q.has('code') || q.has('error'))) return false
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { verifier: string; state: string; returnTo: string } | null
  sessionStorage.removeItem(PENDING)
  history.replaceState(null, '', pending?.returnTo ?? '/')                      // the code must not stay in the address bar
  if (q.has('error')) throw new Error(q.get('error_description')?.split(/\r?\n/)[0] ?? 'Sign-in was cancelled')
  if (!pending || q.get('state') !== pending.state) throw new Error('That sign-in was not started in this tab. Please try again.')
  session = await tokenRequest({ grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: redirectUri(), code_verifier: pending.verifier })
  save()
  return true
}

let refreshing: Promise<string | null> | null = null

/** A valid access token for the API, refreshed when it is about to expire; null when there is no session. */
export async function accessToken(): Promise<string | null> {
  if (!session) return null
  if (!needsRefresh(session)) return session.access
  const old = session
  if (!old.refresh) { forgetSession(); return null }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh })
    .then(s => { session = { ...s, refresh: s.refresh ?? old.refresh }; save(); return session.access })
    .catch(e => {
      if (e instanceof RejectedError) { forgetSession(); return null }
      return old.access                                                          // network trouble: try the old token, keep the session
    })
    .finally(() => { refreshing = null })
  return refreshing
}

export function signOut() {
  if (!authConfigured) { location.reload(); return }
  session = null; save()
  location.assign(`${AUTHORITY}/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri())}`)
}
