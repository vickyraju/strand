import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyOf, patchOf, diffIssues, createIssueSync, type SyncDeps } from './sync.ts'
import type { Issue } from '../data/reducer.ts'

const mk = (id: string, over: Partial<Issue> = {}): Issue => ({
  id, key: `PAY-${id}`, projectId: 'p1', type: 'task', title: `T${id}`, description: '', status: 's1', priority: 'none', reporterId: 'u1',
  labels: [], watcherIds: [], links: [], attachments: [], custom: {}, worklogs: [], rank: 1000, createdAt: 1, updatedAt: 1, ...over,
})

test('patchOf sends only what changed, renames status, and nulls cleared fields', () => {
  const before = mk('1', { assigneeId: 'u2', dueDate: '2026-11-01' })
  assert.equal(patchOf(before, { ...before }), null)
  assert.deepEqual(patchOf(before, { ...before, status: 's2', title: 'New' }), { statusId: 's2', title: 'New' })
  const { assigneeId, dueDate, ...cleared } = before
  void assigneeId; void dueDate
  assert.deepEqual(patchOf(before, cleared as Issue), { assigneeId: null, dueDate: null })
  assert.deepEqual(patchOf(before, { ...before, labels: ['a'], rank: 1500 }), { labels: ['a'], rank: 1500 })
  // changes that live outside the synced fields (watchers…) are not sent
  assert.equal(patchOf(before, { ...before, watcherIds: ['u9'], updatedAt: 99 }), null)
})

test('bodyOf includes the client id and skips fields without a value', () => {
  const b = bodyOf(mk('7', { estimate: 3 }))
  assert.equal(b.id, '7'); assert.equal(b.statusId, 's1'); assert.equal(b.estimate, 3)
  assert.equal('assigneeId' in b, false)
})

test('diffIssues classifies new, returned, removed and edited issues', () => {
  const base = new Map([['1', mk('1')], ['2', mk('2')], ['3', mk('3')]])
  const plan = diffIssues(base, [mk('1', { title: 'changed' }), mk('3'), mk('4'), mk('5')], new Set(['5']))
  assert.deepEqual(plan.patches.map(p => p.issue.id), ['1'])
  assert.deepEqual(plan.creates.map(i => i.id), ['4'])
  assert.deepEqual(plan.restores.map(i => i.id), ['5'])
  assert.deepEqual(plan.deletes.map(i => i.id), ['2'])
})

function harness(over: Partial<SyncDeps> = {}) {
  const calls: { method: string; path: string; body?: any; headers?: any }[] = []
  let issues: Issue[] = []
  const applied: Issue[] = []
  const errors: string[] = []
  const reloaded: string[] = []
  const sync = createIssueSync({
    call: (async (method: string, path: string, body: any, headers: any) => {
      calls.push({ method, path, body, headers })
      const key = /issues\/([A-Z]+-\w+)/.exec(path)?.[1]
      if (method === 'POST' && path.endsWith('/issues')) return { ...body, statusId: body.statusId, key: 'PAY-100', version: 1, reporterId: 'u1', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
      if (method === 'PATCH') return { ...issues.find(i => `PAY-${i.id}` === key || i.key === key)!, statusId: 's1', version: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...body }
      if (method === 'POST' && path.endsWith('/restore')) return { ...issues[0], statusId: 's1', version: 5, key: key!, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
      return undefined
    }) as SyncDeps['call'],
    getIssues: () => issues,
    projectKey: id => (id === 'p1' ? 'PAY' : undefined),
    applyServerIssue: i => applied.push(i),
    applyProjectIssues: (id, list) => { reloaded.push(id); issues = list },
    loadProjectIssues: async () => [mk('1', { title: 'from server' })],
    onError: m => errors.push(m),
    ...over,
  })
  return { sync, calls, applied, errors, reloaded, set: (l: Issue[]) => { issues = l }, get: () => issues }
}

test('a new issue is created once with its client id, and the server key/version are adopted', async () => {
  const h = harness()
  h.sync.load('p1', [])
  h.set([mk('a', { key: 'PAY-local' })])
  h.sync.flush(); h.sync.flush()                 // flushing twice must not send twice
  await h.sync.idle()
  assert.equal(h.calls.length, 1)
  assert.deepEqual([h.calls[0]!.method, h.calls[0]!.path, h.calls[0]!.body.id, h.calls[0]!.body.statusId], ['POST', '/api/projects/PAY/issues', 'a', 's1'])
  assert.equal(h.applied[0]!.key, 'PAY-100')
  // the next edit goes to the server's key, not the local one, with the version it returned
  h.set([mk('a', { key: 'PAY-100', title: 'edited' })])
  h.sync.flush(); await h.sync.idle()
  assert.deepEqual([h.calls[1]!.method, h.calls[1]!.path, h.calls[1]!.headers], ['PATCH', '/api/issues/PAY-100', { 'if-match': '1' }])
  assert.deepEqual(h.calls[1]!.body, { title: 'edited' })
})

test('issues loaded from the server are not sent back; deleting and then undoing restores, not recreates', async () => {
  const h = harness()
  const loaded = [{ ...mk('1', { key: 'PAY-1' }), version: 3 }, mk('2', { key: 'PAY-2' })]
  h.sync.load('p1', loaded); h.set(loaded); h.sync.flush(); await h.sync.idle()
  assert.equal(h.calls.length, 0)

  h.set([loaded[1]!]); h.sync.flush(); await h.sync.idle()           // delete #1
  assert.deepEqual([h.calls[0]!.method, h.calls[0]!.path], ['DELETE', '/api/issues/PAY-1'])
  h.set([loaded[0]!, loaded[1]!]); h.sync.flush(); await h.sync.idle() // undo
  assert.deepEqual([h.calls[1]!.method, h.calls[1]!.path], ['POST', '/api/issues/PAY-1/restore'])
  assert.equal(h.calls.length, 2)
})

test('an edit made while a request is in flight is kept, not overwritten by the response', async () => {
  const h = harness()
  const a = mk('1', { key: 'PAY-1' })
  h.sync.load('p1', [{ ...a, version: 1 }]); h.set([a])
  h.set([{ ...a, title: 'first' }]); h.sync.flush()
  h.set([{ ...a, title: 'second' }])                                   // user types again before the reply
  await h.sync.idle()
  assert.equal(h.applied.length, 0)                                    // local differs from what was sent: no overwrite
  h.sync.flush(); await h.sync.idle()
  assert.deepEqual(h.calls.map(c => c.body), [{ title: 'first' }, { title: 'second' }])
})

test('a failed request reports the error, reloads the project from the server and drops queued work', async () => {
  let n = 0
  const h = harness({ call: (async () => { n++; throw new Error('Edited elsewhere (current version 4)') }) as SyncDeps['call'] })
  const a = mk('1', { key: 'PAY-1' })
  h.sync.load('p1', [{ ...a, version: 1 }]); h.set([a])
  h.set([{ ...a, title: 'x' }]); h.sync.flush()
  h.set([{ ...a, title: 'y' }]); h.sync.flush()                        // second job is queued behind the first
  await h.sync.idle()
  assert.equal(n, 1)                                                   // the second never ran
  assert.deepEqual(h.errors, ['Edited elsewhere (current version 4)'])
  assert.deepEqual(h.reloaded, ['p1'])
  assert.equal(h.get()[0]!.title, 'from server')
  h.sync.flush(); await h.sync.idle()                                  // reloaded state is the new base: nothing to send
  assert.equal(n, 1)
})

test('moving work off a status that was deleted is sent as an admin remap (workflow override)', async () => {
  const h = harness({ statusExists: (_p: string, status: string) => status !== 's-old' } as Partial<SyncDeps>)
  const a = mk('1', { key: 'PAY-1', status: 's-old' })
  h.sync.load('p1', [{ ...a, version: 4 }]); h.set([a])
  h.set([{ ...a, status: 's1' }]); h.sync.flush(); await h.sync.idle()
  assert.deepEqual(h.calls[0]!.headers, { 'if-match': '4', 'x-workflow-override': '1' })
  // an ordinary move between statuses that both still exist is not an override
  h.set([{ ...a, status: 's2' }]); h.sync.flush(); await h.sync.idle()
  assert.deepEqual(h.calls[1]!.headers, { 'if-match': '2' })
})
