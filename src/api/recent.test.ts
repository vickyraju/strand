import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushRecent, keysToLoad } from './recent.ts'

test('recent projects: newest first, no duplicates, case-insensitive, capped at 30', () => {
  assert.deepEqual(pushRecent(['PAY', 'API'], 'api'), ['API', 'PAY'])
  assert.deepEqual(pushRecent([], 'pay'), ['PAY'])
  const many = Array.from({ length: 40 }, (_, i) => `K${i}`)
  const out = pushRecent(many, 'NEW')
  assert.equal(out.length, 30); assert.equal(out[0], 'NEW'); assert.ok(!out.includes('K39'))
})

test('startup loads starred first, then recent, then what is already on screen, without repeats, up to the cap', () => {
  assert.deepEqual(keysToLoad(['PAY', 'api'], ['API', 'OPS', 'pay'], ['OPS', 'DOC']), ['PAY', 'API', 'OPS', 'DOC'])
  assert.deepEqual(keysToLoad([], [], []), [])
  const stars = Array.from({ length: 100 }, (_, i) => `S${i}`)
  assert.equal(keysToLoad(stars, ['X'], []).length, 60)
  assert.equal(keysToLoad(stars, ['X'], [], 5).join(), 'S0,S1,S2,S3,S4')
})
