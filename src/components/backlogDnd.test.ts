import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKLOG, backlogAnnouncements, backlogKeyboard, boxTarget, endTarget, planBacklogDrop, rowTarget } from './backlogDnd.ts'

// ── what a drop does ──

const containerOf = (id: string) => ({ a: 'sprint1', b: 'sprint1', c: null } as Record<string, string | null>)[id] ?? null

test('dropping on a row puts the items before it, in that row’s list, keeping their order', () => {
  assert.deepEqual(planBacklogDrop({ dragged: ['x', 'y'], overId: rowTarget('a'), containerOf }), [
    { id: 'x', beforeId: 'a', container: 'sprint1' }, { id: 'y', beforeId: 'a', container: 'sprint1' }])
  assert.deepEqual(planBacklogDrop({ dragged: ['x'], overId: rowTarget('c'), containerOf }), [{ id: 'x', beforeId: 'c', container: null }])   // a backlog row: backlog
})

test('an item dropped on itself is left out, and the others still move', () => {
  assert.deepEqual(planBacklogDrop({ dragged: ['a', 'x'], overId: rowTarget('a'), containerOf }), [{ id: 'x', beforeId: 'a', container: 'sprint1' }])
  assert.deepEqual(planBacklogDrop({ dragged: ['a'], overId: rowTarget('a'), containerOf }), [])
})

test('dropping on the end of a list, or on its box, sends the items to the end of that sprint or of the backlog', () => {
  for (const over of [endTarget('sprint2'), boxTarget('sprint2')])
    assert.deepEqual(planBacklogDrop({ dragged: ['x', 'y'], overId: over, containerOf }), [{ id: 'x', container: 'sprint2' }, { id: 'y', container: 'sprint2' }])
  for (const over of [endTarget(BACKLOG), boxTarget(BACKLOG)])
    assert.deepEqual(planBacklogDrop({ dragged: ['x'], overId: over, containerOf }), [{ id: 'x', container: null }])      // null is how moveIssue says "backlog"
})

// ── the keyboard ──

// Rows are 40 px tall and touch each other. Sprint 1 holds r1 r2 r3 and ends at y = 120 (its end zone); the backlog starts below.
const slot = (top: number, height = 40) => ({ left: 0, top, width: 600, height, right: 600, bottom: top + height })
const slots: Record<string, ReturnType<typeof slot>> = {
  'row:r1': slot(0), 'row:r2': slot(40), 'row:r3': slot(80), 'end:sprint1': slot(120, 10),
  'row:b1': slot(160), 'end:backlog': slot(200, 10), 'box:sprint1': slot(0, 130), 'box:backlog': slot(150, 70),
}
function press(code: string, carriedTop: number, startTop: number, disabled: string[] = []) {
  let prevented = false
  const ctx = {
    active: { id: 'carried', rect: { current: { initial: { top: startTop, height: 40, left: 0, width: 600, right: 600, bottom: startTop + 40 } } } },
    collisionRect: slot(carriedTop),
    droppableRects: new Map(Object.entries(slots)),
    droppableContainers: { getEnabled: () => Object.keys(slots).filter(id => !disabled.includes(id)).map(id => ({ id })) },
  }
  const got = backlogKeyboard({ code, preventDefault: () => { prevented = true } } as unknown as KeyboardEvent, { active: 'carried', currentCoordinates: { x: 0, y: 0 }, context: ctx as never })
  return { got, prevented }
}

test('Down skips the gap straight after the row’s own place (no change) and goes to the one after; Up goes to the gap before the row above', () => {
  assert.deepEqual(press('ArrowDown', 40, 40, ['row:r2']).got, { x: 0, y: 120 })     // carrying r2: "before r3" is where it already is, so one step down is the end of the list
  assert.deepEqual(press('ArrowUp', 40, 40, ['row:r2']).got, { x: 0, y: 0 })         // up: before r1
})

test('the box is never a keyboard stop, and the list end is', () => {
  const down = press('ArrowDown', 80, 0, ['row:r1'])                                   // carrying r1, now at r3's gap
  assert.deepEqual(down.got, { x: 0, y: 120 })                                         // the end of sprint 1
  assert.deepEqual(press('ArrowDown', 120, 0, ['row:r1']).got, { x: 0, y: 160 })       // then into the backlog: before b1
})

test('at the very top or bottom nothing happens, and other keys are left to the page', () => {
  assert.equal(press('ArrowUp', 0, 0, ['row:r1']).got, undefined)
  assert.equal(press('ArrowDown', 200, 0, ['row:r1']).got, undefined)
  const other = press('KeyQ', 40, 40)
  assert.deepEqual([other.got, other.prevented], [undefined, false])
  assert.equal(press('ArrowDown', 40, 40).prevented, true)
})

// ── what a screen reader hears ──

test('announcements name the item, count a carried selection, and say where it would go', () => {
  let n = 1
  const say = backlogAnnouncements({
    key: () => 'PAY-4', count: () => n, listOf: () => 'Backlog',
    place: id => (String(id).startsWith('row:') ? 'before PAY-9 in Sprint 2' : 'the end of Sprint 2'),
  })
  const ev = (over?: string) => ({ active: { id: 'x' }, over: over ? { id: over } : null }) as never
  assert.equal(say.onDragStart!(ev()), 'Picked up PAY-4. It is in Backlog.')
  assert.equal(say.onDragOver!(ev('box:backlog')), undefined)                              // lifting reports its own list: stay quiet so "Picked up" is heard
  assert.equal(say.onDragOver!(ev('row:q')), 'Over before PAY-9 in Sprint 2.')
  assert.equal(say.onDragOver!(ev()), 'Not over a list.')
  assert.equal(say.onDragEnd!(ev('end:s2')), 'PAY-4 moved to the end of Sprint 2.')
  assert.match(say.onDragEnd!(ev())!, /outside the lists/)
  n = 3
  assert.equal(say.onDragStart!(ev()), 'Picked up PAY-4 and 2 other selected items. It is in Backlog.')
  n = 2
  assert.equal(say.onDragEnd!(ev('end:s2')), 'PAY-4 and 1 other selected item moved to the end of Sprint 2.')
  assert.equal(say.onDragCancel!(ev()), 'Cancelled. PAY-4 and 1 other selected item did not move.')
})
