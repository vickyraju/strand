import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveToOf } from './sprints.ts'
import type { Issue, Sprint } from '../data/reducer.ts'

const sprint = (over: Partial<Sprint> = {}): Sprint => ({ id: 's1', projectId: 'p', name: 'S1', goal: '', state: 'closed', issueIds: ['a', 'b', 'c'], ...over })
const issue = (id: string, sprintId?: string): Issue => ({
  id, key: id, projectId: 'p', type: 'task', title: id, description: '', status: 'x', priority: 'none', reporterId: 'u', labels: [],
  watcherIds: [], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1, ...(sprintId ? { sprintId } : {}),
})

test('moveToOf finds the sprint unfinished work was carried into, or the backlog', () => {
  assert.equal(moveToOf(sprint(), [issue('a', 's1'), issue('b', 's2'), issue('c', 's2'), issue('z', 's9')]), 's2')   // z is not a member
  assert.equal(moveToOf(sprint(), [issue('a', 's1'), issue('b'), issue('c', 's1')]), null)                          // sent to the backlog
  assert.equal(moveToOf(sprint({ issueIds: undefined }), [issue('a', 's2')]), null)
})
