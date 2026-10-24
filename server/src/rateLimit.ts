// Rate limiting, the way Jira Data Center does it (Administration › System › Rate limiting):
// - Off until a workspace admin turns it on in System settings. No limit is built in.
// - Only requests made with personal access tokens (scripts, integrations) count. People using the web app are never limited.
// - A token bucket per person: `requests` new requests every `intervalSeconds`, saving up unused ones to `burst`.
// - Modes: limit (the numbers), unlimited (never refuse), block (refuse every token request). Exemptions give one person
//   their own mode and numbers.
// - Every token response says where the person stands (X-RateLimit-*), and a refused one gets 429 with Retry-After.
// ponytail: buckets live in each API pod's memory, so the limit applies per pod (as Jira's applies per node).
import { HttpError } from './auth.ts'
import { db } from './db.ts'

export interface Policy { mode: 'limit' | 'unlimited' | 'block'; requests: number; intervalSeconds: number; burst: number }
export interface RateSettings extends Policy {
  enabled: boolean
  exemptions: (Partial<Policy> & { userId: string; mode: Policy['mode'] })[]
}

/** The policy that applies to one person: their exemption (filled in from the general numbers), or the general one. Null: no limit. */
export function policyFor(s: RateSettings, userId: string): Policy | null {
  if (!s.enabled) return null
  const ex = s.exemptions.find(e => e.userId === userId)
  const p: Policy = ex ? { mode: ex.mode, requests: ex.requests ?? s.requests, intervalSeconds: ex.intervalSeconds ?? s.intervalSeconds, burst: ex.burst ?? s.burst } : s
  return p.mode === 'unlimited' ? null : p
}

export interface Verdict { allowed: boolean; headers: Record<string, string> }

/** Buckets per person. A bucket refills continuously; its size follows the policy, so a change applies at once. */
export function rateLimiter() {
  const buckets = new Map<string, { tokens: number; at: number }>()
  const prune = setInterval(() => { const cutoff = Date.now() - 86_400_000; for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k) }, 3_600_000)
  prune.unref()
  return {
    take(userId: string, p: Policy, now = Date.now()): Verdict {
      if (p.mode === 'block') return { allowed: false, headers: { 'retry-after': '3600' } }
      const rate = p.requests / p.intervalSeconds                       // requests regained per second
      const b = buckets.get(userId) ?? { tokens: p.burst, at: now }
      b.tokens = Math.min(p.burst, b.tokens + ((now - b.at) / 1000) * rate)
      b.at = now
      buckets.set(userId, b)
      const allowed = b.tokens >= 1
      if (allowed) b.tokens -= 1
      const headers: Record<string, string> = {
        'x-ratelimit-limit': String(p.burst), 'x-ratelimit-remaining': String(Math.floor(b.tokens)),
        'x-ratelimit-interval-seconds': String(p.intervalSeconds), 'x-ratelimit-fillrate': String(p.requests),
      }
      if (!allowed) headers['retry-after'] = String(Math.max(1, Math.ceil((1 - b.tokens) / rate)))
      return { allowed, headers }
    },
    stop: () => clearInterval(prune),
  }
}

export const tooMany = (p: Policy) => new HttpError(429, p.mode === 'block'
  ? 'Requests with access tokens are blocked by your administrator.'
  : `Too many requests: at most ${p.requests} every ${p.intervalSeconds} seconds with access tokens. Try again shortly.`)

/** Records that someone was refused, for the "Limited accounts" list. At most once a minute per person and pod, so a
 *  script hammering the API does not turn every refusal into a write. */
const noted = new Map<string, number>()
export async function noteLimited(workspaceId: string, userId: string, now = Date.now()) {
  if ((noted.get(userId) ?? 0) > now - 60_000) return
  noted.set(userId, now)
  await db.query(
    `insert into rate_limited_accounts (workspace_id, user_id) values ($1, $2)
     on conflict (workspace_id, user_id) do update set last_at = now(), times = rate_limited_accounts.times + 1`, [workspaceId, userId])
}
