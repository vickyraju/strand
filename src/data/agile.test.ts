import { test } from 'node:test'
import assert from 'node:assert/strict'
import { burnup, joinedAt, predictRelease, progressReport, scopeBurndown } from './agile.ts'
import { DAY } from './analytics.ts'

// A project with To do / Done, and items whose history is written by hand. Day 0 is a fixed Monday noon.
const D0 = new Date(2026, 10, 2, 12).getTime()
const day = (n: number) => D0 + n * DAY
const project: any = { id: 'p', key: 'P', statuses: [{ id: 'todo', category: 'todo' }, { id: 'done', category: 'done' }] }
const item = (id: string, o: Record<string, unknown>) => ({ id, key: `P-${id}`, projectId: 'p', type: 'story', status: 'todo', createdAt: day(0), updatedAt: day(0), labels: [], ...o }) as any
const created = (i: any) => ({ id: `c${i.id}`, issueId: i.id, actorId: '', text: '', field: 'status', to: 'todo', createdAt: i.createdAt })
const doneOn = (i: any, n: number) => ({ id: `d${i.id}`, issueId: i.id, actorId: '', text: '', field: 'status', from: 'todo', to: 'done', createdAt: day(n) })
const state = (issues: any[], activity: any[], sprints: any[] = []) => ({ issues, activity, sprints, projects: [project] }) as any

test('[0411.R1] burnup: the scope, the work completed per day, and a guideline rising from zero to the scope', () => {
  const a = item('1', { estimate: 3, status: 'done' }), b = item('2', { estimate: 5 })
  const sprint: any = { id: 's', projectId: 'p', state: 'closed', startedAt: day(0), completedAt: day(4), endsAt: day(4), issueIds: ['1', '2'], estimation: 'points' }
  const r = burnup(state([a, b], [created(a), created(b), doneOn(a, 2)], [sprint]), project, sprint, day(10))!
  assert.deepEqual(r.scope, [8, 8, 8, 8, 8])
  assert.deepEqual(r.completed, [0, 0, 3, 3, 3])
  assert.deepEqual([r.ideal[0], r.ideal.at(-1)], [0, 8])
})

test('[0411.R6] an item joined its epic when its history last put it there, else when it was created', () => {
  const i = item('1', { createdAt: day(0) })
  assert.equal(joinedAt(i, [{ id: 'x', issueId: '1', actorId: '', text: '', field: 'parentId', to: 'E', createdAt: day(3) }] as any, 'parentId', 'E'), day(3))
  assert.equal(joinedAt(i, [{ id: 'x', issueId: '1', actorId: '', text: '', field: 'fixReleaseIds', to: 'v1,v2', createdAt: day(2) }] as any, 'fixReleaseIds', 'v2'), day(2))
  assert.equal(joinedAt(i, [], 'parentId', 'E'), day(0))
})

test('[0411.R2][0411.R5] epic report: total and completed per day in the statistic; completed, incomplete and unestimated lists', () => {
  const a = item('1', { parentId: 'E', estimate: 2, status: 'done' }), b = item('2', { parentId: 'E', estimate: 3 }), c = item('3', { parentId: 'E' })
  const late = item('4', { parentId: 'E', estimate: 1, createdAt: day(2) }), other = item('5', { estimate: 8 })
  const s = state([a, b, c, late, other], [created(a), created(b), created(c), created(late), created(other), doneOn(a, 1)])
  const r = progressReport(s, project, { epic: 'E' }, { from: day(0), now: day(3) })
  assert.deepEqual(r.total, [5, 5, 6, 6])
  assert.deepEqual(r.completed, [0, 2, 2, 2])
  assert.deepEqual([r.lists.completed.map((i: any) => i.id), r.lists.incomplete.map((i: any) => i.id), r.lists.unestimated.map((i: any) => i.id)], [['1'], ['2', '4'], ['3']])
  const counted = progressReport(s, project, { epic: 'E' }, { from: day(0), now: day(3), estimation: 'count' })
  assert.deepEqual([counted.total.at(-1), counted.lists.unestimated.length], [4, 0])   // issue count: nothing is unestimated
})

test('[0411.R3] version report: the predicted release date at the pace so far, 10% faster and slower; none without progress', () => {
  const p = predictRelease({ start: day(0), now: day(10), total: 30, completed: 10 })!   // 1 a day, 20 to go
  assert.deepEqual([p.predicted, p.optimistic, p.pessimistic], [day(30), day(29), day(33)])
  assert.equal(predictRelease({ start: day(0), now: day(10), total: 30, completed: 0 }), null)
  assert.equal(predictRelease({ start: day(0), now: day(10), total: 5, completed: 5 })!.predicted, day(10))
})

test('[0411.R4] epic burndown: per sprint completed, remaining and added; the forecast at the last three sprints’ pace', () => {
  const a = item('1', { parentId: 'E', estimate: 3, status: 'done' }), b = item('2', { parentId: 'E', estimate: 5 })
  const added = item('3', { parentId: 'E', estimate: 2, createdAt: day(8) })
  const sprints: any[] = [
    { id: 's1', name: 'S1', projectId: 'p', state: 'closed', startedAt: day(0), completedAt: day(7) },
    { id: 's2', name: 'S2', projectId: 'p', state: 'closed', startedAt: day(7), completedAt: day(14) },
  ]
  const r = scopeBurndown(state([a, b, added], [created(a), created(b), created(added), doneOn(a, 3)], sprints), project, { epic: 'E' }, sprints)
  assert.deepEqual(r.rows.map(x => [x.name, x.completed, x.remaining, x.added]), [['S1', 3, 5, 0], ['S2', 0, 7, 2]])
  assert.equal(r.remaining, 7)
  assert.equal(r.forecast, 5)                                              // 7 left at 1.5 a sprint: 5 sprints
})

test('[0411.R5] estimates count as they stood: the scope moves when one changes, completed work counts at its estimate when done, raised estimates are added scope', () => {
  const est = (i: any, n: number, from: number | null, to: number | null) => ({ id: `e${i.id}${n}`, issueId: i.id, actorId: '', text: '', field: 'estimate', ...(from != null ? { from: String(from) } : {}), ...(to != null ? { to: String(to) } : {}), createdAt: day(n) })
  // a: 3 at the start, 5 from day 2, done day 3, re-estimated to 8 on day 4 after it was done; b: 2 throughout
  const a = item('1', { estimate: 8, status: 'done', parentId: 'E' }), b = item('2', { estimate: 2, parentId: 'E' })
  const history = [created(a), created(b), est(a, 2, 3, 5), doneOn(a, 3), est(a, 4, 5, 8)]
  const sprint: any = { id: 's', projectId: 'p', state: 'closed', startedAt: day(0), completedAt: day(5), endsAt: day(5), issueIds: ['1', '2'], estimation: 'points' }
  const up = burnup(state([a, b], history, [sprint]), project, sprint, day(10))!
  assert.deepEqual(up.scope, [5, 5, 7, 7, 10, 10])
  assert.deepEqual(up.completed, [0, 0, 0, 5, 5, 5])
  assert.equal(up.ideal.at(-1), 5)                                         // the guideline rises to the scope at the start
  const r = progressReport(state([a, b], history), project, { epic: 'E' }, { from: day(0), now: day(5) })
  assert.deepEqual([r.total, r.completed], [[5, 5, 7, 7, 10, 10], [0, 0, 0, 5, 5, 5]])
  const sprints: any[] = [
    { id: 's1', name: 'S1', projectId: 'p', state: 'closed', startedAt: day(-7), completedAt: day(0) },
    { id: 's2', name: 'S2', projectId: 'p', state: 'closed', startedAt: day(0), completedAt: day(6) },
  ]
  const bd = scopeBurndown(state([a, b], history, sprints), project, { epic: 'E' }, sprints)
  assert.deepEqual(bd.rows.map(x => [x.name, x.completed, x.remaining, x.added]), [['S1', 0, 5, 0], ['S2', 5, 2, 2]])   // 3 → 5 before it was done: 2 added
})
