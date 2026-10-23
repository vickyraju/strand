import { HttpError } from './auth.ts'

/** Requests allowed per person (or token) per minute; RATE_LIMIT_PER_MIN=0 turns the limit off. */
export const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 600)

/** A fixed one-minute window per key. Over the limit: 429 with Retry-After (seconds).
 *  ponytail: counts live in each API pod's memory, so with N pods someone can make up to N × the limit;
 *  move the counts to a shared store if the limit has to be exact. */
export function rateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; until: number }>()
  const prune = setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.until <= now) hits.delete(k) }, windowMs)
  prune.unref()
  return {
    check(key: string, now = Date.now()) {
      let h = hits.get(key)
      if (!h || h.until <= now) hits.set(key, h = { n: 0, until: now + windowMs })
      if (++h.n <= limit) return
      const e = new HttpError(429, `Too many requests: at most ${limit} a minute. Try again shortly.`)
      ;(e as any).retryAfter = Math.ceil((h.until - now) / 1000)
      throw e
    },
    stop: () => clearInterval(prune),
  }
}
