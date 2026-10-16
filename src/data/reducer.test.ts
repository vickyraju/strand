import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, migrate, EMPTY, isDone, type Action, type State, type Issue } from './reducer.ts'
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
  assert.equal(s.version, 4)
  assert.deepEqual([s.views, s.projects[0].fields, s.issues[0].worklogs], [[], [], []])
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

test('time logs add up and only the author can delete theirs', () => {
  let { s, sam } = workspace()
  s = run([
    { type: 'logWork', issueId: 'i1', minutes: 90, date: '2026-10-01', note: 'setup' },
    { type: 'actAs', userId: sam },
    { type: 'logWork', issueId: 'i1', minutes: 30, date: '2026-10-02', note: '' },
  ], s)
  assert.equal(s.issues[0].worklogs.reduce((n, w) => n + w.minutes, 0), 120)
  const ownerLog = s.issues[0].worklogs[0].id
  s = run([{ type: 'deleteWorklog', issueId: 'i1', worklogId: ownerLog }], s) // Sam can't delete the owner's log
  assert.equal(s.issues[0].worklogs.length, 2)
  assert.ok(s.activity.some(a => a.text === 'logged 1h 30m'))
})

test('releasing a version moves unfinished work to the next one', () => {
  let { s } = workspace()
  s = run([
    { type: 'createIssue', id: 'i2', issue: { projectId: 'p1', title: 'Done one' } },
    { type: 'updateProject', id: 'p1', patch: { releases: [
      { id: 'r1', name: '1.0', description: '', released: false },
      { id: 'r2', name: '1.1', description: '', released: false },
    ] } },
    { type: 'updateIssues', ids: ['i1', 'i2'], patch: { releaseId: 'r1' } },
    { type: 'updateIssues', ids: ['i2'], patch: { status: 'done' } },
    { type: 'releaseVersion', projectId: 'p1', releaseId: 'r1', moveTo: 'r2' },
  ], s)
  assert.ok(s.projects[0].releases[0].released)
  assert.equal(s.issues.find(i => i.id === 'i1')!.releaseId, 'r2')
  assert.equal(s.issues.find(i => i.id === 'i2')!.releaseId, 'r1')
})

test('deleting a project clears it from views and dashboards', () => {
  let { s, owner } = workspace()
  s = run([
    { type: 'saveView', view: { id: 'v', name: 'Mine', ownerId: owner, shared: false, filters: { q: '', projectId: 'p1', assignee: 'me', resolution: 'open' } } },
    { type: 'saveDashboard', dashboard: { id: 'd', name: 'Home', ownerId: owner, gadgets: [{ id: 'g1', kind: 'status', projectId: 'p1' }, { id: 'g2', kind: 'view', viewId: 'v' }] } },
    { type: 'deleteProject', id: 'p1' },
  ], s)
  assert.equal(s.views[0].filters.projectId, undefined)
  assert.deepEqual(s.dashboards[0].gadgets.map(g => g.id), ['g2'])
  s = run([{ type: 'deleteView', id: 'v' }], s)
  assert.deepEqual(s.dashboards[0].gadgets, [])
})

test('syncIssue adopts the server copy but keeps local-only parts; upsertProject adds then replaces', () => {
  const issue = (over: Partial<Issue> = {}): Issue => ({
    id: 'i1', key: 'PAY-local', projectId: 'p1', type: 'task', title: 'T', description: '', status: 'todo', priority: 'none', reporterId: 'u',
    labels: [], watcherIds: ['w'], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1, ...over,
  })
  const s0 = { ...EMPTY, issues: [issue()] }
  const s1 = reducer(s0, { type: 'syncIssue', issue: issue({ key: 'PAY-7', watcherIds: [], priority: 'high' }) })
  assert.equal(s1.issues[0]!.key, 'PAY-7')
  assert.equal(s1.issues[0]!.priority, 'high')
  assert.deepEqual(s1.issues[0]!.watcherIds, ['w'])                       // local-only part kept
  assert.equal(reducer(s1, { type: 'syncIssue', issue: issue({ key: 'PAY-7', priority: 'high' }) }), s1)   // no change, same state
  assert.equal(reducer(s0, { type: 'syncIssue', issue: issue({ id: 'gone' }) }), s0)

  const proj = run([{ type: 'setOwner', name: 'Alex' }, { type: 'createProject', project: { id: 'p1', name: 'A', key: 'AAA', color: '#000', template: 'kanban' } }]).projects[0]!
  const added = reducer(EMPTY, { type: 'upsertProject', project: proj })
  assert.equal(added.projects.length, 1)
  assert.equal(reducer(added, { type: 'upsertProject', project: { ...proj, name: 'Renamed' } }).projects[0]!.name, 'Renamed')
})

test('loadIssues replaces only that project\'s issues and is not undoable', async () => {
  const base = run([
    { type: 'setOwner', name: 'Alex' },
    { type: 'createProject', project: { id: 'p1', name: 'A', key: 'AAA', color: '#000', template: 'kanban' } },
    { type: 'createProject', project: { id: 'p2', name: 'B', key: 'BBB', color: '#000', template: 'kanban' } },
  ])
  const mk = (id: string, projectId: string): Issue => ({
    id, key: id, projectId, type: 'task', title: id, description: '', status: 'todo', priority: 'none', reporterId: 'u',
    labels: [], watcherIds: [], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1,
  })
  const s1 = reducer(base, { type: 'loadIssues', projectId: 'p1', issues: [mk('a1', 'p1'), mk('a2', 'p1')] })
  const s2 = reducer(s1, { type: 'loadIssues', projectId: 'p2', issues: [mk('b1', 'p2')] })
  const s3 = reducer(s2, { type: 'loadIssues', projectId: 'p1', issues: [mk('a3', 'p1')] })
  assert.deepEqual(s3.issues.map(i => i.id).sort(), ['a3', 'b1'])
  const { UNDOABLE } = await import('./history.ts')
  assert.equal(UNDOABLE.has('loadIssues'), false)
})

test('loadIssueDetail replaces one issue\'s comments, history, time logs, links and watchers only', () => {
  const mkI = (id: string): Issue => ({
    id, key: id, projectId: 'p1', type: 'task', title: id, description: '', status: 'todo', priority: 'none', reporterId: 'u',
    labels: [], watcherIds: ['old'], links: [], attachments: [], custom: {}, worklogs: [], rank: 1, createdAt: 1, updatedAt: 1,
  })
  const s0: State = { ...EMPTY, issues: [mkI('a'), mkI('b')],
    comments: [{ id: 'c1', issueId: 'a', authorId: 'u', body: 'local', createdAt: 1 }, { id: 'c2', issueId: 'b', authorId: 'u', body: 'other', createdAt: 1 }],
    activity: [{ id: 'x1', issueId: 'a', actorId: 'u', text: 'old', createdAt: 1 }] }
  const s1 = reducer(s0, { type: 'loadIssueDetail', issueId: 'a',
    comments: [{ id: 'c9', issueId: 'a', authorId: 'u', body: 'server', createdAt: 2 }], activity: [],
    worklogs: [{ id: 'w', userId: 'u', minutes: 30, date: '2026-10-01', note: '', at: 1 }], links: [{ type: 'blocks', issueId: 'b' }], watcherIds: ['u'] })
  assert.deepEqual(s1.comments.map(c => c.id).sort(), ['c2', 'c9'])
  assert.equal(s1.activity.length, 0)
  const a = s1.issues.find(i => i.id === 'a')!, b = s1.issues.find(i => i.id === 'b')!
  assert.deepEqual([a.watcherIds, a.links.length, a.worklogs.length], [['u'], 1, 1])
  assert.deepEqual(b.watcherIds, ['old'])
})

test('syncSprint replaces the sprint with the server copy and ignores unknown ones', () => {
  const sp = (over: object = {}) => ({ id: 's1', projectId: 'p', name: 'S', goal: '', state: 'planned' as const, ...over })
  const s0: State = { ...EMPTY, sprints: [sp()] }
  const s1 = reducer(s0, { type: 'syncSprint', sprint: sp({ state: 'active', committed: 8 }) })
  assert.deepEqual([s1.sprints[0]!.state, s1.sprints[0]!.committed], ['active', 8])
  assert.equal(reducer(s0, { type: 'syncSprint', sprint: sp({ id: 'nope' }) }), s0)
})

test('setNotifications replaces the list', () => {
  const n = { id: 'n1', userId: 'u', actorId: '', issueId: 'i', kind: 'assigned' as const, text: 't', read: false, archived: false, createdAt: 1 }
  assert.equal(reducer({ ...EMPTY, notifications: [{ ...n, id: 'old' }] }, { type: 'setNotifications', notifications: [n] }).notifications[0]!.id, 'n1')
})

test('loadProject adds a project with its sprints, then replaces both without touching other projects', () => {
  const owner = run([{ type: 'setOwner', name: 'Alex' }, { type: 'createProject', project: { id: 'p1', name: 'A', key: 'AAA', color: '#000', template: 'scrum' } }, { type: 'createProject', project: { id: 'p2', name: 'B', key: 'BBB', color: '#000', template: 'scrum' } }])
  const sp = (id: string, projectId: string) => ({ id, projectId, name: id, goal: '', state: 'planned' as const })
  const s0 = { ...owner, sprints: [sp('a1', 'p1'), sp('b1', 'p2')] }
  const p3 = { ...owner.projects[0]!, id: 'p3', key: 'CCC', name: 'C' }
  const s1 = reducer(s0, { type: 'loadProject', project: p3, sprints: [sp('c1', 'p3')] })
  assert.deepEqual(s1.projects.map(p => p.key), ['AAA', 'BBB', 'CCC'])
  assert.deepEqual(s1.sprints.map(s => s.id).sort(), ['a1', 'b1', 'c1'])
  const s2 = reducer(s1, { type: 'loadProject', project: { ...p3, name: 'C renamed' }, sprints: [sp('c2', 'p3')] })
  assert.equal(s2.projects.length, 3); assert.equal(s2.projects[2]!.name, 'C renamed')
  assert.deepEqual(s2.sprints.map(s => s.id).sort(), ['a1', 'b1', 'c2'])
})
