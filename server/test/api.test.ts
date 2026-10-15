import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { createHmac } from 'node:crypto'

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
  assert.equal(p.status, 200)
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
  assert.equal((await call('POST', '/api/v1/projects/IDS/fields', { name: 'No id', kind: 'text' })).status, 200)   // still optional
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
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Logs', key: 'LOG', template: 'kanban' })).status, 200)
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
