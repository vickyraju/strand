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
  assert.equal(s.version, 3)
  assert.equal(s.issues[0].rank, 1)
  assert.deepEqual(s.projects[0].rules, [])
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

test('moving an item re-ranks only that item', () => {
  let { s } = workspace()
  s = run(['i2', 'i3', 'i4'].map(id => ({ type: 'createIssue', id, issue: { projectId: 'p1', title: id } }) as Action), s)
  const before = new Map(s.issues.map(i => [i.id, i.rank]))
  s = run([{ type: 'moveIssue', id: 'i4', beforeId: 'i2' }], s)
  const order = [...s.issues].sort((a, b) => a.rank - b.rank).map(i => i.id)
  assert.deepEqual(order, ['i1', 'i4', 'i2', 'i3'])
  assert.deepEqual(s.issues.filter(i => i.rank !== before.get(i.id)).map(i => i.id), ['i4'])
  // To the top, then into a sprint at the bottom
  s = run([{ type: 'moveIssue', id: 'i3', beforeId: 'i1' }], s)
  assert.equal([...s.issues].sort((a, b) => a.rank - b.rank)[0].id, 'i3')
  s = run([{ type: 'createSprint', projectId: 'p1' }], s)
  s = run([{ type: 'moveIssue', id: 'i2', container: s.sprints[0].id }], s)
  assert.equal(s.issues.find(i => i.id === 'i2')!.sprintId, s.sprints[0].id)
})

test('automation rules fire once per event and respect the enabled switch', () => {
  let { s, sam } = workspace()
  const rule = (enabled: boolean) => ({
    id: 'r', name: 'Ship it', enabled, runs: 0,
    trigger: { kind: 'status' as const, to: 'done' },
    actions: [{ kind: 'label' as const, value: 'shipped' }, { kind: 'assign' as const, to: 'reporter' }],
  })
  s = run([{ type: 'updateIssues', ids: ['i1'], patch: { assigneeId: sam } }, { type: 'updateProject', id: 'p1', patch: { rules: [rule(true)] } }], s)
  s = run([{ type: 'updateIssues', ids: ['i1'], patch: { status: 'done' } }], s)
  const issue = s.issues[0]
  assert.deepEqual(issue.labels, ['shipped'])
  assert.equal(issue.assigneeId, issue.reporterId)
  assert.equal(s.projects[0].rules[0].runs, 1)
  assert.ok(s.activity.some(a => a.actorId === 'automation'))
  // Disabled: nothing happens
  let t = workspace().s
  t = run([{ type: 'updateProject', id: 'p1', patch: { rules: [rule(false)] } }, { type: 'updateIssues', ids: ['i1'], patch: { status: 'done' } }], t)
  assert.deepEqual(t.issues[0].labels, [])
})

test('a rule on creation runs for new items', () => {
  let { s } = workspace()
  s = run([{ type: 'updateProject', id: 'p1', patch: { rules: [{
    id: 'r', name: 'Triage', enabled: true, runs: 0, trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }, { kind: 'comment', body: 'Thanks, triaging.' }],
  }] } }, { type: 'createIssue', id: 'i9', issue: { projectId: 'p1', title: 'New' } }], s)
  const i9 = s.issues.find(i => i.id === 'i9')!
  assert.equal(i9.priority, 'high')
  assert.equal(s.comments.filter(c => c.issueId === 'i9').length, 1)
})
