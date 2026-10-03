import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, guessMapping, mapRows } from './csv.ts'
import { DEFAULT_STATUSES, type Project } from './reducer.ts'

test('CSV parsing handles quotes, commas and newlines inside fields', () => {
  const rows = parseCsv('Summary,Description\r\n"Fix login, again","Line one\nLine ""two"""\n\nPlain,\n')
  assert.deepEqual(rows, [['Summary', 'Description'], ['Fix login, again', 'Line one\nLine "two"'], ['Plain', '']])
})

test('Jira-style exports map onto work items', () => {
  const [head, ...rows] = parseCsv('Issue Type,Summary,Status,Priority,Assignee,Labels,Story Points,Due Date\nBug,Crash on save,In Progress,Highest,Sam,ios android,3,2026-11-02\nStory,Dark mode,Someday,Lowest,Nobody,,,')
  const project = { id: 'p', statuses: DEFAULT_STATUSES } as Project
  const out = mapRows(rows, guessMapping(head), project, [{ id: 'u1', name: 'Sam Lee', initials: 'SL', color: '#000' }])
  assert.deepEqual(out[0].issue, {
    projectId: 'p', title: 'Crash on save', description: '', type: 'bug', status: 'in-progress', priority: 'urgent',
    assigneeId: 'u1', labels: ['ios', 'android'], estimate: 3, dueDate: '2026-11-02',
  })
  assert.equal(out[1].issue.status, 'todo')
  assert.equal(out[1].warnings.length, 2)
})
