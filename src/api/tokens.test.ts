import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeCount, curlExample, tokenStatus, type AccessToken } from './tokens.ts'

const DAY = 86_400_000
const at = (days: number, now: number) => new Date(now + days * DAY).toISOString()
const NOW = Date.parse('2026-10-23T10:00:00Z')

test('a token is active, expiring soon (5 days or fewer), or expired', () => {
  assert.equal(tokenStatus({ expiresAt: at(30, NOW), expired: false }, NOW), 'active')
  assert.equal(tokenStatus({ expiresAt: at(5.01, NOW), expired: false }, NOW), 'active')
  assert.equal(tokenStatus({ expiresAt: at(5, NOW), expired: false }, NOW), 'expires-soon')
  assert.equal(tokenStatus({ expiresAt: at(0.1, NOW), expired: false }, NOW), 'expires-soon')
  assert.equal(tokenStatus({ expiresAt: at(-1, NOW), expired: true }, NOW), 'expired')
  assert.equal(tokenStatus({ expiresAt: at(3, NOW), expired: true }, NOW), 'expired')   // the server's word wins over a skewed clock
})

test('only unexpired tokens count toward the limit', () => {
  const t = (expired: boolean): AccessToken => ({ id: '', name: '', hint: '', createdAt: '', expiresAt: '', lastUsedAt: null, expired })
  assert.equal(activeCount([t(false), t(true), t(false)]), 2)
})

test('the example call uses the API address and the token', () => {
  assert.equal(curlExample('https://app.example.com', 'jbp_x'), 'curl -H "Authorization: Bearer jbp_x" https://app.example.com/api/v1/me')
})
