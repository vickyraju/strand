// One-step undo for destructive and bulk changes. Undo is only offered while nothing else has changed since,
// so it can never silently revert someone's later edits.
import { reducer, type Action, type State } from './reducer.ts'

export const UNDOABLE = new Set<Action['type']>([
  'deleteIssues', 'updateIssues', 'moveIssue', 'deleteSprint', 'completeSprint', 'deleteComment', 'removeAttachment',
  'deleteView', 'deleteDashboard', 'releaseVersion', 'removeUser', 'archive', 'deleteProject', 'removeLink',
])

export type StoreAction = Action | { type: 'undo' }
export interface Undoable { state: State; undo?: { before: State; after: State; type: Action['type'] } }

export function undoableReducer(o: Undoable, a: StoreAction): Undoable {
  if (a.type === 'undo') return o.undo && o.state === o.undo.after ? { state: o.undo.before } : o
  const next = reducer(o.state, a)
  if (next === o.state) return o
  return UNDOABLE.has(a.type) ? { state: next, undo: { before: o.state, after: next, type: a.type } } : { state: next, undo: o.undo }
}

export const canUndo = (o: Undoable) => !!o.undo && o.state === o.undo.after
