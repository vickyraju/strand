import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allows, problems, actionChanges, needsInput, type RuleCtx, type ConditionGroup } from '../src/shared/transitionRules.ts'

const item = { assigneeId: 'ann', reporterId: 'rob', priority: 'high', labels: ['ui'], dueDate: null, custom: { f1: 'x' } }
const ctx = (o: Partial<RuleCtx> = {}): RuleCtx => ({
  mover: { id: 'ann', role: 'member', groupIds: ['g1'] }, item, leadId: 'lea', openChildren: 0, parent: null, ...o })
const one = (c: any): ConditionGroup => ({ op: 'all', items: [c] })

test('restrict: who may move (assignee, reporter, lead, people, role, group); automation is not a person', () => {
  assert.equal(allows(one({ kind: 'person', who: 'assignee' }), ctx()), true)
  assert.equal(allows(one({ kind: 'person', who: 'reporter' }), ctx()), false)
  assert.equal(allows(one({ kind: 'person', who: 'lead' }), ctx({ mover: { id: 'lea', groupIds: [] } })), true)
  assert.equal(allows(one({ kind: 'users', userIds: ['bob'] }), ctx()), false)
  assert.equal(allows(one({ kind: 'role', roles: ['admin'] }), ctx()), false)
  assert.equal(allows(one({ kind: 'role', roles: ['admin', 'member'] }), ctx()), true)
  assert.equal(allows(one({ kind: 'group', groupIds: ['g1'] }), ctx()), true)
  assert.equal(allows(one({ kind: 'hidden' }), ctx()), false)
  // automation (no mover): person rules don't apply, "hidden" is for it; rules about the item still do
  assert.equal(allows(one({ kind: 'person', who: 'reporter' }), ctx({ mover: null })), true)
  assert.equal(allows(one({ kind: 'hidden' }), ctx({ mover: null })), true)
  assert.equal(allows(one({ kind: 'childrenDone' }), ctx({ mover: null, openChildren: 2 })), false)
  assert.equal(allows(undefined, ctx()), true)
  assert.equal(allows({ op: 'any', items: [] }, ctx()), true)
})

test('restrict: field values, and groups that must be all or can be any, nested', () => {
  assert.equal(allows(one({ kind: 'field', field: 'priority', op: 'is', value: 'high' }), ctx()), true)
  assert.equal(allows(one({ kind: 'field', field: 'labels', op: 'is', value: 'ui' }), ctx()), true)          // a list: contains
  assert.equal(allows(one({ kind: 'field', field: 'dueDate', op: 'notEmpty' }), ctx()), false)
  assert.equal(allows(one({ kind: 'field', field: 'custom.f1', op: 'isNot', value: 'x' }), ctx()), false)
  // "the assignee, or (an admin and in group g1)"
  const g: ConditionGroup = { op: 'any', items: [
    { kind: 'person', who: 'assignee' },
    { op: 'all', items: [{ kind: 'role', roles: ['admin'] }, { kind: 'group', groupIds: ['g1'] }] },
  ] }
  assert.equal(allows(g, ctx()), true)
  assert.equal(allows(g, ctx({ mover: { id: 'zed', role: 'admin', groupIds: ['g1'] } })), true)
  assert.equal(allows(g, ctx({ mover: { id: 'zed', role: 'admin', groupIds: [] } })), false)
  assert.equal(allows(g, ctx({ mover: { id: 'zed', role: 'member', groupIds: ['g1'] } })), false)
})

test('validate: required fields and comment, a field changed in the move, the parent\'s status', () => {
  const r = { validate: [{ kind: 'required' as const, fields: ['dueDate', 'comment', 'custom.f1'] }, { kind: 'changed' as const, field: 'priority' }] }
  const errs = problems(r, ctx(), item, item)
  assert.deepEqual(Object.keys(errs).sort(), ['comment', 'dueDate', 'priority'])
  assert.match(errs.dueDate!, /Due date is required/)
  assert.deepEqual(problems(r, ctx(), item, { ...item, dueDate: '2026-11-01', priority: 'low' }, 'done it'), {})
  const parent = { kind: 'parentStatus' as const, statusIds: ['s-doing'] }
  assert.match(problems({ validate: [parent] }, ctx(), item, item).parent!, /only for items with a parent/)
  assert.match(problems({ validate: [parent] }, ctx({ parent: { statusId: 's-todo' }, statusName: () => 'In Progress' }), item, item).parent!, /must be in In Progress/)
  assert.deepEqual(problems({ validate: [parent] }, ctx({ parent: { statusId: 's-doing' } }), item, item), {})
  assert.equal(needsInput({ screen: ['comment'] }, ctx(), item, item), true)
  assert.equal(needsInput({}, ctx(), item, item), false)
})

test('actions: assign, set and clear (today for dates), copy from the parent, comment', () => {
  const now = new Date('2026-10-24T10:00:00Z')
  const { patch, comments } = actionChanges({ actions: [
    { kind: 'assign', to: 'reporter' },
    { kind: 'set', field: 'dueDate', value: 'today' },
    { kind: 'set', field: 'custom.f1', value: null },
    { kind: 'copyFromParent', field: 'fixReleaseIds' },
    { kind: 'comment', body: 'Moved by the workflow' },
  ] }, ctx({ parent: { statusId: 's', fixReleaseIds: ['r1'] } }), item, now)
  assert.deepEqual(patch, { assigneeId: 'rob', dueDate: '2026-10-24', fixReleaseIds: ['r1'], custom: {} })
  assert.deepEqual(comments, ['Moved by the workflow'])
  assert.deepEqual(actionChanges({ actions: [{ kind: 'assign', to: 'mover' }] }, ctx({ mover: null }), item).patch, {})   // automation is nobody to assign
  assert.deepEqual(actionChanges({ actions: [{ kind: 'assign', to: 'none' }] }, ctx(), item).patch, { assigneeId: null })
})

test('[0301.R7] fix versions in rules: a set action gives a one-version list, cleared is none, required needs one, copy takes the list', () => {
  const set = (value: string | null) => actionChanges({ actions: [{ kind: 'set', field: 'fixReleaseIds', value }] }, ctx(), item).patch
  assert.deepEqual(set('r2'), { fixReleaseIds: ['r2'] })
  assert.deepEqual(set(null), { fixReleaseIds: [] })
  const need = { validate: [{ kind: 'required' as const, fields: ['fixReleaseIds'] }] }
  assert.ok(problems(need, ctx(), item, { ...item, fixReleaseIds: [] }).fixReleaseIds)
  assert.deepEqual(problems(need, ctx(), item, { ...item, fixReleaseIds: ['r1'] }), {})
  assert.deepEqual(actionChanges({ actions: [{ kind: 'copyFromParent', field: 'fixReleaseIds' }] }, ctx({ parent: { statusId: 's', fixReleaseIds: ['r1', 'r2'] } }), item).patch, { fixReleaseIds: ['r1', 'r2'] })
})
