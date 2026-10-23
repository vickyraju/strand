import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, EMPTY, type State } from './reducer.ts'
import { withSample } from './testdata.ts'
import { toReportData } from '../api/map.ts'
import { burndown, cumulativeFlow, cycleTimes, velocity, createdVsResolved, statusAt, statusHistory } from './analytics.ts'

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

test('velocity, created vs resolved and cycle time are consistent', () => {
  const s = sample()
  const p = pay(s)
  const v = velocity(s, p)
  assert.deepEqual(v.labels, ['Sprint 1', 'Sprint 2'])
  v.completed.forEach((c, i) => assert.ok(c <= v.committed[i]))
  const cr = createdVsResolved(s, p, 90)
  assert.ok(cr.resolved.reduce((a, b) => a + b, 0) > 0)
  const ct = cycleTimes(s, p)
  assert.ok(ct.points.length > 0)
  assert.ok(ct.median > 0 && ct.median <= ct.p85)
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
  assert.deepEqual(ids(cycleTimes(fromServer, p)), ids(cycleTimes(s, p)))
  assert.deepEqual(createdVsResolved(fromServer, p, 30, now), createdVsResolved(s, p, 30, now))
  for (const sp of s.sprints.filter(x => x.projectId === p.id && x.startedAt))
    assert.deepEqual(ids(burndown(fromServer, p, sp, now)), ids(burndown(s, p, sp, now)))
  }
})
