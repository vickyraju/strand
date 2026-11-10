import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusters, controlStats, defaultColumns, windowSize, yScale } from './control.ts'

test('[0410.R3] Jira’s default columns: all but the first and last; with two, the first', () => {
  assert.deepEqual(defaultColumns(['To do', 'In progress', 'Review', 'Done']), ['In progress', 'Review'])
  assert.deepEqual(defaultColumns(['Doing', 'Done']), ['Doing'])
  assert.deepEqual(defaultColumns(['Only']), ['Only'])
})

test('[0410.R5] the rolling window: 20% of the items, odd, at least 5, never more than there are', () => {
  assert.deepEqual([windowSize(100), windowSize(45), windowSize(10), windowSize(4), windowSize(3)], [21, 9, 5, 3, 3])
})

test('[0410.R5] statistics: average, median, min, max; the rolling average and standard deviation over the window', () => {
  const pts = [1, 2, 3, 4, 100].map((v, i) => ({ t: i, v }))
  const s = controlStats(pts)
  assert.deepEqual([s.count, s.average, s.median, s.min, s.max], [5, 22, 3, 1, 100])
  assert.equal(s.rolling.length, 5)
  assert.ok(s.rolling.every(r => r.mean === 22))                                   // 5 items, a window of 5: every point sees all
  assert.ok(Math.abs(s.rolling[0]!.sd - Math.sqrt(((21 ** 2) + (20 ** 2) + (19 ** 2) + (18 ** 2) + (78 ** 2)) / 5)) < 1e-9)
  const many = controlStats(Array.from({ length: 11 }, (_, i) => ({ t: i, v: i })))
  assert.equal(many.median, 5)
  assert.equal(many.rolling[5]!.mean, 5)                                          // a window of 5 around the middle: 3…7
  assert.equal(many.rolling[0]!.mean, 2)                                          // at the edge, the first 5
})

test('[0410.R6] dots on the same spot become one cluster at their average', () => {
  const c = clusters([{ t: 0, v: 1 }, { t: 1, v: 1.2 }, { t: 100, v: 1 }], 5, 0.5)
  assert.deepEqual(c.map(x => [x.items.length, x.t, x.v]), [[2, 0.5, 1.1], [1, 100, 1]])
})

test('[0410.R7] the vertical scale: linear under 30 days, cube-root from 30', () => {
  assert.equal(yScale(10).kind, 'linear'); assert.equal(yScale(10).at(5), 0.5)
  assert.equal(yScale(64).kind, 'cube-root'); assert.equal(yScale(64).at(8), 0.5)
})
