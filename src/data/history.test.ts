import { test } from 'node:test'
import assert from 'node:assert/strict'
import { undoableReducer, canUndo, type StoreAction, type Undoable } from './history.ts'
import { EMPTY } from './reducer.ts'

const run = (o: Undoable, actions: StoreAction[]) => actions.reduce(undoableReducer, o)

test('undo restores a deleted work item, once', () => {
  let o = run({ state: EMPTY }, [
    { type: 'setOwner', name: 'Alex' },
    { type: 'createProject', project: { id: 'p', name: 'P', key: 'PP', color: '#000', template: 'kanban' } },
    { type: 'createIssue', id: 'i', issue: { projectId: 'p', title: 'Keep me' } },
  ])
  assert.equal(canUndo(o), false)
  o = run(o, [{ type: 'deleteIssues', ids: ['i'] }])
  assert.equal(o.state.issues.length, 0)
  assert.equal(canUndo(o), true)
  o = run(o, [{ type: 'undo' }])
  assert.equal(o.state.issues[0].title, 'Keep me')
  assert.equal(canUndo(o), false)
})

test('undo is withdrawn once something else changes', () => {
  let o = run({ state: EMPTY }, [
    { type: 'setOwner', name: 'Alex' },
    { type: 'createProject', project: { id: 'p', name: 'P', key: 'PP', color: '#000', template: 'kanban' } },
    { type: 'createIssue', id: 'i', issue: { projectId: 'p', title: 'A' } },
    { type: 'deleteIssues', ids: ['i'] },
    { type: 'createIssue', id: 'j', issue: { projectId: 'p', title: 'B' } },
  ])
  assert.equal(canUndo(o), false)
  const same = run(o, [{ type: 'undo' }])
  assert.equal(same, o)
})
