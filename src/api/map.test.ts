import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapProject, mapWorkspace, mapSprint, mapIssue, mapIssueDetail } from './map.ts'
import { DEFAULT_BOARD_PREFS } from '../data/reducer.ts'

const apiProject = {
  id: 'p1', key: 'PAY', name: 'Payments', description: null, color: '#112233', template: 'scrum', leadId: null,
  nextNumber: 4, boardPrefs: {}, layout: {}, sample: false, createdAt: '2026-10-01T10:00:00.000Z',
  statuses: [
    { id: 's1', name: 'To do', color: '#000000', category: 'todo', wipLimit: null, position: 0 },
    { id: 's2', name: 'Done', color: '#00aa00', category: 'done', wipLimit: 3, position: 1 },
  ],
  transitions: [{ id: 't1', name: 'Finish', fromIds: null, toId: 's2' }, { id: 't2', name: 'Start', fromIds: ['s1'], toId: 's2' }],
  fields: [{ id: 'f1', name: 'Team', kind: 'select', options: ['A', 'B'], position: 0 }, { id: 'f2', name: 'Note', kind: 'text', options: null }],
  templates: [{ id: 'tp', name: 'Bug', type: 'bug', title: 'Bug: ', description: null, priority: 'high', labels: null, estimate: null }],
  rules: [{ id: 'r1', name: 'Auto', enabled: true, trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }], runs: 2 }],
  releases: [{ id: 'rel', name: '1.0', description: '', startDate: null, releaseDate: '2026-12-01', released: true, releasedAt: '2026-12-02T00:00:00.000Z' }],
  sprints: [{ id: 'sp', projectId: 'p1', name: 'S1', goal: null, state: 'active', startedAt: '2026-10-02T00:00:00.000Z', endsAt: '2026-10-16T00:00:00.000Z', completedAt: null, committed: 8, completed: null, issueIds: null }],
}

test('a project maps to the app shape: nulls become absent, ISO dates become epoch ms', () => {
  const p = mapProject(apiProject)
  assert.equal(p.description, '')
  assert.equal(p.leadId, '')
  assert.equal(p.createdAt, Date.parse('2026-10-01T10:00:00.000Z'))
  assert.deepEqual(p.statuses[0], { id: 's1', name: 'To do', color: '#000000', category: 'todo' })      // no wipLimit key
  assert.equal(p.statuses[1]!.wipLimit, 3)
  assert.deepEqual(p.transitions.map(t => t.from), ['any', ['s1']])                                      // null = from any status
  assert.deepEqual(p.fields[1], { id: 'f2', name: 'Note', kind: 'text' })                                // no options key
  assert.deepEqual(p.templates[0]!.labels, [])
  assert.equal('estimate' in p.templates[0]!, false)
  assert.equal(p.releases[0]!.releasedAt, Date.parse('2026-12-02T00:00:00.000Z'))
  assert.equal('startDate' in p.releases[0]!, false)
  assert.equal(p.rules[0]!.runs, 2)
})

test('empty server board prefs fall back to the app defaults; partial prefs are merged', () => {
  assert.deepEqual(mapProject(apiProject).boardPrefs, DEFAULT_BOARD_PREFS)
  const merged = mapProject({ ...apiProject, boardPrefs: { groupBy: 'assignee', fields: { due: false } } }).boardPrefs
  assert.equal(merged.groupBy, 'assignee')
  assert.equal(merged.fields.due, false)
  assert.equal(merged.fields.key, true)
})

test('a sprint keeps its snapshots and drops what is null', () => {
  const s = mapSprint(apiProject.sprints[0]!)
  assert.equal(s.committed, 8)
  assert.equal('completed' in s, false)
  assert.equal(s.completedAt, undefined)
  assert.equal(s.endsAt, Date.parse('2026-10-16T00:00:00.000Z'))
})

test('the workspace makes the signed-in user the owner and collects every sprint', () => {
  const s = mapWorkspace({ id: 'u1' }, [{ id: 'u1', name: 'Vicky', initials: 'V', color: '#fff', title: null }], [apiProject], ['p1'])
  assert.equal(s.ownerId, 'u1')
  assert.equal(s.actingAsId, null)
  assert.deepEqual(s.users[0], { id: 'u1', name: 'Vicky', initials: 'V', color: '#fff' })
  assert.equal(s.sprints.length, 1)
  assert.deepEqual(s.starred, ['p1'])
  assert.equal(s.issues.length, 0)
})

test('an issue row maps status ids, drops nulls and leaves the detail-only collections empty', () => {
  const i = mapIssue({
    id: 'i1', key: 'PAY-1', projectId: 'p1', type: 'bug', title: 'T', description: null, statusId: 's2', priority: 'high',
    assigneeId: null, reporterId: 'u1', labels: ['a'], estimate: 3, timeEstimate: null, dueDate: '2026-11-01', startDate: null,
    sprintId: 'sp', releaseId: null, parentId: null, custom: { f1: 'A' }, rank: 2000.5, version: 3,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  })
  assert.equal(i.status, 's2')
  assert.equal(i.description, '')
  assert.deepEqual([i.estimate, i.dueDate, i.sprintId], [3, '2026-11-01', 'sp'])
  for (const k of ['assigneeId', 'timeEstimate', 'startDate', 'releaseId', 'parentId']) assert.equal(k in i, false, k)
  assert.deepEqual([i.watcherIds, i.links, i.attachments, i.worklogs], [[], [], [], []])
  assert.equal(i.rank, 2000.5)
  assert.equal(i.updatedAt, Date.parse('2026-10-02T00:00:00.000Z'))
})

test('issue detail maps comments, history (null actor = automation), time logs, outgoing links and watchers', () => {
  const d = mapIssueDetail({
    comments: [{ id: 'c1', issueId: 'i1', authorId: 'u1', body: 'hi', createdAt: '2026-10-01T00:00:00.000Z', editedAt: null }, { id: 'c2', issueId: 'i1', authorId: null, body: 'auto', createdAt: '2026-10-02T00:00:00.000Z', editedAt: '2026-10-03T00:00:00.000Z' }],
    activity: [{ id: 'a1', issueId: 'i1', actorId: null, field: null, fromValue: null, toValue: null, text: 'Automation rule ran', createdAt: '2026-10-01T00:00:00.000Z' },
               { id: 'a2', issueId: 'i1', actorId: 'u1', field: 'status', fromValue: 's1', toValue: 's2', text: 'Changed status', createdAt: '2026-10-01T00:00:00.000Z' }],
    worklogs: [{ id: 'w1', userId: 'u1', minutes: 90, date: '2026-10-01', note: null, createdAt: '2026-10-01T09:00:00.000Z' }],
    links: [{ type: 'blocks', dir: 'out', issueId: 'i2', key: 'PAY-2' }, { type: 'blocks', dir: 'in', issueId: 'i3', key: 'PAY-3' }],
    watcherIds: ['u1'],
  })
  assert.equal(d.comments[0]!.editedAt, undefined)
  assert.equal(d.comments[1]!.editedAt, Date.parse('2026-10-03T00:00:00.000Z'))
  assert.deepEqual([d.activity[0]!.actorId, 'field' in d.activity[0]!], ['automation', false])
  assert.deepEqual([d.activity[1]!.field, d.activity[1]!.from, d.activity[1]!.to], ['status', 's1', 's2'])
  assert.deepEqual(d.worklogs[0], { id: 'w1', userId: 'u1', minutes: 90, date: '2026-10-01', note: '', at: Date.parse('2026-10-01T09:00:00.000Z') })
  assert.deepEqual(d.links, [{ type: 'blocks', issueId: 'i2' }])           // the incoming one belongs to the other issue
  assert.deepEqual(d.watcherIds, ['u1'])
})
