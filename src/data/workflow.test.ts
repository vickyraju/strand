import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_H, NODE_W, addStatus, deleteStatusMoving, resolveMove, transitionsTouching, addTransition, autoLayout, canRedo, canUndo, connect, deleteStatus, edgeOffsets, edgesOf, hasGlobal,
  moveNode, moveStatus, positionsOf, pushHistory, reachable, reconnectSource, reconnectTarget, redo, removeTransition, sameWorkflow, setGlobal,
  setStart, startHistory, undo, updateStatus, updateTransition, validateWorkflow, type Workflow,
} from './workflow.ts'
import type { Category, Status, Transition } from './reducer.ts'

const st = (id: string, category: Category, name = id.toUpperCase()): Status => ({ id, name, color: '#999', category })
const any = (to: string, name = to.toUpperCase()): Transition => ({ id: `any-${to}`, name, from: 'any', to })
const move = (id: string, from: string[], to: string, name = id): Transition => ({ id, name, from, to })

/** A → B → C → D (Done), with "any status" into every one. */
const base = (): Workflow => ({
  statuses: [st('a', 'todo'), st('b', 'in-progress'), st('c', 'in-progress'), st('d', 'done')],
  transitions: [any('a'), any('b'), any('c'), any('d')],
  layout: {},
})
/** The same four statuses joined only by explicit moves. */
const chain = (): Workflow => ({
  statuses: base().statuses,
  transitions: [move('ab', ['a'], 'b'), move('bc', ['b'], 'c'), move('cd', ['c'], 'd')],
  layout: {},
})
const codes = (w: Workflow) => validateWorkflow(w).map(i => i.code)

// ── Statuses ──

test('adding a status puts it before the Done ones, usable at once, and leaves the original untouched', () => {
  const w = base(), before = JSON.stringify(w)
  const { workflow, id } = addStatus(w, { name: 'Review' })
  assert.deepEqual(workflow.statuses.map(s => s.name), ['A', 'B', 'C', 'Review', 'D'])
  assert.equal(workflow.statuses[3]!.id, id)
  assert.ok(hasGlobal(workflow, id))                                                   // anything can move in
  const out = workflow.transitions.find(t => t.from !== 'any' && t.from.includes(id))!
  assert.equal(out.to, 'b')                                                            // and on to the first in-progress status
  assert.equal(JSON.stringify(w), before)
})

test('a Done status goes last and needs no way out; without "global" nothing is connected', () => {
  const done = addStatus(base(), { name: 'Shipped', category: 'done' })
  assert.equal(done.workflow.statuses.at(-1)!.name, 'Shipped')
  assert.equal(done.workflow.transitions.length, base().transitions.length + 1)         // only the way in
  const bare = addStatus(base(), { name: 'Parked', global: false })
  assert.equal(bare.workflow.transitions.length, base().transitions.length)
  assert.ok(codes(bare.workflow).includes('unreachable'))
})

test('renaming a status renames its "any status" transition, but not a transition someone named by hand', () => {
  const w: Workflow = { ...base(), transitions: [...base().transitions, move('go', ['a'], 'b', 'Start work')] }
  const r = updateStatus(w, 'b', { name: 'Doing' })
  assert.equal(r.transitions.find(t => t.id === 'any-b')!.name, 'Doing')
  assert.equal(r.transitions.find(t => t.id === 'go')!.name, 'Start work')
  assert.equal(updateStatus(w, 'b', { name: 'B' }), w)                                  // same value: no change
  assert.equal(updateStatus(w, 'nope', { name: 'x' }), w)
})

test('deleting a status removes the moves into and out of it, and drops moves left with no start', () => {
  const w: Workflow = { ...chain(), layout: { b: { x: 1, y: 2 }, a: { x: 0, y: 0 } } }
  const r = deleteStatus(w, 'b')
  assert.deepEqual(r.statuses.map(s => s.id), ['a', 'c', 'd'])
  assert.deepEqual(r.transitions.map(t => t.id), ['cd'])                                // ab went (into b), bc went (b was its only From)
  assert.deepEqual(r.layout, { a: { x: 0, y: 0 } })
  const multi: Workflow = { ...chain(), transitions: [move('m', ['a', 'b'], 'c')] }
  assert.deepEqual(deleteStatus(multi, 'a').transitions[0]!.from, ['b'])                // a transition keeps its other From statuses
})

test('the last status cannot be deleted, and an unknown one is ignored', () => {
  const one: Workflow = { statuses: [st('a', 'done')], transitions: [], layout: {} }
  assert.equal(deleteStatus(one, 'a'), one)
  const w = base()
  assert.equal(deleteStatus(w, 'zzz'), w)
})

test('statuses can be reordered, and the first one is where new work starts', () => {
  const w = base()
  assert.deepEqual(moveStatus(w, 'c', 0).statuses.map(s => s.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(moveStatus(w, 'a', 99).statuses.map(s => s.id), ['b', 'c', 'd', 'a'])   // clamped to the end
  assert.deepEqual(setStart(w, 'b').statuses[0]!.id, 'b')
  assert.equal(moveStatus(w, 'a', 0), w)
  assert.equal(moveStatus(w, 'zzz', 1), w)
})

test('"allow all statuses to move here" can be switched on and off without duplicating', () => {
  const w = chain()
  const on = setGlobal(w, 'c', true)
  assert.ok(hasGlobal(on, 'c'))
  assert.equal(setGlobal(on, 'c', true), on)
  const off = setGlobal(on, 'c', false)
  assert.ok(!hasGlobal(off, 'c'))
  assert.equal(off.transitions.length, w.transitions.length)
  assert.equal(setGlobal(w, 'c', false), w)
})

test('moving a node stores a whole-number position and ignores a move to the same spot', () => {
  const w = moveNode(base(), 'a', { x: 10.4, y: 20.6 })
  assert.deepEqual(w.layout.a, { x: 10, y: 21 })
  assert.equal(moveNode(w, 'a', { x: 10, y: 21 }), w)
})

// ── Transitions ──

test('a transition never starts where it ends, lists a status once, and needs somewhere to start', () => {
  const r = addTransition(base(), { name: 'Go', from: ['a', 'b', 'a', 'c'], to: 'c' })
  assert.deepEqual(r.workflow.transitions.at(-1)!.from, ['a', 'b'])
  const none = addTransition(base(), { name: 'Loop', from: ['c'], to: 'c' })
  assert.equal(none.id, undefined)
  assert.equal(none.workflow.transitions.length, base().transitions.length)
  assert.equal(addTransition(base(), { name: 'Any', from: 'any', to: 'c' }).workflow.transitions.at(-1)!.from, 'any')
})

test('connecting two statuses adds a named move, or reuses one that already allows it', () => {
  const w = chain()
  const made = connect(w, 'a', 'c')
  assert.ok(made.created)
  assert.deepEqual(made.workflow.transitions.at(-1), { id: made.id, name: 'C', from: ['a'], to: 'c' })   // named after the target by default
  assert.equal(connect(w, 'a', 'c', '  Skip ahead ').workflow.transitions.at(-1)!.name, 'Skip ahead')
  const again = connect(w, 'a', 'b')                                                                       // ab already exists
  assert.deepEqual([again.created, again.id, again.workflow], [false, 'ab', w])
  assert.equal(connect(base(), 'a', 'b').created, false)                                                   // "any" already allows it
  assert.equal(connect(w, 'a', 'a').created, false)
  assert.equal(connect(w, 'a', 'zzz').created, false)
})

test('transitions can be renamed, re-pointed and removed; no-op edits return the same object', () => {
  const w = chain()
  assert.equal(updateTransition(w, 'ab', { name: 'ab' }), w)
  assert.equal(updateTransition(w, 'nope', { name: 'x' }), w)
  const r = updateTransition(w, 'ab', { name: 'Start', to: 'c' })
  assert.deepEqual(r.transitions[0], { id: 'ab', name: 'Start', from: ['a'], to: 'c' })
  assert.deepEqual(updateTransition(w, 'ab', { from: ['b'], to: 'b' }).transitions[0]!.from, [])          // cleaned to empty: validation will say so
  assert.deepEqual(removeTransition(w, 'ab').transitions.map(t => t.id), ['bc', 'cd'])
  assert.equal(removeTransition(w, 'nope'), w)
})

test('dragging an arrow head moves the whole transition, and is refused if it would leave it with no start', () => {
  const w: Workflow = { ...chain(), transitions: [move('m', ['a', 'b'], 'c')] }
  assert.equal(reconnectTarget(w, 'm', 'd').transitions[0]!.to, 'd')
  assert.deepEqual(reconnectTarget(w, 'm', 'b').transitions[0]!.from, ['a'])                        // b is now the target, so it leaves the From list
  const single: Workflow = { ...chain(), transitions: [move('s', ['a'], 'b')] }
  assert.equal(reconnectTarget(single, 's', 'a'), single)                                          // a → a would be empty
  assert.equal(reconnectTarget(single, 's', 'b'), single)
  assert.equal(reconnectTarget(single, 's', 'zzz'), single)
})

test('dragging an arrow tail swaps that From status only', () => {
  const w: Workflow = { ...chain(), transitions: [move('m', ['a', 'b'], 'd')] }
  assert.deepEqual(reconnectSource(w, 'm', 'a', 'c').transitions[0]!.from, ['c', 'b'])
  assert.deepEqual(reconnectSource(w, 'm', 'a', 'b').transitions[0]!.from, ['b'])                  // merges into the existing one
  assert.deepEqual(reconnectSource(w, 'm', 'a', 'd').transitions[0]!.from, ['b'])                  // d is the target, so it drops out of the From list
  const single: Workflow = { ...chain(), transitions: [move('s', ['a'], 'd')] }
  assert.equal(reconnectSource(single, 's', 'a', 'd'), single)                                     // that would leave no From status: refused
  assert.equal(reconnectSource(w, 'm', 'c', 'b'), w)                                               // c is not a From status of m
  assert.equal(reconnectSource({ ...w, transitions: [any('d')] }, 'any-d', 'a', 'b').transitions[0]!.from, 'any')
})

test('the transitions that go with a status are those into it and out of it, "any status" moves into it included', () => {
  const w: Workflow = { ...chain(), transitions: [...chain().transitions, any('b'), move('m', ['a', 'c'], 'd')] }
  assert.deepEqual(transitionsTouching(w, 'b').map(t => t.id), ['ab', 'bc', 'any-b'])
  assert.deepEqual(transitionsTouching(w, 'a').map(t => t.id), ['ab', 'm'])
  assert.deepEqual(transitionsTouching(w, 'zzz'), [])
})

test('deleting a status records where its work goes; the last status stays', () => {
  const d = { workflow: chain(), moves: {} }
  const r = deleteStatusMoving(d, 'b', 'c')
  assert.deepEqual([r.workflow.statuses.map(s => s.id), r.moves], [['a', 'c', 'd'], { b: 'c' }])
  assert.equal(deleteStatusMoving({ workflow: { statuses: [st('a', 'done')], transitions: [], layout: {} }, moves: {} }, 'a', 'a').moves.a, undefined)
  const gone = (id: string) => ['a', 'd'].includes(id)
  const moves = { b: 'c', c: 'd' }                                  // b went to c, then c itself was deleted and went to d
  assert.equal(resolveMove(moves, 'b', gone), 'd')
  assert.equal(resolveMove(moves, 'c', gone), 'd')
  assert.equal(resolveMove({ b: 'c', c: 'b' }, 'b', gone), undefined)    // a loop leads nowhere
  assert.equal(resolveMove({}, 'b', gone), undefined)
  assert.equal(resolveMove({ b: 'a' }, 'b', gone), 'a')
})

// ── Reading the graph ──

test('arrows are drawn per From status, never for "any status"', () => {
  const w: Workflow = { ...base(), transitions: [...base().transitions, move('m', ['a', 'b'], 'c', 'Go'), move('ghost', ['zzz'], 'c')] }
  assert.deepEqual(edgesOf(w).map(e => [e.id, e.from, e.to, e.name]), [['m:a', 'a', 'c', 'Go'], ['m:b', 'b', 'c', 'Go']])
})

test('arrows between the same two statuses are bent apart', () => {
  const pair = edgeOffsets(edgesOf({ ...chain(), transitions: [move('f', ['a'], 'b'), move('r', ['b'], 'a')] }))
  assert.deepEqual([pair.get('f:a'), pair.get('r:b')], [1, -1])                                    // opposite sides
  const solo = edgeOffsets(edgesOf(chain()))
  assert.deepEqual([...solo.values()], [0, 0, 0])                                                  // a lone arrow stays straight
  const fan = edgeOffsets(edgesOf({ ...chain(), transitions: [move('x', ['a'], 'b'), move('y', ['a'], 'b'), move('z', ['a'], 'b')] }))
  assert.deepEqual([fan.get('x:a'), fan.get('y:a'), fan.get('z:a')], [-1, 0, 1])                   // several the same way fan out
})

test('reachability follows moves from the start status and honours "any status"', () => {
  assert.deepEqual([...reachable(chain())].sort(), ['a', 'b', 'c', 'd'])
  assert.deepEqual([...reachable(base())].sort(), ['a', 'b', 'c', 'd'])
  const island: Workflow = { ...chain(), transitions: [move('ab', ['a'], 'b'), move('cd', ['c'], 'd')] }   // c and d only reach each other
  assert.deepEqual([...reachable(island)].sort(), ['a', 'b'])
  const viaAny: Workflow = { ...island, transitions: [...island.transitions, any('c')] }
  assert.deepEqual([...reachable(viaAny)].sort(), ['a', 'b', 'c', 'd'])
})

// ── Checking ──

test('a sound workflow has no problems', () => {
  assert.deepEqual(validateWorkflow(base()), [])
  assert.deepEqual(validateWorkflow(chain()), [])
})

test('missing Done status, blank and duplicate names are errors that point at the culprit', () => {
  const noDone: Workflow = { ...base(), statuses: base().statuses.map(s => ({ ...s, category: 'in-progress' as const })) }
  assert.ok(codes(noDone).includes('no-done'))
  const blank = updateStatus(base(), 'b', { name: '  ' })
  const issue = validateWorkflow(blank).find(i => i.code === 'blank-name')!
  assert.deepEqual(issue.target, { kind: 'status', id: 'b' })
  const dup = updateStatus(base(), 'c', { name: 'b' })                                              // "b" matches B, ignoring case
  const d = validateWorkflow(dup).find(i => i.code === 'duplicate-name')!
  assert.deepEqual([d.target!.id, d.message], ['c', '“b” is used by more than one status.'])
})

test('statuses nobody can reach, or leave, are errors', () => {
  const island: Workflow = { ...chain(), transitions: [move('ab', ['a'], 'b'), move('cd', ['c'], 'd')] }
  const un = validateWorkflow(island).filter(i => i.code === 'unreachable')
  assert.deepEqual(un.map(i => i.target!.id), ['c', 'd'])
  const trap: Workflow = { ...chain(), transitions: [move('ab', ['a'], 'b'), move('cd', ['c'], 'd'), move('bc', ['b'], 'c'), move('loop', ['b'], 'b')] }
  assert.deepEqual(codes(trap), [])                                                                 // b leaves through bc; the loop is ignored
  const stuck: Workflow = { ...chain(), transitions: [move('ab', ['a'], 'b'), move('cd', ['c'], 'd'), any('b')] }
  assert.deepEqual(validateWorkflow(stuck).filter(i => i.code === 'dead-end').map(i => i.target!.id), ['b'])   // nothing leaves b: "any" into b itself is no way out
  const viaAnyExit: Workflow = { ...stuck, transitions: [...stuck.transitions, any('c')] }
  assert.deepEqual(validateWorkflow(viaAnyExit).filter(i => i.code === 'dead-end'), [])                        // "any" into c lets b move there
})

test('transitions need a name and somewhere to start', () => {
  const w: Workflow = { ...base(), transitions: [...base().transitions, move('t', ['a'], 'b', ' '), move('u', [], 'b', 'Empty')] }
  const found = validateWorkflow(w)
  assert.deepEqual(found.filter(i => i.target?.kind === 'transition').map(i => [i.code, i.target!.id]), [['blank-transition-name', 't'], ['transition-no-from', 'u']])
})

test('starting in a Done status is a warning, listed after the errors', () => {
  const w: Workflow = { ...base(), statuses: [st('d', 'done'), st('a', 'todo'), st('b', 'in-progress')], transitions: [any('a'), any('b'), any('d')] }
  const found = validateWorkflow(w)
  assert.deepEqual(found.map(i => [i.level, i.code]), [['warning', 'start-is-done']])
  const both = validateWorkflow({ ...w, transitions: [] })
  assert.equal(both.at(-1)!.level, 'warning')
  assert.ok(both.slice(0, -1).every(i => i.level === 'error'))
  assert.deepEqual(validateWorkflow({ statuses: [], transitions: [], layout: {} }).map(i => i.code), ['no-statuses'])
})

// ── Layout ──

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H

test('auto layout puts a chain in order from left to right, on the grid', () => {
  const pos = autoLayout(chain())
  assert.deepEqual(Object.keys(pos).sort(), ['a', 'b', 'c', 'd'])
  assert.ok(pos.a!.x < pos.b!.x && pos.b!.x < pos.c!.x && pos.c!.x < pos.d!.x)
  for (const p of Object.values(pos)) assert.ok(p.x % 10 === 0 && p.y % 10 === 0 && p.x >= 100 && p.y >= 40)
})

test('auto layout gives the same answer every time and never overlaps boxes, even with cycles, branches and loose statuses', () => {
  const tangled: Workflow = {
    statuses: [st('a', 'todo'), st('b', 'in-progress'), st('c', 'in-progress'), st('e', 'in-progress'), st('f', 'in-progress'), st('d', 'done'), st('x', 'in-progress')],
    transitions: [move('1', ['a'], 'b'), move('2', ['a'], 'c'), move('3', ['b', 'c'], 'e'), move('4', ['e'], 'f'), move('5', ['f'], 'b'),    // a cycle b → e → f → b
      move('6', ['f', 'e'], 'd'), move('7', ['d'], 'a'), any('x')],
    layout: {},
  }
  const first = autoLayout(tangled)
  assert.deepEqual(autoLayout(tangled), first)
  assert.equal(Object.keys(first).length, 7)                                                        // x is only reachable by "any" and still gets a place
  const boxes = Object.values(first)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i]!, boxes[j]!), `${i} overlaps ${j}`)
  assert.deepEqual(autoLayout({ statuses: [], transitions: [], layout: {} }), {})
})

test('a workflow made only of "any status" moves reads left to right in board order, not as a stack', () => {
  const pos = autoLayout(base())                                   // a, b, c, d and no arrows at all
  assert.ok(pos.a!.x < pos.b!.x && pos.b!.x < pos.c!.x && pos.c!.x < pos.d!.x)
  assert.equal(new Set(Object.values(pos).map(p => p.y)).size, 1)  // one row
  const mixed: Workflow = { ...chain(), statuses: [...chain().statuses, st('e', 'in-progress')], transitions: [...chain().transitions, any('e')] }
  const m = autoLayout(mixed)                                      // e has no arrows: it follows d
  assert.ok(m.e!.x > m.d!.x)
})

test('auto layout keeps the start status on the left even when work can be reopened back into it', () => {
  const reopen: Workflow = { ...chain(), transitions: [...chain().transitions, move('re', ['d'], 'a', 'Reopen')] }
  const pos = autoLayout(reopen)
  assert.equal(Math.min(...Object.values(pos).map(p => p.x)), pos.a!.x)
  assert.ok(pos.a!.x < pos.b!.x && pos.b!.x < pos.c!.x && pos.c!.x < pos.d!.x)
})

test('positions: auto layout when nothing is saved, saved ones kept, and new statuses placed clear of them', () => {
  assert.deepEqual(positionsOf(chain()), autoLayout(chain()))
  const all = Object.fromEntries(chain().statuses.map((s, i) => [s.id, { x: 50 + i * 200, y: 70 }]))
  assert.deepEqual(positionsOf({ ...chain(), layout: all }), all)
  const added = addStatus({ ...chain(), layout: all }, { name: 'Review' })
  const added2 = addStatus(added.workflow, { name: 'QA' })
  const pos = positionsOf(added2.workflow)
  assert.deepEqual([pos.a, pos.d], [all.a, all.d])                                                       // saved ones do not move
  const boxes = Object.values(pos)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i]!, boxes[j]!), `${i} overlaps ${j}`)
  assert.ok(pos[added.id]!.x > Math.max(...Object.values(all).map(p => p.x)))                             // to the right of everything saved
  assert.deepEqual(positionsOf({ ...chain(), layout: { ...all, gone: { x: 1, y: 1 } } }), all)           // a deleted status's saved spot is ignored
})

// ── Undo / redo ──

test('undo and redo walk back and forth, and a new change forgets the redo trail', () => {
  let h = startHistory(1)
  h = pushHistory(h, 2, { at: 0 }); h = pushHistory(h, 3, { at: 1 })
  assert.deepEqual([canUndo(h), canRedo(h), h.present], [true, false, 3])
  h = undo(h); h = undo(h)
  assert.deepEqual([h.present, canUndo(h), canRedo(h)], [1, false, true])
  assert.equal(undo(h), h)
  h = redo(h)
  assert.equal(h.present, 2)
  h = pushHistory(h, 9, { at: 2 })
  assert.deepEqual([h.present, canRedo(h)], [9, false])
  assert.equal(redo(h), h)
})

test('changes with the same key close together are one undo step; different keys or a pause are not', () => {
  let h = startHistory('')
  for (const [i, v] of ['a', 'ab', 'abc'].entries()) h = pushHistory(h, v, { coalesce: 'name', at: i * 100 })
  assert.deepEqual([h.present, h.past], ['abc', ['']])                                              // typing a name: one step
  h = pushHistory(h, 'abc!', { coalesce: 'color', at: 300 })
  assert.equal(h.past.length, 2)                                                                    // a different field starts a new step
  h = pushHistory(h, 'abc!!', { coalesce: 'color', at: 5000 })
  assert.equal(h.past.length, 3)                                                                    // after a pause too
  h = pushHistory(h, 'x', { at: 5001 }); h = pushHistory(h, 'y', { at: 5002 })
  assert.equal(h.past.length, 5)                                                                    // no key: never joined
  assert.equal(undo(undo(h)).present, 'abc!!')
})

test('pushing the same object is not a change, and history is capped', () => {
  const h = startHistory({ n: 0 })
  assert.equal(pushHistory(h, h.present), h)
  let big = startHistory(0)
  for (let i = 1; i <= 150; i++) big = pushHistory(big, i, { at: i })
  assert.equal(big.past.length, 100)
  assert.equal(big.past[0], 50)
})

test('two workflows with the same content are the same, whatever the object', () => {
  assert.ok(sameWorkflow(base(), base()))
  assert.ok(!sameWorkflow(base(), moveNode(base(), 'a', { x: 1, y: 1 })))
  assert.ok(!sameWorkflow(base(), moveStatus(base(), 'd', 0)))
})
