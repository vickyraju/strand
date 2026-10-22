import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardAnnouncements, boardKeyboard, planDrop } from './boardDnd.ts'
import type { Issue, Project } from '../data/reducer.ts'

const project = {
  name: 'Payments',
  statuses: [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'In progress' }, { id: 'done', name: 'Done' }],
  transitions: [{ id: 't1', name: 'Start', from: ['todo'], to: 'doing' }, { id: 't2', name: 'Finish', from: ['doing'], to: 'done' }],
} as unknown as Project
const card = (status: string) => ({ id: 'c', status }) as unknown as Issue

// ── what a drop does ──

test('a drop into a column the workflow allows changes the status, and nothing else', () => {
  assert.deepEqual(planDrop({ project, issue: card('todo'), statusId: 'doing', moveLane: false }), { patch: { status: 'doing' } })
})

test('a drop into the same column changes nothing', () => {
  assert.deepEqual(planDrop({ project, issue: card('todo'), statusId: 'todo', moveLane: false }), { patch: {} })
})

test('a move the workflow does not allow is refused with the reason, names included', () => {
  const plan = planDrop({ project, issue: card('todo'), statusId: 'done', moveLane: false })
  assert.deepEqual(plan, { blocked: 'The Payments workflow doesn’t allow To do → Done' })
})

test('moving to another swimlane also changes the grouped field, with or without a status change', () => {
  const lanePatch = { assigneeId: 'ann' }
  assert.deepEqual(planDrop({ project, issue: card('todo'), statusId: 'todo', lanePatch, moveLane: true }), { patch: { assigneeId: 'ann' } })
  assert.deepEqual(planDrop({ project, issue: card('todo'), statusId: 'doing', lanePatch, moveLane: true }), { patch: { status: 'doing', assigneeId: 'ann' } })
  assert.deepEqual(planDrop({ project, issue: card('todo'), statusId: 'todo', lanePatch, moveLane: false }), { patch: {} })   // same lane: no field change
})

test('a refused move changes nothing, not even the swimlane field', () => {
  const plan = planDrop({ project, issue: card('todo'), statusId: 'done', lanePatch: { assigneeId: 'ann' }, moveLane: true })
  assert.ok('blocked' in plan)
})

// ── the keyboard ──

// A board of 3 columns × 2 swimlanes. Cells are 200 wide; the second swimlane starts at y = 320.
const rect = (c: number, l: number) => ({ left: c * 200, top: l * 320, width: 200, height: 300, right: c * 200 + 200, bottom: l * 320 + 300 })
const ids = ['a0', 'b0', 'c0', 'a1', 'b1', 'c1']
const at = (id: string) => rect('abc'.indexOf(id[0]!), Number(id[1]))
function press(code: string, over: string | null, disabled: string[] = []) {
  let prevented = false
  const ctx = {
    active: { id: 'card' }, collisionRect: rect(0, 0), over: over ? { id: over } : null,
    droppableRects: new Map(ids.map(i => [i, at(i)])),
    droppableContainers: { getEnabled: () => ids.filter(i => !disabled.includes(i)).map(i => ({ id: i })) },
  }
  const got = boardKeyboard({ code, preventDefault: () => { prevented = true } } as unknown as KeyboardEvent, { active: 'card', currentCoordinates: { x: 0, y: 0 }, context: ctx as never })
  return { got, prevented }
}
const goesTo = (id: string) => ({ x: at(id).left + 12, y: at(id).top + 12 })

test('arrow keys jump to the neighbouring cell: sideways along the swimlane, up and down between swimlanes', () => {
  assert.deepEqual(press('ArrowRight', 'a0').got, goesTo('b0'))
  assert.deepEqual(press('ArrowRight', 'b1').got, goesTo('c1'))
  assert.deepEqual(press('ArrowLeft', 'c0').got, goesTo('b0'))
  assert.deepEqual(press('ArrowDown', 'b0').got, goesTo('b1'))
  assert.deepEqual(press('ArrowUp', 'c1').got, goesTo('c0'))
})

test('at the edge nothing happens, and other keys are left alone', () => {
  assert.equal(press('ArrowLeft', 'a0').got, undefined)
  assert.equal(press('ArrowUp', 'a0').got, undefined)
  assert.equal(press('ArrowDown', 'a1').got, undefined)
  const other = press('KeyX', 'a0')
  assert.deepEqual([other.got, other.prevented], [undefined, false])                // not ours: the page may use it
  assert.equal(press('ArrowRight', 'a0').prevented, true)                            // ours: it must not scroll the page
  assert.equal(press('ArrowRight', null).got, undefined)                             // not over any cell yet
})

test('a cell that is switched off is skipped', () => {
  assert.deepEqual(press('ArrowRight', 'a0', ['b0']).got, goesTo('c0'))
})

// ── what a screen reader hears ──

test('announcements say what was picked up, where it is, and whether the drop worked', () => {
  const say = boardAnnouncements({
    key: () => 'PAY-7', status: () => 'To do', column: id => ({ todo: 'To do', doing: 'In progress', done: 'Done' })[String(id)] ?? '',
    verdict: (_c, cell) => (cell === 'doing' ? 'moves' : cell === 'todo' ? 'stays' : 'blocked'),
  })
  const ev = (over?: string) => ({ active: { id: 'c' }, over: over ? { id: over } : null }) as never
  assert.equal(say.onDragStart!(ev()), 'Picked up PAY-7. It is in To do.')
  assert.equal(say.onDragOver!(ev('todo')), undefined)                              // lifting reports "over its own column": stay quiet so "Picked up" is heard
  assert.equal(say.onDragOver!(ev('doing')), 'PAY-7 is over In progress.')
  assert.equal(say.onDragOver!(ev('todo')), 'PAY-7 is back over To do, where it started.')   // after wandering off, coming back is news
  assert.match(say.onDragOver!(ev('done'))!, /workflow does not allow/)
  assert.equal(say.onDragEnd!(ev('doing')), 'PAY-7 was moved to In progress.')
  assert.equal(say.onDragEnd!(ev('todo')), 'PAY-7 stays in To do.')
  assert.match(say.onDragEnd!(ev('done'))!, /did not move: the workflow does not allow/)
  assert.match(say.onDragEnd!(ev())!, /outside the board/)
  assert.equal(say.onDragCancel!(ev()), 'Cancelled. PAY-7 did not move.')
})
