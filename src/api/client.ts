// Thin fetch wrapper for the Strand API. Off (apiEnabled = false) unless VITE_API_URL is set,
// in which case the app keeps using its local store. Every request carries the sign-in: a bearer token (Microsoft Entra,
// or the login form's session) or the dev login.
import { accessToken, forgetSession } from './auth.ts'

// Vite inlines import.meta.env in the browser build; scripts and tests under Node set VITE_API_URL in the environment instead.
const configured: string | undefined = import.meta.env?.VITE_API_URL ?? (typeof process !== 'undefined' ? process.env.VITE_API_URL : undefined)
export const API_URL: string | undefined = configured?.replace(/\/$/, '') || undefined
export const apiEnabled = !!API_URL

/** Path prefix of the API. The server serves /api/v1 (documented) and the older /api; set VITE_API_PREFIX=/api/v1 once the
 *  deployed API has /api/v1, and every call moves with no code change. */
const prefixSetting: string | undefined = import.meta.env?.VITE_API_PREFIX ?? (typeof process !== 'undefined' ? process.env.VITE_API_PREFIX : undefined)
export const API_PREFIX = (prefixSetting ?? '/api').replace(/\/$/, '')

/** Call sites write '/api/...'; this swaps in the configured prefix. */
export const withPrefix = (path: string, prefix = API_PREFIX) => (path.startsWith('/api/') ? prefix + path.slice(4) : path)

/** Dev login (AUTH_DEV, development only; spec 0711 R13): sent as x-dev-* headers. */
export interface DevLogin { email: string; secret: string }

const KEY = 'strand:dev-login'   // sessionStorage: the secret is gone when the tab closes

export function getLogin(): DevLogin | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') } catch { return null }
}
export const setLogin = (l: DevLogin | null) =>
  l ? sessionStorage.setItem(KEY, JSON.stringify(l)) : sessionStorage.removeItem(KEY)

export class ApiError extends Error {
  status: number
  errors?: Record<string, string>   // per-field messages, when the server checked a form
  constructor(status: number, message: string, errors?: Record<string, string>) { super(message); this.status = status; this.errors = errors }
}

/** What to tell a person when a call failed: the server's own words, or that it couldn't be reached. */
export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

/** How a request signs in: a bearer token, else the dev login. */
export interface Credentials { token: string | null; login: DevLogin | null }
export const credentials = async (): Promise<Credentials> => ({ token: await accessToken(), login: getLogin() })

export function buildRequest(base: string, c: Credentials, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  const h: Record<string, string> = { ...headers }
  if (c.token) h.authorization = `Bearer ${c.token}`
  else if (c.login) { h['x-dev-user'] = c.login.email; h['x-dev-secret'] = c.login.secret }
  if (body !== undefined) h['content-type'] = 'application/json'
  return [base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }]
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  if (!API_URL) throw new ApiError(0, 'API is not configured (VITE_API_URL)')
  const res = await fetch(...buildRequest(API_URL, await credentials(), method, withPrefix(path), body, headers))
  if (res.status === 401) forgetSession()           // token refused: back to the sign-in screen
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.errors)
  return data as T
}
