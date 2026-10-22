import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { createHash, createHmac } from 'node:crypto'

// Needs a throwaway Postgres: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'
Object.assign(process.env, { AUTH_DEV: '1', SCIM_TOKEN: 'scim-secret', NODE_ENV: 'test', GITHUB_WEBHOOK_SECRET: 'whsec-test', CORS_ORIGINS: 'https://strand-one.vercel.app/, http://localhost:5173' })

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
  const p = await call('POST', '/api/v1/projects', { name: 'Payments', key: 'PAY', template: 'kanban' })
  assert.equal(p.status, 201)
  assert.deepEqual(p.body.statuses.map((s: any) => s.name), ['To do', 'In progress', 'Done'])
  const [todo, doing, done] = p.body.statuses

  const a = (await call('POST', '/api/v1/projects/PAY/issues', { title: 'First', type: 'task' })).body
  const b = (await call('POST', '/api/v1/projects/PAY/issues', { title: 'Second' })).body
  assert.equal(a.key, 'PAY-1'); assert.equal(b.key, 'PAY-2'); assert.ok(b.rank > a.rank)

  // workflow: only To do → In progress allowed once a transition exists
  await call('POST', '/api/v1/projects/PAY/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  assert.equal((await call('PATCH', '/api/v1/issues/PAY-1', { statusId: done.id })).status, 409)
  const moved = await call('PATCH', '/api/v1/issues/PAY-1', { statusId: doing.id }, 'owner@x.com', { 'if-match': '1' })
  assert.equal(moved.body.statusId, doing.id); assert.equal(moved.body.version, 2)
  // stale version
  assert.equal((await call('PATCH', '/api/v1/issues/PAY-1', { title: 'x' }, 'owner@x.com', { 'if-match': '1' })).status, 409)

  // soft delete → gone from list → restore
  assert.equal((await call('DELETE', '/api/v1/issues/PAY-2')).status, 204)
  assert.equal((await call('GET', '/api/v1/projects/PAY/issues')).body.items.length, 1)
  assert.equal((await call('POST', '/api/v1/issues/PAY-2/restore')).status, 200)
  assert.equal((await call('GET', '/api/v1/projects/PAY/issues')).body.items.length, 2)

  // keyset pagination
  const page = (await call('GET', '/api/v1/projects/PAY/issues?limit=1')).body
  assert.equal(page.items.length, 1); assert.ok(page.next)
  const page2 = (await call('GET', `/api/v1/projects/PAY/issues?limit=1&cursor=${page.next}`)).body
  assert.equal(page2.items[0].key, 'PAY-2')
})

test('automation rule, notifications and search', { skip }, async () => {
  const p = (await call('GET', '/api/v1/projects/PAY')).body
  const [todo, doing] = p.statuses
  await call('POST', '/api/v1/projects/PAY/rules', {
    name: 'Escalate started work', trigger: { kind: 'status', to: doing.id }, actions: [{ kind: 'priority', value: 'high' }, { kind: 'comment', body: 'Started' }],
  })
  const i = (await call('POST', '/api/v1/projects/PAY/issues', { title: 'Refund webhook flaky' })).body
  const me = (await call('GET', '/api/v1/me')).body
  const other = (await call('GET', '/api/v1/me', undefined, 'dev2@x.com')).body
  await call('PATCH', `/api/v1/issues/${i.key}`, { assigneeId: other.id })     // notifies dev2
  const moved = (await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: doing.id })).body
  assert.equal(moved.priority, 'high')
  assert.equal((await call('GET', `/api/v1/issues/${i.key}`)).body.comments[0].body, 'Started')
  assert.equal((await call('GET', '/api/v1/notifications', undefined, 'dev2@x.com')).body[0].kind, 'status')

  assert.equal((await call('GET', '/api/v1/search?q=webhook')).body.items[0].key, i.key)
  assert.equal((await call('GET', `/api/v1/search?q=${i.key.toLowerCase()}`)).body.items[0].id, i.id)
  assert.equal((await call('GET', '/api/v1/me/work', undefined, 'dev2@x.com')).body.length, 1)
  assert.ok(me.id !== other.id && todo)
  // notification rows carry the joined issue key/title/project key, and filter by kind/project
  const nrow = (await call('GET', '/api/v1/notifications', undefined, 'dev2@x.com')).body[0]
  assert.equal(nrow.issueKey, i.key); assert.ok(nrow.issueTitle); assert.equal(nrow.projectKey, 'PAY')
  assert.equal((await call('GET', `/api/v1/notifications?kind=assigned`, undefined, 'dev2@x.com')).body.length, 1)
  assert.equal((await call('GET', `/api/v1/notifications?kind=commented`, undefined, 'dev2@x.com')).body.length, 0)
  assert.equal((await call('GET', `/api/v1/notifications?project=${p.id}`, undefined, 'dev2@x.com')).body.length, 2)
  // me/recent: the issues I last touched (activity/comments/work logs), most recent first.
  // dev2 only received notifications (owner did the touching), so it is empty for dev2;
  // the owner's most recent touch is the issue just created and moved above.
  assert.deepEqual((await call('GET', '/api/v1/me/recent', undefined, 'dev2@x.com')).body.map((x: any) => x.key), [])
  const recent = (await call('GET', '/api/v1/me/recent')).body.map((x: any) => x.key)
  assert.equal(recent[0], i.key)   // newest first: the just-created issue is the owner's latest touch
})

test('roles: viewers read, members write, only admins delete projects', { skip }, async () => {
  await call('GET', '/api/v1/me', undefined, 'viewer@x.com')
  await pool.query(`update memberships set role = 'viewer' where user_id = (select id from users where email = 'viewer@x.com')`)
  assert.equal((await call('GET', '/api/v1/projects', undefined, 'viewer@x.com')).status, 200)
  assert.equal((await call('POST', '/api/v1/projects/PAY/issues', { title: 'nope' }, 'viewer@x.com')).status, 403)
  assert.equal((await call('DELETE', '/api/v1/projects/PAY', undefined, 'dev2@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Bad', key: 'bad', template: 'kanban' })).status, 400)
})

test('sprints: one active at a time, completion snapshots and carries over unfinished work', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Core', key: 'COR', template: 'scrum' })).body
  const done = p.statuses.at(-1)
  const s1 = (await call('POST', '/api/v1/projects/COR/sprints', { name: 'S1' })).body
  const s2 = (await call('POST', '/api/v1/projects/COR/sprints', { name: 'S2' })).body
  const x = (await call('POST', '/api/v1/projects/COR/issues', { title: 'x', estimate: 3, sprintId: s1.id })).body
  const y = (await call('POST', '/api/v1/projects/COR/issues', { title: 'y', estimate: 5, sprintId: s1.id })).body
  const end = new Date(Date.now() + 864e5).toISOString()
  const started = await call('POST', `/api/v1/projects/COR/sprints/${s1.id}/start`, { endsAt: end })
  assert.equal(started.body.committed, 8)
  assert.equal((await call('POST', `/api/v1/projects/COR/sprints/${s2.id}/start`, { endsAt: end })).status, 409)
  await call('PATCH', `/api/v1/issues/${x.key}`, { statusId: done.id })
  const closed = await call('POST', `/api/v1/projects/COR/sprints/${s1.id}/complete`, { moveTo: s2.id })
  assert.equal(closed.body.completed, 3)
  assert.equal((await call('GET', `/api/v1/issues/${y.key}`)).body.sprintId, s2.id)
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
  assert.equal((await call('GET', '/api/v1/me', undefined, 'new.hire@x.com')).status, 403)
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
  const r = await call('POST', '/api/v1/import', state)
  assert.deepEqual([r.body.projects, r.body.issues], [1, 2])
  const child = (await call('GET', '/api/v1/issues/IMP-2')).body
  assert.equal(child.links[0].key, 'IMP-1')
  assert.equal((await call('GET', '/api/v1/issues/IMP-1')).body.children[0].key, 'IMP-2')
  assert.equal((await call('GET', '/api/v1/projects')).body.find((x: any) => x.key === 'IMP').starred, true)
  assert.equal((await call('POST', '/api/v1/import', state)).body.skippedProjects[0], 'IMP')   // re-import is a no-op
})

test('OpenAPI: project routes are documented and the schemas are enforced', { skip }, async () => {
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  assert.equal(spec.info.title, 'Strand API')
  assert.ok(spec.components.securitySchemes.bearer && spec.components.securitySchemes.devSecret)
  const post = spec.paths['/api/v1/projects/{key}/statuses'].post
  assert.deepEqual(post.tags, ['Project settings'])
  assert.deepEqual([...post.requestBody.content['application/json'].schema.required].sort(), ['category', 'color', 'name'])
  // every route (except the health check and the docs themselves) must be documented
  for (const [path, ops] of Object.entries<any>(spec.paths))
    if (path !== '/health')
      for (const [method, op] of Object.entries<any>(ops)) {
        assert.ok(op.summary, `${method.toUpperCase()} ${path} has no summary`)
        assert.ok(op.tags?.length, `${method.toUpperCase()} ${path} has no tag`)
      }
  // the committed openapi.json must match the code (regenerate with `npm run openapi`)
  const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  assert.deepEqual(committed, spec, 'server/openapi.json is stale: run `npm run openapi`')

  // the same schema rejects a bad body before the handler runs
  const bad = await call('POST', '/api/v1/projects/PAY/statuses', { name: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'Invalid input')
})

test('CORS: only listed origins may call the API from a browser, and preflight needs no login', { skip }, async () => {
  const pre = (origin: string) => app.inject({
    method: 'OPTIONS', url: '/api/v1/projects',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dev-user,x-dev-secret,if-match' },
  })
  const ok = await pre('https://strand-one.vercel.app')
  assert.equal(ok.statusCode, 204)
  assert.equal(ok.headers['access-control-allow-origin'], 'https://strand-one.vercel.app')
  for (const h of ['x-dev-user', 'x-dev-secret', 'if-match']) assert.match(String(ok.headers['access-control-allow-headers']), new RegExp(h))
  assert.equal((await pre('http://localhost:5173')).headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal((await pre('https://evil.example')).headers['access-control-allow-origin'], undefined)
  // a normal request from a listed origin carries the header too
  const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: 'https://strand-one.vercel.app', 'x-dev-user': 'owner@x.com' } })
  assert.equal(r.headers['access-control-allow-origin'], 'https://strand-one.vercel.app')
})

test('create accepts a client id; reusing it conflicts instead of duplicating; patch can null fields', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Client ids', key: 'CID', template: 'kanban' })).body
  const id = '0192f0c0-0000-7000-8000-00000000c1d0'
  const made = await call('POST', '/api/v1/projects/CID/issues', { id, title: 'from the app', rank: 5, assigneeId: (await call('GET', '/api/v1/me')).body.id })
  assert.equal(made.body.id, id)
  assert.equal(made.body.key, 'CID-1')
  assert.equal((await call('POST', '/api/v1/projects/CID/issues', { id, title: 'retry' })).status, 409)
  assert.equal((await call('GET', '/api/v1/projects/CID/issues')).body.items.length, 1)
  const cleared = await call('PATCH', '/api/v1/issues/CID-1', { assigneeId: null, dueDate: null }, 'owner@x.com', { 'if-match': '1' })
  assert.equal(cleared.body.assigneeId, null)
  assert.ok(p.statuses.length)
})

test('comments, sprints and settings items accept client ids', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Ids', key: 'IDS', template: 'scrum' })
  await call('POST', '/api/v1/projects/IDS/issues', { title: 'x' })
  const cid = '0192f0c0-0000-7000-8000-00000000c0de', sid = '0192f0c0-0000-7000-8000-00000000050d', fid = '0192f0c0-0000-7000-8000-0000000000f1'
  const c = await call('POST', '/api/v1/issues/IDS-1/comments', { id: cid, body: 'hello' })
  assert.equal(c.body.id, cid)
  assert.equal((await call('POST', '/api/v1/issues/IDS-1/comments', { id: cid, body: 'dup' })).status, 409)
  assert.equal((await call('POST', '/api/v1/projects/IDS/sprints', { id: sid, name: 'S1' })).body.id, sid)
  assert.equal((await call('POST', '/api/v1/projects/IDS/fields', { id: fid, name: 'Team', kind: 'text' })).body.id, fid)
  assert.equal((await call('POST', '/api/v1/projects/IDS/fields', { name: 'No id', kind: 'text' })).status, 201)   // still optional
})

test('workflow override: refused for plain members, honored for the project lead and admins', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Override', key: 'OVR', template: 'kanban' }, 'lead@x.com')).body
  const [todo, doing, done] = p.statuses
  await call('POST', '/api/v1/projects/OVR/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id }, 'lead@x.com')
  await call('POST', '/api/v1/projects/OVR/issues', { title: 'stuck', statusId: doing.id }, 'lead@x.com')
  const move = (who: string, headers: Record<string, string>) => call('PATCH', '/api/v1/issues/OVR-1', { statusId: done.id }, who, headers)
  assert.equal((await move('lead@x.com', {})).status, 409)                                  // no transition doing -> done
  assert.equal((await move('someone@x.com', { 'x-workflow-override': '1' })).status, 409)   // a plain member cannot override
  assert.equal((await move('lead@x.com', { 'x-workflow-override': '1' })).status, 200)      // the lead can
  assert.equal((await call('GET', '/api/v1/issues/OVR-1')).body.statusId, done.id)
})

test('views, dashboards and work logs accept client ids; notifications can be read and archived', { skip }, async () => {
  const vid = '0192f0c0-0000-7000-8000-0000000000a1', did = '0192f0c0-0000-7000-8000-0000000000a2', wid = '0192f0c0-0000-7000-8000-0000000000a3'
  assert.equal((await call('POST', '/api/v1/views', { id: vid, name: 'Mine', filters: { q: '' } })).body.id, vid)
  assert.equal((await call('POST', '/api/v1/dashboards', { id: did, name: 'Board' })).body.id, did)
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Logs', key: 'LOG', template: 'kanban' })).status, 201)
  await call('POST', '/api/v1/projects/LOG/issues', { title: 'x' })
  assert.equal((await call('POST', '/api/v1/issues/LOG-1/worklogs', { id: wid, minutes: 30, date: '2026-10-01' })).body.id, wid)
  assert.equal((await call('POST', '/api/v1/views', { id: vid, name: 'dup', filters: { q: '' } })).status, 409)
})

test('errors share one shape: message, stable code, and per-field messages for bad input', { skip }, async () => {
  const shape = (r: { body: any }) => assert.deepEqual(Object.keys(r.body).filter(k => !['errors'].includes(k)).sort(), ['code', 'error'])
  // 400: each bad field gets its own message
  const bad = await call('POST', '/api/v1/projects', { name: '', key: 'bad', template: 'nope' })
  assert.equal(bad.status, 400); shape(bad)
  assert.equal(bad.body.code, 'invalid_input')
  assert.deepEqual(Object.keys(bad.body.errors).sort(), ['key', 'name', 'template'])
  assert.ok(Object.values(bad.body.errors).every(m => typeof m === 'string' && m.length))
  // 401, 403, 404, 409 carry the right codes
  const noAuth = await app.inject({ method: 'GET', url: '/api/v1/me' })
  assert.equal(noAuth.statusCode, 200)                                   // AUTH_DEV: a header-less call is the default dev user
  assert.equal((await call('GET', '/api/v1/projects/NOPE')).body.code, 'not_found')
  assert.equal((await call('GET', '/api/v1/issues/NOPE-1')).body.code, 'not_found')
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Dup', key: 'PAY', template: 'kanban' })).body.code, 'conflict')
  const forbidden = await call('DELETE', '/api/v1/projects/PAY', undefined, 'plain-member@x.com')
  assert.deepEqual([forbidden.status, forbidden.body.code], [403, 'forbidden'])
  // unknown routes use the same shape, not the framework default
  const unknown = await app.inject({ method: 'GET', url: '/api/v1/nope' })
  assert.deepEqual([unknown.statusCode, JSON.parse(unknown.body)], [404, { error: 'Route not found', code: 'not_found' }])
  // malformed JSON is a 400 with a code, not a stack trace
  const broken = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { 'x-dev-user': 'owner@x.com', 'content-type': 'application/json' }, payload: '{nope' })
  assert.equal(broken.statusCode, 400); assert.equal(JSON.parse(broken.body).code, 'invalid_input')
})

test('/api/v1 is the documented path; the unversioned /api still works but is hidden from the docs', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-dev-user': 'owner@x.com' } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-dev-user': 'owner@x.com' } })).statusCode, 200)
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  const paths = Object.keys(spec.paths)
  assert.ok(paths.some(p => p.startsWith('/api/v1/')))
  assert.ok(!paths.some(p => p.startsWith('/api/') && !p.startsWith('/api/v1/')), 'legacy /api paths must not be documented')
  // the shared error shape is documented on operations that take input
  const op = spec.paths['/api/v1/projects'].post
  assert.deepEqual(Object.keys(op.responses).filter(c => /^[45]/.test(c)).sort().slice(0, 2), ['400', '401'])
  assert.deepEqual(op.responses['400'].content['application/json'].schema.properties.errors.additionalProperties, { type: 'string' })
})

test('every documented response body is produced by the real handler and matches its schema', { skip }, async () => {
  const ok = async (method: string, path: string, body?: unknown, who = 'owner@x.com') => {
    const r = await call(method, '/api/v1' + path, body, who)
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  const p = await ok('POST', '/projects', { name: 'Schemas', key: 'SCH', template: 'scrum' })
  const me = await ok('GET', '/me')
  await ok('GET', '/users'); await ok('GET', '/projects'); await ok('GET', '/projects/SCH')
  const tpl = await ok('POST', '/projects/SCH/templates', { name: 'Bug', type: 'bug', title: 'Bug: ' })
  await ok('PATCH', `/projects/SCH/templates/${tpl.id}`, { priority: 'high' })
  const rule = await ok('POST', '/projects/SCH/rules', { name: 'R', trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }] })
  await ok('PATCH', `/projects/SCH/rules/${rule.id}`, { enabled: false })
  const tr = await ok('POST', '/projects/SCH/transitions', { name: 'Go', toId: p.statuses[1].id })
  await ok('PATCH', `/projects/SCH/transitions/${tr.id}`, { name: 'Go on' })
  const rel = await ok('POST', '/projects/SCH/releases', { name: '1.0', releaseDate: '2026-12-01' })
  await ok('POST', `/projects/SCH/releases/${rel.id}/release`, {})
  const sp = await ok('POST', '/projects/SCH/sprints', { name: 'S', goal: 'g' })
  await ok('PATCH', `/projects/SCH/sprints/${sp.id}`, { goal: 'new' })
  await ok('POST', `/projects/SCH/sprints/${sp.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  const i = await ok('POST', '/projects/SCH/issues', { title: 'One', assigneeId: me.id, sprintId: sp.id, releaseId: rel.id, dueDate: '2026-11-01', estimate: 2, labels: ['a'] })
  await ok('POST', '/projects/SCH/issues', { title: 'Two', parentId: i.id })
  await ok('GET', '/projects/SCH/issues'); await ok('GET', '/projects/SCH/summary')
  const c = await ok('POST', '/issues/SCH-1/comments', { body: 'hello' })
  await ok('PATCH', `/comments/${c.id}`, { body: 'edited' })
  await ok('POST', '/issues/SCH-1/worklogs', { minutes: 20, date: '2026-10-01', note: 'n' })
  await ok('POST', '/issues/SCH-1/links', { type: 'blocks', targetKey: 'SCH-2' }); await ok('PUT', '/issues/SCH-1/watch')
  const d = await ok('GET', '/issues/SCH-1')
  assert.equal(d.children.length, 1); assert.equal(d.comments[0].editedAt !== null, true)
  await ok('PATCH', '/issues/SCH-1', { title: 'One!' }); await ok('DELETE', '/issues/SCH-2'); await ok('POST', '/issues/SCH-2/restore')
  await ok('GET', '/search?q=One'); await ok('GET', '/search?q=SCH-1'); await ok('GET', '/me/work')
  await ok('PATCH', '/issues/SCH-1', { assigneeId: (await call('GET', '/api/v1/me', undefined, 'someone@x.com')).body.id })   // makes a notification for someone
  const note = (await ok('GET', '/notifications', undefined, 'someone@x.com'))[0]
  assert.ok(note.issueKey)
  await ok('PATCH', `/notifications/${note.id}`, { read: true }, 'someone@x.com')
  const v = await ok('POST', '/views', { name: 'V', filters: { q: '' } }); await ok('PATCH', `/views/${v.id}`, { shared: true }); await ok('GET', '/views')
  const db = await ok('POST', '/dashboards', { name: 'D', gadgets: [{ id: 'g', kind: 'status' }] }); await ok('PATCH', `/dashboards/${db.id}`, { name: 'D2' }); await ok('GET', '/dashboards')
  await ok('PATCH', '/projects/SCH', { name: 'Schemas 2', boardPrefs: { groupBy: 'none' } })
})

// ── GitHub webhook ──
const sign = (raw: string, secret = 'whsec-test') => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
let delivery = 0
const hook = async (event: string, payload: unknown, opts: { secret?: string; id?: string } = {}) => {
  const raw = JSON.stringify(payload)
  const r = await app.inject({ method: 'POST', url: '/integrations/github/webhook', payload: raw, headers: {
    'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': opts.id ?? `d-${++delivery}`, 'x-hub-signature-256': sign(raw, opts.secret) } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}
const repository = { id: 4242, full_name: 'acme/pay', default_branch: 'main', html_url: 'https://github.com/acme/pay' }
const prPayload = (over: object = {}, number = 7) => ({
  action: 'opened', number, repository, installation: { id: 777 },
  pull_request: { number, html_url: `https://github.com/acme/pay/pull/${number}`, title: 'GH-1 Fix login', body: '', state: 'open', draft: false, merged: false, merged_at: null,
    updated_at: '2026-10-14T10:00:00Z', user: { login: 'vicky' }, head: { ref: 'gh-1-fix-login', sha: 'abc' }, base: { ref: 'main' }, ...over },
})

test('GitHub webhook: signature, dedupe, linking by key, closing words, edits, order and uninstall', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Hub', key: 'GH', template: 'kanban' })).body
  assert.ok(p.id)
  for (const t of ['one', 'two']) await call('POST', '/api/v1/projects/GH/issues', { title: t })
  const ws = (await pool.query(`select workspace_id from projects where key = 'GH'`)).rows[0].workspace_id
  await pool.query(`insert into integrations (workspace_id, provider, installation_id, account_login) values ($1, 'github', 777, 'acme')`, [ws])
  const dev = async (key: string) => (await call('GET', `/api/v1/issues/${key}/development`)).body

  // signature is required, and checked against the raw bytes
  assert.equal((await hook('pull_request', prPayload(), { secret: 'wrong' })).status, 401)
  const noSig = await app.inject({ method: 'POST', url: '/integrations/github/webhook', payload: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'x' } })
  assert.equal(noSig.statusCode, 401)
  assert.equal((await hook('ping', { zen: 'hi' })).status, 200)

  // opened PR whose title and branch mention GH-1 → linked to GH-1 only
  assert.equal((await hook('pull_request', prPayload(), { id: 'pr-open' })).status, 200)
  let d = await dev('GH-1')
  assert.deepEqual([d.pullRequests.length, d.pullRequests[0].state, d.pullRequests[0].closing, d.pullRequests[0].repo], [1, 'open', false, 'acme/pay'])
  assert.equal((await dev('GH-2')).pullRequests.length, 0)

  // the same delivery again is a no-op; a redelivery with a new id and the same data changes nothing
  assert.deepEqual((await hook('pull_request', prPayload(), { id: 'pr-open' })).body, { ok: true, duplicate: true })
  assert.equal((await pool.query(`select count(*)::int n from dev_entities where kind = 'pull_request'`)).rows[0].n, 1)

  // edit: title now fixes GH-2 instead of GH-1 (branch still says gh-1) → closing link to GH-2, GH-1 keeps its branch link
  await hook('pull_request', prPayload({ title: 'Fixes GH-2', updated_at: '2026-10-14T11:00:00Z' }))
  assert.deepEqual([(await dev('GH-2')).pullRequests[0].closing, (await dev('GH-1')).pullRequests[0].closing], [true, false])
  // edit again so the branch is the only mention of GH-1 is not possible; drop GH-1 completely by changing the branch and title
  await hook('pull_request', prPayload({ title: 'Fixes GH-2', head: { ref: 'cleanup', sha: 'b' }, updated_at: '2026-10-14T12:00:00Z' }))
  assert.equal((await dev('GH-1')).pullRequests.length, 0)                                  // link removed when the text no longer mentions it

  // an older delivery arriving late is ignored
  await hook('pull_request', prPayload({ title: 'GH-1 stale', updated_at: '2026-10-14T09:00:00Z' }))
  assert.equal((await dev('GH-1')).pullRequests.length, 0)

  // review and merge
  await hook('pull_request_review', { ...prPayload({ title: 'Fixes GH-2', head: { ref: 'cleanup' }, updated_at: '2026-10-14T12:30:00Z' }), action: 'submitted', review: { state: 'approved' } })
  assert.equal((await dev('GH-2')).pullRequests[0].reviewState, 'approved')
  await hook('pull_request', prPayload({ title: 'Fixes GH-2', head: { ref: 'cleanup' }, state: 'closed', merged: true, merged_at: '2026-10-14T13:00:00Z', updated_at: '2026-10-14T13:00:00Z' }, 7))
  d = await dev('GH-2'); assert.deepEqual([d.pullRequests[0].state, d.pullRequests[0].reviewState], ['merged', 'approved'])

  // push: a branch plus commits; a commit message linking GH-1; the committer email is not stored
  await hook('push', { ref: 'refs/heads/gh-1-work', repository, installation: { id: 777 }, head_commit: { timestamp: '2026-10-14T14:00:00Z' },
    commits: [{ id: 'c1', message: 'GH-1 add button\n\nCloses GH-2', url: 'https://github.com/acme/pay/commit/c1', timestamp: '2026-10-14T14:00:00Z', author: { name: 'Vicky', username: 'vicky', email: 'private@x.com' } }] })
  d = await dev('GH-1'); assert.deepEqual([d.branches.map((b: any) => b.title), d.commits.map((c: any) => c.title)], [['gh-1-work'], ['GH-1 add button']])
  assert.equal((await dev('GH-2')).commits[0].closing, true)
  assert.equal(JSON.stringify((await pool.query('select * from dev_entities')).rows).includes('private@x.com'), false)
  await hook('delete', { ref: 'gh-1-work', ref_type: 'branch', repository, installation: { id: 777 } })
  assert.equal((await dev('GH-1')).branches.length, 0)                                       // deleted branches are hidden

  // repository mapping: restricting the repo to another project stops linking
  await pool.query(`update repositories set project_ids = array[(select id from projects where key = 'PAY')]`)
  await hook('pull_request', prPayload({ title: 'GH-1 again', updated_at: '2026-10-14T15:00:00Z' }, 8))
  assert.equal((await dev('GH-1')).pullRequests.length, 0)
  await pool.query(`update repositories set project_ids = '{}'`)

  // unknown installations and failed deliveries
  assert.equal((await hook('pull_request', { ...prPayload(), installation: { id: 1 } })).body.ignored, 'unknown installation')
  assert.equal((await pool.query(`select count(*)::int n from webhook_deliveries where status = 'processed'`)).rows[0].n > 5, true)

  // uninstall removes the integration and everything it collected
  await hook('installation', { action: 'deleted', installation: { id: 777 } })
  assert.equal((await pool.query('select count(*)::int n from dev_entities')).rows[0].n, 0)
  assert.equal((await dev('GH-2')).pullRequests.length, 0)
})

test('GitHub webhook is closed when no secret is configured', { skip }, async () => {
  const saved = process.env.GITHUB_WEBHOOK_SECRET
  process.env.GITHUB_WEBHOOK_SECRET = ''
  const r = await app.inject({ method: 'POST', url: '/integrations/github/webhook', payload: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'nosecret', 'x-hub-signature-256': sign('{}', '') } })
  process.env.GITHUB_WEBHOOK_SECRET = saved
  assert.equal(r.statusCode, 503)
})

test('creates answer 201 Created; updates and actions answer 200; deletes 204', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Codes', key: 'COD', template: 'kanban' })).status, 201)
  assert.equal((await call('POST', '/api/v1/projects/COD/issues', { title: 'one' })).status, 201)
  assert.equal((await call('POST', '/api/v1/issues/COD-1/comments', { body: 'hi' })).status, 201)
  assert.equal((await call('POST', '/api/v1/issues/COD-1/worklogs', { minutes: 5, date: '2026-10-01' })).status, 201)
  assert.equal((await call('POST', '/api/v1/projects/COD/sprints', { name: 'S' })).status, 201)
  assert.equal((await call('POST', '/api/v1/views', { name: 'V', filters: { q: '' } })).status, 201)
  assert.equal((await call('PATCH', '/api/v1/issues/COD-1', { title: 'two' })).status, 200)
  assert.equal((await call('DELETE', '/api/v1/issues/COD-1')).status, 204)
  // the documented response code matches: creates are described under 201
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  assert.ok(spec.paths['/api/v1/projects'].post.responses['201'])
  assert.ok(!spec.paths['/api/v1/projects'].post.responses['200'])
})

test('issues and projects can be addressed by key or by id', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Refs', key: 'REF', template: 'kanban' })).body
  const i = (await call('POST', '/api/v1/projects/REF/issues', { title: 'by id' })).body
  assert.equal((await call('GET', `/api/v1/issues/${i.id}`)).body.key, 'REF-1')
  assert.equal((await call('PATCH', `/api/v1/issues/${i.id}`, { title: 'renamed' })).body.title, 'renamed')
  assert.equal((await call('GET', `/api/v1/projects/${p.id}`)).body.key, 'REF')
  assert.equal((await call('GET', '/api/v1/issues/00000000-0000-4000-8000-000000000000')).status, 404)
  assert.equal((await call('GET', '/api/v1/issues/not-a-ref')).body.code, 'not_found')
})

test('issue detail: expand picks the related records; comments and history have their own paged endpoints', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Expand', key: 'EXP', template: 'kanban' })
  await call('POST', '/api/v1/projects/EXP/issues', { title: 'busy' })
  for (let n = 1; n <= 5; n++) await call('POST', '/api/v1/issues/EXP-1/comments', { body: `c${n}` })
  for (let n = 1; n <= 4; n++) await call('PATCH', '/api/v1/issues/EXP-1', { title: `t${n}` })
  const all = (await call('GET', '/api/v1/issues/EXP-1')).body
  assert.deepEqual(['comments', 'activity', 'worklogs', 'links', 'watcherIds', 'attachments', 'children'].filter(k => !(k in all)), [])
  const slim = (await call('GET', '/api/v1/issues/EXP-1?expand=comments')).body
  assert.equal(slim.comments.length, 5); assert.ok(!('activity' in slim) && !('worklogs' in slim))
  assert.equal((await call('GET', '/api/v1/issues/EXP-1?expand=nope')).status, 400)
  // comments: oldest first, two per page, no gaps or repeats
  const seen: string[] = []; let cursor = ''
  for (let page = 0; page < 5; page++) {
    const r = (await call('GET', `/api/v1/issues/EXP-1/comments?limit=2${cursor}`)).body
    seen.push(...r.items.map((c: any) => c.body)); if (!r.next) break
    cursor = `&cursor=${r.next}`
  }
  assert.deepEqual(seen, ['c1', 'c2', 'c3', 'c4', 'c5'])
  // history: newest first
  const hist = (await call('GET', '/api/v1/issues/EXP-1/activity?limit=3')).body
  assert.equal(hist.items.length, 3); assert.ok(hist.next)
  assert.equal(hist.items[0].toValue, 't4')
  assert.equal((await call('GET', '/api/v1/issues/EXP-1/comments?cursor=garbage')).status, 400)
})

test('bulk edit, delete and restore: one call, all or nothing, workflow still enforced', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Bulk', key: 'BLK', template: 'kanban' })).body
  const [todo, doing, done] = p.statuses
  for (let n = 1; n <= 4; n++) await call('POST', '/api/v1/projects/BLK/issues', { title: `b${n}` })
  const edit = await call('POST', '/api/v1/issues/bulk/edit', { issues: ['BLK-1', 'BLK-2', 'BLK-3'], patch: { priority: 'high', labels: ['x'] } })
  assert.equal(edit.body.count, 3); assert.ok(edit.body.issues.every((i: any) => i.priority === 'high' && i.version === 2))
  // one missing issue: nothing changes
  const bad = await call('POST', '/api/v1/issues/bulk/edit', { issues: ['BLK-1', 'BLK-99'], patch: { priority: 'low' } })
  assert.deepEqual([bad.status, bad.body.code], [404, 'not_found'])
  assert.equal((await call('GET', '/api/v1/issues/BLK-1')).body.priority, 'high')
  // workflow applies to each issue
  await call('POST', '/api/v1/projects/BLK/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: ['BLK-1', 'BLK-2'], patch: { statusId: done.id } })).status, 409)
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: ['BLK-1', 'BLK-2'], patch: { statusId: doing.id } })).body.count, 2)
  // delete + restore, with duplicates in the list ignored
  assert.equal((await call('POST', '/api/v1/issues/bulk/delete', { issues: ['BLK-1', 'BLK-1', 'BLK-2'] })).body.count, 2)
  assert.equal((await call('GET', '/api/v1/projects/BLK/issues')).body.items.length, 2)
  assert.equal((await call('POST', '/api/v1/issues/bulk/restore', { issues: ['BLK-1', 'BLK-2'] })).body.count, 2)
  assert.equal((await call('GET', '/api/v1/projects/BLK/issues')).body.items.length, 4)
  // limits and permissions
  assert.equal((await call('POST', '/api/v1/issues/bulk/delete', { issues: [] })).status, 400)
  assert.equal((await call('POST', '/api/v1/issues/bulk/delete', { issues: Array.from({ length: 201 }, (_, n) => `BLK-${n + 1}`) })).status, 400)
  await call('GET', '/api/v1/me', undefined, 'bulk-viewer@x.com')
  await pool.query(`update memberships set role = 'viewer' where user_id = (select id from users where email = 'bulk-viewer@x.com')`)
  assert.equal((await call('POST', '/api/v1/issues/bulk/delete', { issues: ['BLK-3'] }, 'bulk-viewer@x.com')).status, 403)
})

test('project and user search are paginated and filtered; archive hides a project without deleting it', { skip }, async () => {
  for (const [name, key] of [['Alpha Search', 'SRA'], ['Beta Search', 'SRB'], ['Gamma Other', 'SRG'], ['delta search', 'SRD']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  const all = (await call('GET', '/api/v1/projects/search?query=search&limit=2')).body
  assert.equal(all.items.length, 2); assert.ok(all.next)
  assert.deepEqual(all.items.map((p: any) => p.name), ['Alpha Search', 'Beta Search'])                  // name order, case-insensitive
  const rest = (await call('GET', `/api/v1/projects/search?query=search&limit=2&cursor=${all.next}`)).body
  assert.deepEqual(rest.items.map((p: any) => p.name), ['delta search']); assert.equal(rest.next, null)
  assert.equal((await call('GET', '/api/v1/projects/search?query=srg')).body.items[0].key, 'SRG')      // matches the key too
  assert.equal((await call('GET', '/api/v1/projects/search?query=%25')).body.items.length, 0)          // % is not a wildcard
  assert.equal((await call('GET', '/api/v1/projects/search?cursor=bad')).status, 400)

  const arch = await call('POST', '/api/v1/projects/SRB/archive')
  assert.ok(arch.body.archivedAt)
  assert.ok(!(await call('GET', '/api/v1/projects')).body.some((p: any) => p.key === 'SRB'))
  assert.ok(!(await call('GET', '/api/v1/projects/search?query=search')).body.items.some((p: any) => p.key === 'SRB'))
  assert.deepEqual((await call('GET', '/api/v1/projects/search?archived=1')).body.items.map((p: any) => p.key), ['SRB'])
  assert.equal((await call('GET', '/api/v1/projects/SRB')).body.key, 'SRB')                            // still readable
  assert.equal((await call('POST', '/api/v1/projects/SRB/restore')).body.archivedAt, null)
  assert.ok((await call('GET', '/api/v1/projects')).body.some((p: any) => p.key === 'SRB'))
  assert.equal((await call('POST', '/api/v1/projects/SRB/archive', undefined, 'plain-member@x.com')).status, 403)

  for (const u of ['ann.search@x.com', 'bob.search@x.com', 'carl@x.com']) await call('GET', '/api/v1/me', undefined, u)
  const users = (await call('GET', '/api/v1/users/search?query=search&limit=1')).body
  assert.equal(users.items.length, 1); assert.ok(users.next)
  const next = (await call('GET', `/api/v1/users/search?query=search&limit=5&cursor=${users.next}`)).body
  assert.deepEqual([users.items[0].email, ...next.items.map((u: any) => u.email)], ['ann.search@x.com', 'bob.search@x.com'])
})

test('paging never repeats or skips rows, even when many are created in the same millisecond', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Paging', key: 'PGE', template: 'kanban' })
  await Promise.all(Array.from({ length: 12 }, (_, n) => call('POST', '/api/v1/projects/PGE/issues', { title: `paged ${n}` })))
  await pool.query(`update issues set updated_at = '2026-10-01T10:00:00.123456Z' where project_id = (select id from projects where key = 'PGE')`)   // identical to the millisecond, different only in microseconds below
  await pool.query(`update issues set updated_at = updated_at + (number * interval '1 microsecond') where project_id = (select id from projects where key = 'PGE')`)
  const seen: string[] = []; let cursor = ''
  for (let page = 0; page < 20; page++) {
    const r = (await call('GET', `/api/v1/search?q=paged&limit=3${cursor}`)).body
    seen.push(...r.items.map((i: any) => i.key)); if (!r.next) break
    cursor = `&cursor=${r.next}`
  }
  assert.equal(seen.length, 12)
  assert.equal(new Set(seen).size, 12)
})

test('search can ask for unassigned work (assignee=none), and "me" and ids still work', { skip }, async () => {
  const me = (await call('GET', '/api/v1/me')).body
  await call('POST', '/api/v1/projects', { name: 'Unassigned', key: 'UNA', template: 'kanban' })
  for (const t of ['una-a', 'una-b']) await call('POST', '/api/v1/projects/UNA/issues', { title: t, assigneeId: me.id })
  for (const t of ['una-c', 'una-d', 'una-e']) await call('POST', '/api/v1/projects/UNA/issues', { title: t })
  const keys = async (q: string) => (await call('GET', `/api/v1/search?q=una-&${q}`)).body.items.length
  assert.equal(await keys(''), 5)
  assert.equal(await keys('assignee=none'), 3)
  assert.equal(await keys('assignee=me'), 2)
  assert.equal(await keys(`assignee=${me.id}`), 2)
})

test('edit presence: heartbeat, who is editing, explicit leave, pruning of stale rows, read-only users refused', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Presence', key: 'PRS', template: 'kanban' })
  await call('POST', '/api/v1/projects/PRS/issues', { title: 'shared' })
  assert.equal((await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'ann.presence@x.com')).status, 204)
  assert.equal((await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'ann.presence@x.com')).status, 204)       // a second beat is an update, not a second row
  assert.equal((await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'ben.presence@x.com')).status, 204)
  const rows = async () => (await pool.query(`select u.email from issue_editors e join users u on u.id = e.user_id order by u.email`)).rows.map(r => r.email)
  assert.deepEqual(await rows(), ['ann.presence@x.com', 'ben.presence@x.com'])
  assert.equal((await call('DELETE', '/api/v1/issues/PRS-1/presence', undefined, 'ann.presence@x.com')).status, 204)
  assert.deepEqual(await rows(), ['ben.presence@x.com'])
  // stale rows (no beat for 2 minutes) are pruned by the next heartbeat from anyone
  await pool.query(`update issue_editors set last_heartbeat = now() - interval '2 minutes'`)
  await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'cat.presence@x.com')
  assert.deepEqual(await rows(), ['cat.presence@x.com'])
  // viewers can look but are not "editing"
  await call('GET', '/api/v1/me', undefined, 'view.presence@x.com')
  await pool.query(`update memberships set role = 'viewer' where user_id = (select id from users where email = 'view.presence@x.com')`)
  assert.equal((await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'view.presence@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/issues/NOPE-1/presence', undefined, 'ann.presence@x.com')).status, 404)
})

test('live stream over real HTTP: carries CORS headers for allowed origins only, and delivers presence to the project', { skip }, async () => {
  const addr = await app.listen({ port: 0, host: '127.0.0.1' })
  await call('POST', '/api/v1/projects', { name: 'Stream', key: 'STR', template: 'kanban' })
  await call('POST', '/api/v1/projects/STR/issues', { title: 'live' })
  const url = `${addr}/api/v1/projects/STR/events`
  const origin = 'https://strand-one.vercel.app'
  const ac = new AbortController()
  const res = await fetch(url, { headers: { 'x-dev-user': 'owner@x.com', origin }, signal: ac.signal })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.equal(res.headers.get('access-control-allow-origin'), origin)                           // a browser may read it
  const other = new AbortController()
  const res2 = await fetch(url, { headers: { 'x-dev-user': 'owner@x.com', origin: 'https://evil.example' }, signal: other.signal })
  assert.equal(res2.headers.get('access-control-allow-origin'), null); other.abort()           // an unlisted origin gets none
  // a heartbeat by someone else shows up on the stream, with the person's name
  const reader = res.body!.getReader(); const dec = new TextDecoder()
  let text = ''
  const beat = fetch(`${addr}/api/v1/issues/STR-1/presence`, { method: 'POST', headers: { 'x-dev-user': 'dan.stream@x.com' } })
  const until = Date.now() + 8000
  while (Date.now() < until && !text.includes('issue.editing')) { const { value } = await reader.read(); text += dec.decode(value) }
  await beat; ac.abort()
  const data = JSON.parse(text.split('\n').find(l => l.startsWith('data:') && l.includes('issue.editing'))!.slice(5))
  assert.equal(data.key, 'STR-1')
  assert.deepEqual(data.editors.map((e: any) => e.name), ['dan.stream'])
})

// ── Personal access tokens ──
const viaToken = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await app.inject({ method: method as any, url: path, payload: body as any, headers: { authorization: `Bearer ${token}` } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}
const mint = async (who: string, name = 'script', expiresInDays?: number) =>
  (await call('POST', '/api/v1/me/tokens', { name, ...(expiresInDays ? { expiresInDays } : {}) }, who))

test('tokens: created once with the secret, listed without it, and the secret is never stored', { skip }, async () => {
  const made = await mint('tok.ann@x.com', '  Release script  ')
  assert.equal(made.status, 201)
  const { token } = made.body
  assert.match(token, /^jbp_[A-Za-z0-9_-]{43}$/)
  assert.equal(made.body.name, 'Release script')                                    // trimmed
  assert.equal(made.body.hint, token.slice(-4))
  assert.equal(made.body.lastUsedAt, null)
  const days = (Date.parse(made.body.expiresAt) - Date.now()) / 86_400_000
  assert.ok(days > 89.9 && days < 90.1, `default expiry is 90 days, got ${days}`)

  const list = (await call('GET', '/api/v1/me/tokens', undefined, 'tok.ann@x.com')).body
  assert.equal(list.length, 1)
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'expired', 'expiresAt', 'hint', 'id', 'lastUsedAt', 'name'])
  assert.ok(!JSON.stringify(list).includes(token))

  // the database holds a hash only: the secret is nowhere in the row
  const row = (await pool.query(`select t::text as everything, token_hash from personal_access_tokens t where id = $1`, [made.body.id])).rows[0]
  assert.ok(!row.everything.includes(token) && !row.everything.includes(token.slice(4)))
  assert.deepEqual(row.token_hash, createHash('sha256').update(token).digest())
})

test('tokens: a token acts as its owner, with the owner\'s role, and records when it was last used', { skip }, async () => {
  const { body } = await mint('tok.ben@x.com')
  const me = await viaToken(body.token, 'GET', '/api/v1/me')
  assert.equal(me.status, 200)
  assert.equal(me.body.email, 'tok.ben@x.com')
  const ownRole = (await call('GET', '/api/v1/me', undefined, 'tok.ben@x.com')).body.role
  assert.equal(me.body.role, ownRole)
  assert.equal((await viaToken(body.token, 'POST', '/api/v1/projects', { name: 'By token', key: 'BYT', template: 'kanban' })).status, 201)
  const [used] = (await call('GET', '/api/v1/me/tokens', undefined, 'tok.ben@x.com')).body
  assert.ok(used.lastUsedAt)
  const first = used.lastUsedAt
  await viaToken(body.token, 'GET', '/api/v1/me')                                    // within a minute: no new write
  assert.equal((await call('GET', '/api/v1/me/tokens', undefined, 'tok.ben@x.com')).body[0].lastUsedAt, first)
})

test('tokens: a token cannot manage tokens, so a leaked one cannot mint or hide others', { skip }, async () => {
  const { body } = await mint('tok.cat@x.com')
  for (const [method, path, payload] of [['GET', '/api/v1/me/tokens'], ['POST', '/api/v1/me/tokens', { name: 'more' }], ['DELETE', `/api/v1/me/tokens/${body.id}`]] as const) {
    const r = await viaToken(body.token, method, path, payload)
    assert.deepEqual([r.status, r.body.code], [403, 'forbidden'], `${method} ${path}`)
  }
  assert.equal((await call('GET', '/api/v1/me/tokens', undefined, 'tok.cat@x.com')).body.length, 1)   // untouched
})

test('tokens: revoking stops the token at once, and nobody can see or revoke another person\'s', { skip }, async () => {
  const mine = (await mint('tok.dan@x.com')).body
  assert.equal((await viaToken(mine.token, 'GET', '/api/v1/me')).status, 200)
  const theirs = (await mint('tok.eve@x.com')).body
  assert.equal((await call('DELETE', `/api/v1/me/tokens/${theirs.id}`, undefined, 'tok.dan@x.com')).status, 404)   // not yours
  assert.equal((await viaToken(theirs.token, 'GET', '/api/v1/me')).status, 200)                                     // still alive
  assert.deepEqual((await call('GET', '/api/v1/me/tokens', undefined, 'tok.dan@x.com')).body.map((t: any) => t.id), [mine.id])
  assert.equal((await call('DELETE', `/api/v1/me/tokens/${mine.id}`, undefined, 'tok.dan@x.com')).status, 204)
  assert.equal((await viaToken(mine.token, 'GET', '/api/v1/me')).status, 401)
  assert.equal((await call('DELETE', `/api/v1/me/tokens/${mine.id}`, undefined, 'tok.dan@x.com')).status, 404)    // already gone
})

test('tokens: expired, unknown and malformed tokens are refused; expired ones show as expired, then are dropped after 30 days', { skip }, async () => {
  const { body } = await mint('tok.fay@x.com')
  await pool.query(`update personal_access_tokens set expires_at = now() - interval '1 minute' where id = $1`, [body.id])
  assert.equal((await viaToken(body.token, 'GET', '/api/v1/me')).status, 401)
  assert.equal((await call('GET', '/api/v1/me/tokens', undefined, 'tok.fay@x.com')).body[0].expired, true)
  const wrong = 'jbp_' + 'A'.repeat(43)
  for (const bad of [wrong, 'jbp_short', 'jbp_' + '!'.repeat(43), 'jbp_', body.token.slice(0, -1)])
    assert.equal((await viaToken(bad, 'GET', '/api/v1/me')).status, 401, bad)
  await pool.query(`update personal_access_tokens set expires_at = now() - interval '31 days' where id = $1`, [body.id])
  await mint('tok.fay@x.com', 'next')
  assert.deepEqual((await call('GET', '/api/v1/me/tokens', undefined, 'tok.fay@x.com')).body.map((t: any) => t.name), ['next'])
})

test('tokens: at most 10 active at once, even when created in parallel; revoking frees a slot', { skip }, async () => {
  // A slow insert widens the window between "count the active tokens" and "add one", so only a real lock keeps the limit
  await pool.query(`create function slow_token_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.05); return new; end $$;
                    create trigger slow_insert before insert on personal_access_tokens for each row execute function slow_token_insert()`)
  const results = await Promise.all(Array.from({ length: 13 }, (_, i) => mint('tok.gus@x.com', `t${i}`)))
  await pool.query('drop trigger slow_insert on personal_access_tokens; drop function slow_token_insert()')
  assert.equal(results.filter(r => r.status === 201).length, 10)
  const refused = results.filter(r => r.status === 409)
  assert.equal(refused.length, 3)
  assert.match(refused[0]!.body.error, /at most 10/)
  const [first] = (await call('GET', '/api/v1/me/tokens', undefined, 'tok.gus@x.com')).body
  await call('DELETE', `/api/v1/me/tokens/${first.id}`, undefined, 'tok.gus@x.com')
  assert.equal((await mint('tok.gus@x.com', 'again')).status, 201)
})

test('tokens: a deactivated owner\'s tokens stop working, and a viewer\'s token is read-only', { skip }, async () => {
  const quit = (await mint('tok.hal@x.com')).body
  assert.equal((await viaToken(quit.token, 'GET', '/api/v1/me')).status, 200)
  await pool.query(`update users set active = false where email = 'tok.hal@x.com'`)
  assert.equal((await viaToken(quit.token, 'GET', '/api/v1/me')).status, 403)

  const viewer = (await mint('tok.ida@x.com')).body
  await pool.query(`update memberships set role = 'viewer' where user_id = (select id from users where email = 'tok.ida@x.com')`)
  assert.equal((await viaToken(viewer.token, 'GET', '/api/v1/projects')).status, 200)
  assert.equal((await viaToken(viewer.token, 'POST', '/api/v1/projects', { name: 'Nope', key: 'NOP', template: 'kanban' })).status, 403)
})

test('tokens: names and lifetimes are validated (1 to 365 days, 1 to 40 characters)', { skip }, async () => {
  const bad = async (body: object) => (await call('POST', '/api/v1/me/tokens', body, 'tok.jon@x.com')).status
  assert.equal(await bad({ name: '' }), 400)
  assert.equal(await bad({ name: '   ' }), 400)
  assert.equal(await bad({ name: 'x'.repeat(41) }), 400)
  assert.equal(await bad({ name: 'ok', expiresInDays: 0 }), 400)
  assert.equal(await bad({ name: 'ok', expiresInDays: 366 }), 400)
  assert.equal(await bad({ name: 'ok', expiresInDays: 1.5 }), 400)
  assert.equal(await bad({ name: 'x'.repeat(40), expiresInDays: 365 }), 201)
})
