import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration, formatDuration, statLabel, DEFAULT_TIME } from './time.ts'
import { statOf } from './reducer.ts'

test('[0016.R7] durations parse the way people type them', () => {
  assert.equal(parseDuration('1h 30m'), 90)
  assert.equal(parseDuration('45m'), 45)
  assert.equal(parseDuration('2d'), 960)
  assert.equal(parseDuration('1d4h'), 720)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration('3 apples'), null)
  assert.equal(parseDuration(''), null)
  assert.equal(formatDuration(90), '1h 30m')
  assert.equal(formatDuration(120), '2h')
  assert.equal(formatDuration(0), '0m')
})

test('[0306.R2] weeks and days follow the settings; a bare number is in the default unit', () => {
  assert.equal(parseDuration('1w 2d 4h 30m'), 5 * 480 + 2 * 480 + 270)                     // 8h days, 5-day weeks (Jira's defaults)
  const short = { ...DEFAULT_TIME, hoursPerDay: 6, daysPerWeek: 4 }
  assert.equal(parseDuration('1w 1d', short), 4 * 360 + 360)
  assert.equal(parseDuration('90'), 90)                                                    // minutes by default, as in Jira
  assert.equal(parseDuration('1.5', { ...DEFAULT_TIME, defaultUnit: 'h' }), 90)
  assert.equal(parseDuration('2', { ...DEFAULT_TIME, defaultUnit: 'd' }), 960)
  assert.equal(parseDuration('1', { ...DEFAULT_TIME, defaultUnit: 'w' }), 2400)
})

test('[0306.R3][0306.R4] minutes show in the chosen format', () => {
  const m = 2400 + 2 * 480 + 3 * 60 + 30
  assert.equal(formatDuration(m), '1w 2d 3h 30m')
  assert.equal(formatDuration(720, { ...DEFAULT_TIME, format: 'days' }), '1.5d')
  assert.equal(formatDuration(750, { ...DEFAULT_TIME, format: 'hours' }), '12.5h')
  assert.equal(formatDuration(720, { ...DEFAULT_TIME, hoursPerDay: 6 }), '2d')
})

test('[0404.R3] totals in a board’s estimation statistic carry its unit', () => {
  assert.equal(statLabel(8), '8 points')
  assert.equal(statLabel(1), '1 point')
  assert.equal(statLabel(3, 'count'), '3 issues')
  assert.equal(statLabel(600, 'time'), '1d 2h')
  assert.equal(statOf({ estimate: 5, timeEstimate: 90 }, 'time'), 90)
  assert.equal(statOf({ estimate: undefined, timeEstimate: undefined }, 'count'), 1)
  assert.equal(statOf({ estimate: 5, timeEstimate: 90 }), 5)
})
