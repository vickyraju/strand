import { test } from 'node:test'
import assert from 'node:assert/strict'
import { broken, day, health, progress, spans, tree, type PlanItem } from '../src/shared/plans.ts'

const it = (id: string, type: string, o: Partial<PlanItem> = {}): PlanItem => ({ id, key: id.toUpperCase(), type, title: id, category: 'todo', startDate: null, dueDate: null,
  sprintId: null, parentId: null, parentLinkId: null, projectKey: 'P', statusName: 'To do', ...o })

test('[0803.R3][0803.R4][0803.R5] plans: the tree, bars from dates, roll-ups and sprints, broken dependencies, progress and health', () => {
  const items = [
    it('ini', 'initiative', { dueDate: '2026-06-30' }),
    it('ep1', 'epic', { parentLinkId: 'ini' }),                                           // no dates: spans its items
    it('a', 'story', { parentId: 'ep1', startDate: '2026-03-01', dueDate: '2026-03-10', category: 'done' }),
    it('b', 'task', { parentId: 'ep1', startDate: '2026-03-05', dueDate: '2026-07-15' }),   // ends after the initiative
    it('c', 'task', { parentId: 'ep1', sprintId: 's1' }),                                    // spans its sprint
    it('ep2', 'epic', { parentLinkId: 'elsewhere', startDate: '2026-04-01', dueDate: '2026-04-30' }),
    it('lone', 'bug'),
  ]
  const t = tree(items)
  assert.deepEqual(t.roots.map(r => r.id), ['ini', 'ep2', 'lone'])                         // an epic whose initiative isn't in the plan is a root
  assert.deepEqual(t.children('ini').map(c => c.id), ['ep1'])
  assert.deepEqual(t.children('ep1').map(c => c.id), ['a', 'b', 'c'])
  const bars = spans(items, [{ id: 's1', startedAt: '2026-03-02T09:00:00.000Z', endsAt: '2026-03-16T09:00:00.000Z', completedAt: null }])
  assert.deepEqual(bars.get('c'), { start: day('2026-03-02'), end: day('2026-03-16'), derived: true })
  assert.deepEqual(bars.get('ep1'), { start: day('2026-03-01'), end: day('2026-07-15'), derived: true })
  assert.deepEqual(bars.get('ini'), { start: day('2026-06-30'), end: day('2026-06-30'), derived: false })
  assert.equal(bars.get('lone'), null)
  // R4: the blocker (b) ends after the blocked (ep2) starts
  const deps = [{ fromId: 'b', toId: 'ep2' }, { fromId: 'a', toId: 'b' }]
  assert.deepEqual(deps.map(d => broken(d, bars)), [true, true])
  assert.equal(broken({ fromId: 'a', toId: 'ep2' }, bars), false)
  // R5
  assert.deepEqual(progress('ep1', items), { done: 1, total: 3 })
  assert.deepEqual(progress('ini', items), { done: 1, total: 3 })                         // an initiative counts its epics' items
  assert.equal(health('ini', items, bars, deps, day('2026-05-01')), 'at-risk')            // b ends after it
  assert.equal(health('ini', items, bars, deps, day('2026-08-01')), 'off-track')          // past due, unfinished
  assert.equal(health('ep2', items, bars, [], day('2026-01-01')), 'on-track')
  assert.equal(health('lone', items, bars, [], day('2026-01-01')), null)                  // no dates: no health
  assert.equal(health('ep1', items, bars, [{ fromId: 'a', toId: 'b' }], day('2026-01-01')), 'at-risk')   // a broken dependency inside it
})
