import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL, EPIC_COLORS, epicColor, epicTarget, panelFilter, panelTarget, planEpicDrop, planVersionDrop, versionTarget } from './panelRules.ts'

const items = [
  { id: 'e1', key: 'P-1', type: 'epic' },
  { id: 'a', key: 'P-2', type: 'story', parentId: 'e1', fixReleaseIds: ['v1'] },
  { id: 'b', key: 'P-3', type: 'task', fixReleaseIds: [] as string[] },
  { id: 's', key: 'P-4', type: 'subtask', parentId: 'b' },
]
const isEpic = (id: string) => id === 'e1'

test('[0407.R6] an epic’s colour: its own, else the same one picked from its key every time', () => {
  assert.equal(epicColor({ key: 'P-1', epicColor: 'ghx-label-4' }), EPIC_COLORS['ghx-label-4'])
  assert.equal(epicColor({ key: 'P-9' }), epicColor({ key: 'P-9' }))
  assert.ok(Object.values(EPIC_COLORS).includes(epicColor({ key: 'P-9', epicColor: 'red' })))
})

test('[0407.R3][0407.R8] the panel filters: one epic, items without an epic, one version, without versions, all', () => {
  const keys = (epic: any, version: any) => panelFilter(items, { epic, version, isEpic }).map(i => i.id)
  assert.deepEqual(keys({ kind: 'one', id: 'e1' }, ALL), ['a'])
  assert.deepEqual(keys({ kind: 'none' }, ALL), ['e1', 'b', 's'])                  // a sub-item's parent isn't an epic
  assert.deepEqual(keys(ALL, { kind: 'one', id: 'v1' }), ['a'])
  assert.deepEqual(keys(ALL, { kind: 'none' }), ['e1', 'b', 's'])
  assert.deepEqual(keys({ kind: 'one', id: 'e1' }, { kind: 'none' }), [])         // ANDed
  assert.equal(keys(ALL, ALL).length, 4)
})

test('[0407.R4] dropping on an epic: items move under it; one already there stays; an epic or a sub-item stops them all', () => {
  const isSubItem = (i: { parentId?: string }) => !!i.parentId && !isEpic(i.parentId)
  assert.deepEqual(planEpicDrop([items[1]!, items[2]!], 'e1', { isEpic, isSubItem }), { moves: [{ id: 'b', parentId: 'e1' }] })
  assert.deepEqual(planEpicDrop([items[1]!], null, { isEpic, isSubItem }), { moves: [{ id: 'a', parentId: null }] })   // Issues without epics
  assert.deepEqual(planEpicDrop([items[2]!, items[3]!], 'e1', { isEpic, isSubItem }), { blocked: 'P-4 is a sub-item: its parent stays its own' })
  assert.deepEqual(planEpicDrop([items[0]!], 'e1', { isEpic, isSubItem }), { blocked: 'P-1 is an epic: an epic has no parent' })
})

test('[0407.R9] dropping on a version adds it to the fix versions; on Issues without versions they are cleared', () => {
  assert.deepEqual(planVersionDrop([items[1]!, items[2]!], 'v1'), [{ id: 'b', fixReleaseIds: ['v1'] }])
  assert.deepEqual(planVersionDrop([items[1]!, items[2]!], 'v2'), [{ id: 'a', fixReleaseIds: ['v1', 'v2'] }, { id: 'b', fixReleaseIds: ['v2'] }])
  assert.deepEqual(planVersionDrop([items[1]!, items[2]!], null), [{ id: 'a', fixReleaseIds: [] }])
})

test('panel drop targets round-trip', () => {
  assert.deepEqual(panelTarget(epicTarget('e1')), { kind: 'epic', id: 'e1' })
  assert.deepEqual(panelTarget(versionTarget(null)), { kind: 'version', id: null })
  assert.equal(panelTarget('row:a'), null)
})
