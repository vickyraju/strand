import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, migrate, EMPTY, isDone, type Action, type State } from './reducer.ts'
import { sampleWorkspace } from './sample.ts'

const run = (actions: Action[], start: State = EMPTY) => actions.reduce((s, a) => reducer(s, a), start)

function workspace() {
  let s = run([
    { type: 'setOwner', name: 'Alex Morgan' },
    { type: 'addUser', name: 'Sam Lee' },
    { type: 'createProject', project: { id: 'p1', name: 'Payments', key: 'PAY', color: '#000', template: 'scrum' } },
  ])
  const sam = s.users[1].id
  s = run([{ type: 'createIssue', id: 'i1', issue: { projectId: 'p1', title: 'First' } }], s)
  return { s, owner: s.ownerId!, sam }
}

test('work items are numbered per project', () => {
  const { s } = workspace()
  const next = run([{ type: 'createIssue', id: 'i2', issue: { projectId: 'p1', title: 'Second' } }], s)
  assert.deepEqual(next.issues.map(i => i.key), ['PAY-1', 'PAY-2'])
})

test('the workflow blocks moves it does not allow', () => {
  const { s } = workspace()
  const p = s.projects[0]
  const strict = run([{ type: 'updateProject', id: 'p1', patch: {
    transitions: [{ id: 't', name: 'Start', from: ['todo'], to: 'in-progress' }],
  } }], s)
  const blocked = run([{ type: 'updateIssues', ids: ['i1'], patch: { status: 'done' } }], strict)
  assert.equal(blocked.issues[0].status, p.statuses[0].id)
  const moved = run([{ type: 'updateIssues', ids: ['i1'], patch: { status: 'in-progress' } }], strict)
  assert.equal(moved.issues[0].status, 'in-progress')
  assert.equal(moved.activity.at(-1)?.field, 'status')
})

test('notifications go to the people involved, never to the actor', () => {
  const { s, owner, sam } = workspace()
  // Owner assigns to Sam: Sam is notified, owner is not
  const assigned = run([{ type: 'updateIssues', ids: ['i1'], patch: { assigneeId: sam } }], s)
  assert.deepEqual(assigned.notifications.map(n => [n.userId, n.kind]), [[sam, 'assigned']])
  // Sam (acting) mentions the owner: owner gets one "mentioned", not also "commented"
  const mentioned = run([
    { type: 'actAs', userId: sam },
    { type: 'addComment', issueId: 'i1', body: 'Can you look, @Alex Morgan?' },
  ], assigned)
  const forOwner = mentioned.notifications.filter(n => n.userId === owner)
  assert.deepEqual(forOwner.map(n => n.kind), ['mentioned'])
})

test('completing a sprint moves unfinished work and records velocity', () => {
  let { s } = workspace()
  s = run([
    { type: 'createIssue', id: 'i2', issue: { projectId: 'p1', title: 'Done one', estimate: 3 } },
    { type: 'updateIssues', ids: ['i1'], patch: { estimate: 5 } },
    { type: 'createSprint', projectId: 'p1' },
  ], s)
  const sprint = s.sprints[0].id
  s = run([
    { type: 'updateIssues', ids: ['i1', 'i2'], patch: { sprintId: sprint } },
    { type: 'startSprint', id: sprint, endsAt: Date.now() },
    { type: 'updateIssues', ids: ['i2'], patch: { status: 'done' } },
    { type: 'completeSprint', id: sprint },
  ], s)
  const closed = s.sprints[0]
  assert.equal(closed.committed, 8)
  assert.equal(closed.completed, 3)
  assert.equal(s.issues.find(i => i.id === 'i1')!.sprintId, undefined)
  assert.equal(s.issues.find(i => i.id === 'i2')!.sprintId, sprint)
})

test('deleting a project removes everything inside it', () => {
  const { s } = workspace()
  const withComment = run([{ type: 'addComment', issueId: 'i1', body: 'hi' }], s)
  const gone = run([{ type: 'deleteProject', id: 'p1' }], withComment)
  assert.equal(gone.issues.length + gone.comments.length + gone.activity.length + gone.projects.length, 0)
})

test('v1 saves migrate to v2', () => {
  const v1 = {
    me: { id: 'u', name: 'Alex', initials: 'AL', color: '#000' }, users: [{ id: 'u', name: 'Alex', initials: 'AL', color: '#000' }],
    projects: [{ id: 'p', key: 'AB', name: 'AB', color: '#000', template: 'kanban', leadId: 'u', nextNumber: 2, createdAt: 1,
      statuses: [{ id: 'todo', name: 'To do', color: '#000' }, { id: 'done', name: 'Done', color: '#000', done: true }] }],
    issues: [{ id: 'i', key: 'AB-1', projectId: 'p', type: 'task', title: 'x', description: '', status: 'done', priority: 'none',
      reporterId: 'u', labels: [], createdAt: 1, updatedAt: 1 }],
    activity: [{ id: 'a', issueId: 'i', actorId: 'u', text: 'created the work item', createdAt: 1 }],
  }
  const s = migrate(v1)
  assert.equal(s.version, 2)
  assert.equal(s.ownerId, 'u')
  assert.ok(isDone(s.projects[0], s.issues[0]))
  assert.equal(s.projects[0].transitions.length, 2)
  assert.deepEqual(s.issues[0].watcherIds, ['u'])
})

test('sample workspace loads, is consistent, and can be removed', () => {
  const s0 = run([{ type: 'setOwner', name: 'Alex Morgan' }])
  const owner = s0.users[0]
  const s = run([{ type: 'merge', data: sampleWorkspace(owner) }], s0)
  assert.equal(s.projects.length, 3)
  assert.ok(s.issues.length >= 50)
  // Every status referenced exists, every parent exists, keys are unique
  for (const i of s.issues) {
    const p = s.projects.find(x => x.id === i.projectId)!
    assert.ok(p.statuses.some(st => st.id === i.status), `${i.key} has unknown status`)
    if (i.parentId) assert.ok(s.issues.some(x => x.id === i.parentId))
  }
  assert.equal(new Set(s.issues.map(i => i.key)).size, s.issues.length)
  // Closed sprints have velocity numbers
  for (const sp of s.sprints.filter(x => x.state === 'closed')) assert.ok(sp.completed! > 0 && sp.committed! >= sp.completed!)
  assert.ok(s.notifications.some(n => n.userId === owner.id && !n.read))
  const cleaned = run([{ type: 'removeSample' }], s)
  assert.deepEqual([cleaned.projects.length, cleaned.issues.length, cleaned.users.length], [0, 0, 1])
})
