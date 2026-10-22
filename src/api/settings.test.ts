import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemsOf, releaseMoveTo } from './settings.ts'
import { DEFAULT_BOARD_PREFS, type Issue, type Project } from '../data/reducer.ts'

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', key: 'PAY', name: 'Pay', description: '', color: '#000000', template: 'scrum', leadId: 'u1',
  statuses: [{ id: 's1', name: 'To do', color: '#111111', category: 'todo' }, { id: 's2', name: 'Done', color: '#222222', category: 'done', wipLimit: 3, description: 'Work is finished' }],
  transitions: [{ id: 't1', name: 'Finish', from: 'any', to: 's2' }, { id: 't2', name: 'Start', from: ['s1'], to: 's2' }],
  layout: {}, boardPrefs: DEFAULT_BOARD_PREFS, nextNumber: 1, createdAt: 1,
  rules: [{ id: 'r1', name: 'Auto', enabled: true, trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }], runs: 4 }],
  fields: [{ id: 'f1', name: 'Team', kind: 'select', options: ['A', 'B'] }, { id: 'f2', name: 'Note', kind: 'text' }],
  releases: [{ id: 'rel1', name: '1.0', description: '', released: false, releaseDate: '2026-12-01' }],
  templates: [{ id: 'tp', name: 'Bug', type: 'bug', title: 'Bug: ', description: '', priority: 'high', labels: ['bug'] }], ...over,
})

test('settings items serialize exactly what the server stores (positions, null for absent, any-status transitions)', () => {
  const p = project()
  assert.deepEqual(itemsOf([p], 'statuses').map(i => i.body), [
    { name: 'To do', description: '', color: '#111111', category: 'todo', wipLimit: null, position: 0 },
    { name: 'Done', description: 'Work is finished', color: '#222222', category: 'done', wipLimit: 3, position: 1 }])
  assert.deepEqual(itemsOf([p], 'transitions').map(i => i.body.fromIds), [null, ['s1']])
  assert.deepEqual(itemsOf([p], 'fields').map(i => [i.body.options, i.body.position]), [[['A', 'B'], 0], [null, 1]])
  assert.equal(itemsOf([p], 'templates')[0]!.body.estimate, null)
  assert.deepEqual(Object.keys(itemsOf([p], 'rules')[0]!.body), ['name', 'enabled', 'trigger', 'actions'])   // `runs` is the server's
  assert.deepEqual([itemsOf([p], 'releases')[0]!.released, itemsOf([p], 'releases')[0]!.body.startDate], [false, null])
})

test('reordering statuses changes only their positions, so it is detected as an edit', () => {
  const [a, b] = project().statuses
  const before = itemsOf([project()], 'statuses'), after = itemsOf([project({ statuses: [b!, a!] })], 'statuses')
  assert.deepEqual(after.map(i => [i.id, i.body.position]), [['s2', 0], ['s1', 1]])
  assert.notDeepEqual(before.find(i => i.id === 's1')!.body, after.find(i => i.id === 's1')!.body)
})

const issue = (id: string, releaseId?: string, status = 'todo'): Issue => ({
  id, key: id, projectId: 'p1', type: 'task', title: id, description: '', status, priority: 'none', reporterId: 'u', labels: [],
  watcherIds: [], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1, ...(releaseId ? { releaseId } : {}),
})

test('releaseMoveTo finds the release unfinished work was moved to, ignoring finished work', () => {
  const unfinished = (i: Issue) => i.status !== 'done'
  const before = [issue('a', 'r1'), issue('b', 'r1', 'done'), issue('c', 'r1'), issue('z', 'r9')]
  assert.equal(releaseMoveTo('r1', before, [issue('a', 'r2'), issue('b', 'r1', 'done'), issue('c', 'r2'), issue('z', 'r9')], unfinished), 'r2')
  assert.equal(releaseMoveTo('r1', before, [issue('a'), issue('b', 'r1', 'done'), issue('c'), issue('z', 'r9')], unfinished), null)
})
