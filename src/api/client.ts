// Thin fetch wrapper for the Strand API. Off (apiEnabled = false) unless VITE_API_URL is set,
// in which case the app keeps using its local store.

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

/** Dev login (no Entra yet): sent as x-dev-* headers. Entra will replace this with a bearer token. */
export interface DevLogin { email: string; secret: string }

const KEY = 'strand:dev-login'   // sessionStorage: the secret is gone when the tab closes

export function getLogin(): DevLogin | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') } catch { return null }
}
export const setLogin = (l: DevLogin | null) =>
  l ? sessionStorage.setItem(KEY, JSON.stringify(l)) : sessionStorage.removeItem(KEY)

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function buildRequest(base: string, login: DevLogin | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  const h: Record<string, string> = { ...headers }
  if (login) { h['x-dev-user'] = login.email; h['x-dev-secret'] = login.secret }
  if (body !== undefined) h['content-type'] = 'application/json'
  return [base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }]
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  if (!API_URL) throw new ApiError(0, 'API is not configured (VITE_API_URL)')
  const res = await fetch(...buildRequest(API_URL, getLogin(), method, withPrefix(path), body, headers))
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`)
  return data as T
}
