import { test } from 'node:test'
import assert from 'node:assert/strict'
import { worklogItems, linkItems, watchItems, linkId } from './detail.ts'
import type { Issue } from '../data/reducer.ts'

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
  id, key: id, projectId: 'p', type: 'task', title: id, description: '', status: 's', priority: 'none', reporterId: 'u', labels: [],
  watcherIds: [], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1, ...over,
})
const log = (id: string) => ({ id, userId: 'u', minutes: 30, date: '2026-10-01', note: '', at: 1 })

test('only issues whose detail is loaded contribute items, so unloaded ones are never mistaken for deletions', () => {
  const issues = [issue('a', { worklogs: [log('w1')], links: [{ type: 'blocks', issueId: 'b' }], watcherIds: ['me', 'x'] }), issue('b', { worklogs: [log('w2')], watcherIds: ['me'] })]
  const loaded = new Set(['a'])
  assert.deepEqual(worklogItems(issues, loaded).map(w => [w.id, w.issueId]), [['w1', 'a']])
  assert.deepEqual(linkItems(issues, loaded), [{ id: linkId('a', 'blocks', 'b'), issueId: 'a', type: 'blocks', otherId: 'b' }])
  assert.deepEqual(watchItems(issues, loaded, 'me'), [{ id: 'a' }])           // only me, only loaded issues
  assert.deepEqual(watchItems(issues, loaded, null), [])
  assert.deepEqual(worklogItems(issues, new Set()), [])
})
