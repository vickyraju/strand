import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.ENTRA_TENANT_ID ??= 't'; process.env.ENTRA_CLIENT_ID ??= 'c'   // auth.ts insists on these at import
const { rateLimiter, policyFor } = await import('../src/rateLimit.ts')

const general = { enabled: true, mode: 'limit' as const, requests: 2, intervalSeconds: 10, burst: 3, exemptions: [] }

test('rate limit: a bucket of `burst` requests refills at `requests` per interval; refused requests say when to retry', () => {
  const l = rateLimiter(), t0 = 1_000_000
  const p = policyFor(general, 'ann')!
  const took = [0, 1, 2, 3].map(i => l.take('ann', p, t0 + i))
  assert.deepEqual(took.map(v => v.allowed), [true, true, true, false])              // the bucket holds 3
  assert.deepEqual([took[0]!.headers['x-ratelimit-limit'], took[0]!.headers['x-ratelimit-fillrate'], took[0]!.headers['x-ratelimit-interval-seconds']], ['3', '2', '10'])
  assert.equal(took[2]!.headers['x-ratelimit-remaining'], '0')
  assert.equal(took[3]!.headers['retry-after'], '5')                                  // one request back every 5 s
  assert.equal(l.take('ann', p, t0 + 5_100).allowed, true)                            // …and there it is
  assert.equal(l.take('ben', p, t0 + 10).allowed, true)                               // someone else has their own bucket
  l.stop()
})

test('rate limit: off unless enabled; unlimited never refuses; block refuses everything; exemptions override for one person', () => {
  assert.equal(policyFor({ ...general, enabled: false }, 'ann'), null)
  assert.equal(policyFor({ ...general, mode: 'unlimited' }, 'ann'), null)
  const l = rateLimiter()
  assert.equal(l.take('ann', policyFor({ ...general, mode: 'block' }, 'ann')!).allowed, false)
  const withExemptions = { ...general, exemptions: [{ userId: 'bot', mode: 'unlimited' as const }, { userId: 'slow', mode: 'limit' as const, burst: 1 }] }
  assert.equal(policyFor(withExemptions, 'bot'), null)
  assert.deepEqual(policyFor(withExemptions, 'slow'), { mode: 'limit', requests: 2, intervalSeconds: 10, burst: 1 })   // the rest from the general setting
  assert.deepEqual(policyFor(withExemptions, 'ann'), withExemptions)
  l.stop()
})
