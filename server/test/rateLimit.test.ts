import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.ENTRA_TENANT_ID ??= 't'; process.env.ENTRA_CLIENT_ID ??= 'c'   // auth.ts insists on these at import
const { rateLimiter } = await import('../src/rateLimit.ts')

test('rate limit: the limit per key per minute, then 429 with when to retry; a new minute starts over; keys are separate', () => {
  const l = rateLimiter(3)
  const t0 = 1_000_000
  for (let i = 0; i < 3; i++) l.check('ann', t0 + i)
  assert.throws(() => l.check('ann', t0 + 10), (e: any) => e.status === 429 && e.retryAfter === 60)
  l.check('ben', t0 + 10)                                                    // someone else is not affected
  assert.throws(() => l.check('ann', t0 + 30_000), (e: any) => e.retryAfter === 30)
  l.check('ann', t0 + 60_000)                                                // the window has passed
  l.stop()
})
