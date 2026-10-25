import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import pg from 'pg'
import { createHash, createHmac } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'

// Needs a throwaway Postgres: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'
const TENANT = '11111111-1111-4111-8111-111111111111', CLIENT = '22222222-2222-4222-8222-222222222222'
Object.assign(process.env, {
  SCIM_TOKEN: 'scim-secret', NODE_ENV: 'test', GITHUB_WEBHOOK_SECRET: 'whsec-test', DOCS_ENABLED: '1', DUE_SCAN_INTERVAL_MS: '0',
  CORS_ORIGINS: 'https://app.example.com/, https://admin.example.com', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT,
})

let app: Awaited<ReturnType<typeof import('../src/app.ts').build>>

// A stand-in for S3 (path-style, no signature checks): objects live in memory as "bucket/key"; deletes can be made to fail.
const objects = new Map<string, Buffer>()
let failDeletes = false
const s3Server = createServer((req, res) => {
  const key = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, ''))
  const copy = req.headers['x-amz-copy-source']
  if (req.method === 'PUT' && copy) {
    const src = objects.get(decodeURIComponent(String(copy)).replace(/^\//, ''))
    if (!src) { res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return }
    objects.set(key, src); res.writeHead(200).end('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>'); return
  }
  if (req.method === 'PUT') { const parts: Buffer[] = []; req.on('data', c => parts.push(c)); req.on('end', () => { objects.set(key, Buffer.concat(parts)); res.writeHead(200, { etag: '"x"' }).end() }); return }
  if (req.method === 'GET') { const o = objects.get(key); if (!o) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); else res.writeHead(200, { 'content-length': String(o.length) }).end(o); return }
  if (req.method === 'HEAD') { const o = objects.get(key); if (!o) res.writeHead(404).end(); else res.writeHead(200, { 'content-length': String(o.length), etag: '"x"' }).end(); return }
  if (req.method === 'DELETE') { if (failDeletes) { res.writeHead(500).end('<Error><Code>InternalError</Code></Error>'); return } objects.delete(key); res.writeHead(204).end(); return }
  res.writeHead(405).end()
})
let pool: pg.Pool

// A stand-in for Entra: a local server publishes the signing key, and tests mint tokens the way Entra would.
let signingKey: CryptoKey, jwksServer: Server, authority: string
const uuidOf = (s: string) => { const h = createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` }
const tokenFor = (email: string, o: { roles?: string[]; aud?: string; iss?: string; exp?: string; key?: CryptoKey; oid?: string | null } = {}) =>
  new SignJWT({ ...(o.oid === null ? {} : { oid: o.oid ?? uuidOf(email) }), preferred_username: email, name: email.split('@')[0], roles: o.roles ?? [] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(o.iss ?? `${authority}/${TENANT}/v2.0`).setAudience(o.aud ?? CLIENT)
    .setIssuedAt().setExpirationTime(o.exp ?? '1h').sign(o.key ?? signingKey)
const bearer = async (email: string, o?: Parameters<typeof tokenFor>[1]) => ({ authorization: `Bearer ${await tokenFor(email, o)}` })

const call = async (method: string, path: string, body?: unknown, who = 'owner@x.com', headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url: path, payload: body as any, headers: { ...(await bearer(who)), ...headers } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}

/** Make `email` a member of project `key` (creating the person if they have never signed in). Global admins need no membership. */
/** A new project's workflow lets every status be reached from any other; tests that draw their own moves start without them. */
const clearMoves = async (key: string) => { for (const t of (await call('GET', `/api/v1/projects/${key}`)).body.transitions) await call('DELETE', `/api/v1/projects/${key}/transitions/${t.id}`) }
const join = async (key: string, email: string, role: 'admin' | 'member' | 'viewer' = 'member') => {
  await call('GET', '/api/v1/me', undefined, email)
  await pool.query(
    `insert into project_members (project_id, user_id, role) select p.id, u.id, $3 from projects p, users u where p.key = $1 and u.email = $2
       on conflict (project_id, user_id) do update set role = $3`, [key, email, role])
}

before(async () => {
  if (skip) return
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
  jwksServer = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>(r => jwksServer.listen(0, '127.0.0.1', r))
  authority = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`
  process.env.ENTRA_AUTHORITY = authority
  await new Promise<void>(r => s3Server.listen(0, '127.0.0.1', r))
  Object.assign(process.env, {
    S3_BUCKET: 'files', S3_ENDPOINT: `http://127.0.0.1:${(s3Server.address() as { port: number }).port}`, AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', FILE_SWEEP_MS: '0', JOBS_POLL_MS: '0',
  })
  pool = new pg.Pool({ connectionString: url })
  await pool.query('drop schema public cascade; create schema public')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of readdirSync(dir).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'))
  app = await (await import('../src/app.ts')).build()
})
after(async () => { if (skip) return; await app.close(); await pool.end(); jwksServer.close(); s3Server.close() })

test('project → issue lifecycle with workflow, versions and undo', { skip }, async () => {
  const p = await call('POST', '/api/v1/projects', { name: 'Payments', key: 'PAY', template: 'kanban' })
  await clearMoves('PAY')
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
  await join('PAY', 'dev2@x.com')
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
    version: 4, starred: ['p1'], views: [], dashboards: [{ id: 'old', name: 'An old dashboard', ownerId: 'u', gadgets: [{ id: 'g', kind: 'status' }] }], comments: [{ issueId: 'i1', body: 'hi', createdAt: 1 }],
    activity: [{ issueId: 'i2', field: 'status', to: 's1', text: 'created', createdAt: 1 }, { issueId: 'i2', field: 'status', from: 's1', to: 's2', text: 'moved', createdAt: 2 }],
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
  // status history arrives as the server records it, with the new status ids, so reports can read it
  const p = (await call('GET', '/api/v1/projects/IMP')).body
  const [todo, done] = [p.statuses.find((x: any) => x.name === 'To do').id, p.statuses.find((x: any) => x.name === 'Done').id]
  assert.deepEqual((await call('GET', '/api/v1/projects/IMP/report-data')).body.statusChanges.map((x: any) => [x.issueId, x.fromId, x.toId]),
    [[child.id, null, todo], [child.id, todo, done]])
  assert.equal((await call('POST', '/api/v1/import', state)).body.skippedProjects[0], 'IMP')   // re-import is a no-op
})

test('OpenAPI: project routes are documented and the schemas are enforced', { skip }, async () => {
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  assert.equal(spec.info.title, 'Strand API')
  assert.deepEqual(Object.keys(spec.components.securitySchemes).sort(), ['bearer', 'scimToken'])
  const post = spec.paths['/api/v1/projects/{key}/statuses'].post
  assert.deepEqual(post.tags, ['Project settings'])
  assert.deepEqual([...post.requestBody.content['application/json'].schema.required].sort(), ['category', 'color', 'name'])
  // every route (except the health and readiness probes) must be documented
  for (const [path, ops] of Object.entries<any>(spec.paths))
    if (path !== '/health' && path !== '/ready')
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
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization,if-match,x-workflow-override' },
  })
  const ok = await pre('https://app.example.com')
  assert.equal(ok.statusCode, 204)
  assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com')
  for (const h of ['authorization', 'if-match', 'x-workflow-override']) assert.match(String(ok.headers['access-control-allow-headers']), new RegExp(h))
  assert.equal((await pre('https://admin.example.com')).headers['access-control-allow-origin'], 'https://admin.example.com')
  assert.equal((await pre('https://evil.example')).headers['access-control-allow-origin'], undefined)
  // a normal request from a listed origin carries the header too
  const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: 'https://app.example.com', ...(await bearer('owner@x.com')) } })
  assert.equal(r.headers['access-control-allow-origin'], 'https://app.example.com')
  assert.match(String(r.headers['access-control-expose-headers']), /content-disposition/)   // so the browser can read an export's file name
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
  await clearMoves('OVR')
  const [todo, doing, done] = p.statuses
  await call('POST', '/api/v1/projects/OVR/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id }, 'lead@x.com')
  await call('POST', '/api/v1/projects/OVR/issues', { title: 'stuck', statusId: doing.id }, 'lead@x.com')
  await join('OVR', 'someone@x.com', 'member'); await join('OVR', 'second.admin@x.com', 'admin')
  const move = (who: string, headers: Record<string, string>) => call('PATCH', '/api/v1/issues/OVR-1', { statusId: done.id }, who, headers)
  assert.equal((await move('lead@x.com', {})).status, 409)                                  // no transition doing -> done
  assert.equal((await move('someone@x.com', { 'x-workflow-override': '1' })).status, 409)   // a plain member cannot override
  assert.equal((await move('second.admin@x.com', { 'x-workflow-override': '1' })).status, 200)   // any project admin can, not only the lead
  assert.equal((await call('GET', '/api/v1/issues/OVR-1')).body.statusId, done.id)
  await call('PATCH', '/api/v1/issues/OVR-1', { statusId: doing.id }, 'owner@x.com', { 'x-workflow-override': '1' })   // and so can a workspace admin
})

test('views and work logs accept client ids; notifications can be read and archived', { skip }, async () => {
  const vid = '0192f0c0-0000-7000-8000-0000000000a1', wid = '0192f0c0-0000-7000-8000-0000000000a3'
  assert.equal((await call('POST', '/api/v1/views', { id: vid, name: 'Mine', filters: { q: '' } })).body.id, vid)
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
  assert.deepEqual([noAuth.statusCode, JSON.parse(noAuth.body).code], [401, 'unauthorized'])
  assert.equal((await call('GET', '/api/v1/projects/NOPE')).body.code, 'not_found')
  assert.equal((await call('GET', '/api/v1/issues/NOPE-1')).body.code, 'not_found')
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Dup', key: 'PAY', template: 'kanban' })).body.code, 'conflict')
  const forbidden = await call('DELETE', '/api/v1/projects/PAY', undefined, 'plain-member@x.com')
  assert.deepEqual([forbidden.status, forbidden.body.code], [403, 'forbidden'])
  // unknown routes use the same shape, not the framework default
  const unknown = await app.inject({ method: 'GET', url: '/api/v1/nope' })
  assert.deepEqual([unknown.statusCode, JSON.parse(unknown.body)], [404, { error: 'Route not found', code: 'not_found' }])
  // malformed JSON is a 400 with a code, not a stack trace
  const broken = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...(await bearer('owner@x.com')), 'content-type': 'application/json' }, payload: '{nope' })
  assert.equal(broken.statusCode, 400); assert.equal(JSON.parse(broken.body).code, 'invalid_input')
})

test('/api/v1 is the only path, and the docs describe it', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('owner@x.com') })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: await bearer('owner@x.com') })).statusCode, 404)
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  const paths = Object.keys(spec.paths)
  assert.ok(paths.some(p => p.startsWith('/api/v1/')))
  assert.ok(paths.every(p => !p.startsWith('/api/') || p.startsWith('/api/v1/')), 'only /api/v1 is served')
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
  await join('SCH', 'someone@x.com')
  await ok('PATCH', '/issues/SCH-1', { assigneeId: (await call('GET', '/api/v1/me', undefined, 'someone@x.com')).body.id })   // makes a notification for someone
  const note = (await ok('GET', '/notifications', undefined, 'someone@x.com'))[0]
  assert.ok(note.issueKey)
  await ok('PATCH', `/notifications/${note.id}`, { read: true }, 'someone@x.com')
  const v = await ok('POST', '/views', { name: 'V', filters: { q: '' } }); await ok('PATCH', `/views/${v.id}`, { shared: true }); await ok('GET', '/views')
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
  await clearMoves('BLK')
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
  await join('BLK', 'bulk-viewer@x.com', 'viewer')
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
  await join('SRB', 'plain-member@x.com', 'member')
  assert.equal((await call('POST', '/api/v1/projects/SRB/archive', undefined, 'plain-member@x.com')).status, 403)   // members cannot archive; project admins can

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
  for (const who of ['ann.presence', 'ben.presence', 'cat.presence']) await join('PRS', `${who}@x.com`)
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
  await join('PRS', 'view.presence@x.com', 'viewer')
  assert.equal((await call('POST', '/api/v1/issues/PRS-1/presence', undefined, 'view.presence@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/issues/NOPE-1/presence', undefined, 'ann.presence@x.com')).status, 404)
})

test('live stream over real HTTP: carries CORS headers for allowed origins only, and delivers presence to the project', { skip }, async () => {
  const addr = await app.listen({ port: 0, host: '127.0.0.1' })
  await call('POST', '/api/v1/projects', { name: 'Stream', key: 'STR', template: 'kanban' })
  await call('POST', '/api/v1/projects/STR/issues', { title: 'live' })
  await join('STR', 'dan.stream@x.com')
  const url = `${addr}/api/v1/projects/STR/events`
  const origin = 'https://app.example.com'
  const ac = new AbortController()
  const res = await fetch(url, { headers: { ...(await bearer('owner@x.com')), origin }, signal: ac.signal })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.equal(res.headers.get('access-control-allow-origin'), origin)                           // a browser may read it
  const other = new AbortController()
  const res2 = await fetch(url, { headers: { ...(await bearer('owner@x.com')), origin: 'https://evil.example' }, signal: other.signal })
  assert.equal(res2.headers.get('access-control-allow-origin'), null); other.abort()           // an unlisted origin gets none
  // a heartbeat by someone else shows up on the stream, with the person's name
  const reader = res.body!.getReader(); const dec = new TextDecoder()
  let text = ''
  const beat = fetch(`${addr}/api/v1/issues/STR-1/presence`, { method: 'POST', headers: await bearer('dan.stream@x.com') })
  const until = Date.now() + 8000
  while (Date.now() < until && !text.includes('issue.editing')) { const { value } = await reader.read(); text += dec.decode(value) }
  await beat; ac.abort()
  const data = JSON.parse(text.split('\n').find(l => l.startsWith('data:') && l.includes('issue.editing'))!.slice(5))
  assert.equal(data.key, 'STR-1')
  assert.deepEqual(data.editors.map((e: any) => e.name), ['dan.stream'])
})

test('live stream: losing access closes the stream at once (removed from the project, or deactivated); others keep theirs', { skip }, async () => {
  const addr = await app.listen({ port: 0, host: '127.0.0.1' }).catch(() => `http://127.0.0.1:${(app.server.address() as any).port}`)
  await call('POST', '/api/v1/projects', { name: 'Revoke', key: 'RVK', template: 'kanban' })
  for (const who of ['rv.ann', 'rv.ben', 'rv.cat']) await join('RVK', `${who}@x.com`)
  const open = async (who: string) => {
    const res = await fetch(`${addr}/api/v1/projects/RVK/events`, { headers: await bearer(`${who}@x.com`) })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    await reader.read()                                              // ": connected"
    return reader
  }
  /** Resolves true when the server ends the stream, false if it is still open after `ms`. */
  const ends = async (r: ReadableStreamDefaultReader<Uint8Array>, ms = 3000) => {
    const timeout = new Promise<false>(res => setTimeout(() => res(false), ms))
    const done = (async () => { for (;;) { const { done } = await r.read(); if (done) return true } })()
    return Promise.race([done, timeout])
  }
  const [ann, ben, cat] = [await open('rv.ann'), await open('rv.ben'), await open('rv.cat')]
  try {
  const id = async (who: string) => (await call('GET', '/api/v1/me', undefined, `${who}@x.com`)).body.id
  assert.equal((await call('DELETE', `/api/v1/projects/RVK/members/${await id('rv.ann')}`)).status, 204)
  assert.equal(await ends(ann), true)                                // removed: stream closed
  await pool.query(`update users set active = false where email = 'rv.ben@x.com'`)
  assert.equal(await ends(ben), true)                                // deactivated: stream closed
  assert.equal(await ends(cat, 1500), false)                         // still a member: stream stays open
  } finally { for (const r of [ann, ben, cat]) await r.cancel().catch(() => {}) }   // a failure must not leave streams holding the run open
  assert.equal((await fetch(`${addr}/api/v1/projects/RVK/events`, { headers: await bearer('rv.ann@x.com') })).status, 404)   // and cannot reopen it
})

test('login: only a valid Entra token gets in; forged, expired, mis-addressed and header-only logins are refused', { skip }, async () => {
  const me = (h: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/me', headers: h })
  const other = (await generateKeyPair('RS256')).privateKey
  const refused: [string, Record<string, string>][] = [
    ['no credentials', {}],
    ['dev headers are not a login', { 'x-dev-user': 'owner@x.com', 'x-dev-secret': 'anything' }],
    ['not a JWT', { authorization: 'Bearer nonsense' }],
    ['signed with another key', await bearer('owner@x.com', { key: other })],
    ['expired', await bearer('owner@x.com', { exp: '-1m' })],
    ['another app\'s audience', await bearer('owner@x.com', { aud: '33333333-3333-4333-8333-333333333333' })],
    ['another tenant\'s issuer', await bearer('owner@x.com', { iss: `${authority}/44444444-4444-4444-8444-444444444444/v2.0` })],
    ['no oid claim', await bearer('owner@x.com', { oid: null })],
  ]
  for (const [why, h] of refused) assert.equal((await me(h)).statusCode, 401, why)
  const ok = await me(await bearer('owner@x.com', { aud: `api://${CLIENT}` }))        // the audience an exposed API scope produces
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.body).email, 'owner@x.com')
})

test('login: the Entra admin role claim decides admin rights, and an email cannot be taken over by another oid', { skip }, async () => {
  await call('GET', '/api/v1/me', undefined, 'first.person@x.com')                       // someone else may already be the owner
  const boss = await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('boss@x.com', { roles: ['Strand.Admin'] }) })
  assert.equal(JSON.parse(boss.body).role, 'admin')
  const demoted = await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('boss@x.com') })   // claim removed in Entra
  assert.equal(JSON.parse(demoted.body).role, 'member')
  const thief = await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('boss@x.com', { oid: uuidOf('someone else') }) })
  assert.equal(thief.statusCode, 403)
})

test('health is open, readiness checks the database', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200)
  const ready = await app.inject({ method: 'GET', url: '/ready' })
  assert.deepEqual([ready.statusCode, JSON.parse(ready.body)], [200, { ok: true }])
  assert.equal(ready.headers['x-content-type-options'], 'nosniff')
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
  // never more than 10; the rest are refused (or, on a slow machine, told the server is busy: 13 transactions wait on one
  // lock and only 10 database connections exist)
  assert.ok(results.filter(r => r.status === 201).length <= 10)
  assert.ok(results.every(r => [201, 409, 503].includes(r.status)), JSON.stringify(results.map(r => r.status)))
  const refused = results.filter(r => r.status === 409)
  assert.ok(refused.length >= 1)
  assert.match(refused[0]!.body.error, /at most 10/)
  while ((await call('GET', '/api/v1/me/tokens', undefined, 'tok.gus@x.com')).body.filter((t: any) => !t.expired).length < 10) await mint('tok.gus@x.com', 'fill')
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
  await call('POST', '/api/v1/projects', { name: 'Tok', key: 'TKV', template: 'kanban' })
  await join('TKV', 'tok.ida@x.com', 'viewer')
  assert.equal((await viaToken(viewer.token, 'GET', '/api/v1/projects/TKV')).status, 200)
  assert.equal((await viaToken(viewer.token, 'POST', '/api/v1/projects/TKV/issues', { title: 'Nope' })).status, 403)
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

test('statuses carry a description: empty by default, set on create, changed by patch, shown with the project, limited to 500 characters', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Describe', key: 'DSC', template: 'kanban' })).body
  assert.ok(p.statuses.every((s: any) => s.description === ''))
  const made = await call('POST', '/api/v1/projects/DSC/statuses', { name: 'Waiting', color: '#aaaaaa', category: 'in-progress', description: 'Waiting for the customer to reply' })
  assert.equal(made.status, 201)
  assert.equal(made.body.description, 'Waiting for the customer to reply')
  const noText = await call('POST', '/api/v1/projects/DSC/statuses', { name: 'Parked', color: '#aaaaaa', category: 'todo' })
  assert.equal(noText.body.description, '')                                                    // optional on create
  assert.deepEqual([made.body.position, noText.body.position], [3, 4])                       // no position given: goes to the end, after the 3 defaults
  const patched = await call('PATCH', `/api/v1/projects/DSC/statuses/${made.body.id}`, { description: 'Blocked on someone else' })
  assert.equal(patched.body.description, 'Blocked on someone else')
  assert.equal((await call('PATCH', `/api/v1/projects/DSC/statuses/${made.body.id}`, { name: 'Waiting on customer' })).body.description, 'Blocked on someone else')   // other edits leave it alone
  const detail = (await call('GET', '/api/v1/projects/DSC')).body
  assert.equal(detail.statuses.find((s: any) => s.id === made.body.id).description, 'Blocked on someone else')
  const tooLong = await call('PATCH', `/api/v1/projects/DSC/statuses/${made.body.id}`, { description: 'x'.repeat(501) })
  assert.equal(tooLong.status, 400)
  assert.ok(tooLong.body.errors.description)
  assert.equal((await call('PATCH', `/api/v1/projects/DSC/statuses/${made.body.id}`, { description: 'x'.repeat(500) })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/projects/DSC/statuses/${made.body.id}`, { description: '' })).body.description, '')     // can be cleared
})

// ── Notifications: mentions and due dates ──
const inbox = async (who: string, query = '') => (await call('GET', `/api/v1/notifications${query}`, undefined, who)).body as { kind: string; text: string; issueKey: string; actorId: string | null }[]

test('mentions: @Full Name notifies that person (not twice), watchers hear "commented", and mentioned people start watching', { skip }, async () => {
  const [ann, bob, cy] = ['mention.ann', 'mention.bob', 'mention.cy']
  await call('POST', '/api/v1/projects', { name: 'Mentions', key: 'MEN', template: 'kanban' })
  for (const n of [ann, bob, cy]) await join('MEN', `${n}@x.com`)
  const issue = (await call('POST', '/api/v1/projects/MEN/issues', { title: 'talk', assigneeId: (await call('GET', '/api/v1/me', undefined, `${cy}@x.com`)).body.id })).body
  const c1 = await call('POST', '/api/v1/issues/MEN-1/comments', { body: `Thanks @${bob}, can you look?` }, `${ann}@x.com`)
  assert.equal(c1.status, 201)
  assert.deepEqual((await inbox(`${bob}@x.com`)).filter(n => n.issueKey === 'MEN-1').map(n => n.kind), ['mentioned'])
  assert.deepEqual((await inbox(`${cy}@x.com`)).filter(n => n.issueKey === 'MEN-1' && n.kind !== 'assigned').map(n => n.kind), ['commented'])   // the assignee watches, was not mentioned
  assert.deepEqual((await inbox(`${ann}@x.com`)).filter(n => n.issueKey === 'MEN-1'), [])                                                       // never notified about their own comment
  // the commenter and the mentioned person now watch: a later comment by someone else reaches them as "commented"
  await call('POST', '/api/v1/issues/MEN-1/comments', { body: 'a later comment' }, `${cy}@x.com`)
  assert.ok((await inbox(`${bob}@x.com`)).some(n => n.issueKey === 'MEN-1' && n.kind === 'commented'))
  assert.ok((await inbox(`${ann}@x.com`)).some(n => n.issueKey === 'MEN-1' && n.kind === 'commented'))
  // a person mentioned AND already watching gets "mentioned" only
  await call('POST', '/api/v1/issues/MEN-1/comments', { body: `@${bob} again` }, `${cy}@x.com`)
  const bobNow = (await inbox(`${bob}@x.com`)).filter(n => n.issueKey === 'MEN-1')
  assert.deepEqual(bobNow.map(n => n.kind).sort(), ['commented', 'mentioned', 'mentioned'])
  assert.ok(issue.id)
})

test('mentions: whole names only, odd characters are safe, self-mentions and deactivated accounts are ignored', { skip }, async () => {
  const mk = async (name: string, email: string) => {
    const me = (await call('GET', '/api/v1/me', undefined, email)).body
    await pool.query('update users set name = $2 where id = $1', [me.id, name]); return me.id as string
  }
  const ann = await mk('Mention Ann', 'edge.ann@x.com'), anna = await mk('Mention Anna', 'edge.anna@x.com')
  const odd = await mk('J. O\'Neil (QA)', 'edge.odd@x.com'), gone = await mk('Mention Gone', 'edge.gone@x.com')
  await pool.query('update users set active = false where id = $1', [gone])
  const author = 'edge.author@x.com'
  await call('GET', '/api/v1/me', undefined, author)
  await call('POST', '/api/v1/projects', { name: 'Edge', key: 'EDG', template: 'kanban' })
  await call('POST', '/api/v1/projects/EDG/issues', { title: 'edge' })
  await join('EDG', author)
  await pool.query(`insert into project_members (project_id, user_id, role) select (select id from projects where key = 'EDG'), unnest($1::uuid[]), 'member'`, [[ann, anna, odd, gone]])
  const kinds = async (email: string) => (await inbox(email)).filter(n => n.issueKey === 'EDG-1').map(n => n.kind)
  await call('POST', '/api/v1/issues/EDG-1/comments', { body: 'Hello @Mention Anna and @J. O\'Neil (QA) and @Mention Gone' }, author)
  assert.deepEqual(await kinds('edge.anna@x.com'), ['mentioned'])
  assert.deepEqual(await kinds('edge.ann@x.com'), [])                    // "@Mention Anna" is not a mention of "Mention Ann"
  assert.deepEqual(await kinds('edge.odd@x.com'), ['mentioned'])         // regex characters in a name are just characters
  assert.equal((await pool.query('select count(*)::int as n from notifications where user_id = $1', [gone])).rows[0].n, 0)   // deactivated: nobody to notify
  await call('POST', '/api/v1/issues/EDG-1/comments', { body: 'Ping @Mention Ann, welcome.' }, author)
  assert.deepEqual(await kinds('edge.ann@x.com'), ['mentioned'])         // punctuation after the name still counts
  await call('POST', '/api/v1/issues/EDG-1/comments', { body: 'I am @Edge Author' }, author)   // no such person, and no crash
  assert.ok(ann && anna && odd)
})

test('due soon: open items assigned to me that are due tomorrow or sooner (3 days late at most) notify me once per due date', { skip }, async () => {
  const who = 'due.dan@x.com'
  const me = (await call('GET', '/api/v1/me', undefined, who)).body
  await call('POST', '/api/v1/projects', { name: 'Due dates', key: 'DUE', template: 'kanban' })
  await join('DUE', who)
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const mk = async (title: string, dueDate: string | undefined, extra: object = {}) =>
    (await call('POST', '/api/v1/projects/DUE/issues', { title, assigneeId: me.id, ...(dueDate ? { dueDate } : {}), ...extra })).body
  const tomorrow = await mk('tomorrow', day(1)), today = await mk('today', day(0)), late = await mk('late', day(-3))
  await mk('far', day(2)); await mk('way late', day(-5)); await mk('no date', undefined)
  const done = (await call('GET', '/api/v1/projects/DUE')).body.statuses.find((s: any) => s.category === 'done')
  await mk('finished', day(0), { statusId: done.id })
  await call('POST', '/api/v1/projects/DUE/issues', { title: 'someone else', dueDate: day(0) })        // not assigned to me
  const due = async () => (await inbox(who)).filter(n => n.kind === 'due').map(n => n.issueKey).sort()
  assert.deepEqual(await due(), [tomorrow.key, today.key, late.key].sort())
  assert.match((await inbox(who)).find(n => n.kind === 'due')!.text, /^is due on \d{4}-\d\d-\d\d$/)
  assert.deepEqual(await due(), [tomorrow.key, today.key, late.key].sort())                            // loading again adds nothing
  await call('PATCH', `/api/v1/issues/${today.key}`, { dueDate: day(1) })                               // a new due date is news again
  assert.equal((await due()).filter(k => k === today.key).length, 2)
  assert.equal((await inbox('due.other@x.com')).filter(n => n.kind === 'due').length, 0)
})

// ── Your work: summary, recent projects, viewed ──
test('your work summary counts open assigned items past the first page: due soon, late, blocked by unfinished work; epics and finished items are left out', { skip }, async () => {
  const who = 'yw.sam@x.com'
  const me = (await call('GET', '/api/v1/me', undefined, who)).body
  const p = (await call('POST', '/api/v1/projects', { name: 'Your work', key: 'YWK', template: 'kanban' })).body
  await join('YWK', who)
  const done = p.statuses.find((s: any) => s.category === 'done').id
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const mk = async (title: string, extra: object = {}) => (await call('POST', '/api/v1/projects/YWK/issues', { title, assigneeId: me.id, ...extra })).body
  const soon = await mk('soon', { dueDate: day(2) }), late = await mk('late', { dueDate: day(-2) }), later = await mk('later', { dueDate: day(10) })
  await mk('no date'); await mk('epic', { type: 'epic', dueDate: day(0) }); await mk('finished', { statusId: done, dueDate: day(-9) })
  const blocker = (await call('POST', '/api/v1/projects/YWK/issues', { title: 'blocker' })).body                    // assigned to nobody
  await call('POST', `/api/v1/issues/${blocker.key}/links`, { type: 'blocks', targetKey: soon.key })
  await call('POST', `/api/v1/issues/${blocker.key}/links`, { type: 'relates', targetKey: later.key })               // a plain relation does not block
  const sum = async () => (await call('GET', '/api/v1/me/work/summary', undefined, who)).body
  assert.deepEqual(await sum(), { assigned: 4, dueSoon: 2, overdue: 1, blocked: 1, dueSoonDays: 3 })                                     // soon+late are due within 3 days; late is also overdue
  await call('PATCH', `/api/v1/issues/${blocker.key}`, { statusId: done })
  assert.equal((await sum()).blocked, 0)                                                                                // once the blocker is done, nothing is blocked
  assert.deepEqual(await (async () => (await call('GET', '/api/v1/me/work/summary', undefined, 'yw.nobody@x.com')).body)(), { assigned: 0, dueSoon: 0, overdue: 0, blocked: 0, dueSoonDays: 3 })
  assert.ok(late.key)
})

test('recent projects: the 4 most recently active, with my open items, done items and totals (epics left out)', { skip }, async () => {
  const who = 'yw.pat@x.com'
  const me = (await call('GET', '/api/v1/me', undefined, who)).body
  for (const [i, key] of ['RPA', 'RPB', 'RPC', 'RPD', 'RPE'].entries()) {
    const p = (await call('POST', '/api/v1/projects', { name: `Recent ${key}`, key, template: 'kanban' })).body
    const done = p.statuses.find((s: any) => s.category === 'done').id
    await join(key, who)
    await call('POST', `/api/v1/projects/${key}/issues`, { title: 'mine', assigneeId: me.id })
    await call('POST', `/api/v1/projects/${key}/issues`, { title: 'done one', statusId: done })
    await call('POST', `/api/v1/projects/${key}/issues`, { title: 'an epic', type: 'epic' })
    await pool.query(`update issues set updated_at = now() - ($2 || ' minutes')::interval where project_id = (select id from projects where key = $1)`, [key, String((5 - i) * 10)])
  }
  await pool.query(`update issues set updated_at = now() - interval '9 days' where project_id in (select id from projects where key not like 'RP_')`)    // other tests' projects are older than these
  await pool.query(`update projects set created_at = now() - interval '9 days' where key not like 'RP_'`)
  const rows = (await call('GET', '/api/v1/me/projects/recent', undefined, who)).body
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r: any) => r.key).slice(0, 4), ['RPE', 'RPD', 'RPC', 'RPB'])                               // newest activity first; the oldest project is cut
  assert.deepEqual([rows[0].myOpen, rows[0].done, rows[0].total], [1, 1, 2])                                           // the epic is not counted
  await join('RPE', 'yw.other@x.com')
  const other = (await call('GET', '/api/v1/me/projects/recent', undefined, 'yw.other@x.com')).body.find((r: any) => r.key === 'RPE')
  assert.deepEqual([other.myOpen, other.done, other.total], [0, 1, 2])                                                 // "my" open items are mine, not everyone's
})

test('viewed: opening an item records it, newest first, once each, 50 at most, private to the person', { skip }, async () => {
  const who = 'yw.vic@x.com'
  await call('GET', '/api/v1/me', undefined, who)
  await call('POST', '/api/v1/projects', { name: 'Viewed', key: 'VWD', template: 'kanban' })
  await join('VWD', who)
  for (let n = 1; n <= 52; n++) await call('POST', '/api/v1/projects/VWD/issues', { title: `item ${n}` })
  const view = (n: number, as = who) => call('POST', `/api/v1/issues/VWD-${n}/view`, undefined, as)
  assert.equal((await view(1)).status, 204)
  for (let n = 2; n <= 52; n++) await view(n)
  let list = (await call('GET', '/api/v1/me/viewed', undefined, who)).body
  assert.equal(list.length, 50)
  assert.deepEqual([list[0].key, list.at(-1).key], ['VWD-52', 'VWD-3'])                                             // 1 and 2 fell off the end
  await view(10)                                                                                                    // opening it again moves it to the top, not twice
  list = (await call('GET', '/api/v1/me/viewed', undefined, who)).body
  assert.deepEqual([list[0].key, list.length, list.filter((i: any) => i.key === 'VWD-10').length], ['VWD-10', 50, 1])
  assert.deepEqual((await call('GET', '/api/v1/me/viewed', undefined, 'yw.nobody2@x.com')).body, [])                // nobody else sees my list
  assert.equal((await call('POST', '/api/v1/issues/NOPE-1/view', undefined, who)).status, 404)
  await call('DELETE', '/api/v1/issues/VWD-52')
  assert.ok(!(await call('GET', '/api/v1/me/viewed', undefined, who)).body.some((i: any) => i.key === 'VWD-52'))     // a deleted item disappears from the list
})

// ── Labels ──
test('labels: every label used in the workspace is listed, from any way an item gets one, narrowed by what you type', { skip }, async () => {
  const who = 'lab.lee@x.com'
  const labels = async (q = '') => (await call('GET', `/api/v1/labels${q}`, undefined, who)).body as string[]
  await call('POST', '/api/v1/projects', { name: 'Labelled', key: 'LAB', template: 'kanban' })
  await join('LAB', who)
  await call('POST', '/api/v1/projects/LAB/issues', { title: 'one', labels: ['Backend', 'urgent-fix'] }, who)       // on create
  await call('POST', '/api/v1/projects/LAB/issues', { title: 'two' })
  await call('PATCH', '/api/v1/issues/LAB-2', { labels: ['frontend'] })                                              // by edit
  await call('POST', '/api/v1/issues/bulk/edit', { issues: ['LAB-1', 'LAB-2'], patch: { labels: ['bulk-label'] } })    // in bulk
  const all = await labels()
  for (const l of ['Backend', 'urgent-fix', 'frontend', 'bulk-label']) assert.ok(all.includes(l), `${l} is missing`)
  assert.deepEqual(await labels('?query=END'), ['Backend', 'frontend'])                                              // anywhere in the name, any case
  assert.deepEqual(await labels('?query=' + encodeURIComponent('%')), [])                                            // % is a character, not a wildcard
  assert.deepEqual((await labels('?limit=2')).length, 2)
  assert.deepEqual([...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), all)                     // alphabetical
  await call('DELETE', '/api/v1/issues/LAB-2')
  assert.ok((await labels()).includes('frontend'))                                                                   // a label stays offered after its items go (as in Jira)
})

test('dashboards are gone: no endpoints, no table, and an old export that still has them imports fine', { skip }, async () => {
  assert.equal((await call('GET', '/api/v1/dashboards')).status, 404)
  assert.equal((await call('POST', '/api/v1/dashboards', { name: 'x' })).status, 404)
  assert.equal((await pool.query(`select to_regclass('public.dashboards') as t`)).rows[0].t, null)
  const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).body)
  assert.ok(!Object.keys(spec.paths).some(p => p.includes('dashboard')))
})

test('project access: outsiders see nothing, viewers read, members work, project admins manage, global admins see all', { skip }, async () => {
  const [admin, member, viewer, outsider] = ['pa.admin@x.com', 'pa.member@x.com', 'pa.viewer@x.com', 'pa.outsider@x.com']
  await call('POST', '/api/v1/projects', { name: 'Access', key: 'ACC', template: 'kanban' })
  await call('POST', '/api/v1/projects/ACC/issues', { title: 'first', labels: ['acc-only'] })
  await join('ACC', admin, 'admin'); await join('ACC', member); await join('ACC', viewer, 'viewer'); await call('GET', '/api/v1/me', undefined, outsider)
  const s = async (who: string, m: string, path: string, body?: unknown) => (await call(m, `/api/v1${path}`, body, who)).status
  const oid = (await call('GET', '/api/v1/me', undefined, outsider)).body.id as string

  // outsider: the project does not exist for them, anywhere
  for (const path of ['/projects/ACC', '/issues/ACC-1', '/projects/ACC/members']) assert.equal(await s(outsider, 'GET', path), 404)
  assert.equal(await s(outsider, 'POST', '/issues/ACC-1/comments', { body: 'hi' }), 404)
  assert.ok(!(await call('GET', '/api/v1/projects', undefined, outsider)).body.items?.some?.((p: any) => p.key === 'ACC') && !JSON.stringify((await call('GET', '/api/v1/projects', undefined, outsider)).body).includes('"ACC"'))
  assert.ok(!JSON.stringify((await call('GET', '/api/v1/labels?q=acc', undefined, outsider)).body).includes('acc-only'))
  assert.ok(JSON.stringify((await call('GET', '/api/v1/labels?q=acc', undefined, member)).body).includes('acc-only'))
  assert.equal(await s(outsider, 'POST', '/issues', undefined), 404)   // no such route: nothing leaks either way

  // viewer: reads, comments, watches; cannot change work or settings
  assert.equal(await s(viewer, 'GET', '/issues/ACC-1'), 200)
  assert.equal((await call('GET', '/api/v1/projects/ACC', undefined, viewer)).body.role, 'viewer')
  assert.equal(await s(viewer, 'POST', '/issues/ACC-1/comments', { body: 'looks good' }), 201)
  assert.equal(await s(viewer, 'POST', '/projects/ACC/issues', { title: 'no' }), 403)
  assert.equal(await s(viewer, 'PATCH', '/issues/ACC-1', { title: 'no' }), 403)

  // member: works on issues; no settings, people or archive
  assert.equal(await s(member, 'POST', '/projects/ACC/issues', { title: 'by member' }), 201)
  assert.equal(await s(member, 'PATCH', '/issues/ACC-1', { title: 'renamed' }), 200)
  assert.equal(await s(member, 'POST', '/projects/ACC/archive'), 403)
  assert.equal(await s(member, 'POST', '/projects/ACC/members', { userIds: [oid], role: 'member' }), 403)
  assert.equal(await s(member, 'GET', '/projects/ACC/members'), 200)

  // the assignee must be able to see the project
  assert.equal(await s(member, 'PATCH', '/issues/ACC-1', { assigneeId: oid }), 400)

  // project admin: adds people, changes roles; the outsider can then see the project
  assert.equal(await s(admin, 'POST', '/projects/ACC/members', { userIds: [oid], role: 'viewer' }), 200)
  assert.equal(await s(outsider, 'GET', '/issues/ACC-1'), 200)
  assert.equal(await s(admin, 'PATCH', `/projects/ACC/members/${oid}`, { role: 'member' }), 200)
  assert.equal(await s(outsider, 'PATCH', '/issues/ACC-1', { assigneeId: oid }), 200)

  // global admin (workspace owner) administers every project without being listed
  assert.equal((await call('GET', '/api/v1/projects/ACC')).body.role, 'admin')
  await pool.query(`delete from project_members where project_id = (select id from projects where key = 'ACC') and user_id = (select id from users where email = 'owner@x.com')`)
  assert.equal((await call('GET', '/api/v1/projects/ACC')).body.role, 'admin')
})

test('project members: last admin is protected, self-leave works, removal clears stars and views, only workspace people can be added', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'People', key: 'PPL', template: 'kanban' })
  await call('POST', '/api/v1/projects/PPL/issues', { title: 'one' })
  const [a, b, c] = ['pm.a@x.com', 'pm.b@x.com', 'pm.c@x.com']
  await join('PPL', a, 'admin'); await join('PPL', b); await call('GET', '/api/v1/me', undefined, c)
  const s = async (who: string, m: string, path: string, body?: unknown) => (await call(m, `/api/v1${path}`, body, who)).status
  const id = async (e: string) => (await call('GET', '/api/v1/me', undefined, e)).body.id as string
  const [aid, bid, cid] = [await id(a), await id(b), await id(c)]
  const m = (r: string) => `/projects/PPL/members/${r === a ? aid : bid}`

  await pool.query(`delete from project_members where project_id = (select id from projects where key = 'PPL') and user_id = (select id from users where email = 'owner@x.com')`)
  assert.equal(await s(a, 'PATCH', m(a), { role: 'member' }), 409)
  assert.equal(await s(a, 'DELETE', m(a)), 409)
  assert.equal(await s(b, 'DELETE', m(a)), 403)

  // bulk add: existing members keep their role
  assert.equal(await s(a, 'POST', '/projects/PPL/members', { userIds: [bid, cid], role: 'viewer' }), 200)
  const roles = Object.fromEntries((await call('GET', '/api/v1/projects/PPL/members', undefined, a)).body.map((x: any) => [x.email, x.role]))
  assert.deepEqual([roles[b], roles[c]], ['member', 'viewer'])
  assert.equal(await s(a, 'POST', '/projects/PPL/members', { userIds: ['00000000-0000-4000-8000-000000000000'], role: 'member' }), 400)

  // leaving removes your stars and views for the project
  await s(b, 'PUT', '/projects/PPL/star'); await s(b, 'POST', '/issues/PPL-1/view')
  assert.equal(await s(b, 'DELETE', m(b)), 204)
  assert.equal(await s(b, 'GET', '/projects/PPL'), 404)
  const left = await pool.query(`select (select count(*)::int from issue_views where user_id = $1) as v, (select count(*)::int from stars where user_id = $1) as s`, [bid])
  assert.deepEqual(left.rows[0], { v: 0, s: 0 })
})

test('automation follows the workflow and project membership like a person would, and says when it skips', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Automate', key: 'AUT', template: 'kanban' })).body
  await clearMoves('AUT')
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  await call('POST', '/api/v1/projects/AUT/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  await join('AUT', 'au.member@x.com')
  const member = (await call('GET', '/api/v1/me', undefined, 'au.member@x.com')).body.id
  const outsider = (await call('GET', '/api/v1/me', undefined, 'au.outsider@x.com')).body.id
  await call('POST', '/api/v1/projects/AUT/rules', { name: 'On create', trigger: { kind: 'created' }, actions: [
    { kind: 'status', value: done.id },          // To do -> Done is not a transition: skipped
    { kind: 'assign', to: outsider },            // not in the project: skipped
    { kind: 'assign', to: member },
    { kind: 'priority', value: 'high' },
  ] })
  const i = (await call('POST', '/api/v1/projects/AUT/issues', { title: 'guarded' })).body
  const now = (await call('GET', `/api/v1/issues/${i.key}`)).body
  assert.equal(now.statusId, todo.id)
  assert.equal(now.assigneeId, member)
  assert.equal(now.priority, 'high')
  const log = (await pool.query('select field, from_value, to_value, text from activity where issue_id = $1 order by created_at, id', [i.id])).rows
  assert.ok(log.some(r => r.text === 'Automation skipped a status change the workflow does not allow'))
  assert.ok(log.some(r => r.text === 'Automation skipped an assignment: that person is not in this project'))
  assert.ok(log.some(r => r.field === 'assigneeId' && r.to_value === member))     // real history, so reports and audits see it
  assert.ok(log.some(r => r.field === 'priority' && r.to_value === 'high'))
  // an allowed move still happens
  await call('POST', '/api/v1/projects/AUT/rules', { name: 'Start on assign', trigger: { kind: 'assigned' }, actions: [{ kind: 'status', value: doing.id }] })
  const j = (await call('POST', '/api/v1/projects/AUT/issues', { title: 'moves' })).body
  const owner = (await call('GET', '/api/v1/me')).body.id
  await call('PATCH', `/api/v1/issues/${j.key}`, { assigneeId: owner })   // the create rule already gave it to the member; a new assignee fires "assigned"
  assert.equal((await call('GET', `/api/v1/issues/${j.key}`)).body.statusId, doing.id)
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and field = 'statusId' and to_value = $2`, [j.id, doing.id])).rows.length)
})

test('transition rules: who may move, what a move needs, what it does; loops; every write path follows them', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Ruled', key: 'RUL', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  await join('RUL', 'rul.ann@x.com'); await join('RUL', 'rul.ben@x.com')
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const [owner, ann, ben] = [await id('owner@x.com'), await id('rul.ann@x.com'), await id('rul.ben@x.com')]
  const [{ id: qa }] = (await pool.query(`insert into groups (display_name) values ('QA') returning id`)).rows
  await pool.query('insert into group_members (group_id, user_id) values ($1, $2)', [qa, ben])
  assert.deepEqual((await call('GET', '/api/v1/me', undefined, 'rul.ben@x.com')).body.groupIds, [qa])
  const transition = async (body: object) => {
    const r = await call('POST', '/api/v1/projects/RUL/transitions', body)
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body
  }
  // the kanban template's any-to-any moves are replaced by a ruled workflow
  for (const t of (await call('GET', '/api/v1/projects/RUL')).body.transitions) await call('DELETE', `/api/v1/projects/RUL/transitions/${t.id}`)
  // Start: only the assignee, or (QA and a member); Finish: needs a due date and a comment, sets resolution and clears the sprint
  const start = await transition({ name: 'Start', fromIds: [todo.id], toId: doing.id, rules: { restrict: { op: 'any', items: [
    { kind: 'person', who: 'assignee' }, { op: 'all', items: [{ kind: 'group', groupIds: [qa] }, { kind: 'role', roles: ['member'] }] }] } } })
  const finish = await transition({ name: 'Finish', fromIds: [doing.id], toId: done.id, rules: {
    validate: [{ kind: 'required', fields: ['dueDate', 'comment'] }], screen: ['dueDate', 'comment'],
    actions: [{ kind: 'set', field: 'resolution', value: "Won't do" }, { kind: 'assign', to: 'reporter' }, { kind: 'comment', body: 'Closed by the workflow' }] } })
  const log = await transition({ name: 'Log progress', fromIds: [doing.id], toId: null, rules: { screen: ['comment'], actions: [{ kind: 'set', field: 'startDate', value: 'today' }] } })
  await transition({ name: 'Reopen', fromIds: [done.id], toId: todo.id, rules: { restrict: { op: 'all', items: [{ kind: 'hidden' }] } } })
  // bad rules are refused when saved
  assert.equal((await call('POST', '/api/v1/projects/RUL/transitions', { name: 'x', fromIds: null, toId: todo.id, rules: { restrict: { op: 'all', items: [{ kind: 'field', field: 'nonsense', op: 'empty' }] } } })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/RUL/transitions', { name: 'x', fromIds: null, toId: todo.id, rules: { actions: [{ kind: 'set', field: 'type', value: 'bug' }] } })).status, 400)

  const i = (await call('POST', '/api/v1/projects/RUL/issues', { title: 'ruled', assigneeId: ann })).body
  // restrict: ann (assignee) and ben (QA member) may start it; the owner (admin, not QA, not assignee) may not, and doesn't see it
  assert.deepEqual((await call('GET', `/api/v1/issues/${i.key}/transitions`)).body, [])
  const refused = await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: doing.id })
  assert.equal(refused.status, 403); assert.match(refused.body.error, /can’t make this move/)
  assert.equal((await call('GET', `/api/v1/issues/${i.key}/transitions`, undefined, 'rul.ben@x.com')).body[0].name, 'Start')
  assert.equal((await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: doing.id }, 'rul.ben@x.com')).status, 200)

  // validate: Finish needs a due date and a comment; GET says so up front, PATCH and POST refuse with field errors
  const avail = (await call('GET', `/api/v1/issues/${i.key}/transitions`, undefined, 'rul.ann@x.com')).body
  assert.deepEqual(avail.map((t: any) => [t.name, t.toId]).sort(), [['Finish', done.id], ['Log progress', null]])
  assert.deepEqual(Object.keys(avail.find((t: any) => t.name === 'Finish').problems).sort(), ['comment', 'dueDate'])
  const missing = await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: done.id }, 'rul.ann@x.com')
  assert.equal(missing.status, 400); assert.deepEqual(Object.keys(missing.body.errors).sort(), ['comment', 'dueDate'])
  const noComment = await call('POST', `/api/v1/issues/${i.key}/transitions`, { transitionId: finish.id, fields: { dueDate: '2026-12-01' } }, 'rul.ann@x.com')
  assert.equal(noComment.status, 400); assert.deepEqual(Object.keys(noComment.body.errors), ['comment'])
  assert.equal((await call('GET', `/api/v1/issues/${i.key}`)).body.dueDate, null)                       // all or nothing

  // a loop: stays in its status, its screen's comment is added and its actions run
  const looped = await call('POST', `/api/v1/issues/${i.key}/transitions`, { transitionId: log.id, comment: 'Half way' }, 'rul.ann@x.com')
  assert.equal(looped.status, 200); assert.equal(looped.body.statusId, doing.id)
  assert.equal(looped.body.startDate, new Date().toISOString().slice(0, 10))

  // the move with its screen filled in: actions set the resolution, give it back to the reporter, and comment
  const made = await call('POST', `/api/v1/issues/${i.key}/transitions`, { transitionId: finish.id, fields: { dueDate: '2026-12-01' }, comment: 'Shipped' }, 'rul.ann@x.com')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.deepEqual([made.body.statusId, made.body.dueDate, made.body.resolution, made.body.assigneeId], [done.id, '2026-12-01', "Won't do", owner])
  const comments = (await call('GET', `/api/v1/issues/${i.key}/comments`)).body.items.map((c: any) => c.body)
  assert.deepEqual(comments, ['Half way', 'Shipped', 'Closed by the workflow'])
  const history = (await pool.query('select text from activity where issue_id = $1', [i.id])).rows.map(r => r.text)
  assert.ok(history.includes('“Log progress”') && history.includes('“Finish” changed resolution'))

  // a loop can't be started from elsewhere; a hidden transition is for automation only
  assert.equal((await call('POST', `/api/v1/issues/${i.key}/transitions`, { transitionId: log.id }, 'rul.ann@x.com')).status, 409)
  assert.equal((await call('POST', `/api/v1/issues/${i.key}/transitions`, { transitionId: start.id }, 'rul.ann@x.com')).status, 409)
  assert.equal((await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: todo.id })).status, 403)

  // bulk edit: the same rules, all or nothing
  const j = (await call('POST', '/api/v1/projects/RUL/issues', { title: 'mine', assigneeId: ann })).body
  const k = (await call('POST', '/api/v1/projects/RUL/issues', { title: 'not mine', assigneeId: ben })).body
  const bulk = await call('POST', '/api/v1/issues/bulk/edit', { issues: [j.key, k.key], patch: { statusId: doing.id } }, 'rul.ann@x.com')
  assert.equal(bulk.status, 403)
  assert.equal((await call('GET', `/api/v1/issues/${j.key}`)).body.statusId, todo.id)

  // automation: person rules don't bind it, the hidden Reopen is its to use, validators still do
  await call('POST', '/api/v1/projects/RUL/rules', { name: 'Reopen on assign', trigger: { kind: 'assigned' }, actions: [{ kind: 'status', value: todo.id }] })
  await call('PATCH', `/api/v1/issues/${i.key}`, { assigneeId: ann })
  assert.equal((await call('GET', `/api/v1/issues/${i.key}`)).body.statusId, todo.id)
  await call('POST', '/api/v1/projects/RUL/rules', { name: 'Finish on assign', trigger: { kind: 'assigned' }, actions: [{ kind: 'status', value: done.id }] })
  await call('PATCH', `/api/v1/issues/${k.key}`, { statusId: doing.id }, 'rul.ben@x.com')
  await call('PATCH', `/api/v1/issues/${k.key}`, { assigneeId: owner })
  assert.equal((await call('GET', `/api/v1/issues/${k.key}`)).body.statusId, doing.id)                 // no due date, no comment: skipped
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and text like 'Automation skipped a status change: %required%'`, [k.id])).rows.length)
})

test('link types: Jira’s four to start with; admins add, rename and remove them; links in use move or go; built-ins stay', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Linked', key: 'LNK', template: 'kanban' })
  for (let n = 0; n < 3; n++) await call('POST', '/api/v1/projects/LNK/issues', { title: `l${n}` })
  const types = (await call('GET', '/api/v1/link-types', undefined, 'lnk.member@x.com')).body
  assert.deepEqual(types.map((t: any) => [t.id, t.outward, t.inward]), [
    ['blocks', 'blocks', 'is blocked by'], ['clones', 'clones', 'is cloned by'], ['duplicates', 'duplicates', 'is duplicated by'], ['relates', 'relates to', 'relates to']])
  // a new kind of link, used both ways; an unknown kind is refused
  const made = await call('POST', '/api/v1/admin/link-types', { name: 'Causes', outward: 'causes', inward: 'is caused by' })
  assert.equal(made.status, 201); assert.equal(made.body.id, 'causes')
  assert.equal((await call('POST', '/api/v1/admin/link-types', { name: 'causes', outward: 'a', inward: 'b' })).status, 409)
  assert.equal((await call('POST', '/api/v1/admin/link-types', { name: 'Nope', outward: 'a', inward: 'b' }, 'lnk.member@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/issues/LNK-1/links', { type: 'causes', targetKey: 'LNK-2' })).status, 204)
  assert.equal((await call('POST', '/api/v1/issues/LNK-1/links', { type: 'duplicates', targetKey: 'LNK-2' })).status, 204)
  assert.equal((await call('POST', '/api/v1/issues/LNK-3/links', { type: 'causes', targetKey: 'LNK-2' })).status, 204)
  assert.equal((await call('POST', '/api/v1/issues/LNK-1/links', { type: 'nonsense', targetKey: 'LNK-3' })).status, 400)
  // rename: links keep their type
  assert.equal((await call('PATCH', '/api/v1/admin/link-types/causes', { inward: 'is the result of' })).body.inward, 'is the result of')
  // removing one in use needs a decision; moving merges with links already there; built-ins can't go
  assert.equal((await call('DELETE', '/api/v1/admin/link-types/causes')).status, 409)
  assert.equal((await call('DELETE', '/api/v1/admin/link-types/causes?moveTo=duplicates')).status, 204)
  const links = (await call('GET', '/api/v1/issues/LNK-2?expand=links')).body.links.map((l: any) => [l.type, l.dir, l.key]).sort()
  assert.deepEqual(links, [['duplicates', 'in', 'LNK-1'], ['duplicates', 'in', 'LNK-3']])
  assert.equal((await call('DELETE', '/api/v1/admin/link-types/blocks?removeLinks=1')).status, 409)
  assert.equal((await call('DELETE', '/api/v1/admin/link-types/duplicates?removeLinks=1')).status, 204)
  assert.deepEqual((await call('GET', '/api/v1/issues/LNK-2?expand=links')).body.links, [])
  const log = (await call('GET', '/api/v1/audit?action=link_type')).body.items.map((e: any) => e.action)
  assert.deepEqual(log.sort(), ['link_type.created', 'link_type.deleted', 'link_type.deleted', 'link_type.updated'])
})

test('clone: a copy in the start status linked to the original, with its children, links and sprint when asked', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Clones', key: 'CLN', template: 'scrum' })).body
  const [todo, doing] = p.statuses
  const [{ id: f1 }] = (await pool.query(`insert into field_defs (project_id, name, kind) values ($1, 'Team', 'text') returning id`, [p.id])).rows
  await join('CLN', 'cln.member@x.com')
  const member = (await call('GET', '/api/v1/me', undefined, 'cln.member@x.com')).body.id
  const sprint = (await call('POST', '/api/v1/projects/CLN/sprints', { name: 'S1' })).body
  const src = (await call('POST', '/api/v1/projects/CLN/issues', { title: 'Original', type: 'story', priority: 'high', labels: ['ui'], estimate: 5, assigneeId: member, sprintId: sprint.id, custom: { [f1]: 'Core' } })).body
  await call('PATCH', `/api/v1/issues/${src.key}`, { statusId: doing.id })
  await call('POST', '/api/v1/projects/CLN/issues', { title: 'Child A', parentId: src.id })
  const other = (await call('POST', '/api/v1/projects/CLN/issues', { title: 'Blocked by the original' })).body
  await call('POST', `/api/v1/issues/${src.key}/links`, { type: 'blocks', targetKey: other.key })

  // plain clone: fields copied, start status, no sprint, no children, linked "clones"
  const a = await call('POST', `/api/v1/issues/${src.key}/clone`, {})
  assert.equal(a.status, 201)
  assert.deepEqual([a.body.title, a.body.type, a.body.priority, a.body.labels, a.body.estimate, a.body.assigneeId, a.body.statusId, a.body.sprintId, a.body.custom[f1]],
    ['CLONE - Original', 'story', 'high', ['ui'], 5, member, todo.id, null, 'Core'])
  const aLinks = (await call('GET', `/api/v1/issues/${a.body.key}?expand=links,children`)).body
  assert.deepEqual(aLinks.links.map((l: any) => [l.type, l.dir, l.key]), [['clones', 'out', src.key]])
  assert.deepEqual(aLinks.children, [])
  // everything: children, links, sprint; another title and assignee
  const b = await call('POST', `/api/v1/issues/${src.key}/clone`, { title: 'Second go', assigneeId: null, include: { children: true, links: true, sprint: true } })
  assert.deepEqual([b.body.title, b.body.assigneeId, b.body.sprintId], ['Second go', null, sprint.id])
  const bFull = (await call('GET', `/api/v1/issues/${b.body.key}?expand=links,children`)).body
  assert.deepEqual(bFull.children.map((c: any) => c.title), ['Child A'])
  assert.deepEqual(bFull.links.map((l: any) => [l.type, l.dir, l.key]).sort(), [['blocks', 'out', other.key], ['clones', 'out', src.key]])
  // history says where it came from; viewers can't clone
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and text = $2`, [b.body.id, `Cloned from ${src.key}`])).rows.length)
  await join('CLN', 'cln.viewer@x.com', 'viewer')
  assert.equal((await call('POST', `/api/v1/issues/${src.key}/clone`, {}, 'cln.viewer@x.com')).status, 403)
})

test('work types: the built-in four, renamed per project; added types; a workflow per type; removing one moves its items', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Typed', key: 'TYP', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  assert.deepEqual(p.types.map((t: any) => [t.key, t.name]), [['epic', 'Epic'], ['story', 'Story'], ['task', 'Task'], ['bug', 'Bug']])
  // rename a built-in (this project only); add a type; a duplicate name is refused
  assert.equal((await call('PATCH', '/api/v1/projects/TYP/types/story', { name: 'User story' })).body.name, 'User story')
  const inc = await call('POST', '/api/v1/projects/TYP/types', { name: 'Incident', color: '#B91C1C', icon: 'shield' })
  assert.equal(inc.status, 201); assert.match(inc.body.key, /^t-/)
  assert.equal((await call('POST', '/api/v1/projects/TYP/types', { name: 'incident', color: '#B91C1C', icon: 'shield' })).status, 409)
  // items may be of the project's types only
  const i = (await call('POST', '/api/v1/projects/TYP/issues', { title: 'Outage', type: inc.body.key })).body
  assert.equal(i.type, inc.body.key)
  assert.equal((await call('POST', '/api/v1/projects/TYP/issues', { title: 'x', type: 'nonsense' })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${i.key}`, { type: 'feature' })).status, 400)
  // the CSV export shows the type's name
  const csv = (await app.inject({ method: 'GET', url: `/api/v1/search/export.csv?project=${p.id}`, headers: await bearer('owner@x.com') })).body
  assert.match(csv, /Incident/)
  // a workflow per type: incidents go To do -> Done directly; everything else goes through In progress
  for (const t of p.transitions) await call('DELETE', `/api/v1/projects/TYP/transitions/${t.id}`)
  await call('POST', '/api/v1/projects/TYP/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  await call('POST', '/api/v1/projects/TYP/transitions', { name: 'Finish', fromIds: [doing.id], toId: done.id })
  await call('POST', '/api/v1/projects/TYP/transitions', { name: 'Resolve', fromIds: [todo.id], toId: done.id, typeKeys: [inc.body.key] })
  const task = (await call('POST', '/api/v1/projects/TYP/issues', { title: 'Plain task' })).body
  assert.deepEqual((await call('GET', `/api/v1/issues/${i.key}/transitions`)).body.map((t: any) => t.name).sort(), ['Resolve', 'Start'])
  assert.deepEqual((await call('GET', `/api/v1/issues/${task.key}/transitions`)).body.map((t: any) => t.name), ['Start'])
  assert.equal((await call('PATCH', `/api/v1/issues/${task.key}`, { statusId: done.id })).status, 409)
  assert.equal((await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: done.id })).status, 200)
  // built-ins stay; removing an added type in use needs a type to move its items to, and the history says so
  assert.equal((await call('DELETE', '/api/v1/projects/TYP/types/bug')).status, 409)
  assert.equal((await call('DELETE', `/api/v1/projects/TYP/types/${inc.body.key}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/projects/TYP/types/${inc.body.key}?moveTo=bug`)).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${i.key}`)).body.type, 'bug')
  const after = (await call('GET', '/api/v1/projects/TYP')).body
  assert.equal(after.transitions.find((t: any) => t.name === 'Resolve').typeKeys, null)   // its only type went: for every type again
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and field = 'type' and to_value = 'bug'`, [i.id])).rows.length)
  // members can't change the types
  await join('TYP', 'typ.member@x.com')
  assert.equal((await call('POST', '/api/v1/projects/TYP/types', { name: 'Spike', color: '#000000', icon: 'flag' }, 'typ.member@x.com')).status, 403)
})

test('workflow versions: publishing records the workflow; nothing new when unchanged; a status in use goes only with somewhere for its items', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Versioned', key: 'VER', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  const v1 = await call('POST', '/api/v1/projects/VER/workflow/versions', { note: 'First' })
  assert.equal(v1.status, 201); assert.deepEqual(v1.body, { version: 1, created: true })
  assert.deepEqual((await call('POST', '/api/v1/projects/VER/workflow/versions', {})).body, { version: 1, created: false })
  // a review status, used by items, some of them not open in anyone's browser (made straight in the database)
  const review = (await call('POST', '/api/v1/projects/VER/statuses', { name: 'Review', color: '#a855f7', category: 'in-progress' })).body
  await call('POST', '/api/v1/projects/VER/transitions', { name: 'To review', fromIds: [doing.id, review.id], toId: review.id === doing.id ? done.id : done.id })
  await call('POST', '/api/v1/projects/VER/transitions', { name: 'Back', fromIds: [review.id], toId: todo.id })
  const items = []
  for (let n = 0; n < 3; n++) items.push((await call('POST', '/api/v1/projects/VER/issues', { title: `r${n}`, statusId: review.id })).body)
  await call('DELETE', `/api/v1/issues/${items[2].key}`)                        // a deleted item still counts
  assert.equal((await call('POST', '/api/v1/projects/VER/workflow/versions', { note: 'Review step' })).body.version, 2)
  // removing it: refused without a destination; with one, every item moves (history written) and transitions let go of it
  assert.equal((await call('DELETE', `/api/v1/projects/VER/statuses/${review.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/projects/VER/statuses/${review.id}?moveTo=${review.id}`)).status, 400)
  assert.equal((await call('DELETE', `/api/v1/projects/VER/statuses/${review.id}?moveTo=${doing.id}`)).status, 204)
  const rows = (await pool.query('select status_id from issues where id = any($1::uuid[])', [items.map(i => i.id)])).rows
  assert.ok(rows.every(r => r.status_id === doing.id))
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and text = 'Changed status (workflow update)'`, [items[0].id])).rows.length)
  const ts = (await call('GET', '/api/v1/projects/VER')).body.transitions
  assert.deepEqual(ts.find((t: any) => t.name === 'To review').fromIds, [doing.id])
  assert.equal(ts.some((t: any) => t.name === 'Back'), false)                    // it only started there
  // versions list and read back; viewers read, only admins publish
  assert.equal((await call('POST', '/api/v1/projects/VER/workflow/versions', { note: 'Without review' })).body.version, 3)
  const list = (await call('GET', '/api/v1/projects/VER/workflow/versions')).body
  assert.deepEqual(list.map((v: any) => [v.version, v.note]), [[3, 'Without review'], [2, 'Review step'], [1, 'First']])
  const two = (await call('GET', '/api/v1/projects/VER/workflow/versions/2')).body
  assert.ok(two.statuses.some((s: any) => s.name === 'Review') && two.transitions.some((t: any) => t.name === 'Back'))
  await join('VER', 'ver.viewer@x.com', 'viewer')
  assert.equal((await call('GET', '/api/v1/projects/VER/workflow/versions', undefined, 'ver.viewer@x.com')).status, 200)
  assert.equal((await call('POST', '/api/v1/projects/VER/workflow/versions', {}, 'ver.viewer@x.com')).status, 403)
  assert.equal((await call('GET', '/api/v1/projects/VER/workflow/versions/9')).status, 404)
})

test('time tracking: the remaining estimate counts down as work is logged, Jira’s four ways; admins manage everyone’s logs', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Timed', key: 'TIM', template: 'kanban' })
  await join('TIM', 'tim.ann@x.com'); await join('TIM', 'tim.ben@x.com')
  const i = (await call('POST', '/api/v1/projects/TIM/issues', { title: 'Estimated', timeEstimate: 600 })).body
  assert.deepEqual([i.timeEstimate, i.timeRemaining], [600, 600])                 // the remaining estimate starts at the original
  const rem = async () => (await call('GET', `/api/v1/issues/${i.key}`)).body.timeRemaining
  const log = (body: object, who = 'tim.ann@x.com') => call('POST', `/api/v1/issues/${i.key}/worklogs`, { date: '2026-10-20', ...body }, who)
  const a = (await log({ minutes: 120 })).body                                    // auto: 600 - 120
  assert.equal(await rem(), 480)
  await log({ minutes: 60, adjustEstimate: 'leave' }); assert.equal(await rem(), 480)
  await log({ minutes: 30, adjustEstimate: 'new', newEstimate: 200 }); assert.equal(await rem(), 200)
  await log({ minutes: 30, adjustEstimate: 'manual', reduceBy: 50 }); assert.equal(await rem(), 150)
  assert.equal((await log({ minutes: 30, adjustEstimate: 'new' })).status, 400)
  // changing a log moves the remaining estimate by the difference; removing it puts its time back
  assert.equal((await call('PATCH', `/api/v1/worklogs/${a.id}`, { minutes: 150 }, 'tim.ann@x.com')).body.minutes, 150)
  assert.equal(await rem(), 120)
  // someone else's log: Ben (a member) can't touch Ann's; the owner (project admin) can, and it is audited
  assert.equal((await call('PATCH', `/api/v1/worklogs/${a.id}`, { note: 'mine now' }, 'tim.ben@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/worklogs/${a.id}`, undefined, 'tim.ben@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/worklogs/${a.id}`)).status, 204)
  assert.equal(await rem(), 270)
  assert.ok((await call('GET', '/api/v1/audit?action=worklog')).body.items.some((e: any) => e.action === 'worklog.deleted'))
  // the remaining estimate can be set by hand, and never goes below zero
  assert.equal((await call('PATCH', `/api/v1/issues/${i.key}`, { timeRemaining: 20 })).body.timeRemaining, 20)
  await log({ minutes: 90 }); assert.equal(await rem(), 0)
})

test('components and affects versions: an item in several; new work goes to the component lead; removing one lets go of its items', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Parts', key: 'PRT', template: 'kanban' })).body
  await join('PRT', 'prt.lea@x.com')
  const lea = (await call('GET', '/api/v1/me', undefined, 'prt.lea@x.com')).body.id
  const owner = (await call('GET', '/api/v1/me')).body.id
  const outsider = (await call('GET', '/api/v1/me', undefined, 'prt.out@x.com')).body.id
  const api = (await call('POST', '/api/v1/projects/PRT/components', { name: 'API', leadId: lea, defaultAssignee: 'component_lead' })).body
  const web = (await call('POST', '/api/v1/projects/PRT/components', { name: 'Web', defaultAssignee: 'project_lead' })).body
  const gone = (await call('POST', '/api/v1/projects/PRT/components', { name: 'Old', leadId: outsider, defaultAssignee: 'component_lead' })).body
  assert.equal((await call('POST', '/api/v1/projects/PRT/components', { name: 'API' })).status, 409)   // names are unique in a project
  assert.deepEqual((await call('GET', '/api/v1/projects/PRT')).body.components.map((c: any) => c.name), ['API', 'Old', 'Web'])
  const r1 = (await call('POST', '/api/v1/projects/PRT/releases', { name: '1.0' })).body
  const r2 = (await call('POST', '/api/v1/projects/PRT/releases', { name: '1.1' })).body
  // default assignee: the component lead; then the project lead; an explicit choice (even nobody) wins; an outsider never
  const a = (await call('POST', '/api/v1/projects/PRT/issues', { title: 'API bug', componentIds: [api.id, web.id], affectsReleaseIds: [r1.id, r2.id] })).body
  assert.deepEqual([a.assigneeId, a.componentIds, a.affectsReleaseIds], [lea, [api.id, web.id], [r1.id, r2.id]])
  assert.equal((await call('POST', '/api/v1/projects/PRT/issues', { title: 'Web bug', componentIds: [web.id] })).body.assigneeId, owner)
  assert.equal((await call('POST', '/api/v1/projects/PRT/issues', { title: 'Mine', componentIds: [api.id], assigneeId: null })).body.assigneeId, null)
  assert.equal((await call('POST', '/api/v1/projects/PRT/issues', { title: 'Old part', componentIds: [gone.id] })).body.assigneeId, null)
  // another project's component or release is refused
  const other = (await call('POST', '/api/v1/projects', { name: 'Other', key: 'OTH', template: 'kanban' })).body
  const theirs = (await call('POST', '/api/v1/projects/OTH/components', { name: 'Theirs' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { componentIds: [theirs.id] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { affectsReleaseIds: [other.id] })).status, 400)
  // removing a component or a release takes it off its items
  await call('DELETE', `/api/v1/projects/PRT/components/${web.id}`)
  await call('DELETE', `/api/v1/projects/PRT/releases/${r1.id}`)
  const after = (await call('GET', `/api/v1/issues/${a.key}`)).body
  assert.deepEqual([after.componentIds, after.affectsReleaseIds], [[api.id], [r2.id]])
})

test('saved views are shared as Jira filters are: with a project, a group or a person, to view or edit; admins give them a new owner', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Filters', key: 'FLT', template: 'kanban' })).body
  await join('FLT', 'flt.pat@x.com')
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const [ann, ben, pat] = [await id('flt.ann@x.com'), await id('flt.ben@x.com'), await id('flt.pat@x.com')]
  const [{ id: grp }] = (await pool.query(`insert into groups (display_name) values ('Filter fans') returning id`)).rows
  await pool.query('insert into group_members (group_id, user_id) values ($1, $2)', [grp, ben])
  const mine = ['For Ben', 'For the group', 'For the project', 'Private', 'Renamed by Ben']   // views other tests share with the whole workspace are left out
  const names = async (who: string) => (await call('GET', '/api/v1/views', undefined, who)).body.map((v: any) => v.name).filter((n: string) => mine.includes(n)).sort()
  const make = (name: string, share: object[]) => call('POST', '/api/v1/views', { name, share, filters: { q: '' } }, 'flt.ann@x.com')
  const toProject = (await make('For the project', [{ kind: 'project', id: p.id }])).body
  const toGroup = (await make('For the group', [{ kind: 'group', id: grp, can: 'edit' }])).body
  const toBen = (await make('For Ben', [{ kind: 'user', id: ben }])).body
  await make('Private', [])
  assert.equal(toGroup.canEdit, true)
  assert.deepEqual(await names('flt.ann@x.com'), ['For Ben', 'For the group', 'For the project', 'Private'])
  assert.deepEqual(await names('flt.pat@x.com'), ['For the project'])            // a member of the project
  assert.deepEqual(await names('flt.ben@x.com'), ['For Ben', 'For the group'])     // in the group, and named
  assert.deepEqual(await names('flt.other@x.com'), [])
  // edit rights: Ben edits the group's view, not the one shared with him to view; nobody but its owner reshares it
  assert.equal((await call('PATCH', `/api/v1/views/${toGroup.id}`, { name: 'Renamed by Ben' }, 'flt.ben@x.com')).status, 200)
  assert.equal((await call('PATCH', `/api/v1/views/${toBen.id}`, { name: 'Nope' }, 'flt.ben@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/views/${toGroup.id}`, { shared: true }, 'flt.ben@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/views/${toGroup.id}`, undefined, 'flt.ben@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/views/${toBen.id}`, { name: 'x' }, 'flt.other@x.com')).status, 404)
  assert.equal((await call('POST', '/api/v1/views', { name: 'bad', share: [{ kind: 'user', id: '0192f0c0-0000-7000-8000-000000000000' }], filters: {} }, 'flt.ann@x.com')).status, 400)
  // Ann leaves: her shared views show in Administration, and an admin gives one to Pat
  await pool.query('update users set active = false where id = $1', [ann])
  const admin = (await call('GET', '/api/v1/admin/views')).body
  assert.ok(admin.some((v: any) => v.id === toProject.id && v.ownerActive === false))
  assert.equal((await call('PATCH', `/api/v1/views/${toProject.id}`, { ownerId: ann })).status, 400)    // not to someone inactive
  const given = await call('PATCH', `/api/v1/views/${toProject.id}`, { ownerId: pat })
  assert.deepEqual([given.status, given.body.ownerId], [200, pat])
  assert.ok((await call('GET', '/api/v1/audit?action=view.owner')).body.items.length)
  await pool.query('update users set active = true where id = $1', [ann])
})

test('JQL search: fields by name, custom fields, AND/OR/NOT, lists, empties, dates, functions, ORDER BY; mistakes are 400s', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Queried', key: 'JQL', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  await join('JQL', 'jql.ann@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'jql.ann@x.com')).body.id
  const [{ id: team }] = (await pool.query(`insert into field_defs (project_id, name, kind) values ($1, 'Team', 'text') returning id`, [p.id])).rows
  const [{ id: pts }] = (await pool.query(`insert into field_defs (project_id, name, kind) values ($1, 'Risk', 'number') returning id`, [p.id])).rows
  const api = (await call('POST', '/api/v1/projects/JQL/components', { name: 'API' })).body
  const mk = async (title: string, b: object) => (await call('POST', '/api/v1/projects/JQL/issues', { title, ...b })).body
  const a = await mk('Login fails', { type: 'bug', priority: 'urgent', assigneeId: ann, labels: ['auth'], custom: { [team]: 'Core', [pts]: 8 }, componentIds: [api.id], dueDate: '2026-01-01' })
  const b = await mk('Write docs', { type: 'task', priority: 'low', custom: { [team]: 'Docs', [pts]: 2 } })
  const c = await mk('Fix payout', { type: 'bug', priority: 'high', assigneeId: ann, statusId: doing.id })
  const d = await mk('Shipped thing', { type: 'story', priority: 'medium', statusId: done.id })
  const keys = async (jql: string) => {
    const r = await call('GET', `/api/v1/search?jql=${encodeURIComponent(jql)}&limit=50`)
    assert.equal(r.status, 200, `${jql}: ${JSON.stringify(r.body)}`)
    return r.body.items.map((i: any) => i.key).filter((k: string) => k.startsWith('JQL-'))
  }
  const sorted = async (jql: string) => (await keys(jql)).sort()
  assert.deepEqual(await sorted('project = JQL'), [a.key, b.key, c.key, d.key].sort())             // JQL replaces the "open only" default
  assert.deepEqual(await sorted('project = JQL AND type = Bug AND assignee = "jql.ann@x.com"'), [a.key, c.key].sort())
  assert.deepEqual(await sorted('project = JQL AND (priority = urgent OR status = "In progress") AND NOT labels = auth'), [c.key])
  assert.deepEqual(await sorted('project = JQL AND priority in (low, medium) AND statusCategory != Done'), [b.key])
  assert.deepEqual(await sorted('project = JQL AND Team = core'), [a.key])                          // custom field by name, any case
  assert.deepEqual(await sorted(`project = JQL AND cf[${pts}] > 5`), [a.key])
  assert.deepEqual(await sorted('project = JQL AND Risk <= 2'), [b.key])
  assert.deepEqual(await sorted('project = JQL AND assignee is empty AND statusCategory = "To Do"'), [b.key])
  assert.deepEqual(await sorted('project = JQL AND component = API'), [a.key])
  assert.deepEqual(await sorted('project = JQL AND duedate < now()'), [a.key])
  assert.deepEqual(await sorted('project = JQL AND created > -1d AND summary ~ "fix"'), [c.key])
  assert.deepEqual(await sorted('project = JQL AND assignee = currentUser()', ), [])
  assert.deepEqual(await sorted('project = JQL AND assignee != "jql.ann@x.com"'), [])               // as in Jira: empty matches neither
  // ORDER BY, and paging through it
  assert.deepEqual(await keys('project = JQL ORDER BY priority DESC'), [a.key, c.key, d.key, b.key])
  const p1 = await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = JQL ORDER BY priority DESC')}&limit=3`)
  const p2 = await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = JQL ORDER BY priority DESC')}&limit=3&cursor=${p1.body.next}`)
  assert.deepEqual([...p1.body.items, ...p2.body.items].map((i: any) => i.key), [a.key, c.key, d.key, b.key])
  // the export follows the query and its order
  const csv = (await app.inject({ method: 'GET', url: `/api/v1/search/export.csv?jql=${encodeURIComponent('project = JQL AND type = bug ORDER BY priority ASC')}`, headers: await bearer('owner@x.com') })).body
  assert.ok(csv.indexOf('Fix payout') < csv.indexOf('Login fails') && csv.indexOf('Login fails') > 0)
  // mistakes are explained
  const bad = async (jql: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(jql)}`)).body.error as string
  assert.match(await bad('status = '), /Expected a value \(at character 9\)/)
  assert.match(await bad('Colour = red'), /no field called “colour”/)
  assert.match(await bad('due < tomorrowish'), /isn’t a date/)
  assert.match(await bad('summary = x'), /search summary with ~/)
  // another person sees only their projects' items, whatever the query
  assert.deepEqual(await (async () => (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = JQL')}`, undefined, 'jql.out@x.com')).body.items)(), [])
})

test('automation audit log: every run is recorded; a failing rule undoes only itself and tells its owner; a dry run changes nothing', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Audited', key: 'AAL', template: 'kanban' })
  await join('AAL', 'aal.admin@x.com', 'admin'); await join('AAL', 'aal.member@x.com')
  const good = (await call('POST', '/api/v1/projects/AAL/rules', { name: 'Triage', trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'new' }, { kind: 'assign', to: '0192f0c0-0000-7000-8000-000000000000' }] }, 'aal.admin@x.com')).body
  const bad = (await call('POST', '/api/v1/projects/AAL/rules', { name: 'Broken', trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'bogus' }] }, 'aal.admin@x.com')).body
  assert.equal(bad.ownerId, (await call('GET', '/api/v1/me', undefined, 'aal.admin@x.com')).body.id)
  // the edit that triggers them saves; the broken rule's change is undone, the good one's stays
  const i = await call('POST', '/api/v1/projects/AAL/issues', { title: 'Watched', priority: 'low' })
  assert.equal(i.status, 201)
  const now = (await call('GET', `/api/v1/issues/${i.body.key}`)).body
  assert.deepEqual([now.labels, now.priority], [['new'], 'low'])
  // the audit log: one run each, with what every action did
  const runs = (await call('GET', '/api/v1/projects/AAL/automation/runs')).body
  const triage = runs.find((r: any) => r.ruleId === good.id), broken = runs.find((r: any) => r.ruleId === bad.id)
  assert.equal(triage.result, 'some_skipped')
  assert.deepEqual(triage.steps.map((s: any) => [s.action, s.outcome]), [['label', 'done'], ['assign', 'skipped']])
  assert.equal(triage.issueKey, i.body.key)
  assert.equal(broken.result, 'failed'); assert.ok(broken.error)
  assert.deepEqual((await call('GET', `/api/v1/projects/AAL/automation/runs?result=failed`)).body.map((r: any) => r.rule), ['Broken'])
  // its owner hears about it; the rule counts the failure
  const notes = (await call('GET', '/api/v1/notifications', undefined, 'aal.admin@x.com')).body
  assert.ok(notes.some((n: any) => n.kind === 'automation' && /Broken.*failed/.test(n.text)))
  assert.equal((await call('GET', '/api/v1/projects/AAL')).body.rules.find((r: any) => r.id === bad.id).failures, 1)
  // dry run: says what would happen, changes nothing
  const dry = await call('POST', '/api/v1/projects/AAL/automation/dry-run', { issue: i.body.key, actions: [{ kind: 'priority', value: 'high' }, { kind: 'label', value: 'new' }] })
  assert.deepEqual(dry.body.steps.map((s: any) => [s.action, s.outcome]), [['priority', 'done'], ['label', 'unchanged']])
  assert.equal((await call('GET', `/api/v1/issues/${i.body.key}`)).body.priority, 'low')
  assert.ok((await call('POST', '/api/v1/projects/AAL/automation/dry-run', { issue: i.body.key, actions: [{ kind: 'priority', value: 'bogus' }] })).body.error)
  // the log and the dry run are for project admins
  assert.equal((await call('GET', '/api/v1/projects/AAL/automation/runs', undefined, 'aal.member@x.com')).status, 403)
})

test('CSV import: a dry run checks every row; the import runs as a job; running it again adds nothing twice', { skip, timeout: 60_000 }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'From CSV', key: 'CSV', template: 'kanban' })).body
  await join('CSV', 'imp.ann@x.com')
  await call('POST', '/api/v1/projects/CSV/components', { name: 'API' })
  const [{ id: team }] = (await pool.query(`insert into field_defs (project_id, name, kind, options) values ($1, 'Team', 'select', '{Core,Web}') returning id`, [p.id])).rows
  const csv = [
    'Summary,Issue Type,Status,Priority,Assignee,Labels,Story Points,Due Date,Component/s,Team',
    'Login fails,Bug,In progress,Highest,imp.ann@x.com,"auth,ui",5,01/Oct/26,API,Core',
    ',Task,To do,Low,,,,,,',
    'Docs,Story,Somewhere,Trivial,nobody@x.com,,lots,not a date,Billing,Mobile',
  ].join('\n')
  const mapping = { title: 0, type: 1, status: 2, priority: 3, assignee: 4, labels: 5, estimate: 6, dueDate: 7, components: 8, [`custom.${team}`]: 9 }
  const dry = await call('POST', '/api/v1/projects/CSV/import', { csv, mapping })
  assert.equal(dry.status, 200)
  assert.deepEqual([dry.body.rows, dry.body.ready, dry.body.skipped, dry.body.jobId], [3, 2, 1, null])
  assert.deepEqual(dry.body.report[1], { row: 3, title: '', ok: false, errors: ['No title'], warnings: [] })
  assert.deepEqual(dry.body.report[2].warnings.length, 6)                       // status, person, points, date, component, Team
  assert.equal((await call('GET', '/api/v1/search?jql=project%20%3D%20CSV')).body.items.length, 0)   // nothing yet
  // the import: a job; the items are as the file said (or empty where it said nothing usable)
  const importId = '0192f0c0-0000-7000-8000-00000000c5f1'
  const run = await call('POST', '/api/v1/projects/CSV/import', { csv, mapping, dryRun: false, importId })
  assert.equal(run.status, 202); assert.ok(run.body.jobId)
  const waitFor = async (jobId: string) => { await (await import('../src/jobs.ts')).runJobs(); return (await call('GET', `/api/v1/jobs/${jobId}`)).body }   // tests run jobs themselves
  const job = await waitFor(run.body.jobId)
  assert.equal(job.status, 'done', job.lastError)
  assert.deepEqual(job.result, { created: 2, already: 0, skipped: 1, warnings: 6 })
  const items = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = CSV ORDER BY key')}`)).body.items
  const login = (await call('GET', `/api/v1/issues/${items[0].key}`)).body
  const ann = (await call('GET', '/api/v1/me', undefined, 'imp.ann@x.com')).body.id
  assert.deepEqual([login.title, login.type, login.priority, login.assigneeId, login.labels, login.estimate, login.dueDate, login.componentIds.length, login.custom[team]],
    ['Login fails', 'bug', 'urgent', ann, ['auth', 'ui'], 5, '2026-10-01', 1, 'Core'])
  assert.equal(login.statusId, p.statuses.find((s: any) => s.name === 'In progress').id)
  // again, with the same import id: nothing new
  const again = await call('POST', '/api/v1/projects/CSV/import', { csv, mapping, dryRun: false, importId })
  assert.deepEqual((await waitFor(again.body.jobId)).result, { created: 0, already: 2, skipped: 1, warnings: 6 })
  assert.equal((await call('GET', '/api/v1/search?jql=project%20%3D%20CSV')).body.items.length, 2)
  // limits and mistakes
  assert.equal((await call('POST', '/api/v1/projects/CSV/import', { csv, mapping: { type: 1 } })).status, 400)
  await call('PUT', '/api/v1/admin/settings/searchAndBulk', { exportMaxRows: 20000, bulkMaxItems: 200, importMaxRows: 10 })
  const big = ['Title', ...Array.from({ length: 11 }, (_, n) => `row ${n}`)].join('\n')
  assert.match((await call('POST', '/api/v1/projects/CSV/import', { csv: big, mapping: { title: 0 } })).body.error, /at most 10 rows/)
  await call('PUT', '/api/v1/admin/settings/searchAndBulk', { exportMaxRows: 20000, bulkMaxItems: 200, importMaxRows: 10000 })
  await join('CSV', 'imp.viewer@x.com', 'viewer')
  assert.equal((await call('POST', '/api/v1/projects/CSV/import', { csv, mapping }, 'imp.viewer@x.com')).status, 403)
})

test('notification settings: each kind in the Inbox and/or by email; email only once an admin turns it on', { skip }, async () => {
  process.env.EMAIL_TRANSPORT = 'memory'
  const { sentEmails } = await import('../src/email.ts')
  const { runJobs } = await import('../src/jobs.ts')
  await call('POST', '/api/v1/projects', { name: 'Mailed', key: 'MAL', template: 'kanban' })
  await join('MAL', 'mal.ann@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'mal.ann@x.com')).body.id
  const prefs = (await call('GET', '/api/v1/me/notification-prefs', undefined, 'mal.ann@x.com')).body
  assert.equal(prefs.emailEnabled, false)
  assert.ok(prefs.prefs.every((p: any) => p.inbox && p.email))
  const assign = async (title: string) => { const i = (await call('POST', '/api/v1/projects/MAL/issues', { title, assigneeId: ann })).body; await runJobs(); return i }
  const inbox = async () => (await call('GET', '/api/v1/notifications', undefined, 'mal.ann@x.com')).body.map((n: any) => n.issueKey)
  // email off for the workspace: Inbox only
  const a = await assign('First')
  assert.deepEqual([await inbox(), sentEmails.length], [[a.key], 0])
  // an admin turns email on: Ann gets both
  assert.equal((await call('PUT', '/api/v1/admin/settings/email', { enabled: true, from: '', appUrl: '' })).status, 400)   // needs a sender
  await call('PUT', '/api/v1/admin/settings/email', { enabled: true, from: 'Strand <strand@example.com>', appUrl: 'https://strand.example.com' })
  const b = await assign('Second')
  assert.equal(sentEmails.length, 1)
  assert.deepEqual([sentEmails[0]!.to, sentEmails[0]!.from, sentEmails[0]!.subject], ['mal.ann@x.com', 'Strand <strand@example.com>', `[${b.key}] Second`])
  assert.match(sentEmails[0]!.text, /assigned you a work item/); assert.match(sentEmails[0]!.html, new RegExp(`https://strand.example.com/i/${b.key}`))
  // Ann: assignments by email only, not in the Inbox
  await call('PUT', '/api/v1/me/notification-prefs', { prefs: [{ kind: 'assigned', inbox: false, email: true }] }, 'mal.ann@x.com')
  const c = await assign('Third')
  assert.ok(!(await inbox()).includes(c.key)); assert.equal(sentEmails.at(-1)!.subject, `[${c.key}] Third`)
  // …then neither
  await call('PUT', '/api/v1/me/notification-prefs', { prefs: [{ kind: 'assigned', inbox: false, email: false }] }, 'mal.ann@x.com')
  const n = sentEmails.length
  await assign('Fourth')
  assert.equal(sentEmails.length, n)
  assert.deepEqual((await call('GET', '/api/v1/me/notification-prefs', undefined, 'mal.ann@x.com')).body.prefs.find((p: any) => p.kind === 'assigned'), { kind: 'assigned', inbox: false, email: false })
  // no way to send: the email waits as a failed job, nothing is lost silently
  await call('PUT', '/api/v1/me/notification-prefs', { prefs: [{ kind: 'assigned', inbox: true, email: true }] }, 'mal.ann@x.com')
  delete process.env.EMAIL_TRANSPORT
  await call('POST', '/api/v1/projects/MAL/issues', { title: 'Fifth', assigneeId: ann }); await runJobs()
  assert.match((await pool.query(`select last_error from jobs where kind = 'email.notification' order by created_at desc limit 1`)).rows[0].last_error, /No email transport/)
  await call('PUT', '/api/v1/admin/settings/email', { enabled: false, from: '', appUrl: '' })
})

test('report data: every live item and every status change in order, for people who can see the project', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Reports', key: 'REP', template: 'kanban' })).body
  const [a, b, c] = p.statuses
  const i = (await call('POST', '/api/v1/projects/REP/issues', { title: 'moves twice' })).body
  await call('POST', '/api/v1/projects/REP/issues', { title: 'never moves' })
  const gone = (await call('POST', '/api/v1/projects/REP/issues', { title: 'deleted' })).body
  await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: b.id })
  await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: c.id })
  await call('PATCH', `/api/v1/issues/${gone.key}`, { statusId: b.id })
  await call('DELETE', `/api/v1/issues/${gone.key}`)
  const r = await call('GET', '/api/v1/projects/REP/report-data')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.issues.map((x: any) => x.title).sort(), ['moves twice', 'never moves'])
  assert.deepEqual(r.body.statusChanges.map((x: any) => [x.issueId, x.fromId, x.toId]), [[i.id, a.id, b.id], [i.id, b.id, c.id]])
  await join('REP', 'rep.viewer@x.com', 'viewer')
  assert.equal((await call('GET', '/api/v1/projects/REP/report-data', undefined, 'rep.viewer@x.com')).status, 200)
  assert.equal((await call('GET', '/api/v1/projects/REP/report-data', undefined, 'rep.outsider@x.com')).status, 404)
})

test('ranking: dropping item after item into the same spot never runs out of room; the order stays exactly as placed', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Ranks', key: 'RNK', template: 'kanban' })
  const first = (await call('POST', '/api/v1/projects/RNK/issues', { title: 'first' })).body
  const last = (await call('POST', '/api/v1/projects/RNK/issues', { title: 'last' })).body
  const list = async () => (await call('GET', '/api/v1/projects/RNK/issues?limit=200')).body.items as { id: string; title: string; rank: number }[]
  const placed: string[] = []
  for (let k = 1; k <= 60; k++) {     // without rebalancing, the midpoint collides with a neighbour after about 40 of these
    const item = (await call('POST', '/api/v1/projects/RNK/issues', { title: `n${k}` })).body
    const now = (await list()).filter(x => x.id !== item.id)
    const at = now.findIndex(x => x.id === first.id)
    const rank = (now[at]!.rank + now[at + 1]!.rank) / 2           // exactly what the app does: midpoint of the neighbours
    assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { rank })).status, 200)
    placed.unshift(`n${k}`)
  }
  const final = await list()
  assert.deepEqual(final.map(x => x.title), ['first', ...placed, 'last'])
  for (let i = 1; i < final.length; i++) assert.ok(final[i]!.rank > final[i - 1]!.rank, 'ranks strictly increase')
  assert.ok(last.id)
})

test('custom fields: values must fit the field (number, option, date, text); deleting a field removes its values', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Custom', key: 'CUS', template: 'kanban' })
  const add = async (name: string, kind: string, options: string[] | null = null) =>
    (await call('POST', '/api/v1/projects/CUS/fields', { name, kind, options, position: 0 })).body.id as string
  const [team, points, due, note] = [await add('Team', 'select', ['Core', 'Web']), await add('Points', 'number'), await add('Due', 'date'), await add('Note', 'text')]
  const i = (await call('POST', '/api/v1/projects/CUS/issues', { title: 'fits', custom: { [team]: 'Core', [points]: 3, [due]: '2026-12-01', [note]: 'ok' } }))
  assert.equal(i.status, 201)
  const bad = async (custom: object) => (await call('PATCH', `/api/v1/issues/${i.body.key}`, { custom: { ...i.body.custom, ...custom } }))
  for (const custom of [{ [team]: 'Mobile' }, { [points]: 'three' }, { [due]: '1 Dec' }, { [due]: '2026-13-45' }, { [note]: 'x'.repeat(5001) }, { '00000000-0000-4000-8000-000000000000': 'x' }]) {
    const r = await bad(custom)
    assert.equal(r.status, 400, JSON.stringify(custom).slice(0, 60))
    assert.equal(r.body.code, 'invalid_input')
    assert.ok(Object.keys(r.body.errors)[0]!.startsWith('custom.'))
  }
  assert.equal((await call('POST', '/api/v1/projects/CUS/issues', { title: 'no', custom: { [team]: 'Nope' } })).status, 400)
  assert.equal((await bad({ [team]: 'Web' })).status, 200)
  // an option renamed later does not block edits to other fields
  await call('PATCH', `/api/v1/projects/CUS/fields/${team}`, { options: ['Platform', 'Web'] })
  assert.equal((await call('PATCH', `/api/v1/issues/${i.body.key}`, { title: 'still editable' })).status, 200)
  // deleting a field clears it from every item
  assert.equal((await call('DELETE', `/api/v1/projects/CUS/fields/${note}`)).status, 204)
  assert.equal(note in (await call('GET', `/api/v1/issues/${i.body.key}`)).body.custom, false)
})

test('attachments: shown only once the file has arrived; removed files leave storage, with retries, also when the item or project goes', { skip }, async () => {
  const { sweepFiles } = await import('../src/routes/files.ts')
  await call('POST', '/api/v1/projects', { name: 'Files', key: 'FIL', template: 'kanban' })
  const i = (await call('POST', '/api/v1/projects/FIL/issues', { title: 'with files' })).body
  const upload = async (name: string, bytes: number, send = bytes) => {
    const t = (await call('POST', `/api/v1/issues/${i.key}/attachments`, { name, size: bytes, type: 'text/plain' })).body
    if (send) await fetch(t.uploadUrl, { method: 'PUT', body: 'x'.repeat(send), headers: { 'content-type': 'text/plain' } })
    return t.id as string
  }
  const listed = async () => (await call('GET', `/api/v1/issues/${i.key}?expand=attachments`)).body.attachments.map((a: any) => a.name)
  const done = await upload('done.txt', 10)
  assert.equal((await call('POST', `/api/v1/attachments/${done}/complete`)).status, 200)
  const never = await upload('never.txt', 10, 0)                 // the browser never sent the bytes
  assert.equal((await call('POST', `/api/v1/attachments/${never}/complete`)).status, 409)
  const short = await upload('short.txt', 10, 4)                 // fewer bytes than registered
  assert.equal((await call('POST', `/api/v1/attachments/${short}/complete`)).status, 409)
  assert.deepEqual(await listed(), ['done.txt'])                 // only confirmed files show
  assert.equal((await call('GET', `/api/v1/attachments/${never}/url`)).status, 404)
  assert.equal((await call('GET', `/api/v1/attachments/${done}/url`)).status, 200)

  // a day later the unconfirmed ones are gone, files and rows
  await sweepFiles(Date.now() + 25 * 60 * 60_000)
  assert.equal((await pool.query('select count(*)::int as n from attachments where issue_id = $1', [i.id])).rows[0].n, 1)
  assert.equal([...objects.keys()].filter(k => k.includes(i.id)).length, 1)

  // removing: the row goes at once; if storage fails, the file stays queued and goes on a later sweep
  failDeletes = true
  assert.equal((await call('DELETE', `/api/v1/attachments/${done}`)).status, 204)
  assert.deepEqual(await listed(), [])
  assert.equal((await sweepFiles()).failed, 1)
  assert.equal([...objects.keys()].filter(k => k.includes(i.id)).length, 1)
  failDeletes = false
  assert.equal((await sweepFiles()).deleted, 1)
  assert.equal([...objects.keys()].filter(k => k.includes(i.id)).length, 0)

  // deleting the whole project takes its files out of storage too
  const j = (await call('POST', '/api/v1/projects/FIL/issues', { title: 'more files' })).body
  const t = (await call('POST', `/api/v1/issues/${j.key}/attachments`, { name: 'a.txt', size: 3, type: 'text/plain' })).body
  await fetch(t.uploadUrl, { method: 'PUT', body: 'abc' })
  await call('POST', `/api/v1/attachments/${t.id}/complete`)
  assert.equal((await call('DELETE', '/api/v1/projects/FIL')).status, 202)
  await (await import('../src/jobs.ts')).runJobs()
  await sweepFiles()
  assert.equal([...objects.keys()].filter(k => k.includes(j.id)).length, 0)
  // only the uploader confirms, and outsiders cannot see attachments at all
  assert.equal((await call('GET', `/api/v1/attachments/${t.id}/url`, undefined, 'files.outsider@x.com')).status, 404)
})

test('due reminders: many requests at once (as from several API pods) still make one reminder per item and due date', { skip }, async () => {
  const who = 'due.burst@x.com'
  const me = (await call('GET', '/api/v1/me', undefined, who)).body
  await call('POST', '/api/v1/projects', { name: 'Burst', key: 'BST', template: 'kanban' })
  await join('BST', who)
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  await call('POST', '/api/v1/projects/BST/issues', { title: 'soon', assigneeId: me.id, dueDate: tomorrow })
  // each pod throttles reminders in its own memory, so several can try at once; the database keeps one
  await Promise.all(Array.from({ length: 5 }, () => call('GET', '/api/v1/notifications', undefined, who)))
  const dup = pool.query(`insert into notifications (user_id, issue_id, kind, text) select user_id, issue_id, kind, text from notifications where user_id = $1 and kind = 'due'`, [me.id])
  await assert.rejects(dup, /notifications_due_once/)                      // the database refuses a second one
  assert.equal((await pool.query(`select count(*)::int as n from notifications where user_id = $1 and kind = 'due'`, [me.id])).rows[0].n, 1)
})

test('audit log: who changed people, settings, workflow and deletions is recorded; only admins read it; nobody can change it', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Audited', key: 'AUD', template: 'kanban' })).body
  await join('AUD', 'aud.admin@x.com', 'admin')
  const memberId = (await call('GET', '/api/v1/me', undefined, 'aud.member@x.com')).body.id
  await call('POST', '/api/v1/projects/AUD/members', { userIds: [memberId], role: 'member' }, 'aud.admin@x.com')
  await call('PATCH', `/api/v1/projects/AUD/members/${memberId}`, { role: 'viewer' }, 'aud.admin@x.com')
  await call('PATCH', '/api/v1/projects/AUD', { name: 'Audited 2' }, 'aud.admin@x.com')
  await call('PATCH', '/api/v1/projects/AUD', { boardPrefs: { groupBy: 'none' } }, 'aud.admin@x.com')       // presentation only: not recorded
  await call('POST', '/api/v1/projects/AUD/transitions', { name: 'Start', fromIds: [p.statuses[0].id], toId: p.statuses[1].id }, 'aud.admin@x.com')
  const i = (await call('POST', '/api/v1/projects/AUD/issues', { title: 'to delete' })).body
  await call('DELETE', `/api/v1/issues/${i.key}`, undefined, 'aud.admin@x.com')
  await call('DELETE', `/api/v1/projects/AUD/members/${memberId}`, undefined, 'aud.admin@x.com')

  const log = (await call('GET', '/api/v1/audit?project=AUD', undefined, 'aud.admin@x.com'))
  assert.equal(log.status, 200)
  const actions = log.body.items.map((x: any) => x.action).reverse()
  assert.deepEqual(actions, ['project.created', 'project.member.added', 'project.member.role_changed', 'project.updated',
    'project.transition.created', 'issue.deleted', 'project.member.removed'])
  const role = log.body.items.find((x: any) => x.action === 'project.member.role_changed')
  assert.deepEqual([role.actor, role.target, role.before, role.after], ['aud.admin@x.com', 'aud.member@x.com', { role: 'member' }, { role: 'viewer' }])
  assert.deepEqual(log.body.items.find((x: any) => x.action === 'project.updated').after, { name: 'Audited 2' })

  // who may read it
  assert.equal((await call('GET', '/api/v1/audit')).status, 200)                                                  // workspace owner: everything
  assert.equal((await call('GET', '/api/v1/audit', undefined, 'aud.admin@x.com')).status, 403)                     // project admin: only with project
  await join('AUD', 'aud.plain@x.com', 'member')
  assert.equal((await call('GET', '/api/v1/audit?project=AUD', undefined, 'aud.plain@x.com')).status, 403)
  assert.equal((await call('GET', '/api/v1/audit?project=AUD', undefined, 'aud.outsider@x.com')).status, 404)
  assert.ok((await call('GET', '/api/v1/audit?action=project.member')).body.items.every((x: any) => x.action.startsWith('project.member')))

  // append-only, and it outlives the project
  await assert.rejects(pool.query(`update audit_log set actor = 'someone else'`), /can only be added to/)
  await assert.rejects(pool.query('delete from audit_log'), /can only be added to/)
  await call('DELETE', '/api/v1/projects/AUD')
  await (await import('../src/jobs.ts')).runJobs()
  const all = (await call('GET', '/api/v1/audit?action=project.deleted')).body.items
  assert.equal(all[0].projectKey, 'AUD')
  assert.equal(all[0].after.items, 1)
})

test('jobs: run once each, retry with growing waits, give up after the limit, survive a crashed worker, never run twice at once', { skip }, async () => {
  const { registerJob, enqueue, runJobs, backoffMs } = await import('../src/jobs.ts')
  const { db } = await import('../src/db.ts')
  const ran: string[] = []
  let flaky = 0
  registerJob('test.ok', async p => { ran.push(p.n); return { doubled: p.n * 2 } })
  registerJob('test.flaky', async () => { if (++flaky < 3) throw new Error(`try ${flaky}`); return 'finally' })
  registerJob('test.broken', async () => { throw new Error('always') })
  const row = async (id: string) => (await pool.query('select status, attempts, result, last_error from jobs where id = $1', [id])).rows[0]
  const due = (id: string) => pool.query(`update jobs set run_at = now() where id = $1`, [id])   // skip the wait

  const ok = await enqueue(db, 'test.ok', { n: 21 })
  assert.equal(await enqueue(db, 'test.ok', { n: 1 }, { dedupeKey: 'once' }), await enqueue(db, 'test.ok', { n: 1 }, { dedupeKey: 'once' }))
  await runJobs()
  assert.deepEqual(await row(ok), { status: 'done', attempts: 1, result: { doubled: 42 }, last_error: null })
  assert.equal(ran.filter(x => x === 1 as any).length, 1)                 // the deduplicated job ran once

  const flakyId = await enqueue(db, 'test.flaky', {})
  await runJobs()
  assert.deepEqual([(await row(flakyId)).status, (await row(flakyId)).last_error], ['queued', 'try 1'])
  await runJobs(); assert.equal((await row(flakyId)).attempts, 1)          // not due yet: it waits before retrying
  await due(flakyId); await runJobs(); await due(flakyId); await runJobs()
  assert.deepEqual([(await row(flakyId)).status, (await row(flakyId)).result], ['done', 'finally'])
  assert.deepEqual([backoffMs(1), backoffMs(2), backoffMs(20)], [10_000, 20_000, 3_600_000])

  const broken = await enqueue(db, 'test.broken', {}, { maxAttempts: 2 })
  await runJobs(); await due(broken); await runJobs(); await due(broken); await runJobs()
  assert.deepEqual([(await row(broken)).status, (await row(broken)).attempts], ['failed', 2])

  // a worker died while running it: the lease runs out and another worker picks it up
  const orphan = await enqueue(db, 'test.ok', { n: 7 })
  await pool.query(`update jobs set status = 'running', attempts = 1, locked_until = now() - interval '1 second' where id = $1`, [orphan])
  await runJobs()
  assert.deepEqual([(await row(orphan)).status, (await row(orphan)).attempts], ['done', 2])

  // several runners at once (as on several pods): each job runs exactly once
  const runs = new Map<number, number>()
  registerJob('test.count', async p => { runs.set(p.n, (runs.get(p.n) ?? 0) + 1) })
  for (let n = 0; n < 40; n++) await enqueue(db, 'test.count', { n })
  await Promise.all(Array.from({ length: 12 }, () => runJobs(100)))
  assert.equal(runs.size, 40)
  assert.deepEqual([...runs.values()].filter(c => c !== 1), [])                 // none ran twice
})

test('project backups: deleting backs up everything first, restore brings it all back; admins choose whether and where', { skip }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const p = (await call('POST', '/api/v1/projects', { name: 'Backed up', key: 'BAK', template: 'scrum' })).body
  await join('BAK', 'bak.member@x.com')
  const member = (await call('GET', '/api/v1/me', undefined, 'bak.member@x.com')).body.id
  await call('POST', '/api/v1/projects/BAK/fields', { name: 'Team', kind: 'select', options: ['Core'], position: 0 })
  const field = (await call('GET', '/api/v1/projects/BAK')).body.fields[0].id
  const epic = (await call('POST', '/api/v1/projects/BAK/issues', { title: 'Epic', type: 'epic' })).body
  const child = (await call('POST', '/api/v1/projects/BAK/issues', { title: 'Child', parentId: epic.id, assigneeId: member, custom: { [field]: 'Core' } })).body
  await call('PATCH', `/api/v1/issues/${child.key}`, { statusId: p.statuses[1].id })
  await call('POST', `/api/v1/issues/${child.key}/comments`, { body: 'keep this' })
  await call('POST', `/api/v1/issues/${child.key}/worklogs`, { minutes: 30, date: '2026-10-01' })
  await call('POST', `/api/v1/issues/${child.key}/links`, { type: 'blocks', targetKey: epic.key })
  const t = (await call('POST', `/api/v1/issues/${child.key}/attachments`, { name: 'spec.txt', size: 5, type: 'text/plain' })).body
  await fetch(t.uploadUrl, { method: 'PUT', body: 'hello' })
  await call('POST', `/api/v1/attachments/${t.id}/complete`)

  // only a workspace admin deletes; the project vanishes at once, for everyone, while the backup runs
  assert.equal((await call('DELETE', '/api/v1/projects/BAK', undefined, 'bak.member@x.com')).status, 403)
  const del = await call('DELETE', '/api/v1/projects/BAK')
  assert.equal(del.status, 202)
  assert.equal((await call('GET', '/api/v1/projects/BAK')).status, 404)
  assert.equal((await call('GET', `/api/v1/issues/${child.key}`, undefined, 'bak.member@x.com')).status, 404)
  assert.ok(!(await call('GET', '/api/v1/projects')).body.some((x: any) => x.key === 'BAK'))
  await runJobs()
  assert.equal((await call('GET', `/api/v1/jobs/${del.body.jobId}`)).body.status, 'done')
  assert.equal((await pool.query(`select count(*)::int as n from projects where key = 'BAK'`)).rows[0].n, 0)

  // the backup: listed, downloadable, and holds every part of the project
  const b = (await call('GET', '/api/v1/admin/project-backups')).body.find((x: any) => x.projectKey === 'BAK')
  assert.deepEqual([b.items, b.files, b.restoredAt], [2, 1, null])
  const doc = JSON.parse(objects.get(`files/${b.objectKey}`)!.toString())
  assert.deepEqual(Object.fromEntries(['issues', 'comments', 'worklogs', 'issue_links', 'attachments', 'field_defs', 'project_members'].map(k => [k, doc.tables[k].length])),
    { issues: 2, comments: 1, worklogs: 1, issue_links: 1, attachments: 1, field_defs: 1, project_members: 2 })
  assert.ok(doc.tables.activity.some((a: any) => a.field === 'statusId'))
  assert.equal(objects.get(`files/${b.objectKey.replace('project.json', `files/${t.id}`)}`)!.toString(), 'hello')
  assert.equal((await call('GET', `/api/v1/admin/project-backups/${b.id}/url`)).status, 200)
  assert.equal((await call('GET', '/api/v1/admin/project-backups', undefined, 'bak.member@x.com')).status, 403)

  // the original file is removed from storage like any deleted attachment; the backup copy stays
  await (await import('../src/routes/files.ts')).sweepFiles()

  // a changed backup document is refused, whoever changed it
  const docKey = `files/${b.objectKey}`, original = objects.get(docKey)!
  const evil = JSON.parse(original.toString()); evil.tables.projects[0].workspace_id = '00000000-0000-4000-8000-000000000000'
  objects.set(docKey, Buffer.from(JSON.stringify(evil)))
  const r = await call('POST', `/api/v1/admin/project-backups/${b.id}/restore`)
  assert.equal(r.status, 202)
  await runJobs()
  const tampered = (await call('GET', `/api/v1/jobs/${r.body.jobId}`)).body
  assert.equal(tampered.status, 'queued'); assert.match(tampered.lastError, /changed since it was written/)
  assert.equal((await call('GET', '/api/v1/projects/BAK')).status, 404)
  // put the real document back: the retry restores it
  objects.set(docKey, original)
  await pool.query('update jobs set run_at = now() where id = $1', [r.body.jobId])
  await runJobs()
  // a workspace admin cannot send backups to a bucket the operators did not allow
  assert.equal((await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: true, bucket: 'someone-elses-bucket' })).status, 400)
  process.env.BACKUP_BUCKETS = 'files,team-backups'
  assert.equal((await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: true, bucket: 'team-backups' })).body.effectiveBucket, 'team-backups')
  await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: true })
  delete process.env.BACKUP_BUCKETS

  // restore: same keys, history, people, files
  assert.equal((await call('GET', `/api/v1/jobs/${r.body.jobId}`)).body.status, 'done')
  const back = (await call('GET', `/api/v1/issues/${child.key}?expand=comments,activity,worklogs,links,attachments`, undefined, 'bak.member@x.com')).body
  assert.deepEqual([back.title, back.parentId, back.assigneeId, back.statusId, back.custom[field]], ['Child', epic.id, member, p.statuses[1].id, 'Core'])
  assert.deepEqual([back.comments.length, back.worklogs.length, back.links.length, back.attachments.length], [1, 1, 1, 1])
  assert.ok(back.activity.some((a: any) => a.field === 'statusId'))
  assert.equal((await call('POST', `/api/v1/attachments/${t.id}/complete`)).status, 200)    // the file is back where it was
  assert.equal((await call('POST', `/api/v1/admin/project-backups/${b.id}/restore`)).status, 409)
  assert.ok((await call('GET', '/api/v1/audit?action=project.')).body.items.some((x: any) => x.action === 'project.restored_from_backup'))

  // settings: off means deleting removes the project without a backup; on with nowhere to put it is refused
  assert.equal((await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: false }, 'bak.member@x.com')).status, 403)
  assert.equal((await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: false })).body.enabled, false)
  assert.equal((await call('DELETE', '/api/v1/projects/BAK')).status, 202)
  await runJobs()
  assert.equal((await call('GET', '/api/v1/admin/project-backups')).body.filter((x: any) => x.projectKey === 'BAK').length, 1)
  await call('PUT', '/api/v1/admin/settings/project-backups', { enabled: true })
  const saved = process.env.S3_BUCKET; process.env.S3_BUCKET = ''
  await call('POST', '/api/v1/projects', { name: 'Nowhere', key: 'NOWH', template: 'kanban' })
  assert.equal((await call('DELETE', '/api/v1/projects/NOWH')).status, 409)
  process.env.S3_BUCKET = saved
})

test('resolution: set when an item reaches Done (by any route), kept while done, cleared when reopened', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Resolved', key: 'RES', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  const get = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body
  const a = (await call('POST', '/api/v1/projects/RES/issues', { title: 'a' })).body
  assert.deepEqual([a.resolution, a.resolvedAt], [null, null])
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { resolution: "Won't do" })).status, 400)   // not finished yet

  const fin = (await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done.id })).body
  assert.equal(fin.resolution, 'Done'); assert.ok(fin.resolvedAt)
  const changed = (await call('PATCH', `/api/v1/issues/${a.key}`, { resolution: "Won't do" })).body
  assert.deepEqual([changed.resolution, changed.resolvedAt], ["Won't do", fin.resolvedAt])           // the date stays
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { resolution: 'Fixed?' })).status, 400)
  const reopened = (await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: todo.id })).body
  assert.deepEqual([reopened.resolution, reopened.resolvedAt], [null, null])
  // finishing with a resolution in one edit
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done.id, resolution: 'Duplicate' })).body.resolution, 'Duplicate')

  // bulk edits and automation go through the same rule
  const b = (await call('POST', '/api/v1/projects/RES/issues', { title: 'b' })).body
  await call('POST', '/api/v1/issues/bulk/edit', { issues: [b.key], patch: { statusId: done.id } })
  assert.equal((await get(b.key)).resolution, 'Done')
  await call('POST', '/api/v1/projects/RES/rules', { name: 'Close on start', trigger: { kind: 'status', to: doing.id }, actions: [{ kind: 'status', value: done.id }] })
  const c = (await call('POST', '/api/v1/projects/RES/issues', { title: 'c' })).body
  await call('PATCH', `/api/v1/issues/${c.key}`, { statusId: doing.id })
  assert.deepEqual([(await get(c.key)).statusId, (await get(c.key)).resolution], [done.id, 'Done'])

  // turning a status into a Done one resolves what is in it (and back)
  const d = (await call('POST', '/api/v1/projects/RES/issues', { title: 'd', statusId: todo.id })).body
  await call('PATCH', `/api/v1/projects/RES/statuses/${todo.id}`, { category: 'done' })
  assert.equal((await get(d.key)).resolution, 'Done')
  await call('PATCH', `/api/v1/projects/RES/statuses/${todo.id}`, { category: 'todo' })
  assert.equal((await get(d.key)).resolution, null)
  // the change of resolution is in the item's history
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and field = 'resolution'`, [a.id])).rows.length)
})

test('CSV export: the same items the search shows (only what you can see), readable names, safe cells, audited', { skip }, async () => {
  const { csvCell } = await import('../src/routes/misc.ts')
  assert.deepEqual(['plain', 'a,b', 'say "hi"', 'two\nlines', '=SUM(A1)', '+1', '-2', '@x', null, ['a', 'b']].map(csvCell),
    ['plain', '"a,b"', '"say ""hi"""', '"two\nlines"', "'=SUM(A1)", "'+1", "'-2", "'@x", '', '"a, b"'])
  await call('POST', '/api/v1/projects', { name: 'Exported', key: 'EXP', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Hidden', key: 'HID', template: 'kanban' })
  await join('EXP', 'exp.member@x.com')
  const me = (await call('GET', '/api/v1/me', undefined, 'exp.member@x.com')).body
  await call('POST', '/api/v1/projects/EXP/issues', { title: 'Plain row', assigneeId: me.id, labels: ['red', 'blue'] })
  await call('POST', '/api/v1/projects/EXP/issues', { title: '=HYPERLINK("http://evil")', description: 'line one\nline, two' })
  await call('POST', '/api/v1/projects/HID/issues', { title: 'Not for exp.member' })

  const r = await app.inject({ method: 'GET', url: '/api/v1/search/export.csv?resolution=all', headers: await bearer('exp.member@x.com') })
  assert.equal(r.statusCode, 200)
  assert.match(String(r.headers['content-type']), /text\/csv/)
  assert.match(String(r.headers['content-disposition']), /attachment; filename="strand-export-\d{4}-\d{2}-\d{2}\.csv"/)
  const body = r.body.replace(/^﻿/, '')
  assert.ok(body.startsWith('Key,Project,Type,Title,Status,Priority,Assignee,'))
  assert.ok(body.includes(`,Plain row,To do,none,${me.name},`))
  assert.ok(body.includes('"red, blue"'))
  assert.ok(body.includes(`"'=HYPERLINK(""http://evil"")"`))         // stays text in a spreadsheet
  assert.ok(body.includes('"line one\nline, two"'))
  assert.ok(!body.includes('Not for exp.member'))                     // nothing from a project you cannot see
  const searched = (await call('GET', '/api/v1/search?resolution=all&limit=200', undefined, 'exp.member@x.com')).body.items.length
  assert.equal(body.trim().split('\r\n').length - 1, searched)          // one row per search result
  const log = (await call('GET', '/api/v1/audit?action=export.csv')).body.items[0]
  assert.deepEqual([log.actor, log.after.rows], ['exp.member@x.com', searched])
})

test('administration: workspace admins list everyone with role, status and project count; others cannot', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Admin view', key: 'ADV', template: 'kanban' })
  await join('ADV', 'adv.member@x.com')
  await call('GET', '/api/v1/me', undefined, 'adv.gone@x.com')
  await pool.query(`update users set active = false where email = 'adv.gone@x.com'`)
  const r = await call('GET', '/api/v1/admin/users')
  assert.equal(r.status, 200)
  const by = Object.fromEntries(r.body.map((u: any) => [u.email, u]))
  assert.deepEqual([by['adv.member@x.com'].role, by['adv.member@x.com'].active, by['adv.member@x.com'].projects], ['member', true, 1])
  assert.equal(by['adv.gone@x.com'].active, false)
  assert.equal(by['owner@x.com'].role, 'owner')
  assert.equal((await call('GET', '/api/v1/admin/users', undefined, 'adv.member@x.com')).status, 403)
})

test('groups: SCIM provisions teams; a project role given to a group reaches everyone in it, and goes when they leave', { skip }, async () => {
  const scim = (method: string, path: string, body?: unknown) =>
    app.inject({ method: method as any, url: `/scim/v2${path}`, payload: body as any, headers: { authorization: 'Bearer scim-secret', 'content-type': 'application/scim+json' } })
  await call('GET', '/api/v1/me')   // the workspace owner signs in first (the first person on an empty system becomes its owner)
  const id = async (who: string) => (await call('GET', '/api/v1/me', undefined, `${who}@x.com`)).body.id as string
  const [ann, ben, cat] = [await id('grp.ann'), await id('grp.ben'), await id('grp.cat')]
  const made = await scim('POST', '/Groups', { displayName: 'Payments team', externalId: 'entra-group-1', members: [{ value: ann }, { value: ben }] })
  assert.equal(made.statusCode, 201)
  const g = JSON.parse(made.body)
  assert.deepEqual(g.members.map((m: any) => m.value).sort(), [ann, ben].sort())
  assert.equal(JSON.parse((await scim('GET', '/Groups?filter=displayName eq "Payments team"')).body).totalResults, 1)

  await call('POST', '/api/v1/projects', { name: 'Grouped', key: 'GRP', template: 'kanban' })
  await call('POST', '/api/v1/projects/GRP/issues', { title: 'team work' })
  assert.equal((await call('GET', '/api/v1/issues/GRP-1', undefined, 'grp.ann@x.com')).status, 404)
  assert.equal((await call('GET', '/api/v1/groups/search?query=payments')).body[0].members, 2)
  assert.equal((await call('POST', '/api/v1/projects/GRP/groups', { groupId: g.id, role: 'member' })).status, 200)

  // everyone in the group can now work in the project; the person outside cannot
  assert.equal((await call('PATCH', '/api/v1/issues/GRP-1', { title: 'edited by ann' }, 'grp.ann@x.com')).status, 200)
  assert.equal((await call('GET', '/api/v1/issues/GRP-1', undefined, 'grp.cat@x.com')).status, 404)
  assert.ok((await call('GET', '/api/v1/projects', undefined, 'grp.ben@x.com')).body.some((p: any) => p.key === 'GRP'))
  assert.equal((await call('PATCH', '/api/v1/issues/GRP-1', { assigneeId: ben })).status, 200)          // assignable through the group
  // a person's own role and their group's: the higher one counts
  await join('GRP', 'grp.ann@x.com', 'viewer')
  assert.equal((await call('GET', '/api/v1/projects/GRP', undefined, 'grp.ann@x.com')).body.role, 'member')

  // Entra adds cat and removes ben
  assert.equal((await scim('PATCH', `/Groups/${g.id}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: cat }] }, { op: 'Remove', path: `members[value eq "${ben}"]` }] })).statusCode, 204)   // Entra's remove has no value
  assert.equal((await call('GET', '/api/v1/issues/GRP-1', undefined, 'grp.cat@x.com')).status, 200)
  assert.equal((await call('GET', '/api/v1/issues/GRP-1', undefined, 'grp.ben@x.com')).status, 404)

  // a group can be the only admin route, and the last one cannot be removed
  await call('PATCH', `/api/v1/projects/GRP/groups/${g.id}`, { role: 'admin' })
  await pool.query(`delete from project_members where project_id = (select id from projects where key = 'GRP') and role = 'admin'`)
  assert.equal((await call('DELETE', `/api/v1/projects/GRP/groups/${g.id}`)).status, 409)
  assert.equal((await call('PATCH', `/api/v1/projects/GRP/groups/${g.id}`, { role: 'viewer' })).status, 409)
  assert.equal((await call('POST', '/api/v1/projects/GRP/groups', { groupId: g.id, role: 'admin' }, 'grp.cat@x.com')).status, 200)   // cat is an admin through the group
  // the changes are audited; deleting the group in Entra takes everyone's access away
  const actions = (await call('GET', '/api/v1/audit?action=project.group')).body.items.map((x: any) => x.action)
  assert.ok(actions.includes('project.group.added') && actions.includes('project.group.role_changed'))
  await join('GRP', 'grp.keeper@x.com', 'admin')
  assert.equal((await scim('DELETE', `/Groups/${g.id}`)).statusCode, 204)
  assert.equal((await call('GET', '/api/v1/issues/GRP-1', undefined, 'grp.cat@x.com')).status, 404)
  assert.equal((await call('GET', '/api/v1/projects/GRP', undefined, 'grp.ann@x.com')).body.role, 'viewer')    // her own role remains
})

// ── Permission matrix: every documented route, with who must be refused. A new route fails this test until it has a row. ──
test('permission matrix: every API route refuses outsiders, and refuses viewers and members where it should', { skip, timeout: 120_000 }, async () => {
  const { db } = await import('../src/db.ts')
  const { enqueue } = await import('../src/jobs.ts')
  const who = { viewer: 'mtx.viewer@x.com', member: 'mtx.member@x.com', outsider: 'mtx.outsider@x.com' }
  const id = async (e: string) => (await call('GET', '/api/v1/me', undefined, e)).body.id as string
  // A project the owner runs, with one of everything
  const p = (await call('POST', '/api/v1/projects', { name: 'Matrix', key: 'MTX', template: 'scrum' })).body
  await join('MTX', who.viewer, 'viewer'); await join('MTX', who.member, 'member')
  const viewerId = await id(who.viewer)
  await id(who.outsider)
  const ownerId = await id('owner@x.com')
  const make = async (kind: string, body: object) => (await call('POST', `/api/v1/projects/MTX/${kind}`, body)).body.id as string
  const status = await make('statuses', { name: 'Extra', color: '#000000', category: 'todo' })
  const transition = await make('transitions', { name: 'Go', fromIds: null, toId: p.statuses[1].id })
  const field = await make('fields', { name: 'Team', kind: 'text', options: null, position: 0 })
  const template = await make('templates', { name: 'Bug', type: 'bug', title: 'Bug:' })
  const rule = await make('rules', { name: 'Rule', trigger: { kind: 'created' }, actions: [] })
  const release = await make('releases', { name: '1.0' })
  const component = await make('components', { name: 'Matrix component' })
  const sprint = await make('sprints', { name: 'Sprint' })
  for (const t of ['one', 'two', 'three']) await call('POST', '/api/v1/projects/MTX/issues', { title: t })
  await call('DELETE', '/api/v1/issues/MTX-2')                                         // a deleted item, to restore
  const comment = (await call('POST', '/api/v1/issues/MTX-1/comments', { body: 'mine' })).body.id
  const worklog = (await call('POST', '/api/v1/issues/MTX-1/worklogs', { minutes: 5, date: '2026-10-01' })).body.id
  const ticket = (await call('POST', '/api/v1/issues/MTX-1/attachments', { name: 'a.txt', size: 1, type: 'text/plain' })).body
  await fetch(ticket.uploadUrl, { method: 'PUT', body: 'a' }); await call('POST', `/api/v1/attachments/${ticket.id}/complete`)
  const group = (await pool.query(`insert into groups (display_name) values ('Matrix team') returning id`)).rows[0].id
  await call('POST', '/api/v1/projects/MTX/groups', { groupId: group, role: 'viewer' })
  const view = (await call('POST', '/api/v1/views', { name: 'Mine', filters: {} })).body.id
  const token = (await call('POST', '/api/v1/me/tokens', { name: 'mine' })).body.id
  const notification = (await pool.query(
    `insert into notifications (user_id, issue_id, kind, text) select $1, i.id, 'assigned', 'matrix' from issues i join projects p on p.id = i.project_id where p.key = 'MTX' limit 1 returning id`, [ownerId])).rows[0].id
  const job = await enqueue(db, 'matrix.noop', {}, { workspaceId: p.workspaceId, createdBy: ownerId })
  const backup = (await pool.query(`insert into project_backups (workspace_id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, sha256)
    values ($1, gen_random_uuid(), 'OLD', 'Old', 'files', 'x/project.json', 0, 0, 0, 'x') returning id`, [p.workspaceId])).rows[0].id

  // Who must be refused:
  //   any    - anyone signed in (results are limited to what they may see); only a missing sign-in is refused
  //   read   - project viewers; outsiders get 404 (the project does not exist for them)
  //   viewer - viewers may do it too (comment, watch, star…); outsiders 404
  //   write  - members; viewers 403; outsiders 404
  //   padmin - project admins; members and viewers 403; outsiders 404
  //   gadmin - workspace admins; everyone else 403
  //   own    - only the person it belongs to; others 403 or 404
  type Rule = 'any' | 'read' | 'viewer' | 'write' | 'padmin' | 'gadmin' | 'own'
  const K = 'MTX', I = 'MTX-1'
  const M: Record<string, [Rule, string, object?]> = {
    'GET /me': ['any', '/me'], 'GET /users': ['any', '/users'], 'GET /users/search': ['any', '/users/search'],
    'GET /projects': ['any', '/projects'], 'POST /projects': ['any', '/projects', { name: 'M', key: 'MTXNEW', template: 'kanban' }],
    'GET /projects/search': ['any', '/projects/search'],
    'POST /projects/{key}/archive': ['padmin', `/projects/${K}/archive`], 'POST /projects/{key}/restore': ['padmin', `/projects/${K}/restore`],
    'GET /projects/{key}': ['read', `/projects/${K}`], 'PATCH /projects/{key}': ['padmin', `/projects/${K}`, { name: 'x' }],
    'DELETE /projects/{key}': ['gadmin', `/projects/${K}`],
    'PUT /projects/{key}/star': ['viewer', `/projects/${K}/star`], 'DELETE /projects/{key}/star': ['viewer', `/projects/${K}/star`],
    'GET /projects/{key}/events': ['read', `/projects/${K}/events`],
    'POST /projects/{key}/statuses': ['padmin', `/projects/${K}/statuses`, { name: 's', color: '#000000', category: 'todo' }],
    'PATCH /projects/{key}/statuses/{id}': ['padmin', `/projects/${K}/statuses/${status}`, { name: 'x' }],
    'DELETE /projects/{key}/statuses/{id}': ['padmin', `/projects/${K}/statuses/${status}`],
    'POST /projects/{key}/transitions': ['padmin', `/projects/${K}/transitions`, { name: 't', fromIds: null, toId: p.statuses[0].id }],
    'PATCH /projects/{key}/transitions/{id}': ['padmin', `/projects/${K}/transitions/${transition}`, { name: 'x' }],
    'DELETE /projects/{key}/transitions/{id}': ['padmin', `/projects/${K}/transitions/${transition}`],
    'POST /projects/{key}/fields': ['padmin', `/projects/${K}/fields`, { name: 'f', kind: 'text', options: null, position: 1 }],
    'PATCH /projects/{key}/fields/{id}': ['padmin', `/projects/${K}/fields/${field}`, { name: 'x' }],
    'DELETE /projects/{key}/fields/{id}': ['padmin', `/projects/${K}/fields/${field}`],
    'POST /projects/{key}/templates': ['padmin', `/projects/${K}/templates`, { name: 't', type: 'task', title: 't' }],
    'PATCH /projects/{key}/templates/{id}': ['padmin', `/projects/${K}/templates/${template}`, { name: 'x' }],
    'DELETE /projects/{key}/templates/{id}': ['padmin', `/projects/${K}/templates/${template}`],
    'POST /projects/{key}/rules': ['padmin', `/projects/${K}/rules`, { name: 'r', trigger: { kind: 'created' }, actions: [] }],
    'PATCH /projects/{key}/rules/{id}': ['padmin', `/projects/${K}/rules/${rule}`, { name: 'x' }],
    'DELETE /projects/{key}/rules/{id}': ['padmin', `/projects/${K}/rules/${rule}`],
    'POST /projects/{key}/releases': ['padmin', `/projects/${K}/releases`, { name: 'r' }],
    'PATCH /projects/{key}/releases/{id}': ['padmin', `/projects/${K}/releases/${release}`, { name: 'x' }],
    'DELETE /projects/{key}/releases/{id}': ['padmin', `/projects/${K}/releases/${release}`],
    'POST /projects/{key}/releases/{id}/release': ['padmin', `/projects/${K}/releases/${release}/release`, {}],
    'POST /projects/{key}/sprints': ['write', `/projects/${K}/sprints`, { name: 's' }],
    'PATCH /projects/{key}/sprints/{id}': ['write', `/projects/${K}/sprints/${sprint}`, { name: 'x' }],
    'DELETE /projects/{key}/sprints/{id}': ['write', `/projects/${K}/sprints/${sprint}`],
    'POST /projects/{key}/sprints/{id}/start': ['write', `/projects/${K}/sprints/${sprint}/start`, { endsAt: '2026-12-01T00:00:00.000Z' }],
    'POST /projects/{key}/sprints/{id}/complete': ['write', `/projects/${K}/sprints/${sprint}/complete`, {}],
    'GET /projects/{key}/members': ['read', `/projects/${K}/members`],
    'POST /projects/{key}/members': ['padmin', `/projects/${K}/members`, { userIds: [viewerId], role: 'member' }],
    'PATCH /projects/{key}/members/{userId}': ['padmin', `/projects/${K}/members/${viewerId}`, { role: 'member' }],
    'DELETE /projects/{key}/members/{userId}': ['padmin', `/projects/${K}/members/${ownerId}`],
    'GET /groups/search': ['any', '/groups/search'],
    'GET /projects/{key}/groups': ['read', `/projects/${K}/groups`],
    'POST /projects/{key}/groups': ['padmin', `/projects/${K}/groups`, { groupId: group, role: 'member' }],
    'PATCH /projects/{key}/groups/{groupId}': ['padmin', `/projects/${K}/groups/${group}`, { role: 'member' }],
    'DELETE /projects/{key}/groups/{groupId}': ['padmin', `/projects/${K}/groups/${group}`],
    'GET /projects/{key}/report-data': ['read', `/projects/${K}/report-data`],
    'GET /projects/{key}/issues': ['read', `/projects/${K}/issues`],
    'POST /projects/{key}/issues': ['write', `/projects/${K}/issues`, { title: 'x' }],
    'GET /issues/{key}': ['read', `/issues/${I}`], 'PATCH /issues/{key}': ['write', `/issues/${I}`, { title: 'x' }],
    'DELETE /issues/{key}': ['write', `/issues/${I}`],
    'GET /issues/{key}/comments': ['read', `/issues/${I}/comments`], 'POST /issues/{key}/comments': ['viewer', `/issues/${I}/comments`, { body: 'x' }],
    'GET /issues/{key}/activity': ['read', `/issues/${I}/activity`],
    'POST /issues/{key}/clone': ['write', `/issues/${I}/clone`, {}],
    'GET /issues/{key}/transitions': ['read', `/issues/${I}/transitions`],
    'POST /issues/{key}/transitions': ['write', `/issues/${I}/transitions`, { transitionId: transition }],
    'POST /issues/bulk/edit': ['write', '/issues/bulk/edit', { issues: [I], patch: { title: 'x' } }],
    'POST /issues/bulk/delete': ['write', '/issues/bulk/delete', { issues: [I] }],
    'POST /issues/bulk/restore': ['write', '/issues/bulk/restore', { issues: ['MTX-2'] }],
    'POST /issues/{key}/view': ['viewer', `/issues/${I}/view`], 'POST /issues/{key}/restore': ['write', '/issues/MTX-2/restore'],
    'POST /issues/{key}/links': ['write', `/issues/${I}/links`, { type: 'relates', targetKey: 'MTX-3' }],
    'DELETE /issues/{key}/links': ['write', `/issues/${I}/links?type=relates&target=MTX-3`],
    'PUT /issues/{key}/watch': ['viewer', `/issues/${I}/watch`], 'DELETE /issues/{key}/watch': ['viewer', `/issues/${I}/watch`],
    'POST /issues/{key}/presence': ['write', `/issues/${I}/presence`], 'DELETE /issues/{key}/presence': ['viewer', `/issues/${I}/presence`],
    'PATCH /comments/{id}': ['own', `/comments/${comment}`, { body: 'x' }], 'DELETE /comments/{id}': ['own', `/comments/${comment}`],
    'POST /issues/{key}/worklogs': ['write', `/issues/${I}/worklogs`, { minutes: 5, date: '2026-10-01' }],
    'PATCH /worklogs/{id}': ['own', `/worklogs/${worklog}`, { note: 'x' }],
    'DELETE /worklogs/{id}': ['own', `/worklogs/${worklog}`],
    'GET /search/export.csv': ['any', '/search/export.csv'], 'GET /search': ['any', '/search'], 'GET /labels': ['any', '/labels'],
    'GET /me/work': ['any', '/me/work'], 'GET /me/recent': ['any', '/me/recent'], 'GET /me/work/summary': ['any', '/me/work/summary'],
    'GET /me/projects/recent': ['any', '/me/projects/recent'], 'GET /me/viewed': ['any', '/me/viewed'],
    'GET /projects/{key}/summary': ['read', `/projects/${K}/summary`],
    'GET /notifications': ['any', '/notifications'], 'PATCH /notifications/{id}': ['own', `/notifications/${notification}`, { read: true }],
    'POST /notifications/read-all': ['any', '/notifications/read-all'],
    'GET /views': ['any', '/views'], 'POST /views': ['any', '/views', { name: 'v', filters: {} }],
    'PATCH /views/{id}': ['own', `/views/${view}`, { name: 'x' }], 'DELETE /views/{id}': ['own', `/views/${view}`],
    'POST /issues/{key}/attachments': ['write', `/issues/${I}/attachments`, { name: 'b.txt', size: 1, type: 'text/plain' }],
    'POST /attachments/{id}/complete': ['write', `/attachments/${ticket.id}/complete`],
    'GET /attachments/{id}/url': ['read', `/attachments/${ticket.id}/url`], 'DELETE /attachments/{id}': ['write', `/attachments/${ticket.id}`],
    'GET /issues/{key}/development': ['read', `/issues/${I}/development`],
    'GET /me/tokens': ['any', '/me/tokens'], 'POST /me/tokens': ['any', '/me/tokens', { name: 't' }], 'DELETE /me/tokens/{id}': ['own', `/me/tokens/${token}`],
    'POST /import': ['gadmin', '/import', { version: 4, projects: [] }],
    'GET /audit': ['gadmin', '/audit'], 'GET /admin/users': ['gadmin', '/admin/users'],
    'GET /admin/settings/project-backups': ['gadmin', '/admin/settings/project-backups'],
    'PUT /admin/settings/project-backups': ['gadmin', '/admin/settings/project-backups', { enabled: true }],
    'GET /admin/project-backups': ['gadmin', '/admin/project-backups'],
    'GET /admin/project-backups/{id}/url': ['gadmin', `/admin/project-backups/${backup}/url`],
    'POST /admin/project-backups/{id}/restore': ['gadmin', `/admin/project-backups/${backup}/restore`],
    'GET /jobs/{id}': ['own', `/jobs/${job}`],
    'GET /admin/settings': ['gadmin', '/admin/settings'],
    'PUT /admin/settings/{key}': ['gadmin', '/admin/settings/attachments', { enabled: true, maxSizeMb: 25 }],
    'GET /admin/rate-limits/limited': ['gadmin', '/admin/rate-limits/limited'],
    'GET /settings/public': ['any', '/settings/public'],
    'GET /link-types': ['any', '/link-types'],
    'GET /me/notification-prefs': ['any', '/me/notification-prefs'],
    'PUT /me/notification-prefs': ['any', '/me/notification-prefs', { prefs: [] }],
    'POST /projects/{key}/import': ['write', `/projects/${K}/import`, { csv: 'Title\nx', mapping: { title: 0 } }],
    'GET /projects/{key}/automation/runs': ['padmin', `/projects/${K}/automation/runs`],
    'POST /projects/{key}/automation/dry-run': ['padmin', `/projects/${K}/automation/dry-run`, { issue: I, actions: [] }],
    'GET /admin/views': ['gadmin', '/admin/views'],
    'POST /projects/{key}/components': ['padmin', `/projects/${K}/components`, { name: 'Matrix part' }],
    'PATCH /projects/{key}/components/{id}': ['padmin', `/projects/${K}/components/${component}`, { description: 'x' }],
    'DELETE /projects/{key}/components/{id}': ['padmin', `/projects/${K}/components/${component}`],
    'GET /projects/{key}/workflow/versions': ['read', `/projects/${K}/workflow/versions`],
    'GET /projects/{key}/workflow/versions/{version}': ['read', `/projects/${K}/workflow/versions/1`],
    'POST /projects/{key}/workflow/versions': ['padmin', `/projects/${K}/workflow/versions`, { note: 'm' }],
    'POST /projects/{key}/types': ['padmin', `/projects/${K}/types`, { name: 'Matrix type', color: '#123456', icon: 'flag' }],
    'PATCH /projects/{key}/types/{typeKey}': ['padmin', `/projects/${K}/types/story`, { color: '#16A34A' }],
    'DELETE /projects/{key}/types/{typeKey}': ['padmin', `/projects/${K}/types/t-nothinghere`],
    'POST /admin/link-types': ['gadmin', '/admin/link-types', { name: 'Matrix link', outward: 'x', inward: 'y' }],
    'PATCH /admin/link-types/{id}': ['gadmin', '/admin/link-types/relates', { outward: 'relates to' }],
    'DELETE /admin/link-types/{id}': ['gadmin', '/admin/link-types/nothing-here'],
  }

  // every documented operation has a row, and every row is a documented operation
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  const documented = Object.entries(spec.paths as Record<string, object>).filter(([path]) => path.startsWith('/api/v1/'))
    .flatMap(([path, ops]) => Object.keys(ops).map(m => `${m.toUpperCase()} ${path.slice(7)}`))
  assert.deepEqual(documented.filter(op => !(op in M)), [], 'routes with no permission rule')
  assert.deepEqual(Object.keys(M).filter(op => !documented.includes(op)), [], 'rules for routes that do not exist')

  const send = async (op: string, as: string | null) => {
    const [method] = op.split(' '), [, path, body] = M[op]!
    const r = await app.inject({ method: method as any, url: `/api/v1${path}`, payload: body as any, headers: as ? await bearer(as) : {} })
    return r.statusCode
  }
  const wrong: string[] = []
  const expect = (op: string, as: string, got: number, ok: number[]) => { if (!ok.includes(got)) wrong.push(`${op} as ${as}: ${got}, expected ${ok.join(' or ')}`) }
  for (const op of Object.keys(M)) {
    const rule = M[op]![0]
    expect(op, 'nobody', await send(op, null), [401])
    if (rule === 'read' || rule === 'viewer') expect(op, 'outsider', await send(op, who.outsider), [404])
    if (rule === 'write') { expect(op, 'outsider', await send(op, who.outsider), [404]); expect(op, 'viewer', await send(op, who.viewer), [403]) }
    if (rule === 'padmin') {
      expect(op, 'outsider', await send(op, who.outsider), [404]); expect(op, 'viewer', await send(op, who.viewer), [403]); expect(op, 'member', await send(op, who.member), [403])
    }
    if (rule === 'gadmin') { expect(op, 'member', await send(op, who.member), [403]); expect(op, 'outsider', await send(op, who.outsider), [403]) }
    if (rule === 'own') { expect(op, 'member', await send(op, who.member), [403, 404]); expect(op, 'outsider', await send(op, who.outsider), [403, 404]) }
  }
  assert.deepEqual(wrong, [])
})

// ── Concurrency: several people (or retries) hitting the same records at the same moment ──
test('concurrency: same-version edits, a retried create, simultaneous reordering, and sprint completion during edits all stay consistent', { skip, timeout: 120_000 }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Race', key: 'RCE', template: 'scrum' })).body
  const done = p.statuses.find((s: any) => s.category === 'done')
  const items: any[] = []
  for (let n = 0; n < 12; n++) items.push((await call('POST', '/api/v1/projects/RCE/issues', { title: `race ${n}` })).body)

  // 1. Five people edit the same item from the same version: exactly one wins, the others are told it changed
  const target = items[0]
  // Hold the row so all five read the same version before any of them writes (otherwise they would simply take turns)
  const lock = await pool.connect()
  await lock.query('begin'); await lock.query('select 1 from issues where id = $1 for update', [target.id])
  const racingEdits = Promise.all(Array.from({ length: 5 }, (_, k) =>
    call('PATCH', `/api/v1/issues/${target.key}`, { title: `edit ${k}` }, 'owner@x.com', { 'if-match': String(target.version) })))
  await new Promise(r => setTimeout(r, 300))
  await lock.query('commit'); lock.release()
  const edits = await racingEdits
  assert.deepEqual(edits.map(r => r.status).sort(), [200, 409, 409, 409, 409])
  const winner = edits.find(r => r.status === 200)!.body
  assert.equal((await call('GET', `/api/v1/issues/${target.key}`)).body.title, winner.title)
  assert.equal(winner.version, target.version + 1)
  // …but an edit that didn't ask for a version check isn't refused because something else saved the item while it ran
  const held = await pool.connect()
  await held.query('begin'); await held.query(`update issues set title = 'changed meanwhile', version = version + 1 where id = $1`, [target.id])
  const unchecked = call('PATCH', `/api/v1/issues/${target.key}`, { priority: 'high' })
  await new Promise(r => setTimeout(r, 300))
  await held.query('commit'); held.release()
  const u = await unchecked
  assert.equal(u.status, 200, JSON.stringify(u.body))
  assert.deepEqual([u.body.title, u.body.priority], ['changed meanwhile', 'high'])

  // 2. A flaky network sends the same new comment five times at once: one comment, the rest conflict
  const cid = '0192f0c0-0000-7000-8000-0000000c0de1'
  const posts = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/api/v1/issues/${target.key}/comments`, { id: cid, body: 'only once' })))
  assert.equal(posts.filter(r => r.status === 201).length, 1)
  assert.ok(posts.every(r => r.status === 201 || r.status === 409))
  assert.equal((await pool.query('select count(*)::int as n from comments where id = $1', [cid])).rows[0].n, 1)

  // 3. Ten people drag different items to the top at once: every item stays, every rank is unique, the order is the same for everyone
  const list = async () => (await call('GET', '/api/v1/projects/RCE/issues?limit=100')).body.items as any[]
  const before = await list()
  const top = before[0].rank
  await Promise.all(before.slice(2).map((it, k) => call('PATCH', `/api/v1/issues/${it.key}`, { rank: top - 1 - k / 1000 })))
  const after = await list()
  assert.equal(after.length, before.length)
  assert.equal(new Set(after.map(x => x.rank)).size, after.length)
  assert.deepEqual((await list()).map(x => x.id), after.map(x => x.id))

  // 4. A sprint is completed while its items are being edited: every item ends either done in the closed sprint or back in the backlog
  const sprint = (await call('POST', '/api/v1/projects/RCE/sprints', { name: 'Race sprint' })).body
  for (const it of items.slice(1)) await call('PATCH', `/api/v1/issues/${it.key}`, { sprintId: sprint.id })
  await call('POST', `/api/v1/projects/RCE/sprints/${sprint.id}/start`, { endsAt: '2026-12-01T00:00:00.000Z' })
  const racing = Promise.all(items.slice(1).map((it, k) =>
    call('PATCH', `/api/v1/issues/${it.key}`, k % 2 ? { statusId: done.id } : { title: `${it.title} (edited)` })))
  const complete = call('POST', `/api/v1/projects/RCE/sprints/${sprint.id}/complete`, {})
  const [results, completed] = await Promise.all([racing, complete])
  assert.equal(completed.status, 200)
  assert.ok(results.every(r => r.status === 200), JSON.stringify(results.map(r => r.status)))
  const rows = (await pool.query(
    `select i.sprint_id, st.category from issues i join statuses st on st.id = i.status_id where i.id = any($1::uuid[])`, [items.slice(1).map(i => i.id)])).rows
  for (const r of rows) {
    if (r.category === 'done') assert.ok(r.sprint_id === sprint.id || r.sprint_id === null)   // finished: stays with the sprint (or was finished after it closed)
    else assert.equal(r.sprint_id, null)                                                   // unfinished: back to the backlog, never left in a closed sprint
  }
  assert.equal((await call('GET', '/api/v1/projects/RCE')).body.sprints.find((s: any) => s.id === sprint.id).state, 'closed')
})

test('system settings: admins change policies at runtime (validated, audited); everyone reads the public ones; the API follows them', { skip }, async () => {
  const { clearSettingsCache } = await import('../src/settings.ts')
  const put = (key: string, value: object, who = 'owner@x.com') => call('PUT', `/api/v1/admin/settings/${key}`, value, who)
  const all = (await call('GET', '/api/v1/admin/settings')).body
  assert.deepEqual(all.map((s: any) => s.key), ['rateLimiting', 'attachments', 'accessTokens', 'searchAndBulk', 'dueReminders', 'email'])
  assert.equal(all.find((s: any) => s.key === 'rateLimiting').value.enabled, false)                  // no limit unless an admin sets one
  assert.equal((await call('GET', '/api/v1/admin/settings', undefined, 'set.member@x.com')).status, 403)
  assert.equal((await put('attachments', { enabled: true, maxSizeMb: 5 }, 'set.member@x.com')).status, 403)
  assert.equal((await put('nonsense', {})).status, 404)
  const bad = await put('accessTokens', { enabled: true, maxPerUser: 0, maxExpiryDays: 30, defaultExpiryDays: 60 })
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.maxPerUser && bad.body.errors.defaultExpiryDays)

  // public settings: what the web app needs, for anyone signed in (not rate limiting)
  const pub = (await call('GET', '/api/v1/settings/public', undefined, 'set.member@x.com')).body
  assert.deepEqual(Object.keys(pub).sort(), ['accessTokens', 'attachments', 'dueReminders', 'searchAndBulk'])

  // attachments: size limit and the switch
  await call('POST', '/api/v1/projects', { name: 'Settings', key: 'SET', template: 'kanban' })
  for (let n = 0; n < 4; n++) await call('POST', '/api/v1/projects/SET/issues', { title: `s${n}` })
  assert.equal((await put('attachments', { enabled: true, maxSizeMb: 1 })).status, 200)
  assert.equal((await call('POST', '/api/v1/issues/SET-1/attachments', { name: 'big.bin', size: 2 * 1024 * 1024, type: 'application/octet-stream' })).status, 400)
  assert.equal((await call('POST', '/api/v1/issues/SET-1/attachments', { name: 'ok.txt', size: 100, type: 'text/plain' })).status, 201)
  await put('attachments', { enabled: false, maxSizeMb: 1 })
  assert.equal((await call('POST', '/api/v1/issues/SET-1/attachments', { name: 'ok.txt', size: 100, type: 'text/plain' })).status, 403)
  await put('attachments', { enabled: true, maxSizeMb: 25 })

  // bulk size and export size
  await put('searchAndBulk', { exportMaxRows: 100, bulkMaxItems: 2, importMaxRows: 10000 })
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: ['SET-1', 'SET-2', 'SET-3'], patch: { priority: 'high' } })).status, 400)
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: ['SET-1', 'SET-2'], patch: { priority: 'high' } })).status, 200)
  await put('searchAndBulk', { exportMaxRows: 20000, bulkMaxItems: 200, importMaxRows: 10000 })

  // access tokens: lifetime, number, and the switch (which also stops existing tokens)
  await put('accessTokens', { enabled: true, maxPerUser: 1, maxExpiryDays: 30, defaultExpiryDays: 7 })
  assert.equal((await call('POST', '/api/v1/me/tokens', { name: 'too long', expiresInDays: 60 }, 'set.tokens@x.com')).status, 400)
  const T = 'set.tokens@x.com'                                                            // someone with no tokens yet
  const tok = (await call('POST', '/api/v1/me/tokens', { name: 'default' }, T)).body
  assert.equal(Math.round((Date.parse(tok.expiresAt) - Date.now()) / 86_400_000), 7)
  assert.equal((await call('POST', '/api/v1/me/tokens', { name: 'second' }, T)).status, 409)
  const viaToken = (method: string, url: string) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tok.token}` } })
  assert.equal((await viaToken('GET', '/api/v1/me')).statusCode, 200)
  await put('accessTokens', { enabled: false, maxPerUser: 1, maxExpiryDays: 30, defaultExpiryDays: 7 })
  assert.equal((await viaToken('GET', '/api/v1/me')).statusCode, 401)
  await put('accessTokens', { enabled: true, maxPerUser: 10, maxExpiryDays: 365, defaultExpiryDays: 90 })

  // rate limiting: none by default, then a small limit for tokens only; the web app is never limited; an exemption lifts it
  assert.equal((await viaToken('GET', '/api/v1/me')).headers['x-ratelimit-limit'], undefined)
  await put('rateLimiting', { enabled: true, mode: 'limit', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [] })
  const r = [await viaToken('GET', '/api/v1/me'), await viaToken('GET', '/api/v1/me'), await viaToken('GET', '/api/v1/me')]
  assert.deepEqual(r.map(x => x.statusCode), [200, 200, 429])
  assert.deepEqual([r[0]!.headers['x-ratelimit-limit'], r[1]!.headers['x-ratelimit-remaining']], ['2', '0'])
  assert.ok(Number(r[2]!.headers['retry-after']) > 0)
  for (let n = 0; n < 5; n++) assert.equal((await call('GET', '/api/v1/me', undefined, T)).status, 200)   // the same person in the web app: never limited
  const limited = (await call('GET', '/api/v1/admin/rate-limits/limited')).body
  assert.equal(limited[0].email, T)
  const me = (await call('GET', '/api/v1/me', undefined, T)).body.id
  await put('rateLimiting', { enabled: true, mode: 'limit', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [{ userId: me, mode: 'unlimited' }] })
  assert.equal((await viaToken('GET', '/api/v1/me')).statusCode, 200)
  await put('rateLimiting', { enabled: true, mode: 'block', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [] })
  assert.equal((await viaToken('GET', '/api/v1/me')).statusCode, 429)
  await put('rateLimiting', { enabled: false, mode: 'limit', requests: 100, intervalSeconds: 60, burst: 100, exemptions: [] })
  assert.equal((await viaToken('GET', '/api/v1/me')).statusCode, 200)

  // every change is in the audit log, with what changed
  const log = (await call('GET', '/api/v1/audit?action=settings.')).body.items
  assert.ok(log.some((e: any) => e.action === 'settings.attachments.updated' && e.after.maxSizeMb === 1))
  assert.ok(log.some((e: any) => e.action === 'settings.rateLimiting.updated'))
  // a value saved by another pod is picked up (the cache is short): simulate by writing directly and clearing this pod's cache
  await pool.query(`update system_settings set value = jsonb_set(value, '{maxSizeMb}', '3') where key = 'attachments'`)
  clearSettingsCache()
  assert.equal((await call('GET', '/api/v1/settings/public')).body.attachments.maxSizeMb, 3)
  await put('attachments', { enabled: true, maxSizeMb: 25 })
})
