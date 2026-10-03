import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration, formatDuration } from './time.ts'

test('durations parse the way people type them', () => {
  assert.equal(parseDuration('1h 30m'), 90)
  assert.equal(parseDuration('45m'), 45)
  assert.equal(parseDuration('2d'), 960)
  assert.equal(parseDuration('1.5'), 90)
  assert.equal(parseDuration('1d4h'), 720)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration('3 apples'), null)
  assert.equal(parseDuration(''), null)
  assert.equal(formatDuration(90), '1h 30m')
  assert.equal(formatDuration(120), '2h')
  assert.equal(formatDuration(0), '0m')
})
