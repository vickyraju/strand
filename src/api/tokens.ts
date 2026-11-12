// Personal access tokens: create one under Settings, send it as `Authorization: Bearer <token>` from scripts.
import { api } from './client.ts'

export interface AccessToken {
  id: string; name: string; hint: string
  createdAt: string; expiresAt: string; lastUsedAt: string | null; expired: boolean
}
export interface CreatedToken extends AccessToken { token: string }

/** Lifetimes to offer: the usual ones up to the longest allowed (System settings), plus the default and the longest. */
export function expiryChoices(maxDays: number, defaultDays: number): number[] {
  return [...new Set([7, 30, 90, 180, 365, defaultDays, maxDays])].filter(d => d <= maxDays).sort((a, b) => a - b)
}
export const daysLabel = (d: number) => (d % 365 === 0 ? (d === 365 ? '1 year' : `${d / 365} years`) : `${d} days`)
const SOON_DAYS = 5   // the "expires soon" warning window (the same as Atlassian's)

export const listTokens = () => api<AccessToken[]>('GET', '/api/me/tokens')
export const createToken = (name: string, expiresInDays: number) => api<CreatedToken>('POST', '/api/me/tokens', { name, expiresInDays })
export const revokeToken = (id: string) => api<void>('DELETE', `/api/me/tokens/${encodeURIComponent(id)}`)

/** active, expiring within 5 days, or expired. The server's `expired` flag decides the last one. */
export function tokenStatus(t: Pick<AccessToken, 'expiresAt' | 'expired'>, now = Date.now()): 'active' | 'expires-soon' | 'expired' {
  if (t.expired) return 'expired'
  return Date.parse(t.expiresAt) - now <= SOON_DAYS * 86_400_000 ? 'expires-soon' : 'active'
}

export const activeCount = (tokens: AccessToken[]) => tokens.filter(t => !t.expired).length

/** The call a person can paste to check their new token works. */
export const curlExample = (apiUrl: string, token: string) => `curl -H "Authorization: Bearer ${token}" ${apiUrl}/api/v1/me`
