import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, EMPTY, type State } from './reducer.ts'
import { withSample } from './testdata.ts'
import { toReportData } from '../api/map.ts'
import { burndown, cumulativeFlow, velocity, createdVsResolved, statusAt, statusHistory, guideline, isWorkingDay } from './analytics.ts'

function sample(): State {
  const s0 = reducer(EMPTY, { type: 'setOwner', name: 'Alex Morgan' })
  return withSample(s0)
}
const pay = (s: State) => s.projects.find(p => p.key === 'PAY')!

test('burndown starts at the committed points and never rises without scope changes', () => {
  const s = sample()
  for (const sprint of s.sprints.filter(x => x.startedAt)) {
    const b = burndown(s, pay(s), sprint)!
    const known = b.remaining.filter(v => !Number.isNaN(v))
    assert.ok(known.length > 0)
    assert.ok(known[0] <= b.total, `${sprint.name} starts above the commitment`)
    for (let i = 1; i < known.length; i++) assert.ok(known[i] <= known[i - 1], `${sprint.name} burndown rose on day ${i}`)
    assert.equal(b.ideal[0], b.total)
    assert.equal(b.ideal.at(-1), 0)
  }
})

test('cumulative flow bands add up to the number of items that existed each day', () => {
  const s = sample()
  const p = pay(s)
  const cfd = cumulativeFlow(s, p, 30)
  const items = s.issues.filter(i => i.projectId === p.id && i.type !== 'epic')
  const today = cfd.labels.length - 1
  const total = cfd.counts.todo[today] + cfd.counts['in-progress'][today] + cfd.counts.done[today]
  assert.equal(total, items.length)
  // Done never shrinks in the sample (nothing is reopened)
  for (let i = 1; i < cfd.counts.done.length; i++) assert.ok(cfd.counts.done[i] >= cfd.counts.done[i - 1])
})

test('status history replays to each item’s current status', () => {
  const s = sample()
  const history = statusHistory(s)
  for (const i of s.issues) assert.equal(statusAt(i, history.get(i.id), Date.now()), i.status, i.key)
})

test('velocity and created vs resolved are consistent', () => {
  const s = sample()
  const p = pay(s)
  const v = velocity(s, p)
  assert.deepEqual(v.labels, ['Sprint 1', 'Sprint 2'])
  v.completed.forEach((c, i) => assert.ok(c <= v.committed[i]))
  const cr = createdVsResolved(s, p, 90)
  assert.ok(cr.resolved.reduce((a, b) => a + b, 0) > 0)
})

test('reports from server data (items plus status changes) match reports from the full local history', () => {
  const s = sample(), p = pay(s), now = Date.now()
  const iso = (t: number) => new Date(t).toISOString()
  // What /projects/:key/report-data returns: item rows, and every status change (the server records no "created" entry)
  const rows = s.issues.map(i => ({ ...i, statusId: i.status, createdAt: iso(i.createdAt), updatedAt: iso(i.updatedAt) }))
  // Edits made on the server record changes only; imported history also has each item's creation (no "from")
  const edited = s.activity.filter(a => a.field === 'status' && a.from), imported = s.activity.filter(a => a.field === 'status')
  for (const recorded of [edited, imported]) {
  const changes = recorded
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(a => ({ issueId: a.issueId, fromId: a.from ?? null, toId: a.to!, at: iso(a.createdAt) }))
  assert.ok(changes.length > 50)
  const fromServer: State = { ...s, ...toReportData(rows, changes) }
  // compare the numbers and which items count; items themselves differ (server rows carry no watchers or work logs)
  const ids = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => v && typeof v === 'object' && 'watcherIds' in v ? v.id : v))
  assert.deepEqual(cumulativeFlow(fromServer, p, 30, now), cumulativeFlow(s, p, 30, now))
  assert.deepEqual(createdVsResolved(fromServer, p, 30, now), createdVsResolved(s, p, 30, now))
  for (const sp of s.sprints.filter(x => x.projectId === p.id && x.startedAt))
    assert.deepEqual(ids(burndown(fromServer, p, sp, now)), ids(burndown(s, p, sp, now)))
  }
})

test('[0405.R2] the burndown guideline falls only on working days, flat across a weekend and a holiday', () => {
  // Monday 2 Nov 2026 to Monday 9 Nov: Sat 7 and Sun 8 are off, and Wednesday 4 is a holiday
  const day = (d: number) => new Date(2026, 10, d).getTime()
  const timeline = [2, 3, 4, 5, 6, 7, 8, 9].map(day)
  const w = { weekdays: [1, 2, 3, 4, 5], nonWorking: ['2026-11-04'] }
  assert.deepEqual(guideline(timeline, 8, w), [8, 6, 6, 4, 2, 2, 2, 0])
  assert.deepEqual(guideline(timeline, 7), [7, 6, 5, 4, 3, 2, 1, 0])                     // no working days set: every day
  assert.equal(isWorkingDay(day(7), w), false)
})

test('[0412.R1][0412.R2][0412.R3] a number field statistic, the remaining-estimate burndown, and days in the team’s time zone', async () => {
  const { statOf, statistic } = await import('./reducer.ts')
  const { estimatesAt } = await import('./agile.ts')
  const { startOfDay, endOfDay, days, isoDay } = await import('./analytics.ts')
  // R1: the statistic as one value; an item's field value, and as it stood from the field's history
  assert.equal(statistic({ estimation: 'field', estimationFieldId: 'f1' }), 'field:f1')
  assert.equal(statistic({ estimation: 'field', estimationFieldId: null }), 'points')
  assert.equal(statOf({ estimate: 3, timeEstimate: 60, custom: { f1: 8 } }, 'field:f1'), 8)
  assert.equal(statOf({ estimate: 3, timeEstimate: 60, custom: { f1: 'x' } }, 'field:f1'), 0)
  const s = sample()
  const sprint = s.sprints.find(x => x.state === 'active')!
  const item = s.issues.find(i => i.sprintId === sprint.id)!
  const t0 = sprint.startedAt!
  const withField: State = { ...s, issues: s.issues.map(i => i.id === item.id ? { ...i, custom: { ...i.custom, f1: 13 } } : i),
    activity: [...s.activity, { id: 'h1', issueId: item.id, actorId: '', text: 'x', field: 'custom:f1', from: '5', to: '13', createdAt: t0 + 3_600_000 }] }
  const at = estimatesAt(withField, 'field:f1')
  assert.deepEqual([at(withField.issues.find(i => i.id === item.id)!, t0), at(withField.issues.find(i => i.id === item.id)!, t0 + 7_200_000)], [5, 13])
  // R2: the remaining estimate falls as work is logged, not only when work is done
  const members = s.issues.filter(i => i.sprintId === sprint.id)
  const timed: State = { ...s, issues: s.issues.map(i => i.sprintId === sprint.id ? { ...i, timeEstimate: 600, timeRemaining: 600 } : i),
    activity: [...s.activity.filter(a => a.field !== 'timeRemaining'), { id: 'r1', issueId: members[0]!.id, actorId: '', text: 'x', field: 'timeRemaining', from: '600', to: '120', createdAt: t0 + 3_600_000 }] }
  const b = burndown(timed, pay(timed), { ...sprint, estimation: 'time' }, t0 + 2 * 3_600_000, undefined, 'remaining')!
  assert.equal(b.total, members.length * 600)
  assert.ok(b.remaining[0]! <= b.total - 480, `logged work lowers the line: ${b.remaining[0]} of ${b.total}`)
  // R3: days in a chosen time zone, also across a daylight-saving change
  const t = Date.UTC(2026, 2, 8, 12)                                      // 8 Mar 2026, the US switch to summer time
  assert.equal(new Date(startOfDay(t, 'America/New_York')).toISOString(), '2026-03-08T05:00:00.000Z')
  assert.equal(new Date(endOfDay(t, 'America/New_York')).toISOString(), '2026-03-09T03:59:59.999Z')
  assert.equal(isoDay(Date.UTC(2026, 0, 1, 23), 'Asia/Kolkata'), '2026-01-02')
  assert.deepEqual(days(Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 9, 12), 'America/New_York').map(d => isoDay(d, 'America/New_York')), ['2026-03-07', '2026-03-08', '2026-03-09'])
  assert.equal(isWorkingDay(Date.UTC(2026, 0, 2, 20), { weekdays: [1, 2, 3, 4, 5], nonWorking: [], timeZone: 'Asia/Tokyo' }), false)   // Friday evening in UTC is Saturday in Tokyo
})
