// Thin fetch wrapper for the API. Off (apiEnabled = false) unless VITE_API_URL is set,
// in which case the app keeps using its local store. Every request carries the signed-in user's Entra access token.
import { accessToken, forgetSession } from './auth.ts'

// Vite inlines import.meta.env in the browser build; scripts and tests under Node set VITE_API_URL in the environment instead.
const configured: string | undefined = import.meta.env?.VITE_API_URL ?? (typeof process !== 'undefined' ? process.env.VITE_API_URL : undefined)
export const API_URL: string | undefined = configured?.replace(/\/$/, '') || undefined
export const apiEnabled = !!API_URL

/** Path prefix of the API (VITE_API_PREFIX overrides it, e.g. behind a gateway that mounts the API elsewhere). */
const prefixSetting: string | undefined = import.meta.env?.VITE_API_PREFIX ?? (typeof process !== 'undefined' ? process.env.VITE_API_PREFIX : undefined)
export const API_PREFIX = (prefixSetting ?? '/api/v1').replace(/\/$/, '')

/** Call sites write '/api/...'; this swaps in the configured prefix. */
export const withPrefix = (path: string, prefix = API_PREFIX) => (path.startsWith('/api/') ? prefix + path.slice(4) : path)

export class ApiError extends Error {
  status: number
  errors?: Record<string, string>   // per-field messages, when the server checked a form
  constructor(status: number, message: string, errors?: Record<string, string>) { super(message); this.status = status; this.errors = errors }
}

export function buildRequest(base: string, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  const h: Record<string, string> = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined) h['content-type'] = 'application/json'
  return [base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }]
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  if (!API_URL) throw new ApiError(0, 'API is not configured (VITE_API_URL)')
  const res = await fetch(...buildRequest(API_URL, await accessToken(), method, withPrefix(path), body, headers))
  if (res.status === 401) forgetSession()           // token refused: back to the sign-in screen
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.errors)
  return data as T
}
