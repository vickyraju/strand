import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

// Needs a throwaway Postgres: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'
Object.assign(process.env, { AUTH_DEV: '1', SCIM_TOKEN: 'scim-secret', NODE_ENV: 'test' })

let app: Awaited<ReturnType<typeof import('../src/app.ts').build>>
let pool: pg.Pool

const call = async (method: string, path: string, body?: unknown, who = 'owner@x.com', headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url: path, payload: body as any, headers: { 'x-dev-user': who, ...headers } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}

before(async () => {
  if (skip) return
  pool = new pg.Pool({ connectionString: url })
  await pool.query('drop schema public cascade; create schema public')
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  for (const f of readdirSync(dir).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'))
  app = await (await import('../src/app.ts')).build()
})
after(async () => { if (skip) return; await app.close(); await pool.end() })

test('project → issue lifecycle with workflow, versions and undo', { skip }, async () => {
  const p = await call('POST', '/api/projects', { name: 'Payments', key: 'PAY', template: 'kanban' })
  assert.equal(p.status, 200)
  assert.deepEqual(p.body.statuses.map((s: any) => s.name), ['To do', 'In progress', 'Done'])
  const [todo, doing, done] = p.body.statuses

  const a = (await call('POST', '/api/projects/PAY/issues', { title: 'First', type: 'task' })).body
  const b = (await call('POST', '/api/projects/PAY/issues', { title: 'Second' })).body
  assert.equal(a.key, 'PAY-1'); assert.equal(b.key, 'PAY-2'); assert.ok(b.rank > a.rank)

  // workflow: only To do → In progress allowed once a transition exists
  await call('POST', '/api/projects/PAY/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  assert.equal((await call('PATCH', '/api/issues/PAY-1', { statusId: done.id })).status, 409)
  const moved = await call('PATCH', '/api/issues/PAY-1', { statusId: doing.id }, 'owner@x.com', { 'if-match': '1' })
  assert.equal(moved.body.statusId, doing.id); assert.equal(moved.body.version, 2)
  // stale version
  assert.equal((await call('PATCH', '/api/issues/PAY-1', { title: 'x' }, 'owner@x.com', { 'if-match': '1' })).status, 409)

  // soft delete → gone from list → restore
  assert.equal((await call('DELETE', '/api/issues/PAY-2')).status, 204)
  assert.equal((await call('GET', '/api/projects/PAY/issues')).body.items.length, 1)
  assert.equal((await call('POST', '/api/issues/PAY-2/restore')).status, 200)
  assert.equal((await call('GET', '/api/projects/PAY/issues')).body.items.length, 2)

  // keyset pagination
  const page = (await call('GET', '/api/projects/PAY/issues?limit=1')).body
  assert.equal(page.items.length, 1); assert.ok(page.next)
  const page2 = (await call('GET', `/api/projects/PAY/issues?limit=1&cursor=${page.next}`)).body
  assert.equal(page2.items[0].key, 'PAY-2')
})

test('automation rule, notifications and search', { skip }, async () => {
  const p = (await call('GET', '/api/projects/PAY')).body
  const [todo, doing] = p.statuses
  await call('POST', '/api/projects/PAY/rules', {
    name: 'Escalate started work', trigger: { kind: 'status', to: doing.id }, actions: [{ kind: 'priority', value: 'high' }, { kind: 'comment', body: 'Started' }],
  })
  const i = (await call('POST', '/api/projects/PAY/issues', { title: 'Refund webhook flaky' })).body
  const me = (await call('GET', '/api/me')).body
  const other = (await call('GET', '/api/me', undefined, 'dev2@x.com')).body
  await call('PATCH', `/api/issues/${i.key}`, { assigneeId: other.id })     // notifies dev2
  const moved = (await call('PATCH', `/api/issues/${i.key}`, { statusId: doing.id })).body
  assert.equal(moved.priority, 'high')
  assert.equal((await call('GET', `/api/issues/${i.key}`)).body.comments[0].body, 'Started')
  assert.equal((await call('GET', '/api/notifications', undefined, 'dev2@x.com')).body[0].kind, 'status')

  assert.equal((await call('GET', '/api/search?q=webhook')).body.items[0].key, i.key)
  assert.equal((await call('GET', `/api/search?q=${i.key.toLowerCase()}`)).body.items[0].id, i.id)
  assert.equal((await call('GET', '/api/me/work', undefined, 'dev2@x.com')).body.length, 1)
  assert.ok(me.id !== other.id && todo)
})

test('roles: viewers read, members write, only admins delete projects', { skip }, async () => {
  await call('GET', '/api/me', undefined, 'viewer@x.com')
  await pool.query(`update memberships set role = 'viewer' where user_id = (select id from users where email = 'viewer@x.com')`)
  assert.equal((await call('GET', '/api/projects', undefined, 'viewer@x.com')).status, 200)
  assert.equal((await call('POST', '/api/projects/PAY/issues', { title: 'nope' }, 'viewer@x.com')).status, 403)
  assert.equal((await call('DELETE', '/api/projects/PAY', undefined, 'dev2@x.com')).status, 403)
  assert.equal((await call('POST', '/api/projects', { name: 'Bad', key: 'bad', template: 'kanban' })).status, 400)
})

test('sprints: one active at a time, completion snapshots and carries over unfinished work', { skip }, async () => {
  const p = (await call('POST', '/api/projects', { name: 'Core', key: 'COR', template: 'scrum' })).body
  const done = p.statuses.at(-1)
  const s1 = (await call('POST', '/api/projects/COR/sprints', { name: 'S1' })).body
  const s2 = (await call('POST', '/api/projects/COR/sprints', { name: 'S2' })).body
  const x = (await call('POST', '/api/projects/COR/issues', { title: 'x', estimate: 3, sprintId: s1.id })).body
  const y = (await call('POST', '/api/projects/COR/issues', { title: 'y', estimate: 5, sprintId: s1.id })).body
  const end = new Date(Date.now() + 864e5).toISOString()
  const started = await call('POST', `/api/projects/COR/sprints/${s1.id}/start`, { endsAt: end })
  assert.equal(started.body.committed, 8)
  assert.equal((await call('POST', `/api/projects/COR/sprints/${s2.id}/start`, { endsAt: end })).status, 409)
  await call('PATCH', `/api/issues/${x.key}`, { statusId: done.id })
  const closed = await call('POST', `/api/projects/COR/sprints/${s1.id}/complete`, { moveTo: s2.id })
  assert.equal(closed.body.completed, 3)
  assert.equal((await call('GET', `/api/issues/${y.key}`)).body.sprintId, s2.id)
})

test('SCIM: token required, provisioning and deactivation block login', { skip }, async () => {
  const scim = (method: string, path: string, body?: unknown, token = 'scim-secret') =>
    app.inject({ method: method as any, url: `/scim/v2${path}`, payload: body as any, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' } })
  assert.equal((await scim('GET', '/Users', undefined, 'wrong')).statusCode, 401)
  const created = await scim('POST', '/Users', { userName: 'New.Hire@x.com', displayName: 'New Hire', externalId: '5a0c1c4e-0000-4000-8000-000000000001', active: true })
  assert.equal(created.statusCode, 201)
  const id = JSON.parse(created.body).id
  assert.equal(JSON.parse((await scim('GET', '/Users?filter=userName eq "new.hire@x.com"')).body).totalResults, 1)
  await scim('PATCH', `/Users/${id}`, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })
  assert.equal((await call('GET', '/api/me', undefined, 'new.hire@x.com')).status, 403)
})

test('import: moves a reducer v4 state in with ids remapped', { skip }, async () => {
  const state = {
    version: 4, starred: ['p1'], views: [], dashboards: [], comments: [{ issueId: 'i1', body: 'hi', createdAt: 1 }], activity: [],
    sprints: [],
    projects: [{
      id: 'p1', key: 'IMP', name: 'Imported', template: 'kanban', color: '#112233', nextNumber: 3, createdAt: 1,
      statuses: [{ id: 's1', name: 'To do', color: '#000000', category: 'todo' }, { id: 's2', name: 'Done', color: '#000000', category: 'done' }],
      transitions: [{ id: 't1', name: 'Finish', from: 'any', to: 's2' }], fields: [{ id: 'f1', name: 'Team', kind: 'text' }],
      releases: [], templates: [], rules: [],
    }],
    issues: [
      { id: 'i1', key: 'IMP-1', projectId: 'p1', type: 'epic', title: 'Epic', status: 's1', priority: 'none', labels: [], rank: 1, createdAt: 1, updatedAt: 1, custom: { f1: 'Core' } },
      { id: 'i2', key: 'IMP-2', projectId: 'p1', type: 'task', title: 'Child', status: 's2', priority: 'low', labels: ['a'], rank: 2, parentId: 'i1', createdAt: 1, updatedAt: 1, links: [{ type: 'blocks', issueId: 'i1' }] },
    ],
  }
  const r = await call('POST', '/api/import', state)
  assert.deepEqual([r.body.projects, r.body.issues], [1, 2])
  const child = (await call('GET', '/api/issues/IMP-2')).body
  assert.equal(child.links[0].key, 'IMP-1')
  assert.equal((await call('GET', '/api/issues/IMP-1')).body.children[0].key, 'IMP-2')
  assert.equal((await call('GET', '/api/projects')).body.find((x: any) => x.key === 'IMP').starred, true)
  assert.equal((await call('POST', '/api/import', state)).body.skippedProjects[0], 'IMP')   // re-import is a no-op
})
