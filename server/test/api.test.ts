import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'
import { createHash, createHmac } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

// Needs a throwaway Postgres: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'
Object.assign(process.env, { AUTH_DEV: '1', SCIM_TOKEN: 'scim-secret', NODE_ENV: 'test', DUE_SCAN_INTERVAL_MS: '0', GITHUB_WEBHOOK_SECRET: 'whsec-test', CORS_ORIGINS: 'https://strand-one.vercel.app/, http://localhost:5173' })
// the stand-in Entra for spec 0711 (Entra is configured at runtime; the other tests sign in with the dev login)
const TENANT = '11111111-1111-4111-8111-111111111111', CLIENT = '22222222-2222-4222-8222-222222222222', WEB = '33333333-3333-4333-8333-333333333333'
let signingKey: CryptoKey, jwksServer: ReturnType<typeof createServer>, authority = ''

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

const call = async (method: string, path: string, body?: unknown, who = 'owner@x.com', headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as any, url: path, payload: body as any, headers: { 'x-dev-user': who, ...headers } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}

type Move = { name: string; fromIds?: string[] | null; toId: string | null; rules?: Record<string, unknown> }
let flows = 0
/** Give project `key` workflows of its own, made in the library by a system administrator: the project's statuses (plus
 *  `add`), these transitions (between the project's status ids, as tests hold them; `add` ones by their given ids), and
 *  for `byType` work types another workflow. Returns the project afterwards. */
const flow = async (key: string, moves: Move[], o: { add?: { id: string; name: string; color: string; category: string }[]; byType?: Record<string, Move[]> } = {}) => {
  const p = (await call('GET', `/api/v1/projects/${key}`)).body
  const g = new Map<string, string>(p.statuses.map((s: any) => [s.id, s.globalStatusId]))
  const gid = (id: string) => g.get(id) ?? id
  const statuses = [...p.statuses.map((s: any) => ({ id: s.globalStatusId, name: s.name, color: s.color, category: s.category })), ...(o.add ?? [])]
  const make = async (ms: Move[]) => {
    const w = await call('POST', '/api/v1/admin/workflows', { name: `${key} flow ${++flows}` })
    const r = await call('POST', `/api/v1/admin/workflows/${w.body.id}/publish`, {
      statuses, transitions: ms.map((m, i) => ({ id: String(i), name: m.name, fromIds: m.fromIds ? m.fromIds.map(gid) : null, toId: m.toId && gid(m.toId), rules: m.rules ?? {} })),
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return w.body.id as string
  }
  const mappings: Record<string, string> = {}
  for (const [t, ms] of Object.entries(o.byType ?? {})) mappings[t] = await make(ms)
  const s = await call('POST', '/api/v1/admin/workflow-schemes', { name: `${key} scheme ${++flows}`, defaultWorkflowId: await make(moves), mappings })
  assert.equal((await call('PUT', `/api/v1/projects/${key}/workflow-scheme`, { schemeId: s.body.id })).status, 200)
  return (await call('GET', `/api/v1/projects/${key}`)).body
}
/** Make `email` a member of project `key` (creating the person if they have never signed in). Global admins need no membership. */
const join = async (key: string, email: string, role: 'admin' | 'member' | 'viewer' = 'member') => {
  await call('GET', '/api/v1/me', undefined, email)
  await pool.query(
    `insert into project_members (project_id, user_id, role) select p.id, u.id, $3 from projects p, users u where p.key = $1 and u.email = $2
       on conflict (project_id, user_id) do update set role = $3`, [key, email, role])
}

// Two company directories in memory (spec 0712). Every connection the server makes goes to one of them, so nothing
// leaves the machine; any other host is refused as unreachable.
import type { FakeDirectory } from '../src/fakeLdap.ts'
const BASE = 'DC=corp,DC=test', SVC = `CN=svc-strand,OU=Service,${BASE}`
const adUser = (cn: string, sam: string, o: { mail?: string; groups?: string[]; uac?: string; guid?: string } = {}) => ({
  dn: `CN=${cn},OU=People,${BASE}`, objectClass: ['top', 'person', 'organizationalPerson', 'user'], objectCategory: 'Person', sAMAccountName: sam,
  givenName: cn.split(' ')[0]!, sn: cn.split(' ')[1] ?? '', displayName: cn, ...(o.mail === '' ? {} : { mail: o.mail ?? `${sam}@corp.test` }),
  objectGUID: Buffer.from(createHash('md5').update(o.guid ?? sam).digest()), memberOf: o.groups ?? [], userAccountControl: o.uac ?? '512',
})
const adGroup = (cn: string, members: string[] = [], guid = cn) => ({ dn: `CN=${cn},OU=Groups,${BASE}`, objectClass: ['top', 'group'], objectCategory: 'Group', cn, description: `${cn} team`, member: members, objectGUID: Buffer.from(createHash('md5').update(`group:${guid}`).digest()) })
const corp: FakeDirectory = { host: 'dc1.corp.test', passwords: {}, entries: [], log: { binds: [], searches: [] } }
const other: FakeDirectory = { host: 'dc1.other.test', passwords: {}, entries: [], log: { binds: [], searches: [] } }
const corpConfig = (o: Record<string, unknown> = {}) => ({ host: corp.host, port: 389, security: 'none', bindDn: SVC, baseDn: BASE, ...o })

before(async () => {
  if (skip) return
  const { useLdap } = await import('../src/ldap.ts'), { fakeConnect } = await import('../src/fakeLdap.ts')
  useLdap(s => fakeConnect(s.host === other.host ? other : corp)(s))
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
  // the stand-in Entra: its discovery document (for the configuration check, spec 0711) and its signing keys
  jwksServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url?.endsWith('/.well-known/openid-configuration')
      ? { issuer: `${authority}/${TENANT}/v2.0`, jwks_uri: `${authority}/${TENANT}/discovery/v2.0/keys` } : { keys: [jwk] }))
  })
  await new Promise<void>(r => jwksServer.listen(0, '127.0.0.1', r))
  authority = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`
  await new Promise<void>(r => s3Server.listen(0, '127.0.0.1', r))
  Object.assign(process.env, {
    S3_BUCKET: 'files', S3_ENDPOINT: `http://127.0.0.1:${(s3Server.address() as { port: number }).port}`, AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', FILE_SWEEP_MS: '0', JOBS_POLL_MS: '0',
  })
  pool = new pg.Pool({ connectionString: url })
  await pool.query('drop schema public cascade; create schema public')
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  for (const f of readdirSync(dir).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'))
  app = await (await import('../src/app.ts')).build()
})
after(async () => { if (skip) return; await app.close(); await pool.end(); s3Server.close(); jwksServer.close() })

test('project → issue lifecycle with workflow, versions and undo', { skip }, async () => {
  const p = await call('POST', '/api/v1/projects', { name: 'Payments', key: 'PAY', template: 'kanban' })
  assert.equal(p.status, 201)
  assert.deepEqual(p.body.statuses.map((s: any) => s.name), ['To do', 'In progress', 'Done'])
  const [todo, doing, done] = p.body.statuses

  const a = (await call('POST', '/api/v1/projects/PAY/issues', { title: 'First', type: 'task' })).body
  const b = (await call('POST', '/api/v1/projects/PAY/issues', { title: 'Second' })).body
  assert.equal(a.key, 'PAY-1'); assert.equal(b.key, 'PAY-2'); assert.ok(b.rank > a.rank)

  // workflow: only To do → In progress
  await flow('PAY', [{ name: 'Start', fromIds: [todo.id], toId: doing.id }])
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
  assert.ok(spec.components.securitySchemes.bearer && spec.components.securitySchemes.devSecret)
  const post = spec.paths['/api/v1/admin/statuses'].post
  assert.deepEqual(post.tags, ['Workflows'])
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
  const bad = await call('POST', '/api/v1/admin/statuses', { name: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'Invalid input')
})

test('CORS: only listed origins may call the API from a browser, and preflight needs no login', { skip }, async () => {
  const pre = (origin: string) => app.inject({
    method: 'OPTIONS', url: '/api/v1/projects',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dev-user,x-dev-secret,if-match,x-workflow-override' },
  })
  const ok = await pre('https://strand-one.vercel.app')
  assert.equal(ok.statusCode, 204)
  assert.equal(ok.headers['access-control-allow-origin'], 'https://strand-one.vercel.app')
  for (const h of ['x-dev-user', 'x-dev-secret', 'if-match', 'x-workflow-override']) assert.match(String(ok.headers['access-control-allow-headers']), new RegExp(h))
  assert.equal((await pre('http://localhost:5173')).headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal((await pre('https://evil.example')).headers['access-control-allow-origin'], undefined)
  // a normal request from a listed origin carries the header too
  const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: 'https://strand-one.vercel.app', 'x-dev-user': 'owner@x.com' } })
  assert.equal(r.headers['access-control-allow-origin'], 'https://strand-one.vercel.app')
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
  const [todo, doing, done] = p.statuses
  await flow('OVR', [{ name: 'Start', fromIds: [todo.id], toId: doing.id }])
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
  const bad = await call('POST', '/api/v1/projects', { name: '', key: '', template: 'nope' })
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
  await ok('PATCH', `/projects/SCH/statuses/${p.statuses[1].id}`, { wipLimit: 3 })
  await ok('GET', '/projects/SCH/workflow'); await ok('GET', '/workflow-schemes'); await ok('GET', '/workflows')
  const wf = await ok('POST', '/admin/workflows', { name: 'Schemas flow', copyFrom: p.workflows[0].workflowId })
  await ok('GET', `/workflows/${wf.id}`); await ok('PATCH', `/admin/workflows/${wf.id}`, { description: 'For the schema test' })
  await ok('POST', `/admin/workflows/${wf.id}/publish`, { statuses: wf.statuses, transitions: wf.transitions.slice(1), note: 'Fewer moves' })
  await ok('GET', `/workflows/${wf.id}/versions`); await ok('GET', `/workflows/${wf.id}/versions/1`)
  const st = await ok('POST', '/admin/statuses', { name: 'Schema check', color: '#123456', category: 'todo' })
  await ok('GET', '/admin/statuses'); await ok('PATCH', `/admin/statuses/${st.id}`, { color: '#654321' })
  const sc = await ok('POST', '/admin/workflow-schemes', { name: 'Schemas', defaultWorkflowId: wf.id, mappings: { bug: p.workflows[0].workflowId } })
  await ok('PATCH', `/admin/workflow-schemes/${sc.id}`, { description: 'Bugs as before', dryRun: true })
  await ok('PUT', '/projects/SCH/workflow-scheme', { schemeId: sc.id, dryRun: true })
  const rel = await ok('POST', '/projects/SCH/releases', { name: '1.0', releaseDate: '2026-12-01' })
  await ok('POST', `/projects/SCH/releases/${rel.id}/release`, {})
  const sp = await ok('POST', '/projects/SCH/sprints', { name: 'S', goal: 'g' })
  await ok('PATCH', `/projects/SCH/sprints/${sp.id}`, { goal: 'new' })
  await ok('POST', `/projects/SCH/sprints/${sp.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  const i = await ok('POST', '/projects/SCH/issues', { title: 'One', assigneeId: me.id, sprintId: sp.id, fixReleaseIds: [rel.id], dueDate: '2026-11-01', estimate: 2, labels: ['a'] })
  await ok('POST', '/projects/SCH/issues', { title: 'Two', parentId: i.id })
  await ok('GET', '/projects/SCH/issues'); await ok('GET', '/projects/SCH/summary')
  const c = await ok('POST', '/issues/SCH-1/comments', { body: 'hello' })
  await ok('PATCH', `/comments/${c.id}`, { body: 'edited' })
  await ok('POST', '/issues/SCH-1/worklogs', { minutes: 20, date: '2026-10-01', note: 'n' })
  await ok('POST', '/issues/SCH-1/links', { type: 'blocks', targetKey: 'SCH-2' }); await ok('PUT', '/issues/SCH-1/watch')
  const d = await ok('GET', '/issues/SCH-1')
  assert.equal(d.children.length, 1); assert.equal(d.comments[0].editedAt !== null, true)
  await ok('PATCH', '/issues/SCH-1', { title: 'One!' }); await ok('GET', '/issues/SCH-2/delete-preview'); await ok('DELETE', '/issues/SCH-2')
  await ok('GET', '/projects/SCH/deleted'); await ok('POST', '/issues/SCH-2/restore')
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
  assert.equal((await call('POST', '/api/v1/views', { name: 'Status codes view', filters: { q: '' } })).status, 201)
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
  await flow('BLK', [{ name: 'Start', fromIds: [todo.id], toId: doing.id }])
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
  assert.deepEqual((await call('GET', '/api/v1/admin/archived-projects')).body.items.map((p: any) => p.key), ['SRB'])
  assert.equal((await call('GET', '/api/v1/projects/SRB')).body.key, 'SRB')                            // still readable
  assert.equal((await call('POST', '/api/v1/projects/SRB/restore')).body.archivedAt, null)
  assert.ok((await call('GET', '/api/v1/projects')).body.some((p: any) => p.key === 'SRB'))
  await join('SRB', 'plain-member@x.com', 'member')
  assert.equal((await call('POST', '/api/v1/projects/SRB/archive', undefined, 'plain-member@x.com')).status, 403)   // members cannot archive (nor project admins: spec 0102)

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

test('live stream: losing access closes the stream at once (removed from the project, or deactivated); others keep theirs', { skip }, async () => {
  const addr = await app.listen({ port: 0, host: '127.0.0.1' }).catch(() => `http://127.0.0.1:${(app.server.address() as any).port}`)
  await call('POST', '/api/v1/projects', { name: 'Revoke', key: 'RVK', template: 'kanban' })
  for (const who of ['rv.ann', 'rv.ben', 'rv.cat']) await join('RVK', `${who}@x.com`)
  const open = async (who: string) => {
    const res = await fetch(`${addr}/api/v1/projects/RVK/events`, { headers: { 'x-dev-user': `${who}@x.com` } })
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
  assert.equal((await fetch(`${addr}/api/v1/projects/RVK/events`, { headers: { 'x-dev-user': 'rv.ann@x.com' } })).status, 404)   // and cannot reopen it
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
  const made = await call('POST', '/api/v1/admin/statuses', { name: 'Waiting', color: '#aaaaaa', category: 'in-progress', description: 'Waiting for the customer to reply' })
  assert.equal(made.status, 201)
  assert.equal(made.body.description, 'Waiting for the customer to reply')
  const noText = await call('POST', '/api/v1/admin/statuses', { name: 'Parked', color: '#aaaaaa', category: 'todo' })
  assert.equal(noText.body.description, '')                                                    // optional on create
  assert.equal(noText.body.position, made.body.position + 1)                                 // no position given: goes to the end
  // the project gets it once its workflow has it, and sees later changes
  const id = (await flow('DSC', [], { add: [made.body] })).statuses.find((s: any) => s.globalStatusId === made.body.id).id
  const patched = await call('PATCH', `/api/v1/admin/statuses/${made.body.id}`, { description: 'Blocked on someone else' })
  assert.equal(patched.body.description, 'Blocked on someone else')
  assert.equal((await call('PATCH', `/api/v1/admin/statuses/${made.body.id}`, { name: 'Waiting on customer' })).body.description, 'Blocked on someone else')   // other edits leave it alone
  const detail = (await call('GET', '/api/v1/projects/DSC')).body
  assert.deepEqual(['description', 'name'].map(k => detail.statuses.find((s: any) => s.id === id)[k]), ['Blocked on someone else', 'Waiting on customer'])
  const tooLong = await call('PATCH', `/api/v1/admin/statuses/${made.body.id}`, { description: 'x'.repeat(501) })
  assert.equal(tooLong.status, 400)
  assert.ok(tooLong.body.errors.description)
  assert.equal((await call('PATCH', `/api/v1/admin/statuses/${made.body.id}`, { description: 'x'.repeat(500) })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/admin/statuses/${made.body.id}`, { description: '' })).body.description, '')     // can be cleared
  // a status a workflow uses can't go; one nothing uses can
  assert.equal((await call('DELETE', `/api/v1/admin/statuses/${made.body.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/statuses/${noText.body.id}`)).status, 204)
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
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  await flow('AUT', [{ name: 'Start', fromIds: [todo.id], toId: doing.id }])
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
  assert.ok((await call('GET', '/api/v1/me', undefined, 'rul.ben@x.com')).body.groupIds.includes(qa))
  // the kanban template's any-to-any moves are replaced by a ruled workflow
  // Start: only the assignee, or (QA and a member); Finish: needs a due date and a comment, sets resolution and clears the sprint
  const ruled = await flow('RUL', [
    { name: 'Start', fromIds: [todo.id], toId: doing.id, rules: { restrict: { op: 'any', items: [
      { kind: 'person', who: 'assignee' }, { op: 'all', items: [{ kind: 'group', groupIds: [qa] }, { kind: 'role', roles: ['member'] }] }] } } },
    { name: 'Finish', fromIds: [doing.id], toId: done.id, rules: {
      validate: [{ kind: 'required', fields: ['dueDate', 'comment'] }], screen: ['dueDate', 'comment'],
      actions: [{ kind: 'set', field: 'resolution', value: "Won't do" }, { kind: 'assign', to: 'reporter' }, { kind: 'comment', body: 'Closed by the workflow' }] } },
    { name: 'Log progress', fromIds: [doing.id], toId: null, rules: { screen: ['comment'], actions: [{ kind: 'set', field: 'startDate', value: 'today' }] } },
    { name: 'Reopen', fromIds: [done.id], toId: todo.id, rules: { restrict: { op: 'all', items: [{ kind: 'hidden' }] } } },
  ])
  const [start, finish, log] = ['Start', 'Finish', 'Log progress'].map(n => ruled.transitions.find((t: any) => t.name === n))
  // bad rules are refused when saved
  const wf = ruled.workflows[0].workflowId, cur = (await call('GET', `/api/v1/workflows/${wf}`)).body
  const save = (rules: object) => call('POST', `/api/v1/admin/workflows/${wf}/publish`, { statuses: cur.statuses, transitions: [{ id: 'x', name: 'x', fromIds: null, toId: cur.statuses[0].id, rules }] })
  assert.equal((await save({ restrict: { op: 'all', items: [{ kind: 'field', field: 'nonsense', op: 'empty' }] } })).status, 400)
  assert.equal((await save({ actions: [{ kind: 'set', field: 'type', value: 'bug' }] })).status, 400)
  assert.equal((await save({ validate: [{ kind: 'required', fields: ['custom.00000000-0000-4000-8000-000000000000'] }] })).status, 400)   // a project's own field
  assert.equal((await call('GET', `/api/v1/workflows/${wf}`)).body.version, cur.version)                                                    // nothing saved

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

test('link types: Jira’s four (and test management’s Defect) to start with; admins add, rename and remove them; links in use move or go; built-ins stay', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Linked', key: 'LNK', template: 'kanban' })
  for (let n = 0; n < 3; n++) await call('POST', '/api/v1/projects/LNK/issues', { title: `l${n}` })
  const types = (await call('GET', '/api/v1/link-types', undefined, 'lnk.member@x.com')).body
  assert.deepEqual(types.map((t: any) => [t.id, t.outward, t.inward]), [
    ['blocks', 'blocks', 'is blocked by'], ['clones', 'clones', 'is cloned by'], ['duplicates', 'duplicates', 'is duplicated by'], ['relates', 'relates to', 'relates to'],
    ['defect', 'has defect', 'is a defect of'], ['tests', 'tests', 'is tested by']])   // test management's: defects runs found; requirements tests cover
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
  // how many links each type has: for system administrators (everyone else's list doesn't count them)
  assert.equal((await call('GET', '/api/v1/link-types?uses=1')).body.find((t: any) => t.id === 'causes').uses, 2)
  assert.equal((await call('GET', '/api/v1/link-types', undefined, 'lnk.member@x.com')).body.find((t: any) => t.id === 'causes').uses, null)
  assert.equal((await call('GET', '/api/v1/link-types?uses=1', undefined, 'lnk.member@x.com')).status, 403)
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
  const csv = (await app.inject({ method: 'GET', url: `/api/v1/search/export.csv?project=${p.id}`, headers: { 'x-dev-user': 'owner@x.com' } })).body
  assert.match(csv, /Incident/)
  // a workflow per type: incidents go To do -> Done directly; everything else goes through In progress
  const moves = [{ name: 'Start', fromIds: [todo.id], toId: doing.id }, { name: 'Finish', fromIds: [doing.id], toId: done.id }]
  await flow('TYP', moves, { byType: { [inc.body.key]: [...moves, { name: 'Resolve', fromIds: [todo.id], toId: done.id }] } })
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
  assert.equal(after.transitions.some((t: any) => t.name === 'Resolve'), false)            // nothing uses its workflow any more
  assert.ok(after.transitions.every((t: any) => t.typeKeys === null))                      // every type is on the one workflow again
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and field = 'type' and to_value = 'bug'`, [i.id])).rows.length)
  // members can't change the types
  await join('TYP', 'typ.member@x.com')
  assert.equal((await call('POST', '/api/v1/projects/TYP/types', { name: 'Spike', color: '#000000', icon: 'flag' }, 'typ.member@x.com')).status, 403)
})

test('shared workflows: a system administrator’s change reaches every project using it, items in a removed status move as mapped, and versions are kept', { skip }, async () => {
  for (const key of ['VER', 'VEA']) await call('POST', '/api/v1/projects', { name: key, key, template: 'kanban' })
  const wf = (await flow('VER', [])).workflows[0].workflowId
  await call('PUT', '/api/v1/projects/VEA/workflow-scheme', { schemeId: (await call('GET', '/api/v1/projects/VER')).body.workflowSchemeId })
  const cur = (await call('GET', `/api/v1/workflows/${wf}`)).body
  const [todo, doing, done] = cur.statuses
  const review = { id: crypto.randomUUID(), name: 'Review', color: '#a855f7', category: 'in-progress', description: '' }
  const { runJobs } = await import('../src/jobs.ts')
  // publishing queues a job that applies the change to every project; tests run jobs themselves
  const pub = async (body: object, who?: string) => { const r = await call('POST', `/api/v1/admin/workflows/${wf}/publish`, body, who); if (r.body?.jobId) await runJobs(); return r }
  const withReview = { statuses: [todo, doing, review, done], transitions: [{ id: 'review', name: 'To review', fromIds: [doing.id], toId: review.id }, { id: 'back', name: 'Back', fromIds: [review.id], toId: todo.id }] }
  const both = (await call('POST', '/api/v1/projects/VER/boards', { name: 'Both', type: 'kanban', jql: 'project in (VER, VEA)' })).body
  const cols = async (id: string) => (await call('GET', `/api/v1/boards/${id}`)).body.columns.map((c: any) => c.name)
  const verBoard = (await call('GET', '/api/v1/projects/VER')).body.boards[0].id
  const r1 = await pub({ ...withReview, note: 'Review step' })
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.deepEqual([r1.body.version, r1.body.created], [cur.version + 1, true])
  assert.deepEqual([r1.body.summary.projects, r1.body.summary.changed, r1.body.summary.added], [2, 2, ['Review']])
  assert.deepEqual(r1.body.summary.top.map((x: any) => x.project.key).sort(), ['VEA', 'VER'])
  const job = (await call('GET', `/api/v1/jobs/${r1.body.jobId}`)).body
  assert.deepEqual([job.status, job.progress.done, job.progress.total, job.result.applied], ['done', 2, 2, 2])
  for (const key of ['VER', 'VEA']) assert.deepEqual((await call('GET', `/api/v1/projects/${key}`)).body.statuses.map((s: any) => s.name), ['To do', 'In progress', 'Review', 'Done'])
  assert.equal((await pub(withReview)).body.created, false)                                // unchanged: no new version
  // the projects' boards gain a column for the new status, in its place
  for (const id of [verBoard, both.id]) assert.deepEqual(await cols(id), ['To do', 'In progress', 'Review', 'Done'])
  // items in Review (one of them deleted, which still counts)
  const rev = (await call('GET', '/api/v1/projects/VER')).body.statuses.find((s: any) => s.name === 'Review')
  const items = []
  for (let n = 0; n < 3; n++) items.push((await call('POST', '/api/v1/projects/VER/issues', { title: `r${n}`, statusId: rev.id })).body)
  await call('DELETE', `/api/v1/issues/${items[2].key}`)
  // taking Review out: as in Jira, its work items must leave it first (spec 0103); the deleted one doesn't count, and moves
  const without = { statuses: [todo, doing, done], transitions: [] }
  const pv = await pub({ ...without, dryRun: true })
  assert.deepEqual([pv.body.summary.blocked, pv.body.summary.removed, pv.body.jobId], [[{ status: 'Review', items: 2, projects: ['VER'], more: 0 }], ['Review'], null])
  assert.equal((await pub(without)).status, 409)
  assert.equal((await call('GET', `/api/v1/workflows/${wf}`)).body.version, r1.body.version)
  const todoP = (await call('GET', '/api/v1/projects/VER')).body.statuses.find((s: any) => s.name === 'To do')
  for (const it of items.slice(0, 2)) assert.equal((await call('PATCH', `/api/v1/issues/${it.key}`, { statusId: todoP.id })).status, 200)
  assert.equal((await pub({ ...without, note: 'Without review' })).status, 200)
  const ver = (await call('GET', '/api/v1/projects/VER')).body
  const doingId = ver.statuses.find((s: any) => s.name === 'In progress').id
  assert.equal((await pool.query('select status_id from issues where id = $1', [items[2].id])).rows[0].status_id, doingId)   // the first of its kind
  assert.deepEqual([ver.statuses.length, ver.transitions.length], [3, 0])
  // the project's own board loses the column; a board across projects keeps its columns (another project may use the status)
  assert.deepEqual([await cols(verBoard), await cols(both.id)], [['To do', 'In progress', 'Done'], ['To do', 'In progress', 'Review', 'Done']])
  // versions: read by anyone signed in
  const list = (await call('GET', `/api/v1/workflows/${wf}/versions`)).body
  assert.deepEqual(list.slice(0, 2).map((v: any) => v.note), ['Without review', 'Review step'])
  const two = (await call('GET', `/api/v1/workflows/${wf}/versions/${list[1].version}`)).body
  assert.ok(two.statuses.some((s: any) => s.name === 'Review') && two.transitions.some((t: any) => t.name === 'Back'))
  assert.equal((await call('GET', `/api/v1/workflows/${wf}/versions/99`)).status, 404)
  // only system administrators change workflows, statuses and schemes; a project admin can't
  await join('VER', 'ver.admin@x.com', 'admin')
  const seen = await call('GET', `/api/v1/workflows/${wf}`, undefined, 'ver.admin@x.com')
  assert.deepEqual([seen.status, seen.body.projectCount], [200, 2])                                  // how many use it: anyone; which: only system administrators
  assert.equal((await call('GET', `/api/v1/admin/workflows/${wf}/projects`, undefined, 'ver.admin@x.com')).status, 403)
  assert.equal((await pub(withReview, 'ver.admin@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/admin/workflows', { name: 'Mine' }, 'ver.admin@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/admin/statuses', { name: 'Mine', color: '#000000', category: 'todo' }, 'ver.admin@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/admin/workflow-schemes/${ver.workflowSchemeId}`, { description: 'x' }, 'ver.admin@x.com')).status, 403)
  // in use: a workflow a scheme names, and a scheme a project uses, can't be removed
  assert.equal((await call('DELETE', `/api/v1/admin/workflows/${wf}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/workflow-schemes/${ver.workflowSchemeId}`)).status, 409)
})

test('a workflow used by many projects: counted, listed a page at a time, previewed from the items that could move, applied by a job that carries on past a failing project', { skip, timeout: 120_000 }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const keys = Array.from({ length: 30 }, (_, n) => `MNY${String.fromCharCode(65 + Math.floor(n / 26), 65 + (n % 26))}`)
  for (const key of keys) await call('POST', '/api/v1/projects', { name: `Many ${key}`, key, template: 'kanban' })
  const wfId = (await flow(keys[0]!, [])).workflows[0].workflowId
  const schemeId = (await call('GET', `/api/v1/projects/${keys[0]}`)).body.workflowSchemeId
  for (const key of keys.slice(1)) await call('PUT', `/api/v1/projects/${key}/workflow-scheme`, { schemeId })
  const doing: { key: string }[] = []
  for (const key of keys.slice(0, 5)) doing.push((await call('POST', `/api/v1/projects/${key}/issues`, { title: 'doing', statusId: (await call('GET', `/api/v1/projects/${key}`)).body.statuses[1].id })).body)
  // how many, and which, a page at a time
  assert.equal((await call('GET', `/api/v1/workflows/${wfId}`)).body.projectCount, 30)
  const p1 = (await call('GET', `/api/v1/admin/workflows/${wfId}/projects?limit=20`)).body
  const p2 = (await call('GET', `/api/v1/admin/workflows/${wfId}/projects?limit=20&cursor=${p1.next}`)).body
  assert.deepEqual([p1.items.length, p2.items.length, p2.next, p1.total], [20, 10, null, 30])
  assert.deepEqual([...p1.items, ...p2.items].map((p: any) => p.key), keys)
  assert.deepEqual((await call('GET', `/api/v1/admin/workflow-schemes/${schemeId}/projects?query=MNYB`)).body.items.map((p: any) => p.key), keys.filter(k => k.startsWith('MNYB')))
  // taking In progress out: the preview's counts are what applying then does
  const cur = (await call('GET', `/api/v1/workflows/${wfId}`)).body
  const body = { statuses: cur.statuses.filter((s: any) => s.category !== 'in-progress'), transitions: [] }
  // as in Jira, the 5 items in it stop it leaving (spec 0103): the preview says where, kept short; then they move out
  const blocked = (await call('POST', `/api/v1/admin/workflows/${wfId}/publish`, { ...body, dryRun: true })).body.summary
  assert.deepEqual(blocked.blocked, [{ status: 'In progress', items: 5, projects: keys.slice(0, 3), more: 2 }])
  assert.match((await call('POST', `/api/v1/admin/workflows/${wfId}/publish`, body)).body.error, /^In progress has 5 work items in MNYAA, MNYAB, MNYAC and 2 more\./)
  for (const i of doing) {
    const todo = (await call('GET', `/api/v1/projects/${i.key.split('-')[0]}`)).body.statuses.find((x: any) => x.name === 'To do')
    await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: todo.id })
  }
  const pv = (await call('POST', `/api/v1/admin/workflows/${wfId}/publish`, { ...body, dryRun: true })).body.summary
  assert.deepEqual([pv.projects, pv.changed, pv.itemsMoved, pv.removed, pv.blocked], [30, 30, 0, ['In progress'], []])
  assert.equal(pv.top.length, 10)
  // one project can't be changed (a fault on its statuses): the job records it and applies the rest
  const bad = (await call('GET', `/api/v1/projects/${keys[7]}`)).body.id
  await pool.query(`create function fail_one() returns trigger language plpgsql as $$ begin if old.project_id = '${bad}' then raise exception 'broken project'; end if; return old; end $$`)
  await pool.query('create trigger fail_one before delete on statuses for each row execute function fail_one()')
  try {
    const r = await call('POST', `/api/v1/admin/workflows/${wfId}/publish`, body)
    assert.ok(r.body.jobId)
    // one change at a time: another while it waits is refused
    const again = await call('POST', `/api/v1/admin/workflows/${wfId}/publish`, { ...body, note: 'again', statuses: cur.statuses })
    assert.equal(again.status, 409); assert.match(again.body.error, /still being applied/)
    assert.equal((await call('GET', '/api/v1/admin/workflows/applying')).body.total, 30)
    await runJobs()
    const job = (await call('GET', `/api/v1/jobs/${r.body.jobId}`)).body
    assert.deepEqual([job.status, job.result.applied, job.result.failed.map((f: any) => f.key)], ['done', 29, [keys[7]]])
    assert.match(job.result.failed[0].error, /broken project/)
    assert.equal((await call('GET', '/api/v1/admin/workflows/applying')).body, null)
  } finally { await pool.query('drop trigger fail_one on statuses; drop function fail_one()') }
  for (const key of [keys[0], keys[29]]) assert.deepEqual((await call('GET', `/api/v1/projects/${key}`)).body.statuses.map((s: any) => s.name), ['To do', 'Done'])
  assert.ok((await call('GET', `/api/v1/projects/${keys[7]}`)).body.statuses.some((s: any) => s.name === 'In progress'))      // left as it was
  const moved = (await pool.query(`select count(*)::int as n from issues i join statuses s on s.id = i.status_id join projects p on p.id = i.project_id where p.key like 'MNY%' and s.name = 'To do'`)).rows[0].n
  assert.equal(moved, 5)
  // the message for a scheme in use stays short
  const del = await call('DELETE', `/api/v1/admin/workflow-schemes/${schemeId}`)
  assert.equal(del.status, 409); assert.match(del.body.error, /MNYAA, MNYAB, MNYAC and 27 more/)
})

test('boards: several per project, each with its own filter (across projects too), columns, quick filters and swimlanes; project admins and named board admins change them', { skip, timeout: 120_000 }, async () => {
  // a new project starts with one board: its own items, a column per status, Jira's two quick filters
  const p = (await call('POST', '/api/v1/projects', { name: 'Boarded', key: 'BRD', template: 'kanban' })).body
  assert.deepEqual(p.boards.map((b: any) => [b.name, b.type, b.jql]), [['BRD board', 'kanban', 'project = BRD']])
  const first = (await call('GET', `/api/v1/boards/${p.boards[0].id}`)).body
  assert.deepEqual(first.columns.map((c: any) => c.name), p.statuses.map((s: any) => s.name))
  assert.deepEqual(first.quickFilters.map((q: any) => q.name), ['Only my issues', 'Recently updated'])
  assert.equal(first.doneDays, 14)
  // work in two projects
  await call('POST', '/api/v1/projects', { name: 'Boarded too', key: 'BRE', template: 'kanban' })
  const me = (await call('GET', '/api/v1/me')).body.id
  const mk = (key: string, title: string, extra: object = {}) => call('POST', `/api/v1/projects/${key}/issues`, { title, ...extra }).then(r => r.body)
  const bug = await mk('BRD', 'A bug', { type: 'bug', priority: 'high' }), task = await mk('BRD', 'A task', { assigneeId: me }), other = await mk('BRE', 'Elsewhere', { type: 'bug' })
  // a second board: bugs from both projects, created with a filter and later edited
  await join('BRD', 'brd.member@x.com', 'member'); await join('BRD', 'brd.boss@x.com', 'member')
  assert.equal((await call('POST', '/api/v1/projects/BRD/boards', { name: 'Bugs', type: 'kanban', jql: 'type = Bug' }, 'brd.member@x.com')).status, 403)   // members don't create boards
  const bad = await call('POST', '/api/v1/projects/BRD/boards', { name: 'Bugs', type: 'kanban', jql: 'type = = Bug' })
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.jql)
  const made = await call('POST', '/api/v1/projects/BRD/boards', { name: 'Bugs', type: 'kanban', jql: 'project in (BRD, BRE) AND type = Bug' })
  assert.equal(made.status, 201)
  const bugs = made.body
  const items = async (id: string, q = '', who?: string) => (await call('GET', `/api/v1/boards/${id}/issues${q}`, undefined, who)).body
  assert.deepEqual((await items(bugs.id)).items.map((i: any) => i.key).sort(), [bug.key, other.key].sort())                  // across projects
  assert.deepEqual((await items(p.boards[0].id)).items.map((i: any) => i.key).sort(), [bug.key, task.key].sort())         // the first board is unchanged
  // only what the viewer may see: a member of BRD only doesn't see BRE's bug
  assert.deepEqual((await items(bugs.id, '', 'brd.member@x.com')).items.map((i: any) => i.key), [bug.key])
  // edit the filter later
  const narrowed = await call('PATCH', `/api/v1/boards/${bugs.id}`, { jql: 'project in (BRD, BRE) AND type = Bug AND priority in (high, urgent)' })
  assert.equal(narrowed.status, 200)
  assert.deepEqual((await items(bugs.id)).items.map((i: any) => i.key), [bug.key])
  // the statuses its columns can name: its project's and those of the projects its filter finds work in
  await flow('BRE', [], { add: [{ id: crypto.randomUUID(), name: 'Triage', color: '#a855f7', category: 'todo' }] })
  const can = async (who?: string) => (await call('GET', `/api/v1/boards/${bugs.id}/statuses`, undefined, who)).body.map((x: any) => x.name)
  assert.ok((await can()).includes('Triage'))
  assert.ok(!(await can('brd.member@x.com')).includes('Triage'))                        // not from a project they can't see
  // quick filters AND the board filter
  const mine = first.quickFilters.find((q: any) => q.name === 'Only my issues').id
  assert.deepEqual((await items(p.boards[0].id, `?quick=${mine}`)).items.map((i: any) => i.key), [task.key])
  assert.equal((await call('GET', `/api/v1/boards/${p.boards[0].id}/issues?quick=nope`)).status, 400)
  // swimlane queries: each item in the first that matches
  const lanes = await call('PATCH', `/api/v1/boards/${p.boards[0].id}`, { swimlanes: { by: 'queries', queries: [{ name: 'Bugs', jql: 'type = Bug' }, { name: 'High', jql: 'priority = high' }] } })
  const bugLane = lanes.body.swimlanes.queries[0].id
  const lanedR = await items(p.boards[0].id)
  assert.ok(lanedR.items, JSON.stringify(lanedR))
  const laned = lanedR.items
  assert.equal(laned.find((i: any) => i.key === bug.key).lane, bugLane)                 // a high-priority bug: in "Bugs", the first match
  assert.equal(laned.find((i: any) => i.key === task.key).lane, '')
  // Kanban: Done items not updated for longer than doneDays are left out
  const done = p.statuses.find((s: any) => s.category === 'done')
  const old = await mk('BRD', 'Long done', { statusId: done.id })
  await pool.query(`update issues set updated_at = now() - interval '30 days' where id = $1`, [old.id])
  assert.ok(!(await items(p.boards[0].id)).items.some((i: any) => i.key === old.key))
  assert.ok((await items(p.boards[0].id, '?scope=all')).items.some((i: any) => i.key === old.key))
  // columns: statuses mapped, two to one column; a status twice or an unknown one is refused
  const [todoG, doingG, doneG] = p.statuses.map((s: any) => s.globalStatusId)
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { columns: [{ name: 'Open', statusIds: [todoG, doingG], max: 3 }, { name: 'Closed', statusIds: [doneG] }] })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { columns: [{ name: 'A', statusIds: [todoG] }, { name: 'B', statusIds: [todoG] }] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { columns: [{ name: 'A', statusIds: ['00000000-0000-4000-8000-000000000000'] }] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { columns: [{ name: 'A', statusIds: [todoG], min: 5, max: 2 }] })).status, 400)
  // a named board admin (here, through a group) may change it; a member may not; the project's admins may
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { name: 'x' }, 'brd.boss@x.com')).status, 403)
  const team = (await call('POST', '/api/v1/groups', { name: 'brd-board-admins' })).body
  await call('POST', `/api/v1/groups/${team.id}/members`, { userIds: [(await call('GET', '/api/v1/me', undefined, 'brd.boss@x.com')).body.id] })
  await call('PATCH', `/api/v1/boards/${bugs.id}`, { admins: { userIds: [me], groupIds: [team.id] } })
  // administrators must be real: an unknown person or group is refused, not skipped
  const ghost = '00000000-0000-4000-8000-000000000000'
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { admins: { userIds: [me, ghost], groupIds: [] } })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/boards/${bugs.id}`, { admins: { userIds: [me], groupIds: [ghost] } })).status, 400)
  const renamed = await call('PATCH', `/api/v1/boards/${bugs.id}`, { name: 'Bug triage' }, 'brd.boss@x.com')
  assert.deepEqual([renamed.status, renamed.body.name, renamed.body.canManage], [200, 'Bug triage', true])
  assert.equal((await call('GET', '/api/v1/projects/BRD/boards', undefined, 'brd.boss@x.com')).body.find((b: any) => b.id === bugs.id).canManage, true)
  assert.equal((await call('GET', `/api/v1/boards/${bugs.id}`, undefined, 'brd.member@x.com')).body.canManage, false)
  assert.equal((await call('GET', `/api/v1/boards/${bugs.id}`, undefined, 'brd.outsider@x.com')).status, 404)
  // checking a query: how many it finds, or where it is wrong
  assert.equal((await call('POST', '/api/v1/jql/check', { jql: 'project = BRD AND type = Bug' })).body.count, 1)
  assert.equal((await call('POST', '/api/v1/jql/check', { jql: 'project = (' })).status, 400)
  // deleting: not a project's last board
  assert.equal((await call('DELETE', `/api/v1/boards/${bugs.id}`, undefined, 'brd.member@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/boards/${bugs.id}`)).status, 204)
  assert.equal((await call('DELETE', `/api/v1/boards/${p.boards[0].id}`)).status, 409)
  assert.ok((await call('GET', '/api/v1/audit?action=board.')).body.items.some((x: any) => x.action === 'board.created'))
})

test('[0101.R2][0101.R5][0101.R6][0101.R7][0101.R8] sprint actions need the right to change work in every project the board’s filter names; a refusal names what is missing and changes nothing', { skip }, async () => {
  for (const key of ['SMA', 'SMB', 'SMC']) await call('POST', '/api/v1/projects', { name: `Sprint mgmt ${key}`, key, template: 'scrum' })
  const board = (await call('POST', '/api/v1/projects/SMA/boards', { name: 'Two teams', type: 'scrum', jql: 'project in (SMA, SMB)' })).body
  const one = 'sm.one@x.com', both = 'sm.both@x.com', viewerA = 'sm.viewer@x.com'
  // since spec 0203, managing sprints is for project admins: "able to manage" below means admin
  await join('SMA', one, 'admin'); await join('SMB', one, 'viewer'); await join('SMA', both, 'admin'); await join('SMB', both, 'admin')
  await join('SMA', viewerA, 'viewer'); await join('SMB', viewerA, 'admin'); await join('SMC', viewerA, 'admin')
  const item = (await call('POST', '/api/v1/projects/SMB/issues', { title: 'From B' })).body
  const s = (await call('POST', '/api/v1/projects/SMA/sprints', { name: 'Train 1', boardId: board.id })).body
  await call('PATCH', `/api/v1/issues/${item.key}`, { sprintId: s.id })
  const base = `/api/v1/projects/SMA/sprints/${s.id}`
  const ends = { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() }
  // R2 + R5: a member of only the board's project is refused each action, with SMB named; nothing changes
  for (const [m, path, body] of [['POST', '/api/v1/projects/SMA/sprints', { name: 'x', boardId: board.id }], ['PATCH', base, { name: 'x' }], ['POST', `${base}/start`, ends], ['DELETE', base, undefined]] as const) {
    const r = await call(m, path, body, one)
    assert.equal(r.status, 403, `${m} ${path}`); assert.match(r.body.error, /every project it covers: SMB$/)
  }
  assert.equal((await call('GET', `/api/v1/boards/${board.id}`)).body.name, 'Two teams')
  assert.equal((await pool.query('select name, state from sprints where id = $1', [s.id])).rows[0].name, 'Train 1')
  // R7: who may manage sprints is on the board and in the board list
  assert.equal((await call('GET', `/api/v1/boards/${board.id}`, undefined, one)).body.canManageSprints, false)
  assert.equal((await call('GET', '/api/v1/projects/SMA/boards', undefined, both)).body.find((b: any) => b.id === board.id).canManageSprints, true)
  // R8: a viewer of the board's project who is a member of every project its filter names may manage them
  const bOnly = (await call('POST', '/api/v1/projects/SMA/boards', { name: 'B only', type: 'scrum', jql: 'project = SMB' })).body
  assert.equal((await call('POST', '/api/v1/projects/SMA/sprints', { name: 'B sprint', boardId: bOnly.id }, viewerA)).status, 201)
  assert.equal((await call('POST', '/api/v1/projects/SMA/sprints', { name: 'x', boardId: board.id }, viewerA)).status, 403)   // not for a board naming SMA
  assert.equal((await call('POST', `${base}/start`, ends, both)).status, 200)
  // R6: reading is unchanged: the viewer and the one-project member see the sprint and the board
  assert.equal((await call('GET', `/api/v1/boards/${board.id}/issues?scope=backlog`, undefined, one)).status, 200)
  assert.ok((await call('GET', '/api/v1/projects/SMA', undefined, one)).body.sprints.some((x: any) => x.id === s.id))
  // R2: completing as the one-project member is refused, and B's item stays in the sprint; a member of both completes it
  const refused = await call('POST', `${base}/complete`, { moveTo: null }, one)
  assert.equal(refused.status, 403)
  assert.deepEqual([(await pool.query('select state from sprints where id = $1', [s.id])).rows[0].state, (await call('GET', `/api/v1/issues/${item.key}`)).body.sprintId], ['active', s.id])
  assert.equal((await call('POST', `${base}/complete`, { moveTo: null }, both)).status, 200)
  assert.equal((await call('GET', `/api/v1/issues/${item.key}`)).body.sprintId, null)
  // R5: projects the person can't see are counted, not named
  const wide = (await call('POST', '/api/v1/projects/SMA/boards', { name: 'Three', type: 'scrum', jql: 'project in (SMA, SMB, SMC)' })).body
  const r = await call('POST', '/api/v1/projects/SMA/sprints', { name: 'y', boardId: wide.id }, one)
  assert.equal(r.status, 403); assert.match(r.body.error, /: SMB and 1 more$/)
  await join('SMC', 'sm.c@x.com', 'admin'); await join('SMA', 'sm.c@x.com', 'admin')
  assert.match((await call('POST', '/api/v1/projects/SMA/sprints', { name: 'z', boardId: board.id }, 'sm.c@x.com')).body.error, /covers, including one you can’t see$/)
})

test('[0101.R3] a board whose filter can include any project: only someone who can change work in every project manages its sprints', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Open filter', key: 'SMO', template: 'scrum' })
  const board = (await call('POST', '/api/v1/projects/SMO/boards', { name: 'Bugs anywhere', type: 'scrum', jql: 'project = SMO OR type = Bug' })).body
  await join('SMO', 'sm.open@x.com', 'admin')
  const r = await call('POST', '/api/v1/projects/SMO/sprints', { name: 'x', boardId: board.id }, 'sm.open@x.com')
  assert.equal(r.status, 403); assert.match(r.body.error, /can include any project/)
  assert.equal((await call('GET', `/api/v1/boards/${board.id}`, undefined, 'sm.open@x.com')).body.canManageSprints, false)
  assert.equal((await call('POST', '/api/v1/projects/SMO/sprints', { name: 'x', boardId: board.id })).status, 201)   // a global admin
})

test('[0101.R9][0101.R10] completing a sprint: unfinished work to the backlog, a future sprint of the board or a new sprint; a Done item with unfinished sub-items blocks it', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Completing', key: 'CMP', template: 'scrum' })).body
  const done = p.statuses.find((x: any) => x.category === 'done').id
  const other = (await call('POST', '/api/v1/projects/CMP/boards', { name: 'Other', type: 'scrum', jql: 'project = CMP' })).body
  const ends = { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() }
  const sprint = async (name: string, boardId?: string) => (await call('POST', '/api/v1/projects/CMP/sprints', { name, ...(boardId ? { boardId } : {}) })).body
  const mk = (title: string, extra: object = {}) => call('POST', '/api/v1/projects/CMP/issues', { title, ...extra }).then(r => r.body)
  const s1 = await sprint('Sprint A'), elsewhere = await sprint('Elsewhere', other.id)
  const parent = await mk('Parent', { sprintId: s1.id }), child = await mk('Child', { sprintId: s1.id, parentId: parent.id })
  const open = await mk('Open', { sprintId: s1.id })
  await call('POST', `/api/v1/projects/CMP/sprints/${s1.id}/start`, ends)
  // R10: the parent is Done, its sub-item isn't: refused, nothing changes
  await call('PATCH', `/api/v1/issues/${parent.key}`, { statusId: done })
  const blocked = await call('POST', `/api/v1/projects/CMP/sprints/${s1.id}/complete`, { moveTo: null })
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, `Complete the sub-items first: ${parent.key}`)
  assert.equal((await pool.query('select state from sprints where id = $1', [s1.id])).rows[0].state, 'active')
  // R9: another board's sprint is refused; "new" makes a planned sprint on the same board and moves the unfinished work there
  await call('PATCH', `/api/v1/issues/${child.key}`, { statusId: done })
  assert.equal((await call('POST', `/api/v1/projects/CMP/sprints/${s1.id}/complete`, { moveTo: elsewhere.id })).status, 400)
  const made = await call('POST', `/api/v1/projects/CMP/sprints/${s1.id}/complete`, { moveTo: 'new' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.deepEqual([made.body.state, made.body.newSprint.state, made.body.newSprint.boardId, made.body.newSprint.name], ['closed', 'planned', s1.boardId, 'CMP Sprint 3'])
  assert.equal((await call('GET', `/api/v1/issues/${open.key}`)).body.sprintId, made.body.newSprint.id)
  assert.equal((await call('GET', `/api/v1/issues/${parent.key}`)).body.sprintId, s1.id)               // finished work stays
  // R9: a future sprint of the board, then the backlog; a completed sprint can't take work
  const s3 = await sprint('Sprint C')
  await call('POST', `/api/v1/projects/CMP/sprints/${made.body.newSprint.id}/start`, ends)
  assert.equal((await call('POST', `/api/v1/projects/CMP/sprints/${made.body.newSprint.id}/complete`, { moveTo: s1.id })).status, 400)
  assert.equal((await call('POST', `/api/v1/projects/CMP/sprints/${made.body.newSprint.id}/complete`, { moveTo: s3.id })).status, 200)
  assert.equal((await call('GET', `/api/v1/issues/${open.key}`)).body.sprintId, s3.id)
  await call('POST', `/api/v1/projects/CMP/sprints/${s3.id}/start`, ends)
  await call('POST', `/api/v1/projects/CMP/sprints/${s3.id}/complete`, { moveTo: null })
  assert.equal((await call('GET', `/api/v1/issues/${open.key}`)).body.sprintId, null)
})

test('[0102.R1][0102.R2][0102.R3][0102.R4][0102.R6][0102.R7][0102.R8][0102.R9] an archived project: only global admins archive and restore; read-only for everyone, hidden from lists, search and boards; its items still open by key', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Shelved', key: 'ARC', template: 'scrum' })).body
  await call('POST', '/api/v1/projects', { name: 'Still going', key: 'ARD', template: 'scrum' })
  const adm = 'arc.admin@x.com', mem = 'arc.member@x.com'
  await join('ARC', adm, 'admin'); await join('ARC', mem); await join('ARD', mem)
  const me = (await call('GET', '/api/v1/me', undefined, mem)).body.id
  const item = (await call('POST', '/api/v1/projects/ARC/issues', { title: 'Shelved work', assigneeId: me })).body
  const comment = (await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'before' }, mem)).body
  const log = (await call('POST', `/api/v1/issues/${item.key}/worklogs`, { minutes: 30, date: '2026-11-01' }, mem)).body
  const version = (await call('POST', '/api/v1/projects/ARC/releases', { name: '1.0' })).body
  // a board in another project whose filter names it, and a sprint there holding the archived project's work
  const both = (await call('POST', '/api/v1/projects/ARD/boards', { name: 'Both', type: 'scrum', jql: 'project in (ARC, ARD)' })).body
  const other = (await call('POST', '/api/v1/projects/ARD/issues', { title: 'Other work' })).body
  const sprint = (await call('POST', '/api/v1/projects/ARD/sprints', { name: 'Both 1', boardId: both.id })).body
  for (const k of [item.key, other.key]) await call('PATCH', `/api/v1/issues/${k}`, { sprintId: sprint.id })
  await call('POST', `/api/v1/projects/ARD/sprints/${sprint.id}/start`, { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() })

  // R1: a project admin can't archive; a global admin can, and it is audited with who did it
  assert.equal((await call('POST', '/api/v1/projects/ARC/archive', undefined, adm)).status, 403)
  assert.equal((await call('POST', '/api/v1/projects/ARC/archive')).status, 200)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'project.archived' and target_id = $1`, [p.id])).rows.length)

  // R2: nothing in it changes, for anyone, global admins included
  const refused = async (who: string | undefined, m: string, path: string, body?: unknown) => {
    const r = await call(m, `/api/v1${path}`, body, who)
    assert.deepEqual([r.status, r.body?.error], [403, 'This project is archived. A system administrator can restore it to change it.'], `${m} ${path} as ${who ?? 'owner'}`)
  }
  for (const who of [mem, adm, undefined]) {
    await refused(who, 'PATCH', `/issues/${item.key}`, { title: 'changed' })
    await refused(who, 'POST', '/projects/ARC/issues', { title: 'new' })
    await refused(who, 'POST', `/issues/${item.key}/comments`, { body: 'more' })
    await refused(who, 'PUT', `/issues/${item.key}/watch`)
    await refused(who, 'POST', `/issues/${item.key}/worklogs`, { minutes: 5, date: '2026-11-01' })
    await refused(who, 'POST', '/projects/ARC/sprints', { name: 'x' })
    await refused(who, 'PATCH', `/projects/ARC/releases/${version.id}`, { name: '1.1' })
    await refused(who, 'POST', '/projects/ARC/components', { name: 'API' })
    await refused(who, 'PATCH', '/projects/ARC', { name: 'Renamed' })
    await refused(who, 'PATCH', `/boards/${p.boards[0].id}`, { name: 'x' })
  }
  await refused(mem, 'PATCH', `/comments/${comment.id}`, { body: 'edited' })
  await refused(mem, 'DELETE', `/worklogs/${log.id}`)
  await refused(undefined, 'POST', '/projects/ARC/members', { userIds: [me], role: 'admin' })
  assert.equal((await call('GET', `/api/v1/issues/${item.key}`)).body.title, 'Shelved work')

  // R3: hidden from search, counts, export, other projects' boards, Your work and the project lists
  const keys = (r: any) => (r.body.items ?? r.body).map((x: any) => x.key)
  assert.ok(!keys(await call('GET', '/api/v1/search?q=Shelved')).includes(item.key))
  assert.equal((await call('POST', '/api/v1/jql/check', { jql: 'project = ARC' })).body.count, 0)
  assert.ok(!(await app.inject({ method: 'GET', url: '/api/v1/search/export.csv?q=Shelved', headers: { 'x-dev-user': 'owner@x.com' } })).body.includes(item.key))
  assert.deepEqual(keys(await call('GET', `/api/v1/boards/${both.id}/issues`)), [other.key])
  assert.ok(!keys(await call('GET', '/api/v1/me/work', undefined, mem)).includes(item.key))
  assert.ok(!(await call('GET', '/api/v1/projects')).body.some((x: any) => x.key === 'ARC'))
  assert.ok(!(await call('GET', '/api/v1/projects/search?query=ARC')).body.items.some((x: any) => x.key === 'ARC'))
  // R4: its items still open by their key, read-only, and recording that I opened it works
  const opened = await call('GET', `/api/v1/issues/${item.key}`, undefined, mem)
  assert.equal(opened.status, 200)
  assert.equal((await call('POST', `/api/v1/issues/${item.key}/view`, undefined, mem)).status, 204)
  assert.equal((await call('GET', '/api/v1/projects/ARC', undefined, mem)).body.role, 'viewer')
  // R6: completing the other board's sprint leaves the archived project's item where it was
  assert.equal((await call('POST', `/api/v1/projects/ARD/sprints/${sprint.id}/complete`, { moveTo: null })).status, 200)   // a global admin (sprints: project admins, 0203)
  assert.deepEqual([(await call('GET', `/api/v1/issues/${item.key}`)).body.sprintId, (await call('GET', `/api/v1/issues/${other.key}`)).body.sprintId], [sprint.id, null])

  // R7: Administration › Archived projects, global admins only, newest first, searchable
  assert.equal((await call('GET', '/api/v1/admin/archived-projects', undefined, adm)).status, 403)
  const listed = (await call('GET', '/api/v1/admin/archived-projects?query=shelv')).body
  assert.deepEqual(listed.items.map((x: any) => [x.key, x.archivedBy]), [['ARC', 'owner']])
  // R1 + R9: a project admin can't restore; a global admin restores, and it is as it was
  assert.equal((await call('POST', '/api/v1/projects/ARC/restore', undefined, adm)).status, 403)
  assert.equal((await call('POST', '/api/v1/projects/ARC/restore')).status, 200)
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'Back to work' }, mem)).status, 200)
  assert.ok(keys(await call('GET', '/api/v1/search?q=Back')).includes(item.key))
  assert.equal((await call('GET', '/api/v1/admin/archived-projects?query=Shelved')).body.items.length, 0)
  // R8: a global admin can delete an archived project without restoring it
  await call('POST', '/api/v1/projects/ARC/archive')
  const del = await call('DELETE', '/api/v1/projects/ARC')
  assert.equal(del.status, 202, JSON.stringify(del.body))
})

test('[0103.R1][0103.R2][0103.R3][0103.R4][0103.R5][0103.R6] active workflows keep their name and any status with work; only global admins switch a project’s scheme; copy and switch moves the work', { skip }, async () => {
  // R1: a new workflow, in a scheme no project uses yet, is inactive: it can be renamed
  const wf = (await call('POST', '/api/v1/admin/workflows', { name: 'Act flow' })).body
  const base = (await call('GET', `/api/v1/workflows/${wf.id}`)).body
  const review = { id: crypto.randomUUID(), name: 'Act review', color: '#a855f7', category: 'in-progress', description: '' }
  const [first, last] = base.statuses
  assert.equal((await call('POST', `/api/v1/admin/workflows/${wf.id}/publish`, { statuses: [first, review, last], transitions: [] })).status, 200)
  const sc = (await call('POST', '/api/v1/admin/workflow-schemes', { name: 'Act scheme', defaultWorkflowId: wf.id, mappings: {} })).body
  assert.equal((await call('PATCH', `/api/v1/admin/workflows/${wf.id}`, { name: 'Act flow 2' })).status, 200)
  // R5: a project admin can't switch their project's scheme, not even to preview it; a global admin does
  await call('POST', '/api/v1/projects', { name: 'Activated', key: 'ACT', template: 'kanban' })
  await join('ACT', 'act.admin@x.com', 'admin')
  for (const body of [{ schemeId: sc.id }, { schemeId: sc.id, dryRun: true }])
    assert.equal((await call('PUT', '/api/v1/projects/ACT/workflow-scheme', body, 'act.admin@x.com')).status, 403)
  assert.equal((await call('PUT', '/api/v1/projects/ACT/workflow-scheme', { schemeId: sc.id })).status, 200)
  // R2: now active: the name stays, the description changes
  const renamed = await call('PATCH', `/api/v1/admin/workflows/${wf.id}`, { name: 'Act flow 3' })
  assert.deepEqual([renamed.status, renamed.body.errors?.name], [400, 'In use'])
  assert.equal((await call('PATCH', `/api/v1/admin/workflows/${wf.id}`, { description: 'For the act team' })).body.description, 'For the act team')
  // R3: a status with work can't leave; nothing is saved
  const p = (await call('GET', '/api/v1/projects/ACT')).body
  const inReview = (await call('POST', '/api/v1/projects/ACT/issues', { title: 'Under review', statusId: p.statuses.find((x: any) => x.name === 'Act review').id })).body
  const v = (await call('GET', `/api/v1/workflows/${wf.id}`)).body.version
  const refused = await call('POST', `/api/v1/admin/workflows/${wf.id}/publish`, { statuses: [first, last], transitions: [] })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'Act review has 1 work item in ACT. Move them to another status first, or copy the workflow and switch the projects to the copy.')
  assert.equal((await call('GET', `/api/v1/workflows/${wf.id}`)).body.version, v)
  // R4: a status map is no longer taken; a dry run lists what blocks
  assert.equal((await call('POST', `/api/v1/admin/workflows/${wf.id}/publish`, { statuses: [first, last], transitions: [], statusMap: { [review.id]: first.id } })).status, 400)
  assert.deepEqual((await call('POST', `/api/v1/admin/workflows/${wf.id}/publish`, { statuses: [first, last], transitions: [], dryRun: true })).body.summary.blocked,
    [{ status: 'Act review', items: 1, projects: ['ACT'], more: 0 }])
  // R6: copy the workflow, take the status out of the copy, switch the project to a scheme using it: the work moves as mapped
  const copy = (await call('POST', '/api/v1/admin/workflows', { name: 'Act lean', copyFrom: wf.id })).body
  assert.equal((await call('POST', `/api/v1/admin/workflows/${copy.id}/publish`, { statuses: [first, last], transitions: [] })).status, 200)
  const lean = (await call('POST', '/api/v1/admin/workflow-schemes', { name: 'Act lean scheme', defaultWorkflowId: copy.id, mappings: {} })).body
  assert.equal((await call('PUT', '/api/v1/projects/ACT/workflow-scheme', { schemeId: lean.id, statusMap: { [review.id]: last.id } })).status, 200)
  const q = (await call('GET', '/api/v1/projects/ACT')).body
  assert.equal((await call('GET', `/api/v1/issues/${inReview.key}`)).body.statusId, q.statuses.find((x: any) => x.name === last.name).id)
  assert.ok((await call('GET', `/api/v1/workflows/${wf.id}`)).body.statuses.some((x: any) => x.name === 'Act review'))   // the original is untouched
})

test('[0102.R10] a system administrator’s scheme change still reaches an archived project, moving its items out of a status the new workflow lacks', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Shelved flow', key: 'ARF', template: 'kanban' })
  const p = await flow('ARF', [])
  const doing = p.statuses.find((x: any) => x.name === 'In progress')
  const item = (await call('POST', '/api/v1/projects/ARF/issues', { title: 'Half done', statusId: doing.id })).body
  await call('POST', '/api/v1/projects/ARF/archive')
  // a workflow without In progress (inactive, so free to change), then the project's scheme switched to it with a map
  const cur = (await call('GET', `/api/v1/workflows/${p.workflows[0].workflowId}`)).body
  const [todo, mid, done] = cur.statuses
  const lean = (await call('POST', '/api/v1/admin/workflows', { name: 'ARF lean' })).body
  assert.equal((await call('POST', `/api/v1/admin/workflows/${lean.id}/publish`, { statuses: [todo, done], transitions: [] })).status, 200)
  const r = await call('PATCH', `/api/v1/admin/workflow-schemes/${p.workflowSchemeId}`, { defaultWorkflowId: lean.id, statusMap: { [mid.id]: todo.id } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const { runJobs } = await import('../src/jobs.ts'); await runJobs()
  const now = (await call('GET', `/api/v1/issues/${item.key}`)).body
  assert.equal(now.statusId, (await call('GET', '/api/v1/projects/ARF')).body.statuses.find((x: any) => x.name === 'To do').id)
})

test('scrum boards: each has its own sprints, one active at a time; a sprint holds work from every project its board covers; its backlog is its filter’s unfinished work', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Sprinted', key: 'SPB', template: 'scrum' })).body
  await call('POST', '/api/v1/projects', { name: 'Sprinted too', key: 'SPC', template: 'scrum' })
  const both = (await call('POST', '/api/v1/projects/SPB/boards', { name: 'Both', type: 'scrum', jql: 'project in (SPB, SPC)' })).body
  const own = p.boards[0].id
  const mk = (key: string, title: string, extra: object = {}) => call('POST', `/api/v1/projects/${key}/issues`, { title, ...extra }).then(r => r.body)
  // sprints on each board; without one named, a sprint goes on the project's first Scrum board
  const s1 = (await call('POST', '/api/v1/projects/SPB/sprints', { name: 'Own 1' })).body
  const s2 = (await call('POST', '/api/v1/projects/SPB/sprints', { name: 'Both 1', boardId: both.id })).body
  const s3 = (await call('POST', '/api/v1/projects/SPB/sprints', { name: 'Both 2', boardId: both.id })).body
  assert.deepEqual([s1.boardId, s2.boardId], [own, both.id])
  assert.equal((await call('POST', '/api/v1/projects/SPB/sprints', { name: 'x', boardId: '00000000-0000-4000-8000-000000000000' })).status, 400)
  // a sprint holds work from both projects
  const a = await mk('SPB', 'Here', { sprintId: s2.id, estimate: 3 }), b = await mk('SPC', 'There', { sprintId: s2.id, estimate: 5 })
  const loose = await mk('SPC', 'In the backlog')
  // one active sprint per board, not per project
  const start = (id: string) => call('POST', `/api/v1/projects/SPB/sprints/${id}/start`, { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() })
  assert.equal((await start(s1.id)).status, 200)
  assert.equal((await start(s2.id)).status, 200)
  assert.equal((await start(s3.id)).status, 409)
  const shown = async (id: string, scope = 'board') => (await call('GET', `/api/v1/boards/${id}/issues?scope=${scope}`)).body.items.map((i: any) => i.key).sort()
  assert.deepEqual(await shown(both.id), [a.key, b.key].sort())                                  // the active sprint, both projects
  assert.deepEqual(await shown(own), [])                                                        // its own sprint is empty
  assert.deepEqual(await shown(both.id, 'backlog'), [a.key, b.key, loose.key].sort())           // unfinished, not in a completed sprint
  // a completed sprint can't take work; completing moves unfinished work from both projects
  const doneB = (await call('GET', '/api/v1/projects/SPC')).body.statuses.find((x: any) => x.category === 'done').id
  await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: doneB })
  assert.equal((await call('POST', `/api/v1/projects/SPB/sprints/${s2.id}/complete`, { moveTo: s1.id })).status, 400)   // another board's sprint
  const closed = await call('POST', `/api/v1/projects/SPB/sprints/${s2.id}/complete`, { moveTo: s3.id })
  assert.equal(closed.status, 200); assert.deepEqual([closed.body.committed, closed.body.completed], [8, 5])
  assert.equal((await call('GET', `/api/v1/issues/${a.key}`)).body.sprintId, s3.id)
  assert.equal((await call('GET', `/api/v1/issues/${b.key}`)).body.sprintId, s2.id)
  assert.equal((await call('PATCH', `/api/v1/issues/${loose.key}`, { sprintId: s2.id })).status, 400)
  // only a sprint I can see
  await join('SPC', 'spc.member@x.com', 'member')
  assert.equal((await call('PATCH', `/api/v1/issues/${loose.key}`, { sprintId: s3.id }, 'spc.member@x.com')).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${loose.key}`, { sprintId: s3.id })).status, 200)
  // JQL finds a sprint's work by name in every project
  assert.equal((await call('POST', '/api/v1/jql/check', { jql: 'sprint = "Both 2"' })).body.count, 2)
})

test('workflow schemes: each work type follows its own workflow, new work starts at its start, a type change needs a status of the new one; project admins choose the scheme', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Schemed', key: 'WFS', template: 'kanban' })).body
  const [todo, doing, done] = p.statuses
  const doneG = (await call('GET', `/api/v1/workflows/${p.workflows[0].workflowId}`)).body.statuses.find((s: any) => s.category === 'done')
  // bugs are triaged first, and only a done parent lets them be fixed
  const triage = { id: crypto.randomUUID(), name: 'Triage', color: '#f97316', category: 'todo', description: '' }
  const bw = (await call('POST', '/api/v1/admin/workflows', { name: 'Bug flow' })).body
  assert.equal((await call('POST', `/api/v1/admin/workflows/${bw.id}/publish`, { statuses: [triage, doneG],
    transitions: [{ id: 'fix', name: 'Fixed', fromIds: [triage.id], toId: doneG.id, rules: { validate: [{ kind: 'parentStatus', statusIds: [doneG.id] }] } }] })).status, 200)
  const sc = (await call('POST', '/api/v1/admin/workflow-schemes', { name: 'Bugs triaged', defaultWorkflowId: p.workflows[0].workflowId, mappings: { bug: bw.id } })).body
  const story = (await call('POST', '/api/v1/projects/WFS/issues', { title: 'Story', type: 'story', statusId: doing.id })).body
  const bug = (await call('POST', '/api/v1/projects/WFS/issues', { title: 'Bug', type: 'bug' })).body
  // a project admin chooses it (a member can't); the preview says the bug moves to Triage and changes nothing
  await join('WFS', 'wfs.admin@x.com', 'admin'); await join('WFS', 'wfs.member@x.com', 'member')
  assert.equal((await call('PUT', '/api/v1/projects/WFS/workflow-scheme', { schemeId: sc.id }, 'wfs.member@x.com')).status, 403)
  const pv = await call('PUT', '/api/v1/projects/WFS/workflow-scheme', { schemeId: sc.id, dryRun: true })
  assert.deepEqual(pv.body.moves, [{ type: 'bug', from: 'To do', to: 'Triage', count: 1 }], JSON.stringify(pv))
  assert.equal((await call('GET', '/api/v1/projects/WFS')).body.workflowSchemeId, p.workflowSchemeId)
  assert.equal((await call('PUT', '/api/v1/projects/WFS/workflow-scheme', { schemeId: sc.id }, 'wfs.admin@x.com')).status, 403)   // spec 0103: Jira administrators switch schemes
  assert.equal((await call('PUT', '/api/v1/projects/WFS/workflow-scheme', { schemeId: sc.id })).status, 200)
  const q = (await call('GET', '/api/v1/projects/WFS')).body
  assert.deepEqual(q.statuses.map((s: any) => s.name), ['To do', 'Triage', 'In progress', 'Done'])          // board columns by category
  const tri = q.statuses.find((s: any) => s.name === 'Triage')
  assert.equal((await call('GET', `/api/v1/issues/${bug.key}`)).body.statusId, tri.id)
  assert.deepEqual(q.transitions.find((t: any) => t.name === 'Fixed').rules.validate[0].statusIds, [done.id])   // the rule names the project's status
  // new work starts where its type's workflow starts; a bug moves only along the bug workflow
  assert.equal((await call('POST', '/api/v1/projects/WFS/issues', { title: 'Bug 2', type: 'bug' })).body.statusId, tri.id)
  assert.equal((await call('POST', '/api/v1/projects/WFS/issues', { title: 'Story 2', type: 'story' })).body.statusId, todo.id)
  assert.equal((await call('POST', '/api/v1/projects/WFS/issues', { title: 'Bug 3', type: 'bug', statusId: doing.id })).status, 400)
  assert.deepEqual((await call('GET', `/api/v1/issues/${bug.key}/transitions`)).body.map((t: any) => t.name), ['Fixed'])
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { statusId: doing.id })).status, 409)
  // a story becoming a bug needs a status in the bug workflow
  const retype = await call('PATCH', `/api/v1/issues/${story.key}`, { type: 'bug' })
  assert.equal(retype.status, 400); assert.ok(retype.body.errors.statusId)
  // …where it lands (its kind of status, else the start), not anywhere: a type change is no way round the bug workflow's rules
  assert.equal((await call('PATCH', `/api/v1/issues/${story.key}`, { type: 'bug', statusId: done.id }, 'wfs.member@x.com')).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${story.key}`, { type: 'bug', statusId: tri.id })).body.statusId, tri.id)
  // everyone in the project sees which workflow each type uses
  const seen = (await call('GET', '/api/v1/projects/WFS/workflow', undefined, 'wfs.member@x.com')).body
  assert.deepEqual([seen.scheme.name, seen.types.find((t: any) => t.typeKey === 'bug').workflow], ['Bugs triaged', 'Bug flow'])
  // a project admin can set the board's WIP limit, and nothing else about a status
  assert.equal((await call('PATCH', `/api/v1/projects/WFS/statuses/${doing.id}`, { wipLimit: 4 }, 'wfs.admin@x.com')).body.wipLimit, 4)
  assert.equal((await call('PATCH', `/api/v1/projects/WFS/statuses/${doing.id}`, { name: 'Doing' }, 'wfs.admin@x.com')).status, 400)
  assert.equal((await call('PATCH', `/api/v1/projects/WFS/statuses/${doing.id}`, { wipLimit: 2 }, 'wfs.member@x.com')).status, 403)
  // and only a system administrator deletes a project
  assert.equal((await call('DELETE', '/api/v1/projects/WFS', undefined, 'wfs.admin@x.com')).status, 403)
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
  // since spec 0203 a view is shared only with my groups and projects: Ann is in both
  await pool.query('insert into group_members (group_id, user_id) values ($1, $2)', [grp, ann]); await join('FLT', 'flt.ann@x.com')
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
  const admin = (await call('GET', '/api/v1/admin/views?ownerLeft=1')).body
  assert.ok(admin.items.some((v: any) => v.id === toProject.id && v.ownerActive === false))
  assert.ok(admin.items.every((v: any) => v.ownerActive === false) && admin.total >= 1)
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
  const csv = (await app.inject({ method: 'GET', url: `/api/v1/search/export.csv?jql=${encodeURIComponent('project = JQL AND type = bug ORDER BY priority ASC')}`, headers: { 'x-dev-user': 'owner@x.com' } })).body
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
  const bad = (await call('POST', '/api/v1/projects/AAL/rules', { name: 'Broken', trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }] }, 'aal.admin@x.com')).body
  await pool.query(`update rules set actions = '[{"kind": "priority", "value": "bogus"}]' where id = $1`, [bad.id])   // broken since it was saved (saving checks priorities: spec 0305)
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

test('[0307.R3] CSV import: a dry run checks every row; the import runs as a job; running it again adds nothing twice', { skip, timeout: 60_000 }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'From CSV', key: 'CSV', template: 'kanban' })).body
  await join('CSV', 'imp.ann@x.com')
  await call('POST', '/api/v1/projects/CSV/components', { name: 'API' })
  const [{ id: team }] = (await pool.query(`insert into field_defs (project_id, name, kind, options) values ($1, 'Team', 'select', '[{"id":"o1","name":"Core","disabled":false},{"id":"o2","name":"Web","disabled":false}]') returning id`, [p.id])).rows
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

test('issue security: an item with a level is invisible everywhere to people outside it; comments can be limited to a role', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Secret', key: 'SEC', template: 'kanban' })).body
  await join('SEC', 'sec.ann@x.com', 'admin'); await join('SEC', 'sec.bob@x.com'); await join('SEC', 'sec.viewer@x.com', 'viewer')
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const [ann, bob] = [await id('sec.ann@x.com'), await id('sec.bob@x.com')]
  const lvl = (await call('POST', '/api/v1/projects/SEC/security-levels', { name: 'Security team', members: [{ kind: 'role', role: 'admin' }, { kind: 'user', id: ann }, { kind: 'reporter' }] })).body
  assert.equal(lvl.name, 'Security team')
  // Bob (a member, not in the level) can't set it; the owner can
  const open = (await call('POST', '/api/v1/projects/SEC/issues', { title: 'Public item' })).body
  const hidden = (await call('POST', '/api/v1/projects/SEC/issues', { title: 'Hidden vulnerability', securityLevelId: lvl.id, dueDate: '2020-01-01' })).body
  assert.equal(hidden.securityLevelId, lvl.id)
  assert.equal((await call('PATCH', `/api/v1/issues/${open.key}`, { securityLevelId: lvl.id }, 'sec.bob@x.com')).body.errors?.securityLevelId, 'You aren’t in this level')
  await call('POST', `/api/v1/issues/${open.key}/links`, { type: 'relates', targetKey: hidden.key })
  // Ann (listed) sees it; Bob sees nothing of it, on any path
  assert.equal((await call('GET', `/api/v1/issues/${hidden.key}`, undefined, 'sec.ann@x.com')).status, 200)
  const as = (path: string) => call('GET', path, undefined, 'sec.bob@x.com')
  assert.equal((await as(`/api/v1/issues/${hidden.key}`)).status, 404)
  assert.equal((await as(`/api/v1/issues/${hidden.id}`)).status, 404)
  assert.equal((await call('PATCH', `/api/v1/issues/${hidden.key}`, { title: 'x' }, 'sec.bob@x.com')).status, 404)
  assert.equal((await call('POST', `/api/v1/issues/${hidden.key}/comments`, { body: 'x' }, 'sec.bob@x.com')).status, 404)
  const keys = (rows: any[]) => rows.map((r: any) => r.key)
  assert.deepEqual(keys((await as('/api/v1/projects/SEC/issues')).body.items), [open.key])
  assert.deepEqual(keys((await as('/api/v1/projects/SEC/report-data')).body.issues), [open.key])
  assert.deepEqual(keys((await as('/api/v1/search?q=vulnerability&resolution=all')).body.items), [])
  assert.deepEqual(keys((await as(`/api/v1/search?jql=${encodeURIComponent('project = SEC')}`)).body.items), [open.key])
  assert.doesNotMatch((await app.inject({ method: 'GET', url: '/api/v1/search/export.csv?q=&resolution=all', headers: { 'x-dev-user': 'sec.bob@x.com' } })).body, /Hidden vulnerability/)
  assert.deepEqual((await as(`/api/v1/issues/${open.key}?expand=links`)).body.links, [])
  const summary = (await as('/api/v1/projects/SEC/summary')).body
  assert.equal(summary.byStatus.reduce((n: number, s: any) => n + s.count, 0), 1)
  assert.equal(summary.overdue, 0)
  // assigning it to Bob notifies nobody who can't see it… unless the level lets assignees in
  await call('PATCH', `/api/v1/issues/${hidden.key}`, { assigneeId: bob })
  assert.equal((await as('/api/v1/notifications')).body.some((n: any) => n.issueKey === hidden.key), false)
  assert.equal((await as('/api/v1/me/work')).body.some((i: any) => i.key === hidden.key), false)
  await call('PATCH', `/api/v1/projects/SEC/security-levels/${lvl.id}`, { members: [...lvl.members, { kind: 'assignee' }] })
  assert.equal((await as(`/api/v1/issues/${hidden.key}`)).status, 200)
  // comments limited to project admins: Bob (now able to see the item) doesn't see it; its author and admins do
  await call('POST', `/api/v1/issues/${hidden.key}/comments`, { body: 'For admins only', visibility: { kind: 'role', role: 'admin' } }, 'sec.ann@x.com')
  await call('POST', `/api/v1/issues/${hidden.key}/comments`, { body: 'For everyone' }, 'sec.ann@x.com')
  const bodies = async (w: string) => (await call('GET', `/api/v1/issues/${hidden.key}/comments`, undefined, w)).body.items.map((c: any) => c.body)
  assert.deepEqual(await bodies('sec.bob@x.com'), ['For everyone'])
  assert.deepEqual(await bodies('sec.ann@x.com'), ['For admins only', 'For everyone'])
  assert.deepEqual(await bodies('owner@x.com'), ['For admins only', 'For everyone'])
  assert.deepEqual((await as(`/api/v1/issues/${hidden.key}?expand=comments`)).body.comments.map((c: any) => c.body), ['For everyone'])
  // cloning a parent "with child items" copies only the children the cloner can see (the copy would name them reporter)
  await call('PATCH', `/api/v1/projects/SEC/security-levels/${lvl.id}`, { members: lvl.members })            // reporter in, assignee out again
  const parent = (await call('POST', '/api/v1/projects/SEC/issues', { title: 'Parent' })).body
  await call('POST', '/api/v1/projects/SEC/issues', { title: 'Secret child', parentId: parent.id, securityLevelId: lvl.id })
  await call('POST', '/api/v1/projects/SEC/issues', { title: 'Open child', parentId: parent.id })
  const cloned = (await call('POST', `/api/v1/issues/${parent.key}/clone`, { include: { children: true, links: false, sprint: false } }, 'sec.bob@x.com')).body
  const kids = (await pool.query('select title from issues where parent_id = $1 order by title', [cloned.id])).rows.map(r => r.title)
  assert.deepEqual(kids, ['Open child'])
  // removing a level in use needs somewhere for its items
  assert.equal((await call('DELETE', `/api/v1/projects/SEC/security-levels/${lvl.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/projects/SEC/security-levels/${lvl.id}?moveTo=none`)).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${hidden.key}`, undefined, 'sec.viewer@x.com')).status, 200)
})

test('testing: turning it on adds the Xray work types; Tests hold steps, Gherkin or a definition; it turns off only when unused', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Tested', key: 'TST', template: 'kanban' })
  await join('TST', 'tst.member@x.com')
  const types = async () => (await call('GET', '/api/v1/projects/TST')).body.types.map((t: any) => t.key)
  assert.equal((await call('POST', '/api/v1/projects/TST/issues', { title: 'x', type: 'test' })).status, 400)          // not on yet
  assert.equal((await call('PUT', '/api/v1/projects/TST/testing', { enabled: true }, 'tst.member@x.com')).status, 403)
  assert.deepEqual((await call('PUT', '/api/v1/projects/TST/testing', { enabled: true })).body, { enabled: true, requirementTypes: null })
  assert.deepEqual(await types(), ['epic', 'story', 'task', 'bug', 'test', 'precondition', 'test_set', 'test_plan', 'test_execution'])
  assert.equal((await call('GET', '/api/v1/projects/TST')).body.testing, true)
  // a manual test with steps
  const steps = [{ id: 's1', action: 'Open the login page', expected: 'The form shows' }, { id: 's2', action: 'Sign in', data: 'ann / secret', expected: 'Home page' }]
  const t = (await call('POST', '/api/v1/projects/TST/issues', { title: 'Sign in works', type: 'test', testSpec: { kind: 'manual', steps } }, 'tst.member@x.com')).body
  assert.deepEqual(t.testSpec.steps.map((s: any) => [s.action, s.data, s.expected]), [['Open the login page', '', 'The form shows'], ['Sign in', 'ann / secret', 'Home page']])
  const r = await call('PATCH', `/api/v1/issues/${t.key}`, { testSpec: { kind: 'cucumber', gherkin: 'Scenario: sign in\n  Given a user\n  When they sign in\n  Then they see home' } }, 'tst.member@x.com')
  assert.equal(r.body.testSpec.kind, 'cucumber')
  assert.ok((await call('GET', `/api/v1/issues/${t.key}/activity`)).body.items.some((a: any) => a.text === 'Changed the test steps'))
  // only Tests and Pre-Conditions; shapes are checked
  const task = (await call('POST', '/api/v1/projects/TST/issues', { title: 'A task' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${task.key}`, { testSpec: { kind: 'generic', definition: 'x' } })).body.errors?.testSpec, 'Not a Test')
  assert.equal((await call('PATCH', `/api/v1/issues/${t.key}`, { testSpec: { kind: 'manual', steps: [{ id: 's1' }] } })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/TST/issues', { title: 'Logged in', type: 'precondition', testSpec: { kind: 'generic', definition: 'A signed-in user' } })).status, 201)
  // built in: renamed, not removed; off only when no testing items remain
  assert.equal((await call('DELETE', '/api/v1/projects/TST/types/test')).status, 409)
  assert.equal((await call('PATCH', '/api/v1/projects/TST/types/test', { name: 'Test case' })).body.name, 'Test case')
  assert.equal((await call('PUT', '/api/v1/projects/TST/testing', { enabled: false })).status, 409)
  for (const i of (await call('GET', '/api/v1/projects/TST/issues')).body.items.filter((x: any) => x.type !== 'task')) await call('DELETE', `/api/v1/issues/${i.key}`)
  assert.deepEqual((await call('PUT', '/api/v1/projects/TST/testing', { enabled: false })).body, { enabled: false, requirementTypes: null })
  assert.deepEqual(await types(), ['epic', 'story', 'task', 'bug'])
})

test('testing: sets, plans and pre-conditions hold tests (by key or JQL); plans have folders; the repository has a folder tree', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Suites', key: 'SUI', template: 'kanban' })
  await call('PUT', '/api/v1/projects/SUI/testing', { enabled: true })
  await join('SUI', 'sui.member@x.com'); await join('SUI', 'sui.viewer@x.com', 'viewer')
  const mk = async (title: string, type: string, extra = {}) => (await call('POST', '/api/v1/projects/SUI/issues', { title, type, labels: ['smoke'], ...extra })).body
  const [t1, t2, t3] = [await mk('Sign in', 'test'), await mk('Sign out', 'test'), await mk('Reset password', 'test', { labels: [] })]
  const story = await mk('A story', 'story')
  const set = await mk('Smoke suite', 'test_set'), plan = await mk('Release 1.0', 'test_plan'), pre = await mk('A signed-in user', 'precondition')
  const keys = (r: any) => (r.items ?? r).map((i: any) => i.key)
  // by key; by JQL (only Tests are taken); twice adds nothing
  assert.deepEqual(keys((await call('POST', `/api/v1/issues/${set.key}/tests`, { keys: [t1.key, t2.key] }, 'sui.member@x.com')).body), [t1.key, t2.key])
  assert.equal((await call('POST', `/api/v1/issues/${set.key}/tests`, { keys: [story.key] })).body.errors?.keys, 'Only Tests can be added')
  assert.equal((await call('POST', `/api/v1/issues/${set.key}/tests`, { keys: ['SUI-999'] })).status, 400)
  const byJql = (await call('POST', `/api/v1/issues/${plan.key}/tests`, { jql: 'project = SUI AND labels = smoke', folder: 'Smoke' })).body
  assert.deepEqual([byJql.added, keys(byJql)], [2, [t1.key, t2.key]])
  assert.equal((await call('POST', `/api/v1/issues/${plan.key}/tests`, { keys: [t1.key, t3.key] })).body.added, 1)
  assert.deepEqual((await call('GET', `/api/v1/issues/${plan.key}/tests`)).body.map((i: any) => [i.key, i.folder]), [[t3.key, ''], [t1.key, 'Smoke'], [t2.key, 'Smoke']])
  // plan folders; a pre-condition holds tests too
  assert.deepEqual((await call('PATCH', `/api/v1/issues/${plan.key}/tests/${t3.key}`, { folder: ' Regression / Accounts ' })).body.find((i: any) => i.key === t3.key).folder, 'Regression/Accounts')
  await call('POST', `/api/v1/issues/${pre.key}/tests`, { keys: [t1.key] })
  assert.deepEqual((await call('GET', `/api/v1/issues/${t1.key}/test-containers`)).body.map((c: any) => c.key).sort(), [set.key, plan.key, pre.key].sort())
  // only containers hold tests; viewers can't change them; removing
  assert.equal((await call('POST', `/api/v1/issues/${story.key}/tests`, { keys: [t1.key] })).status, 400)
  assert.equal((await call('POST', `/api/v1/issues/${set.key}/tests`, { keys: [t3.key] }, 'sui.viewer@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/issues/${set.key}/tests/${t2.key}`)).status, 204)
  assert.equal((await call('DELETE', `/api/v1/issues/${set.key}/tests/${t2.key}`)).status, 404)
  assert.deepEqual(keys((await call('GET', `/api/v1/issues/${set.key}/tests`, undefined, 'sui.viewer@x.com')).body), [t1.key])
  // a test the reader can't see (security level) is left out of the list
  const lvl = (await call('POST', '/api/v1/projects/SUI/security-levels', { name: 'Admins', members: [{ kind: 'role', role: 'admin' }] })).body
  await call('PATCH', `/api/v1/issues/${t1.key}`, { securityLevelId: lvl.id })
  assert.deepEqual(keys((await call('GET', `/api/v1/issues/${set.key}/tests`, undefined, 'sui.viewer@x.com')).body), [])
  // repository folders: a tree; names unique among siblings; no loops; removing moves its tests up
  const f = (path: string, body?: unknown, method = 'POST') => call(method, `/api/v1/projects/SUI/test-folders${path}`, body, 'sui.member@x.com')
  const web = (await f('', { name: 'Web' })).body, auth = (await f('', { name: 'Auth', parentId: web.id })).body
  assert.equal((await f('', { name: 'auth', parentId: web.id })).status, 409)
  assert.equal((await f(`/${web.id}`, { parentId: auth.id }, 'PATCH')).body.errors?.parentId, 'Inside itself')
  assert.equal((await call('PATCH', `/api/v1/issues/${t2.key}`, { testFolderId: auth.id }, 'sui.member@x.com')).body.testFolderId, auth.id)
  assert.equal((await call('PATCH', `/api/v1/issues/${story.key}`, { testFolderId: auth.id })).body.errors?.testFolderId, 'Not a Test')
  assert.equal((await f('', undefined, 'GET')).body.find((x: any) => x.id === auth.id).tests, 1)
  assert.equal((await f(`/${auth.id}`, undefined, 'DELETE')).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${t2.key}`)).body.testFolderId, web.id)
})

test('testing: an execution runs tests; step results set the run status; finishing records who and when; defects link to the test', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Runs', key: 'RUN', template: 'kanban' })
  await call('PUT', '/api/v1/projects/RUN/testing', { enabled: true })
  await join('RUN', 'run.tester@x.com'); await join('RUN', 'run.viewer@x.com', 'viewer')
  const tester = (await call('GET', '/api/v1/me', undefined, 'run.tester@x.com')).body.id
  const steps = [{ id: 'a', action: 'Open' }, { id: 'b', action: 'Pay' }, { id: 'c', action: 'See receipt' }]
  const t1 = (await call('POST', '/api/v1/projects/RUN/issues', { title: 'Checkout', type: 'test', testSpec: { kind: 'manual', steps } })).body
  const t2 = (await call('POST', '/api/v1/projects/RUN/issues', { title: 'Refund', type: 'test', testSpec: { kind: 'generic', definition: 'RefundTest' } })).body
  const plan = (await call('POST', '/api/v1/projects/RUN/issues', { title: 'Release 3', type: 'test_plan' })).body
  await call('POST', `/api/v1/issues/${plan.key}/tests`, { keys: [t1.key, t2.key] })
  // an execution made from the plan runs its tests, and belongs to it
  const exec = (await call('POST', `/api/v1/issues/${plan.key}/executions`, { environments: ['chrome'], revision: 'build 42' }, 'run.tester@x.com')).body
  assert.deepEqual([exec.type, exec.testEnvironments, exec.revision], ['test_execution', ['chrome'], 'build 42'])
  assert.deepEqual((await call('GET', `/api/v1/issues/${plan.key}/executions`)).body.map((e: any) => e.key), [exec.key])
  const runs = (await call('GET', `/api/v1/issues/${exec.key}/runs`)).body
  assert.deepEqual(runs.map((r: any) => [r.testKey, r.status, r.steps.length]), [[t1.key, 'TODO', 3], [t2.key, 'TODO', 0]])
  const run = runs[0]
  // step results drive the run: one done → EXECUTING (started); a failure → FAIL (finished, by whom)
  const patch = (body: object, who = 'run.tester@x.com') => call('PATCH', `/api/v1/test-runs/${run.id}`, body, who)
  let r = (await patch({ steps: [{ id: 'a', status: 'PASS' }] })).body
  assert.deepEqual([r.status, !!r.startedAt, r.finishedAt], ['EXECUTING', true, null])
  r = (await patch({ steps: [{ id: 'b', status: 'FAIL', actual: 'Card declined' }], version: r.version })).body
  assert.deepEqual([r.status, !!r.finishedAt, r.executedBy, r.steps[1].actual], ['FAIL', true, tester, 'Card declined'])
  assert.equal((await patch({ comment: 'stale', version: 1 })).status, 409)
  assert.equal((await patch({ steps: [{ id: 'zz', status: 'PASS' }] })).status, 400)
  assert.equal((await patch({ steps: [{ id: 'a', status: 'NOPE' }] })).status, 400)
  assert.equal((await patch({ comment: 'x' }, 'run.viewer@x.com')).status, 403)
  // a defect from step b: a new bug, linked to the test
  const dr = (await call('POST', `/api/v1/test-runs/${run.id}/defects`, { stepId: 'b', title: 'Payment declined for valid cards' }, 'run.tester@x.com')).body
  assert.equal(dr.defect.type, 'bug')
  assert.match(dr.defect.description, new RegExp(`Found running ${t1.key}.*step 2`))
  assert.deepEqual([dr.run.defectIds, dr.run.steps[1].defectIds], [[dr.defect.id], [dr.defect.id]])
  assert.ok((await pool.query(`select 1 from issue_links where issue_id = $1 and target_id = $2 and type = 'defect'`, [t1.id, dr.defect.id])).rowCount)
  // a tester who can't edit the test (another project, viewer there) records the defect on the run, but adds no link to the test
  await call('POST', '/api/v1/projects', { name: 'Elsewhere', key: 'ELS', template: 'kanban' })
  await call('PUT', '/api/v1/projects/ELS/testing', { enabled: true })
  await join('ELS', 'run.tester@x.com', 'viewer')
  const foreign = (await call('POST', '/api/v1/projects/ELS/issues', { title: 'Foreign test', type: 'test' })).body
  const exec3 = (await call('POST', '/api/v1/projects/RUN/issues', { title: 'Cross-project', type: 'test_execution' })).body
  await call('POST', `/api/v1/issues/${exec3.key}/runs`, { keys: [foreign.key] })
  const frun = (await call('GET', `/api/v1/issues/${exec3.key}/runs`)).body[0]
  const fd = await call('POST', `/api/v1/test-runs/${frun.id}/defects`, { title: 'Seen elsewhere' }, 'run.tester@x.com')
  assert.equal(fd.status, 201); assert.deepEqual(fd.body.run.defectIds, [fd.body.defect.id])
  assert.equal((await pool.query(`select 1 from issue_links where issue_id = $1`, [foreign.id])).rowCount, 0)
  // a status given directly wins; back to a non-final status clears the finish
  r = (await patch({ status: 'PASS' })).body
  assert.equal(r.status, 'PASS')
  r = (await patch({ status: 'EXECUTING' })).body
  assert.deepEqual([r.status, r.finishedAt], ['EXECUTING', null])
  // generic tests take a status directly; progress counts both
  const r2 = (await call('GET', `/api/v1/issues/${exec.key}/runs`)).body[1]
  await call('PATCH', `/api/v1/test-runs/${r2.id}`, { status: 'PASS' })
  assert.deepEqual((await call('GET', `/api/v1/issues/${exec.key}/test-progress`)).body, { total: 2, byStatus: { EXECUTING: 1, PASS: 1 } })
  // the plan: each test's status across its executions; a finished result outweighs a newer run still to do (setting on)
  await patch({ status: 'FAIL' })
  const exec2 = (await call('POST', `/api/v1/issues/${plan.key}/executions`, { title: 'Rerun', environments: ['chrome'] })).body
  assert.deepEqual((await call('GET', `/api/v1/issues/${plan.key}/test-progress`)).body, { total: 2, byStatus: { FAIL: 1, PASS: 1 } })
  await call('PUT', '/api/v1/admin/settings/testing', { finalStatusesHavePrecedence: false })
  assert.deepEqual((await call('GET', `/api/v1/issues/${plan.key}/test-progress`)).body, { total: 2, byStatus: { TODO: 2 } })
  await call('PUT', '/api/v1/admin/settings/testing', { finalStatusesHavePrecedence: true })
  // the test changed after the run was made: the run says so, and a reset takes the new version
  await call('PATCH', `/api/v1/issues/${t1.key}`, { testSpec: { kind: 'manual', steps: [...steps, { id: 'd', action: 'Log out' }] } })
  assert.equal((await call('GET', `/api/v1/test-runs/${run.id}`)).body.specChanged, true)
  r = (await call('POST', `/api/v1/test-runs/${run.id}/reset`, undefined, 'run.tester@x.com')).body
  assert.deepEqual([r.status, r.steps.length, r.specChanged, r.finishedAt], ['TODO', 4, false, null])
  // a test's runs in every execution
  assert.deepEqual((await call('GET', `/api/v1/issues/${t1.key}/runs`)).body.map((x: any) => x.executionKey).sort(), [exec.key, exec2.key].sort())
  // statuses: admins add one; built-in ones keep their meaning; one in use can't go
  const flaky = (await call('POST', '/api/v1/admin/test-statuses', { kind: 'run', name: 'Flaky', color: '#9333EA', final: false, mapsTo: 'unknown' })).body
  assert.match(flaky.key, /^c-/)
  assert.equal((await call('PATCH', '/api/v1/admin/test-statuses/run/PASS', { mapsTo: 'nok' })).status, 400)
  await patch({ status: flaky.key })
  assert.equal((await call('DELETE', `/api/v1/admin/test-statuses/run/${flaky.key}`)).status, 409)
  await patch({ status: 'PASS' })
  assert.equal((await call('DELETE', `/api/v1/admin/test-statuses/run/${flaky.key}`)).status, 204)
})

test('[0301.R9] coverage: a story is UNCOVERED, then NOK for version 1.0 after a failing run, OK after a pass; plans, environments and sub-requirements count', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Covered', key: 'COV', template: 'kanban' })).body
  await call('PUT', '/api/v1/projects/COV/testing', { enabled: true })
  const v1 = (await call('POST', '/api/v1/projects/COV/releases', { name: '1.0' })).body.id
  const v2 = (await call('POST', '/api/v1/projects/COV/releases', { name: '2.0' })).body.id
  const mk = async (title: string, type: string, extra = {}) => (await call('POST', '/api/v1/projects/COV/issues', { title, type, ...extra })).body
  const story = await mk('Customers can pay', 'story'), sub = await mk('Pay by card', 'task', { parentId: undefined })
  await call('PATCH', `/api/v1/issues/${sub.key}`, { parentId: story.id })
  const [t1, t2, t3] = [await mk('Pays', 'test'), await mk('Refunds', 'test'), await mk('Card works', 'test')]
  const cov = async (q = '') => (await call('GET', `/api/v1/issues/${story.key}/coverage${q}`)).body
  assert.equal((await cov()).status, 'UNCOVERED')
  // only a Test tests, and only a requirement is tested
  assert.equal((await call('POST', `/api/v1/issues/${story.key}/links`, { type: 'tests', targetKey: t1.key })).status, 400)
  for (const t of [t1, t2]) assert.equal((await call('POST', `/api/v1/issues/${t.key}/links`, { type: 'tests', targetKey: story.key })).status, 204)
  await call('POST', `/api/v1/issues/${t3.key}/links`, { type: 'tests', targetKey: sub.key })
  // covered, not run yet
  let c = await cov()
  assert.deepEqual([c.status, c.tests.map((t: any) => [t.key, t.status])], ['NOTRUN', [[t1.key, null], [t2.key, null]]])
  // version 1.0: t1 fails, t2 passes → NOK
  const run = async (exec: any, test: any, status: string) => {
    const r = (await call('GET', `/api/v1/issues/${exec.key}/runs`)).body.find((x: any) => x.testKey === test.key)
    await call('PATCH', `/api/v1/test-runs/${r.id}`, { status })
  }
  const plan = await mk('Release 1.0 plan', 'test_plan')
  await call('POST', `/api/v1/issues/${plan.key}/tests`, { keys: [t1.key, t2.key, t3.key] })
  const e1 = (await call('POST', `/api/v1/issues/${plan.key}/executions`, { releaseId: v1, environments: ['chrome'] })).body
  await run(e1, t1, 'FAIL'); await run(e1, t2, 'PASS'); await run(e1, t3, 'PASS')
  c = await cov(`?version=${v1}`)
  assert.deepEqual([c.status, c.own, c.subRequirements.map((s: any) => s.status)], ['NOK', 'NOK', ['OK']])
  assert.equal((await cov(`?version=${v2}`)).status, 'NOTRUN')         // nothing run for 2.0
  // a passing rerun for 1.0 → OK (the latest finished result counts)
  const e2 = (await call('POST', '/api/v1/projects/COV/issues', { title: 'Rerun', type: 'test_execution', fixReleaseIds: [v1], testEnvironments: ['chrome'] })).body
  await call('POST', `/api/v1/issues/${e2.key}/runs`, { keys: [t1.key] })
  await run(e2, t1, 'PASS')
  assert.equal((await cov(`?version=${v1}`)).status, 'OK')
  // the plan only counts its own executions (the rerun isn't in it): still NOK there
  assert.equal((await cov(`?plan=${plan.key}`)).status, 'NOK')
  // a failure in another environment fails it across environments, but not in chrome alone
  const e3 = (await call('POST', '/api/v1/projects/COV/issues', { title: 'Firefox', type: 'test_execution', fixReleaseIds: [v1], testEnvironments: ['firefox'] })).body
  await call('POST', `/api/v1/issues/${e3.key}/runs`, { keys: [t2.key] })
  await run(e3, t2, 'FAIL')
  assert.equal((await cov(`?version=${v1}`)).status, 'NOK')
  assert.equal((await cov(`?version=${v1}&environment=chrome`)).status, 'OK')
  // a sub-requirement that fails makes the parent fail
  await run(e1, t3, 'FAIL')
  c = await cov(`?plan=${plan.key}`)
  assert.deepEqual([c.subRequirements[0].status, c.status], ['NOK', 'NOK'])
  // every test's status in a scope
  const results = (await call('GET', `/api/v1/projects/COV/test-results?version=${v1}&environment=chrome`)).body
  assert.deepEqual(results.map((r: any) => [r.key, r.status]), [[t1.key, 'PASS'], [t2.key, 'PASS'], [t3.key, 'FAIL']])
  assert.equal((await call('GET', `/api/v1/issues/${story.key}/coverage?plan=${story.key}`)).status, 400)
  // requirement types: a project's choice, only its own non-testing types
  assert.deepEqual((await call('PUT', '/api/v1/projects/COV/testing', { enabled: true, requirementTypes: ['story', 'epic'] })).body, { enabled: true, requirementTypes: ['story', 'epic'] })
  assert.equal((await call('PUT', '/api/v1/projects/COV/testing', { enabled: true, requirementTypes: ['test'] })).status, 400)
  assert.deepEqual((await call('GET', '/api/v1/projects/COV')).body.requirementTypes, ['story', 'epic'])
  void p
})

test('CI results: JUnit, Cucumber and Xray JSON at Xray’s own addresses, with an access token; tests are matched or made; one run per test', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Continuous', key: 'CI', template: 'kanban' })
  await call('PUT', '/api/v1/projects/CI/testing', { enabled: true })
  await call('POST', '/api/v1/projects/CI/releases', { name: '5.1' })
  await join('CI', 'ci.bot@x.com'); await join('CI', 'ci.viewer@x.com', 'viewer')
  const token = (await call('POST', '/api/v1/me/tokens', { name: 'pipeline' }, 'ci.bot@x.com')).body.token
  const raven = (path: string, payload: string | object, type = 'application/json', t = token) =>
    app.inject({ method: 'POST', url: `/rest/raven/1.0${path}`, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { authorization: `Bearer ${t}`, 'content-type': type } })
  const story = (await call('POST', '/api/v1/projects/CI/issues', { title: 'Login', type: 'story' })).body
  const plan = (await call('POST', '/api/v1/projects/CI/issues', { title: 'Nightly', type: 'test_plan' })).body
  // JUnit, as a multipart file (as Xray's endpoint takes it): new tests by definition, the failure's message, Xray's properties
  const junit = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "BOOM">]><testsuites><testsuite name="auth">
    <testcase classname="auth.LoginTest" name="signsIn" time="1.2"><properties><property name="requirements" value="${story.key}"/></properties></testcase>
    <testcase classname="auth.LoginTest" name="rejectsBadPassword"><failure message="expected 401">got 200 &amp; a cookie &boom;</failure></testcase>
    <testcase classname="auth.LoginTest" name="locksOut"><skipped/></testcase>
  </testsuite></testsuites>`
  const boundary = 'XBOUNDARY'
  const form = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="junit.xml"\r\nContent-Type: text/xml\r\n\r\n${junit}\r\n--${boundary}--\r\n`
  const r1 = await raven(`/import/execution/junit?projectKey=CI&testPlanKey=${plan.key}&testEnvironments=linux;chrome&fixVersion=5.1&revision=abc123`, form, `multipart/form-data; boundary=${boundary}`)
  assert.equal(r1.statusCode, 200, r1.body)
  const exec = JSON.parse(r1.body).testExecIssue
  assert.match(exec.key, /^CI-\d+$/)
  const e = (await call('GET', `/api/v1/issues/${exec.key}`)).body
  assert.deepEqual([e.type, e.testEnvironments, e.revision], ['test_execution', ['linux', 'chrome'], 'abc123'])
  const runs = async (key: string) => (await call('GET', `/api/v1/issues/${key}/runs`)).body
  let rs = await runs(exec.key)
  assert.deepEqual(rs.map((r: any) => [r.testTitle, r.status]), [['signsIn', 'PASS'], ['rejectsBadPassword', 'FAIL'], ['locksOut', 'TODO']])
  assert.equal(rs[1].comment, 'expected 401\ngot 200 & a cookie &boom;')      // the declared entity is left as text, never expanded
  assert.equal(rs[0].spec.definition, 'auth.LoginTest.signsIn')
  assert.equal((await call('GET', `/api/v1/issues/${story.key}/coverage`)).body.tests.length, 1)   // its requirements property
  assert.deepEqual((await call('GET', `/api/v1/issues/${plan.key}/executions`)).body.map((x: any) => x.key), [exec.key])
  // the same report again, into the same execution: the same tests (matched by definition), no new ones
  const r2 = await raven(`/import/execution/junit?testExecKey=${exec.key}`, junit.replace('<skipped/>', ''), 'text/xml')
  assert.equal(r2.statusCode, 200, r2.body)
  assert.deepEqual(JSON.parse(r2.body).createdTests, [])
  rs = await runs(exec.key)
  assert.deepEqual(rs.map((r: any) => r.status), ['PASS', 'FAIL', 'PASS'])
  // Cucumber: a scenario tagged with a test's key updates it; an untagged one is found by name or made; outline rows merge
  const cuke = (await call('POST', '/api/v1/projects/CI/issues', { title: 'Search finds items', type: 'test', testSpec: { kind: 'cucumber', gherkin: 'Scenario: x' } })).body
  const step = (status: string, name = 'a step') => ({ keyword: 'Given ', name, result: { status, ...(status === 'failed' ? { error_message: 'boom' } : {}) } })
  const features = [{ name: 'Search', elements: [
    { type: 'scenario', keyword: 'Scenario', name: 'Search finds items', tags: [{ name: `@${cuke.key}` }, { name: `@${story.key}` }], steps: [step('passed'), step('passed')] },
    { type: 'scenario', keyword: 'Scenario Outline', name: 'Filters', steps: [step('passed')] },
    { type: 'scenario', keyword: 'Scenario Outline', name: 'Filters', steps: [step('failed')] },
  ] }]
  const r3 = await raven('/import/execution/cucumber?projectKey=CI', features)
  assert.equal(r3.statusCode, 200, r3.body)
  const c = JSON.parse(r3.body)
  assert.equal(c.createdTests.length, 1)
  rs = await runs(c.testExecIssue.key)
  assert.deepEqual(rs.map((r: any) => [r.testKey, r.status]), [[cuke.key, 'PASS'], [c.createdTests[0], 'FAIL']])
  assert.equal((await call('GET', `/api/v1/issues/${c.createdTests[0]}`)).body.testSpec.gherkin, 'Scenario Outline: Filters\n  Given a step')
  // Xray JSON: a manual test with step results, by summary; Xray Cloud's status names; an unknown status refuses everything
  const xray = { info: { project: 'CI', summary: 'Manual pass', testEnvironments: ['ios'] }, tests: [
    { testInfo: { projectKey: 'CI', summary: 'Checkout by hand', testType: 'Manual', steps: [{ action: 'Open', result: 'Opens' }, { action: 'Pay', result: 'Paid' }] },
      status: 'FAILED', comment: 'Pay button missing', steps: [{ status: 'PASSED' }, { status: 'FAILED', actualResult: 'No button' }] },
  ] }
  const r4 = await raven('/import/execution', xray)
  assert.equal(r4.statusCode, 200, r4.body)
  const [mr] = await runs(JSON.parse(r4.body).testExecIssue.key)
  assert.deepEqual([mr.status, mr.steps.map((s: any) => s.status), mr.steps[1].actual, mr.comment], ['FAIL', ['PASS', 'FAIL'], 'No button', 'Pay button missing'])
  const before = (await call('GET', '/api/v1/projects/CI/issues')).body.items.length
  assert.equal((await raven('/import/execution', { ...xray, tests: [...xray.tests, { testInfo: { summary: 'New one', testType: 'Generic' }, status: 'MAYBE' }] })).statusCode, 400)
  assert.equal((await call('GET', '/api/v1/projects/CI/issues')).body.items.length, before)          // nothing was saved
  // the native address does the same; viewers and strangers can't; broken files are refused
  assert.equal((await call('POST', '/api/v1/testing/import/xray?projectKey=CI', { tests: [{ testKey: mr.testKey, status: 'PASS' }] }, 'ci.bot@x.com')).status, 200)
  assert.equal((await call('POST', '/api/v1/testing/import/xray?projectKey=CI', { tests: [{ testKey: mr.testKey, status: 'PASS' }] }, 'ci.viewer@x.com')).status, 403)
  assert.equal((await raven('/import/execution/junit?projectKey=CI', '<testsuite><testcase name="x">', 'text/xml')).statusCode, 400)
  assert.equal((await raven('/import/execution', { tests: [] }, 'application/json', 'jbp_' + 'x'.repeat(43))).statusCode, 401)
  // a test the importer can't see (security level) is never matched by name: a new one is made, the hidden one is untouched
  const lvl = (await call('POST', '/api/v1/projects/CI/security-levels', { name: 'Owners only', members: [{ kind: 'user', id: (await call('GET', '/api/v1/me')).body.id }] })).body
  const hidden = (await call('POST', '/api/v1/projects/CI/issues', { title: 'Secret flow', type: 'test', securityLevelId: lvl.id, testSpec: { kind: 'generic', definition: 'secret.Flow.works' } })).body
  const h = await raven('/import/execution/junit?projectKey=CI', '<testsuite><testcase classname="secret.Flow" name="works"/></testsuite>', 'text/xml')
  assert.equal(h.statusCode, 200, h.body)
  assert.equal(JSON.parse(h.body).createdTests.length, 1)
  assert.notEqual(JSON.parse(h.body).testIssues.success[0].key, hidden.key)
  assert.equal((await call('GET', `/api/v1/issues/${hidden.key}/runs`)).body.length, 0)
  // the size and count limits are System settings
  await call('PUT', '/api/v1/admin/settings/testing', { finalStatusesHavePrecedence: true, resultImportMaxMb: 1, resultImportMaxTests: 10 })
  const many = { info: { project: 'CI' }, tests: Array.from({ length: 11 }, (_, n) => ({ testInfo: { summary: `t${n}`, testType: 'Generic' }, status: 'PASS' })) }
  assert.match(JSON.parse((await raven('/import/execution', many)).body).error, /At most 10 results/)
  assert.equal((await raven('/import/execution/junit?projectKey=CI', `<testsuite>${' '.repeat(1100 * 1024)}</testsuite>`, 'text/xml')).statusCode, 413)
  await call('PUT', '/api/v1/admin/settings/testing', { finalStatusesHavePrecedence: true, resultImportMaxMb: 10, resultImportMaxTests: 2000 })
})

test('testing JQL and reports: Xray’s functions find tests by requirement, set, plan (with status) and execution; traceability and test runs', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Traced', key: 'TRC', template: 'kanban' })
  await call('PUT', '/api/v1/projects/TRC/testing', { enabled: true })
  await join('TRC', 'trc.viewer@x.com', 'viewer')
  const mk = async (title: string, type: string, extra = {}) => (await call('POST', '/api/v1/projects/TRC/issues', { title, type, ...extra })).body
  const [story, other] = [await mk('Pay', 'story'), await mk('Ship', 'story')]
  const [t1, t2, t3] = [await mk('Pays by card', 'test'), await mk('Pays by bank', 'test'), await mk('Ships', 'test')]
  for (const [t, r] of [[t1, story], [t2, story], [t3, other]] as const) await call('POST', `/api/v1/issues/${t.key}/links`, { type: 'tests', targetKey: r.key })
  const set = await mk('Payments', 'test_set'), plan = await mk('Release', 'test_plan')
  await call('POST', `/api/v1/issues/${set.key}/tests`, { keys: [t1.key, t2.key] })
  await call('POST', `/api/v1/issues/${plan.key}/tests`, { keys: [t1.key, t2.key, t3.key] })
  const exec = (await call('POST', `/api/v1/issues/${plan.key}/executions`, {})).body
  const runs = (await call('GET', `/api/v1/issues/${exec.key}/runs`)).body
  await call('PATCH', `/api/v1/test-runs/${runs.find((r: any) => r.testKey === t1.key).id}`, { status: 'FAIL' })
  await call('PATCH', `/api/v1/test-runs/${runs.find((r: any) => r.testKey === t2.key).id}`, { status: 'PASS' })
  const bug = (await call('POST', `/api/v1/test-runs/${runs.find((r: any) => r.testKey === t1.key).id}/defects`, { title: 'Card declined' })).body.defect
  const jql = async (q: string, who = 'owner@x.com') => {
    const r = await call('GET', `/api/v1/search?resolution=all&jql=${encodeURIComponent(q)}`, undefined, who)
    return r.status === 200 ? r.body.items.map((i: any) => i.key).sort() : r
  }
  const keys = (...xs: any[]) => xs.map(x => x.key).sort()
  assert.deepEqual(await jql(`issue in requirementTests("${story.key}")`), keys(t1, t2))
  assert.deepEqual(await jql(`issue in testRequirements("${t3.key}", "${t1.key}")`), keys(story, other))
  assert.deepEqual(await jql(`issue in testSetTests("${set.key}")`), keys(t1, t2))
  assert.deepEqual(await jql(`issue in testPlanTests("${plan.key}")`), keys(t1, t2, t3))
  assert.deepEqual(await jql(`issue in testPlanTests("${plan.key}", "FAIL", "To do")`), keys(t1, t3))     // keys or names; a test not run is to do
  assert.deepEqual(await jql(`issue in testExecutionTests("${exec.key}", PASS)`), keys(t2))
  assert.deepEqual(await jql(`project = TRC AND issue not in testPlanTests("${plan.key}") AND type = test`), [])
  // mistakes, and items the searcher can't see, say so the same way
  assert.match((await jql(`issue in testSetTests("${plan.key}")`)).body.error, /isn’t a Test Set/)
  assert.match((await jql(`issue in testPlanTests("${plan.key}", "SOMETIMES")`)).body.error, /no test status/)
  const lvl = (await call('POST', '/api/v1/projects/TRC/security-levels', { name: 'Admins', members: [{ kind: 'role', role: 'admin' }] })).body
  await call('PATCH', `/api/v1/issues/${set.key}`, { securityLevelId: lvl.id })
  assert.match((await jql(`issue in testSetTests("${set.key}")`, 'trc.viewer@x.com')).body.error, new RegExp(`no work item ${set.key}`))
  assert.match((await jql('issue in testSetTests("TRC-999")', 'trc.viewer@x.com')).body.error, /no work item TRC-999/)
  // traceability: each requirement, its coverage, its tests' results in the scope, their defects
  const tr = (await call('GET', `/api/v1/projects/TRC/reports/traceability?plan=${plan.key}`)).body
  const pay = tr.find((r: any) => r.key === story.key)
  assert.deepEqual([pay.status, pay.tests.map((t: any) => [t.key, t.status, t.defects.map((x: any) => x.key)])], ['NOK', [[t1.key, 'FAIL', [bug.key]], [t2.key, 'PASS', []]]])
  assert.deepEqual(tr.find((r: any) => r.key === other.key).status, 'NOTRUN')
  assert.ok(!tr.some((r: any) => r.key === bug.key || r.key === t1.key))          // bugs and tests aren't requirements
  // test runs: newest first; by status
  const tr2 = (await call('GET', `/api/v1/projects/TRC/reports/test-runs?plan=${plan.key}&status=FAIL`)).body
  assert.deepEqual(tr2.map((r: any) => r.testKey), [t1.key])
  assert.equal((await call('GET', '/api/v1/projects/TRC/reports/test-runs')).body.length, 3)
})

test('system groups: everyone is in users-access and rejoins at sign-in; system-administrators decides admin rights; the Entra role brings admins back', { skip }, async () => {
  const sys = async (role: string) => (await pool.query('select id, display_name from groups where system_role = $1', [role])).rows[0]
  const [users, admins] = [await sys('default-users'), await sys('system-admins')]
  assert.deepEqual([users.display_name, admins.display_name], ['users-access', 'system-administrators'])
  const inGroup = async (g: string, email: string) => (await pool.query('select 1 from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1 and u.email = $2', [g, email])).rowCount === 1
  // someone new is in users-access from their first request
  await call('GET', '/api/v1/me', undefined, 'sg.newcomer@x.com')
  assert.ok(await inGroup(users.id, 'sg.newcomer@x.com'))
  // taken out, they stay out until their next sign-in (a script's token doesn't count)
  await pool.query(`delete from group_members where group_id = $1 and user_id = (select id from users where email = 'sg.newcomer@x.com')`, [users.id])
  await call('GET', '/api/v1/me', undefined, 'sg.newcomer@x.com')
  assert.equal(await inGroup(users.id, 'sg.newcomer@x.com'), false)
  const token = (await call('POST', '/api/v1/me/tokens', { name: 'script' }, 'sg.newcomer@x.com')).body.token
  const viaPat = await app.inject({ method: 'POST', url: '/api/v1/me/sign-in', headers: { authorization: `Bearer ${token}` } })
  assert.equal(viaPat.statusCode, 400)
  assert.equal(await inGroup(users.id, 'sg.newcomer@x.com'), false)
  assert.equal((await call('POST', '/api/v1/me/sign-in', undefined, 'sg.newcomer@x.com')).status, 204)
  assert.ok(await inGroup(users.id, 'sg.newcomer@x.com'))
  assert.ok((await pool.query(`select last_sign_in_at from users where email = 'sg.newcomer@x.com'`)).rows[0].last_sign_in_at)
  // admin rights come from system-administrators: in it, Administration answers; out of it, it doesn't
  assert.equal((await call('GET', '/api/v1/admin/users', undefined, 'sg.newcomer@x.com')).status, 403)
  const uid = (await call('GET', '/api/v1/me', undefined, 'sg.newcomer@x.com')).body.id
  await pool.query('insert into group_members (group_id, user_id) values ($1, $2)', [admins.id, uid])
  const me = (await call('GET', '/api/v1/me', undefined, 'sg.newcomer@x.com')).body
  assert.deepEqual([me.admin, me.role], [true, 'admin'])
  assert.equal((await call('GET', '/api/v1/admin/users', undefined, 'sg.newcomer@x.com')).status, 200)
  assert.equal((await viaToken(token, 'GET', '/api/v1/admin/users')).status, 200)            // tokens act with the same rights
  await pool.query('delete from group_members where group_id = $1 and user_id = $2', [admins.id, uid])
  assert.equal((await call('GET', '/api/v1/admin/users', undefined, 'sg.newcomer@x.com')).status, 403)
  assert.equal((await viaToken(token, 'GET', '/api/v1/admin/users')).status, 403)
  // with Entra's Strand.Admin role, a sign-in puts them back in system-administrators
  const headers = { 'x-dev-user': 'sg.newcomer@x.com', 'x-dev-admin': '1' }   // the dev sign-in's stand-in for Entra's Strand.Admin role
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers })).statusCode, 403)   // not before signing in
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/me/sign-in', headers })).statusCode, 204)
  assert.ok(await inGroup(admins.id, 'sg.newcomer@x.com'))
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers })).statusCode, 200)
  // directory provisioning (SCIM) can't see or change the system groups
  const scim = await app.inject({ method: 'GET', url: '/scim/v2/Groups', headers: { authorization: `Bearer ${process.env.SCIM_TOKEN}` } })
  assert.ok(!JSON.parse(scim.body).Resources.some((g: any) => g.id === admins.id || g.id === users.id))
  assert.equal((await app.inject({ method: 'DELETE', url: `/scim/v2/Groups/${admins.id}`, headers: { authorization: `Bearer ${process.env.SCIM_TOKEN}` } })).statusCode, 404)   // spec 0104 R3
  assert.ok(await sys('system-admins'))
})

test('groups: anyone makes one and manages it; a project admin gives it a role; system and directory groups are protected', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Mobile', key: 'MOBX', template: 'kanban' })
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const [lead, dev1, dev2, other] = [await id('gr.lead@x.com'), await id('gr.dev1@x.com'), await id('gr.dev2@x.com'), await id('gr.other@x.com')]
  // a user makes mobile-developers: they own it and are in it; names are unique, ignoring case
  const made = await call('POST', '/api/v1/groups', { name: 'mobile-developers', description: 'Everyone building the apps' }, 'gr.lead@x.com')
  assert.equal(made.status, 201)
  const g = made.body
  assert.deepEqual([g.kind, g.isOwner, g.isMember, g.canManage, g.owners.map((o: any) => o.id)], ['strand', true, true, true, [lead]])
  assert.equal((await call('POST', '/api/v1/groups', { name: 'Mobile-Developers' }, 'gr.other@x.com')).status, 409)
  // the owner adds people; someone else can't
  assert.deepEqual((await call('POST', `/api/v1/groups/${g.id}/members`, { userIds: [dev1, dev2] }, 'gr.lead@x.com')).body, { added: 2 })
  assert.equal((await call('POST', `/api/v1/groups/${g.id}/members`, { userIds: [other] }, 'gr.other@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/groups/${g.id}`, { name: 'hijacked' }, 'gr.dev1@x.com')).status, 403)
  // its name is fixed once made (as in Jira); its description can change
  const renamed = await call('PATCH', `/api/v1/groups/${g.id}`, { name: 'phone-developers' }, 'gr.lead@x.com')
  assert.deepEqual([renamed.status, renamed.body.errors?.name], [400, 'Can’t be changed'])
  assert.equal((await call('PATCH', `/api/v1/groups/${g.id}`, { name: g.name, description: 'The mobile team' }, 'gr.lead@x.com')).body.description, 'The mobile team')
  assert.equal((await call('GET', `/api/v1/groups/${g.id}`)).body.name, g.name)
  // a project admin gives the group Member: its people can now work there; the grant shows who manages the group
  assert.equal((await call('POST', '/api/v1/issues', undefined, 'gr.dev1@x.com')).status, 404)
  assert.equal((await call('GET', '/api/v1/projects/MOBX', undefined, 'gr.dev1@x.com')).status, 404)
  const grants = (await call('POST', '/api/v1/projects/MOBX/groups', { groupId: g.id, role: 'member' })).body
  assert.deepEqual(grants.map((x: any) => [x.name, x.kind, x.owners]), [['mobile-developers', 'strand', ['gr.lead']]])
  assert.equal((await call('POST', '/api/v1/projects/MOBX/issues', { title: 'From the group' }, 'gr.dev1@x.com')).status, 201)
  assert.deepEqual((await call('GET', `/api/v1/groups/${g.id}`, undefined, 'gr.dev2@x.com')).body.projects, [{ key: 'MOBX', name: 'Mobile', role: 'member' }])
  assert.deepEqual((await call('GET', `/api/v1/groups/${g.id}`, undefined, 'gr.other@x.com')).body.projects, [])   // only projects you can see
  // leaving: anyone may leave a group made here; and loses its access at once
  assert.equal((await call('DELETE', `/api/v1/groups/${g.id}/members/${dev2}`, undefined, 'gr.dev2@x.com')).status, 204)
  assert.equal((await call('GET', '/api/v1/projects/MOBX', undefined, 'gr.dev2@x.com')).status, 404)
  // owners: more can be added; the last one can't leave (a system administrator may remove them)
  assert.equal((await call('DELETE', `/api/v1/groups/${g.id}/owners/${lead}`, undefined, 'gr.lead@x.com')).status, 409)
  assert.deepEqual((await call('POST', `/api/v1/groups/${g.id}/owners`, { userIds: [dev1] }, 'gr.lead@x.com')).body.owners.length, 2)
  assert.equal((await call('DELETE', `/api/v1/groups/${g.id}/owners/${lead}`, undefined, 'gr.lead@x.com')).status, 204)
  assert.equal((await call('PATCH', `/api/v1/groups/${g.id}`, { description: 'Apps team' }, 'gr.lead@x.com')).status, 403)   // no longer an owner
  // a group that is a project's only admin can't be emptied or deleted
  await call('PATCH', '/api/v1/projects/MOBX/groups/' + g.id, { role: 'admin' })
  const [{ ownerAdmin }] = (await pool.query(`select count(*)::int as "ownerAdmin" from project_members pm join projects p on p.id = pm.project_id where p.key = 'MOBX' and pm.role = 'admin'`)).rows
  await pool.query(`delete from project_members where project_id = (select id from projects where key = 'MOBX')`)
  assert.equal((await call('DELETE', `/api/v1/groups/${g.id}`, undefined, 'gr.dev1@x.com')).status, 409)
  assert.ok(ownerAdmin >= 0)
  // System settings: only system administrators make groups
  await call('PUT', '/api/v1/admin/settings/groups', { whoCanCreate: 'admins' })
  assert.equal((await call('POST', '/api/v1/groups', { name: 'web-developers' }, 'gr.other@x.com')).status, 403)
  assert.equal((await call('POST', '/api/v1/groups', { name: 'web-developers' })).status, 201)
  await call('PUT', '/api/v1/admin/settings/groups', { whoCanCreate: 'everyone' })
  // system groups: only system administrators change them; never deleted; never left without an administrator
  const admins = (await call('GET', '/api/v1/groups?query=system-administrators')).body.items[0]
  assert.equal(admins.kind, 'system')
  assert.equal((await call('POST', `/api/v1/groups/${admins.id}/members`, { userIds: [other] }, 'gr.lead@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/groups/${admins.id}`)).status, 409)
  const ownerId = await id('owner@x.com')
  const adminIds = [ownerId, ...(await call('GET', `/api/v1/groups/${admins.id}`)).body.people.filter((p: any) => p.active && p.id !== ownerId).map((p: any) => p.id)]
  for (const a of adminIds.slice(1)) await call('DELETE', `/api/v1/groups/${admins.id}/members/${a}`)
  assert.match((await call('DELETE', `/api/v1/groups/${admins.id}/members/${adminIds[0]}`)).body.error, /at least one system administrator/)
  for (const a of adminIds.slice(1)) await call('POST', `/api/v1/groups/${admins.id}/members`, { userIds: [a] })
  // a directory group (from Entra) is read-only here
  const [{ id: dir }] = (await pool.query(`insert into groups (display_name, external_id, source) values ('Entra Mobile', 'ext-mobile', 'directory') returning id`)).rows
  assert.equal((await call('POST', `/api/v1/groups/${dir}/members`, { userIds: [other] })).status, 403)
  assert.equal((await call('GET', `/api/v1/groups/${dir}`)).body.kind, 'directory')
  // every change is in the audit log
  const actions = (await call('GET', '/api/v1/audit?action=group.&limit=200')).body.items.map((e: any) => e.action)
  for (const a of ['group.created', 'group.members_added', 'group.member_removed', 'group.owners_added', 'group.owner_removed']) assert.ok(actions.includes(a), a)
})

test('[0710.R3] people admin: bulk deactivate and reactivate, refused sign-ins, back in users-access on sign-in, group changes, last active', { skip }, async () => {
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const [idle, fresh] = [await id('pa.idle@x.com'), await id('pa.fresh@x.com')]
  const keepers = (await call('POST', '/api/v1/groups', { name: 'pa-keepers' })).body.id
  const access = async (u: string) => (await pool.query(`select 1 from group_members gm join groups g on g.id = gm.group_id where g.system_role = 'default-users' and gm.user_id = $1`, [u])).rowCount === 1
  // out of users-access (as an admin may do): signing in puts them back
  await pool.query(`delete from group_members where user_id = $1 and group_id = (select id from groups where system_role = 'default-users')`, [idle])
  assert.equal(await access(idle), false)
  assert.equal((await call('POST', '/api/v1/me/sign-in', undefined, 'pa.idle@x.com')).status, 204)
  assert.equal(await access(idle), true)
  // deactivated: refused at sign-in and listed; reactivated: back in
  assert.deepEqual((await call('POST', '/api/v1/admin/users/bulk', { action: 'deactivate', userIds: [idle] })).body, { changed: 1, unchanged: 0 })
  assert.equal((await call('GET', '/api/v1/me', undefined, 'pa.idle@x.com')).status, 403)
  assert.ok((await call('GET', '/api/v1/admin/users/refused-sign-ins')).body.some((r: any) => r.email === 'pa.idle@x.com'))
  assert.deepEqual((await call('POST', '/api/v1/admin/users/bulk', { action: 'reactivate', userIds: [idle] })).body, { changed: 1, unchanged: 0 })
  assert.equal((await call('GET', '/api/v1/me', undefined, 'pa.idle@x.com')).status, 200)
  // group changes in bulk; nobody deactivates themselves
  assert.deepEqual((await call('POST', '/api/v1/admin/users/bulk', { action: 'add-to-group', groupId: keepers, userIds: [idle, fresh] })).body, { changed: 2, unchanged: 0 })
  assert.deepEqual((await call('POST', '/api/v1/admin/users/bulk', { action: 'remove-from-group', groupId: keepers, userIds: [idle] })).body, { changed: 1, unchanged: 0 })
  assert.equal((await call('POST', '/api/v1/admin/users/bulk', { action: 'deactivate', userIds: [await id('owner@x.com')] })).status, 400)
  const row = (await call('GET', '/api/v1/admin/users?limit=200')).body.items.find((u: any) => u.id === fresh)
  assert.ok(row.lastActiveAt && row.groups.some((g: any) => g.name === 'pa-keepers'))
  // activity is recorded on use
  await pool.query('update users set last_active_at = null where id = $1', [fresh])
  await call('GET', '/api/v1/me', undefined, 'pa.fresh@x.com')
  assert.ok((await pool.query('select last_active_at from users where id = $1', [fresh])).rows[0].last_active_at)
})

test('[0710.R1][0710.R2] License cleanup is gone: no routes, no setting, no table', { skip }, async () => {
  for (const [m, path] of [['GET', '/api/v1/admin/license-cleanup'], ['POST', '/api/v1/admin/license-cleanup/preview'], ['POST', '/api/v1/admin/license-cleanup/run']] as const)
    assert.equal((await call(m, path, m === 'POST' ? {} : undefined)).status, 404, path)
  assert.equal((await call('GET', '/api/v1/admin/settings')).body.some((s: any) => s.key === 'licenseCleanup'), false)
  assert.equal((await call('PUT', '/api/v1/admin/settings/licenseCleanup', { enabled: false })).status, 404)
  assert.equal((await pool.query(`select to_regclass('license_cleanup_runs') as t`)).rows[0].t, null)
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

test('[0105.R10] custom fields: values must fit the field (number, option, date, text); deleting a field removes its values', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Custom', key: 'CUS', template: 'kanban' })
  const add = async (name: string, kind: string, options: string[] | null = null) =>
    (await call('POST', '/api/v1/projects/CUS/fields', { name, kind, options: options && options.map(name => ({ name })), position: 0 })).body.id as string
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
  // an option disabled later does not block edits to other fields (spec 0105)
  const opts = (await call('GET', '/api/v1/projects/CUS')).body.fields.find((f: any) => f.id === team).options
  await call('PATCH', `/api/v1/projects/CUS/fields/${team}`, { options: opts.map((o: any) => ({ ...o, disabled: o.name === 'Web' })) })
  assert.equal((await call('PATCH', `/api/v1/issues/${i.body.key}`, { title: 'still editable' })).status, 200)
  // deleting a field clears it from every item
  assert.equal((await call('DELETE', `/api/v1/projects/CUS/fields/${note}`)).status, 204)
  assert.equal(note in (await call('GET', `/api/v1/issues/${i.body.key}`)).body.custom, false)
})

test('[0201.R2][0201.R3] permissions come from one table: a refusal names the Jira permission and the project; who may do what is unchanged', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Permitted', key: 'PRM', template: 'kanban' })
  await join('PRM', 'prm.viewer@x.com', 'viewer'); await join('PRM', 'prm.member@x.com', 'member')
  const item = (await call('POST', '/api/v1/projects/PRM/issues', { title: 'Guarded' })).body
  const edit = await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'x' }, 'prm.viewer@x.com')
  assert.deepEqual([edit.status, edit.body.error], [403, 'You need the Edit issues permission in PRM'])
  const settings = await call('PATCH', '/api/v1/projects/PRM', { name: 'x' }, 'prm.member@x.com')
  assert.deepEqual([settings.status, settings.body.error], [403, 'You need the Administer projects permission in PRM'])
  // viewers comment; 0202 made deleting admins-only and 0203 made viewers not assignable
  assert.equal((await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'hi' }, 'prm.viewer@x.com')).status, 201)
  const viewerId = (await call('GET', '/api/v1/me', undefined, 'prm.viewer@x.com')).body.id
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { assigneeId: viewerId })).status, 400)
  assert.equal((await call('DELETE', `/api/v1/issues/${item.key}`, undefined, 'prm.member@x.com')).status, 403)
})

test('[0202.R1][0202.R2][0202.R3][0202.R4][0202.R5][0202.R7] deleting work items as in Jira: project admins only; sub-items go too, an epic’s items stay; restoring brings back what went with it', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Deleting', key: 'DEL', template: 'kanban' })
  await join('DEL', 'del.member@x.com'); await join('DEL', 'del.admin@x.com', 'admin')
  const mk = (title: string, extra: object = {}) => call('POST', '/api/v1/projects/DEL/issues', { title, ...extra }).then(r => r.body)
  const epic = await mk('Epic', { type: 'epic' })
  const story = await mk('Story', { parentId: epic.id }), other = await mk('Other story', { parentId: epic.id })
  const sub = await mk('Sub', { parentId: story.id }), subsub = await mk('Sub 2', { parentId: story.id })   // one level of sub-items since 0303
  const alone = await mk('Alone')
  const get = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).status === 200
  // R1: a member can't delete, one or many; R2: nor restore
  const r = await call('DELETE', `/api/v1/issues/${alone.key}`, undefined, 'del.member@x.com')
  assert.deepEqual([r.status, r.body.error], [403, 'You need the Delete issues permission in DEL'])
  assert.equal((await call('POST', '/api/v1/issues/bulk/delete', { issues: [alone.key] }, 'del.member@x.com')).status, 403)
  // R3: the preview counts the sub-items at every depth; deleting takes them all
  assert.deepEqual((await call('GET', `/api/v1/issues/${story.key}/delete-preview`, undefined, 'del.admin@x.com')).body, { subItems: 2, epicItems: 0 })
  assert.equal((await call('DELETE', `/api/v1/issues/${story.key}`, undefined, 'del.admin@x.com')).status, 204)
  assert.deepEqual([await get(story.key), await get(sub.key), await get(subsub.key)], [false, false, false])
  assert.equal((await call('DELETE', `/api/v1/issues/${story.key}`, undefined, 'del.admin@x.com')).status, 204)   // again: nothing more
  assert.equal((await call('POST', `/api/v1/issues/${alone.key}/restore`, undefined, 'del.member@x.com')).status, 403)
  // R4: deleting an epic leaves its items, without an epic
  assert.deepEqual((await call('GET', `/api/v1/issues/${epic.key}/delete-preview`)).body, { subItems: 0, epicItems: 1 })
  await call('DELETE', `/api/v1/issues/${epic.key}`, undefined, 'del.admin@x.com')
  const left = (await call('GET', `/api/v1/issues/${other.key}`)).body
  assert.equal(left.parentId, null)
  // R7: the list shows what was deleted itself, newest first, with who and how many went with it; admins only
  const list = await call('GET', '/api/v1/projects/DEL/deleted', undefined, 'del.admin@x.com')
  assert.deepEqual(list.body.items.map((x: any) => [x.key, x.subItems, x.deletedBy]), [[epic.key, 0, 'del.admin'], [story.key, 2, 'del.admin']])
  assert.ok(Date.parse(list.body.items[0].removedAt) - Date.parse(list.body.items[0].deletedAt) >= 29 * 864e5)
  assert.equal((await call('GET', '/api/v1/projects/DEL/deleted', undefined, 'del.member@x.com')).status, 403)
  assert.deepEqual((await call('GET', '/api/v1/projects/DEL/deleted?query=epi', undefined, 'del.admin@x.com')).body.items.map((x: any) => x.key), [epic.key])
  // R5: restoring brings back what went with it, and an epic its items
  assert.equal((await call('POST', `/api/v1/issues/${story.key}/restore`, undefined, 'del.admin@x.com')).status, 200)
  assert.deepEqual([await get(story.key), await get(sub.key), await get(subsub.key)], [true, true, true])
  await call('POST', `/api/v1/issues/${epic.key}/restore`, undefined, 'del.admin@x.com')
  assert.equal((await call('GET', `/api/v1/issues/${other.key}`)).body.parentId, epic.id)
  // a sub-item deleted on its own earlier stays deleted when its parent is restored later
  await call('DELETE', `/api/v1/issues/${subsub.key}`, undefined, 'del.admin@x.com')
  await call('DELETE', `/api/v1/issues/${sub.key}`, undefined, 'del.admin@x.com')
  await call('POST', `/api/v1/issues/${sub.key}/restore`, undefined, 'del.admin@x.com')
  assert.deepEqual([await get(sub.key), await get(subsub.key)], [true, false])
})

test('[0202.R6] deleted work items are removed for good after the period in System settings, with what belongs to them', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Purging', key: 'PUR', template: 'kanban' })
  const mk = (title: string) => call('POST', '/api/v1/projects/PUR/issues', { title }).then(r => r.body)
  const old = await mk('Long gone'), fresh = await mk('Just gone')
  await call('POST', `/api/v1/issues/${old.key}/comments`, { body: 'a comment' })
  await call('DELETE', `/api/v1/issues/${old.key}`); await call('DELETE', `/api/v1/issues/${fresh.key}`)
  await pool.query(`update issues set deleted_at = now() - interval '2 days' where id = $1`, [old.id])
  for (const v of [0, 400]) assert.equal((await call('PUT', '/api/v1/admin/settings/deletedItems', { retentionDays: v })).status, 400)
  assert.equal((await call('PUT', '/api/v1/admin/settings/deletedItems', { retentionDays: 1 })).status, 200)
  const { purgeDeleted } = await import('../src/deletedItems.ts')
  const ws = (await call('GET', '/api/v1/me')).body.workspaceId
  assert.ok(await purgeDeleted(ws) >= 1)
  assert.equal((await pool.query('select 1 from issues where id = $1', [old.id])).rows.length, 0)
  assert.equal((await pool.query('select 1 from comments where issue_id = $1', [old.id])).rows.length, 0)
  assert.equal((await pool.query('select 1 from issues where id = $1', [fresh.id])).rows.length, 1)
  await call('PUT', '/api/v1/admin/settings/deletedItems', { retentionDays: 30 })
})

test('[0203.R1][0203.R2][0203.R3][0203.R4][0203.R5][0203.R6][0203.R7][0203.R8] the rest of Jira’s default permission scheme: sprints, attachments, comments, sharing, reporter, watchers and assignees', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Defaults', key: 'DFP', template: 'scrum' })
  const [adm, mem, viw, out] = ['dfp.admin@x.com', 'dfp.member@x.com', 'dfp.viewer@x.com', 'dfp.out@x.com']
  await join('DFP', adm, 'admin'); await join('DFP', mem); await join('DFP', viw, 'viewer')
  const id = async (e: string) => (await call('GET', '/api/v1/me', undefined, e)).body.id as string
  const [admId, memId, viwId, outId] = [await id(adm), await id(mem), await id(viw), await id(out)]
  const item = (await call('POST', '/api/v1/projects/DFP/issues', { title: 'Shared work' }, mem)).body
  // R1: sprints are for project admins
  assert.equal((await call('POST', '/api/v1/projects/DFP/sprints', { name: 'S' }, mem)).status, 403)
  assert.equal((await call('POST', '/api/v1/projects/DFP/sprints', { name: 'S' }, adm)).status, 201)
  // R2: a member deletes their own attachment, not someone else's; an admin deletes any
  const attach = async (who: string) => (await call('POST', `/api/v1/issues/${item.key}/attachments`, { name: 'a.txt', size: 3, type: 'text/plain' }, who)).body.id
  const mine = await attach(mem), theirs = await attach(adm)
  assert.equal((await call('DELETE', `/api/v1/attachments/${theirs}`, undefined, mem)).status, 403)
  assert.equal((await call('DELETE', `/api/v1/attachments/${mine}`, undefined, mem)).status, 204)
  assert.equal((await call('DELETE', `/api/v1/attachments/${theirs}`, undefined, adm)).status, 204)
  // R3: an admin edits and deletes a member's comment, audited; a member can't touch another's
  const c1 = (await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'member says' }, mem)).body
  const c2 = (await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'admin says' }, adm)).body
  assert.equal((await call('PATCH', `/api/v1/comments/${c2.id}`, { body: 'x' }, mem)).status, 403)
  assert.equal((await call('DELETE', `/api/v1/comments/${c2.id}`, undefined, mem)).status, 403)
  assert.equal((await call('PATCH', `/api/v1/comments/${c1.id}`, { body: 'tidied by an admin' }, adm)).status, 200)
  assert.equal((await call('DELETE', `/api/v1/comments/${c1.id}`, undefined, adm)).status, 204)
  assert.equal((await call('GET', '/api/v1/audit?action=comment.moderated')).body.items.filter((x: any) => x.targetId === c1.id).length, 2)
  // R4: limited only to a role I hold or a group I'm in
  const g = (await call('POST', '/api/v1/groups', { name: 'dfp-team' }, adm)).body
  const cm = (v: object, who: string) => call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'v', visibility: v }, who)
  assert.equal((await cm({ kind: 'role', role: 'admin' }, mem)).status, 400)
  assert.equal((await cm({ kind: 'role', role: 'member' }, mem)).status, 201)
  assert.equal((await cm({ kind: 'role', role: 'member' }, viw)).status, 400)
  assert.equal((await cm({ kind: 'group', id: g.id }, mem)).status, 400)
  assert.equal((await cm({ kind: 'group', id: g.id }, adm)).status, 201)
  // R5: a view is shared only with my groups and projects; what it already has stays
  const v = (await call('POST', '/api/v1/views', { name: 'Mine', filters: {}, share: [{ kind: 'group', id: g.id }] }, mem))
  assert.equal(v.status, 400)
  const ok = (await call('POST', '/api/v1/views', { name: 'Ours', filters: {}, share: [{ kind: 'group', id: g.id }] }, adm)).body
  await call('POST', `/api/v1/groups/${g.id}/members/${admId}`, undefined, adm).catch(() => {})
  await pool.query('delete from group_members where group_id = $1 and user_id = $2', [g.id, admId])   // the owner leaves the group
  assert.equal((await call('PATCH', `/api/v1/views/${ok.id}`, { name: 'Ours, renamed', share: ok.share }, adm)).status, 200)
  // R6: an admin changes the reporter, to someone who can see the project; a member can't
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { reporterId: admId }, mem)).status, 403)
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { reporterId: outId }, adm)).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { reporterId: viwId }, adm)).body.reporterId, viwId)
  // R7: viewers aren't assignable; an item already assigned to one keeps it
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { assigneeId: viwId }, adm)).status, 400)
  await pool.query('update issues set assignee_id = $2 where id = $1', [item.id, viwId])
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'still mine' }, adm)).status, 200)
  // R8: an admin adds and removes other watchers who can see the project; a member can't
  assert.equal((await call('PUT', `/api/v1/issues/${item.key}/watchers/${viwId}`, undefined, mem)).status, 403)
  assert.equal((await call('PUT', `/api/v1/issues/${item.key}/watchers/${outId}`, undefined, adm)).status, 400)
  assert.equal((await call('PUT', `/api/v1/issues/${item.key}/watchers/${viwId}`, undefined, adm)).status, 204)
  assert.ok((await call('GET', `/api/v1/issues/${item.key}`)).body.watcherIds.includes(viwId))
  assert.equal((await call('DELETE', `/api/v1/issues/${item.key}/watchers/${viwId}`, undefined, adm)).status, 204)
  assert.equal((await call('PUT', `/api/v1/issues/${item.key}/watchers/${memId}`, undefined, mem)).status, 204)   // yourself: always
})

test('[0105.R1][0105.R2][0105.R3][0105.R4][0105.R5][0105.R6][0105.R9] custom fields as in Jira: the type is fixed; options have ids, and renaming, disabling and deleting one carry through to items', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Options', key: 'OPT', template: 'kanban' })
  const f = (await call('POST', '/api/v1/projects/OPT/fields', { name: 'Team', kind: 'select', options: [{ name: 'Web' }, { name: 'Mobile' }, { name: 'Data' }], position: 0 })).body
  // R2: options come back with ids
  assert.ok(f.options.every((o: any) => o.id && o.disabled === false))
  const [web, mobile, data] = f.options
  const mk = (title: string, team: string) => call('POST', '/api/v1/projects/OPT/issues', { title, custom: { [f.id]: team } }).then(r => r.body)
  const a = await mk('a', 'Mobile'), b = await mk('b', 'Mobile'), c = await mk('c', 'Data')
  // R1: the type can't change; the name can
  const retyped = await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { kind: 'text' })
  assert.deepEqual([retyped.status, retyped.body.errors?.kind], [400, 'Fixed once made'])
  assert.equal((await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { name: 'Squad' })).body.name, 'Squad')
  // R6: names unique within the field, ignoring case, and not empty
  assert.equal((await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, { ...mobile, name: 'web' }, data] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, { ...mobile, name: ' ' }, data] })).status, 400)
  // R5 (before): how many items have each option
  assert.deepEqual((await call('GET', `/api/v1/projects/OPT/fields/${f.id}/usage`)).body.options, { [web.id]: 0, [mobile.id]: 2, [data.id]: 1 })
  // R3: renaming keeps the id and changes it on every item, with a new version; R9: JQL finds them by the new name
  const v = (await call('GET', `/api/v1/issues/${a.key}`)).body.version
  const renamed = (await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, { ...mobile, name: 'Mobile apps' }, data] })).body
  assert.equal(renamed.options[1].id, mobile.id)
  const now = (await call('GET', `/api/v1/issues/${a.key}`)).body
  assert.deepEqual([now.custom[f.id], now.version], ['Mobile apps', v + 1])
  assert.equal((await call('POST', '/api/v1/jql/check', { jql: 'project = OPT AND Squad = "Mobile apps"' })).body.count, 2)
  // R4: a disabled option can't be chosen, stays where it is, and can be enabled again
  const mob = { ...mobile, name: 'Mobile apps' }
  await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, mob, { ...data, disabled: true }] })
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { custom: { [f.id]: 'Data' } })).status, 400)
  assert.equal((await call('GET', `/api/v1/issues/${c.key}`)).body.custom[f.id], 'Data')
  assert.equal((await call('PATCH', `/api/v1/issues/${c.key}`, { title: 'c edited' })).status, 200)
  await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, mob, data] })
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { custom: { [f.id]: 'Data' } })).status, 200)
  // R5: deleting an option clears it from the items that had it
  await call('PATCH', `/api/v1/projects/OPT/fields/${f.id}`, { options: [web, data] })
  assert.equal(f.id in (await call('GET', `/api/v1/issues/${b.key}`)).body.custom, false)
  assert.equal((await call('GET', `/api/v1/issues/${a.key}`)).body.custom[f.id], 'Data')
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
  const p = (await call('POST', '/api/v1/projects', { name: 'Audit trail', key: 'AUD', template: 'kanban' })).body
  await join('AUD', 'aud.admin@x.com', 'admin')
  const memberId = (await call('GET', '/api/v1/me', undefined, 'aud.member@x.com')).body.id
  await call('POST', '/api/v1/projects/AUD/members', { userIds: [memberId], role: 'member' }, 'aud.admin@x.com')
  await call('PATCH', `/api/v1/projects/AUD/members/${memberId}`, { role: 'viewer' }, 'aud.admin@x.com')
  await call('PATCH', '/api/v1/projects/AUD', { name: 'Audited 2' }, 'aud.admin@x.com')
  await call('PATCH', '/api/v1/projects/AUD', { boardPrefs: { groupBy: 'none' } }, 'aud.admin@x.com')       // presentation only: not recorded
  const scrum = (await call('GET', '/api/v1/workflow-schemes')).body.find((x: any) => x.name === 'Scrum')
  assert.notEqual(scrum.id, p.workflowSchemeId)
  await call('PUT', '/api/v1/projects/AUD/workflow-scheme', { schemeId: scrum.id })
  const i = (await call('POST', '/api/v1/projects/AUD/issues', { title: 'to delete' })).body
  await call('DELETE', `/api/v1/issues/${i.key}`, undefined, 'aud.admin@x.com')
  await call('DELETE', `/api/v1/projects/AUD/members/${memberId}`, undefined, 'aud.admin@x.com')

  const log = (await call('GET', '/api/v1/audit?project=AUD', undefined, 'aud.admin@x.com'))
  assert.equal(log.status, 200)
  const actions = log.body.items.map((x: any) => x.action).reverse()
  // the scheme change and what applying it did are one transaction (one moment), so either may be listed first
  const at = actions.indexOf('project.workflow_scheme.changed')
  assert.deepEqual(actions.filter((a: string) => a !== 'project.workflow.applied' && a !== 'project.workflow_scheme.changed'),
    ['project.created', 'project.member.added', 'project.member.role_changed', 'project.updated', 'issue.deleted', 'project.member.removed'])
  assert.deepEqual(actions.filter((a: string) => a === 'project.workflow.applied' || a === 'project.workflow_scheme.changed').sort(), ['project.workflow.applied', 'project.workflow_scheme.changed'])
  assert.equal(Math.abs(actions.indexOf('project.workflow.applied') - at), 1)
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
  await call('POST', '/api/v1/projects/BAK/fields', { name: 'Team', kind: 'select', options: [{ name: 'Core' }], position: 0 })
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
  const b = (await call('GET', '/api/v1/admin/project-backups?query=BAK')).body.items.find((x: any) => x.projectKey === 'BAK')
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
  assert.equal((await call('GET', '/api/v1/admin/project-backups?query=BAK')).body.items.filter((x: any) => x.projectKey === 'BAK').length, 1)
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

  // turning a status into a Done one (in Administration) resolves what is in it (and back)
  const parked = (await call('POST', '/api/v1/admin/statuses', { name: 'Parked here', color: '#aaaaaa', category: 'todo' })).body
  const here = (await flow('RES', [], { add: [parked] })).statuses.find((s: any) => s.name === 'Parked here')
  const d = (await call('POST', '/api/v1/projects/RES/issues', { title: 'd', statusId: here.id })).body
  await call('PATCH', `/api/v1/admin/statuses/${parked.id}`, { category: 'done' })
  assert.equal((await get(d.key)).resolution, 'Done')
  await call('PATCH', `/api/v1/admin/statuses/${parked.id}`, { category: 'todo' })
  assert.equal((await get(d.key)).resolution, null)
  // the change of resolution is in the item's history
  assert.ok((await pool.query(`select 1 from activity where issue_id = $1 and field = 'resolution'`, [a.id])).rows.length)
})

test('CSV export: the same items the search shows (only what you can see), readable names, safe cells, audited', { skip }, async () => {
  const { csvCell } = await import('../src/routes/misc.ts')
  assert.deepEqual(['plain', 'a,b', 'say "hi"', 'two\nlines', '=SUM(A1)', '+1', '-2', '@x', null, ['a', 'b']].map(csvCell),
    ['plain', '"a,b"', '"say ""hi"""', '"two\nlines"', "'=SUM(A1)", "'+1", "'-2", "'@x", '', '"a, b"'])
  await call('POST', '/api/v1/projects', { name: 'Exported', key: 'EXP', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Hidden project', key: 'HID', template: 'kanban' })
  await join('EXP', 'exp.member@x.com')
  const me = (await call('GET', '/api/v1/me', undefined, 'exp.member@x.com')).body
  await call('POST', '/api/v1/projects/EXP/issues', { title: 'Plain row', assigneeId: me.id, labels: ['red', 'blue'] })
  await call('POST', '/api/v1/projects/EXP/issues', { title: '=HYPERLINK("http://evil")', description: 'line one\nline, two' })
  await call('POST', '/api/v1/projects/HID/issues', { title: 'Not for exp.member' })

  const r = await app.inject({ method: 'GET', url: '/api/v1/search/export.csv?resolution=all', headers: { 'x-dev-user': 'exp.member@x.com' } })
  assert.equal(r.statusCode, 200)
  assert.match(String(r.headers['content-type']), /text\/csv/)
  assert.match(String(r.headers['content-disposition']), /attachment; filename="strand-export-\d{4}-\d{2}-\d{2}\.csv"/)
  const body = r.body.replace(/^﻿/, '')
  assert.ok(body.startsWith('Key,Project,Type,Title,Status,Priority,Assignee,'))
  assert.ok(body.includes(`,Plain row,To do,Medium,${me.name},`))   // the priority's name; new work gets the default (spec 0305)
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
  const r = await call('GET', '/api/v1/admin/users?limit=200')
  assert.equal(r.status, 200)
  const by = Object.fromEntries(r.body.items.map((u: any) => [u.email, u]))
  assert.deepEqual([by['adv.member@x.com'].role, by['adv.member@x.com'].active, by['adv.member@x.com'].projects], ['member', true, 1])
  assert.equal(by['adv.gone@x.com'].active, false)
  assert.equal(by['owner@x.com'].role, 'owner')
  assert.equal((await call('GET', '/api/v1/admin/users', undefined, 'adv.member@x.com')).status, 403)
})

test('groups at scale: the list and a group’s members come a page at a time, searchable; nothing is cut off', { skip, timeout: 60_000 }, async () => {
  const ws = (await call('GET', '/api/v1/me')).body.workspaceId
  await pool.query(`insert into groups (display_name) select 'scale-group-' || lpad(n::text, 3, '0') from generate_series(1, 150) n`)
  const g = (await pool.query(`select id from groups where display_name = 'scale-group-001'`)).rows[0].id
  await pool.query(`insert into users (email, name, initials) select 'gm' || n || '@x.com', 'Group member ' || lpad(n::text, 3, '0'), 'GM' from generate_series(1, 120) n`)
  await pool.query(`insert into memberships (workspace_id, user_id, role) select $1, id, 'member' from users where email like 'gm%@x.com' on conflict do nothing`, [ws])
  await pool.query(`insert into group_members (group_id, user_id) select $1, id from users where email like 'gm%@x.com'`, [g])
  const l1 = (await call('GET', '/api/v1/groups?query=scale-group&limit=100')).body
  const l2 = (await call('GET', `/api/v1/groups?query=scale-group&limit=100&cursor=${l1.next}`)).body
  assert.deepEqual([l1.items.length, l2.items.length, l2.next], [100, 50, null])
  assert.equal(new Set([...l1.items, ...l2.items].map((x: any) => x.id)).size, 150)
  const all = (await call('GET', '/api/v1/groups?limit=200')).body.items
  assert.ok(all[0].kind === 'system')                                                         // system groups first
  const d = (await call('GET', `/api/v1/groups/${g}`)).body
  assert.equal(d.people.length, 50); assert.ok(d.morePeople)
  const m2 = (await call('GET', `/api/v1/groups/${g}/members?cursor=${d.morePeople}&limit=100`)).body
  assert.deepEqual([m2.items.length, m2.next], [70, null])
  assert.deepEqual((await call('GET', `/api/v1/groups/${g}/members?query=member%2011`)).body.items.map((x: any) => x.name).sort(),
    ['Group member 110', 'Group member 111', 'Group member 112', 'Group member 113', 'Group member 114', 'Group member 115', 'Group member 116', 'Group member 117', 'Group member 118', 'Group member 119'].sort())
  assert.equal((await call('GET', '/api/v1/groups?cursor=nope')).status, 400)
})

test('people at scale: searched, filtered and paged on the server; everyone a filter matches changes in the background', { skip, timeout: 120_000 }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const ws = (await call('GET', '/api/v1/me')).body.workspaceId
  // 230 people called "Bulk person …", half of them idle for a year
  await pool.query(`insert into users (email, name, initials, last_active_at) select 'bulk' || n || '@x.com', 'Bulk person ' || lpad(n::text, 3, '0'), 'BP',
                      case when n % 2 = 0 then now() - interval '400 days' else now() end from generate_series(1, 230) n`)
  await pool.query(`insert into memberships (workspace_id, user_id, role) select $1, id, 'member' from users where email like 'bulk%@x.com' on conflict do nothing`, [ws])
  const page = (q: string) => call('GET', `/api/v1/admin/users?${q}`)
  const p1 = (await page('query=bulk%20person&limit=100')).body
  const p2 = (await page(`query=bulk%20person&limit=100&cursor=${p1.next}`)).body
  const p3 = (await page(`query=bulk%20person&limit=100&cursor=${p2.next}`)).body
  assert.deepEqual([p1.total, p1.items.length, p2.items.length, p3.items.length, p3.next], [230, 100, 100, 30, null])
  const names = [...p1.items, ...p2.items, ...p3.items].map((u: any) => u.name)
  assert.equal(new Set(names).size, 230); assert.deepEqual(names, [...names].sort())         // every one once, in name order
  assert.equal((await page('query=bulk%20person&inactive=365')).body.total, 115)
  assert.equal((await page('query=bulk%20person&status=deactivated')).body.total, 0)
  assert.equal((await page('cursor=nonsense')).status, 400)
  // deactivate everyone idle for a year: more than one request may name, so a background job, with progress
  const r = await call('POST', '/api/v1/admin/users/bulk', { filter: { query: 'bulk person', inactive: '365' }, action: 'deactivate' })
  assert.deepEqual([r.status, r.body.matched], [202, 115])
  await runJobs()
  const job = (await call('GET', `/api/v1/jobs/${r.body.jobId}`)).body
  assert.deepEqual([job.status, job.result.changed, job.progress.done], ['done', 115, 115])
  assert.equal((await page('query=bulk%20person&status=deactivated')).body.total, 115)
  assert.equal((await call('POST', '/api/v1/admin/users/bulk', { action: 'reactivate' })).status, 400)       // people, or a filter
  assert.equal((await call('POST', '/api/v1/admin/users/bulk', { filter: {}, action: 'reactivate' }, 'adv.member@x.com')).status, 403)
})

test('[0104.R1][0104.R2][0104.R3][0104.R4][0104.R5][0104.R6][0104.R7] directory groups are the directory’s: names unique, read-only in Strand, deletes go through and are audited; Strand’s own groups are out of SCIM’s reach', { skip }, async () => {
  const scim = (method: string, path: string, body?: unknown) =>
    app.inject({ method: method as any, url: `/scim/v2${path}`, payload: body as any, headers: { authorization: 'Bearer scim-secret', 'content-type': 'application/scim+json' } })
  await call('GET', '/api/v1/me')
  const uid = async (who: string) => (await call('GET', '/api/v1/me', undefined, `${who}@x.com`)).body.id as string
  const [dee, eve] = [await uid('dg.dee'), await uid('dg.eve')]
  // R2: made by SCIM without the directory's id, it is still a directory group; R3: Strand's own groups are invisible to SCIM
  const made = await scim('POST', '/Groups', { displayName: 'Directory ops', members: [{ value: dee }] })
  assert.equal(made.statusCode, 201)
  const dg = JSON.parse(made.body)
  assert.equal((await call('GET', `/api/v1/groups/${dg.id}`)).body.kind, 'directory')
  const own = (await call('POST', '/api/v1/groups', { name: 'Strand crew' })).body
  const list = JSON.parse((await scim('GET', '/Groups')).body).Resources.map((g: any) => g.id)
  assert.ok(list.includes(dg.id) && !list.includes(own.id))
  for (const [m, b] of [['GET', undefined], ['PATCH', { Operations: [{ op: 'Add', path: 'members', value: [{ value: eve }] }] }], ['DELETE', undefined]] as const)
    assert.equal((await scim(m, `/Groups/${own.id}`, b)).statusCode, 404, m)
  assert.equal((await call('GET', `/api/v1/groups/${own.id}`)).body.members, 1)
  // R1 + R4: names are unique ignoring case, for SCIM and in Strand
  assert.equal((await scim('POST', '/Groups', { displayName: 'strand CREW' })).statusCode, 409)
  assert.equal((await call('POST', '/api/v1/groups', { name: 'DIRECTORY OPS' })).status, 409)
  // R5: a rename from the directory keeps members and roles, and is audited; to a taken name, refused
  await call('POST', '/api/v1/projects', { name: 'Dir groups', key: 'DGP', template: 'kanban' })
  assert.equal((await call('POST', '/api/v1/projects/DGP/groups', { groupId: dg.id, role: 'admin' })).status, 200)
  await pool.query(`delete from project_members where project_id = (select id from projects where key = 'DGP')`)   // the group is the only admin route
  assert.equal((await scim('PATCH', `/Groups/${dg.id}`, { Operations: [{ op: 'Replace', path: 'displayName', value: 'Strand Crew' }] })).statusCode, 409)
  assert.equal((await scim('PATCH', `/Groups/${dg.id}`, { Operations: [{ op: 'Replace', path: 'displayName', value: 'Platform ops' }] })).statusCode, 204)
  assert.equal((await call('GET', '/api/v1/projects/DGP', undefined, 'dg.dee@x.com')).body.role, 'admin')
  await call('POST', '/api/v1/projects/DGP/issues', { title: 'Dee’s work', assigneeId: dee })
  const count = async (q: string) => (await call('POST', '/api/v1/jql/check', { jql: q })).body.count
  assert.deepEqual([await count('project = DGP AND assignee in membersOf("Platform ops")'), await count('project = DGP AND assignee in membersOf("Directory ops")')], [1, 0])
  assert.ok((await call('GET', '/api/v1/audit?action=group.renamed')).body.items.some((x: any) => x.targetId === dg.id))
  // R7: nobody in Strand changes a directory group or who is in it, global admins included
  assert.equal((await call('DELETE', `/api/v1/groups/${dg.id}`)).status, 403)
  assert.equal((await call('POST', `/api/v1/groups/${dg.id}/members`, { userIds: [eve] })).status, 403)
  assert.equal((await call('DELETE', `/api/v1/groups/${dg.id}/members/${dee}`)).status, 403)
  assert.equal((await call('POST', '/api/v1/admin/users/bulk', { userIds: [eve], action: 'add-to-group', groupId: dg.id })).status, 400)
  // R6: deleting from the directory goes through and says which project was left without an admin; people stay
  assert.equal((await scim('DELETE', `/Groups/${dg.id}`)).statusCode, 204)
  const del = (await call('GET', '/api/v1/audit?action=group.deleted')).body.items.find((x: any) => x.targetId === dg.id)
  assert.deepEqual([del.before.roles, del.after.projectsWithoutAdmin], [['DGP: admin'], ['DGP']])
  assert.equal((await call('GET', '/api/v1/me', undefined, 'dg.dee@x.com')).status, 200)
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
  const wf = p.workflows[0].workflowId, gs = p.statuses[0].globalStatusId, none = '00000000-0000-4000-8000-000000000000'
  const board = p.boards[0].id
  const field = await make('fields', { name: 'Team', kind: 'text', options: null, position: 0 })
  const template = await make('templates', { name: 'Bug', type: 'bug', title: 'Bug:' })
  const rule = await make('rules', { name: 'Rule', trigger: { kind: 'created' }, actions: [] })
  const release = await make('releases', { name: '1.0' })
  const component = await make('components', { name: 'Matrix component' })
  const level = await make('security-levels', { name: 'Matrix fixture level', members: [{ kind: 'role', role: 'admin' }] })
  const sprint = await make('sprints', { name: 'Sprint' })
  for (const t of ['one', 'two', 'three']) await call('POST', '/api/v1/projects/MTX/issues', { title: t })
  await call('PUT', '/api/v1/projects/MTX/testing', { enabled: true })
  const mtest = (await call('POST', '/api/v1/projects/MTX/issues', { title: 'Matrix test', type: 'test' })).body.key
  const mset = (await call('POST', '/api/v1/projects/MTX/issues', { title: 'Matrix set', type: 'test_set' })).body.key
  await call('POST', `/api/v1/issues/${mset}/tests`, { keys: [mtest] })
  const tfolder = await make('test-folders', { name: 'Matrix folder' })
  const mgroup = (await call('POST', '/api/v1/groups', { name: 'Matrix group' })).body.id
  const mexec = (await call('POST', `/api/v1/issues/${mset}/executions`, {})).body.key
  const mrun = (await call('GET', `/api/v1/issues/${mexec}/runs`)).body[0].id
  await call('DELETE', '/api/v1/issues/MTX-2')                                         // a deleted item, to restore
  const comment = (await call('POST', '/api/v1/issues/MTX-1/comments', { body: 'mine' })).body.id
  const worklog = (await call('POST', '/api/v1/issues/MTX-1/worklogs', { minutes: 5, date: '2026-10-01' })).body.id
  const ticket = (await call('POST', '/api/v1/issues/MTX-1/attachments', { name: 'a.txt', size: 1, type: 'text/plain' })).body
  await fetch(ticket.uploadUrl, { method: 'PUT', body: 'a' }); await call('POST', `/api/v1/attachments/${ticket.id}/complete`)
  const group = (await pool.query(`insert into groups (display_name) values ('Matrix team') returning id`)).rows[0].id
  await call('POST', '/api/v1/projects/MTX/groups', { groupId: group, role: 'viewer' })
  const view = (await call('POST', '/api/v1/views', { name: 'Matrix view', filters: {} })).body.id
  const token = (await call('POST', '/api/v1/me/tokens', { name: 'mine' })).body.id
  const notification = (await pool.query(
    `insert into notifications (user_id, issue_id, kind, text) select $1, i.id, 'assigned', 'matrix' from issues i join projects p on p.id = i.project_id where p.key = 'MTX' limit 1 returning id`, [ownerId])).rows[0].id
  const job = await enqueue(db, 'matrix.noop', {}, { workspaceId: p.workspaceId, createdBy: ownerId })
  const backup = (await pool.query(`insert into project_backups (workspace_id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, sha256)
    values ($1, gen_random_uuid(), 'OLD', 'Old', 'files', 'x/project.json', 0, 0, 0, 'x') returning id`, [p.workspaceId])).rows[0].id

  // Who must be refused:
  //   public - no sign-in needed (signing in itself, spec 0711)
  //   any    - anyone signed in (results are limited to what they may see); only a missing sign-in is refused
  //   read   - project viewers; outsiders get 404 (the project does not exist for them)
  //   viewer - viewers may do it too (comment, watch, star…); outsiders 404
  //   write  - members; viewers 403; outsiders 404
  //   padmin - project admins; members and viewers 403; outsiders 404
  //   gadmin - workspace admins; everyone else 403
  //   own    - only the person it belongs to; others 403 or 404
  type Rule = 'public' | 'any' | 'read' | 'viewer' | 'write' | 'padmin' | 'gadmin' | 'own'
  const K = 'MTX', I = 'MTX-1'
  const PRESET_AD = (await import('../src/directories.ts')).PRESETS.ad
  const M: Record<string, [Rule, string, object?]> = {
    'GET /me': ['any', '/me'], 'GET /users': ['any', '/users'], 'GET /users/search': ['any', '/users/search'],
    'GET /projects': ['any', '/projects'], 'POST /projects': ['any', '/projects', { name: 'M', key: 'MTXNEW', template: 'kanban' }],
    'GET /projects/search': ['any', '/projects/search'],
    'POST /projects/{key}/archive': ['gadmin', `/projects/${K}/archive`], 'POST /projects/{key}/restore': ['gadmin', `/projects/${K}/restore`],   // 0102.R1
    'GET /admin/archived-projects': ['gadmin', '/admin/archived-projects'],   // 0102.R7
    'GET /auth/config': ['public', '/auth/config'], 'POST /auth/logout': ['public', '/auth/logout'],   // 0711.R1
    'POST /auth/login': ['public', '/auth/login', { username: 'matrix.nobody', password: 'x' }],
    'GET /admin/authentication': ['gadmin', '/admin/authentication'],   // 0711.R11
    'GET /admin/directories': ['gadmin', '/admin/directories'], 'GET /admin/directories/presets': ['gadmin', '/admin/directories/presets'],   // 0712.R13
    'GET /admin/directories/{id}': ['gadmin', `/admin/directories/${none}`],
    'POST /admin/directories': ['gadmin', '/admin/directories', { name: 'Matrix directory', type: 'ad', enabled: false, config: { ...PRESET_AD, ...corpConfig() }, password: 'x' }],
    'PUT /admin/directories/{id}': ['gadmin', `/admin/directories/${none}`, { name: 'Matrix directory', enabled: false, config: { ...PRESET_AD, ...corpConfig() } }],
    'PUT /admin/directories/order': ['gadmin', '/admin/directories/order', { ids: [none] }],
    'POST /admin/directories/test': ['gadmin', '/admin/directories/test', { config: { ...PRESET_AD, ...corpConfig({ host: 'matrix.invalid' }) }, password: 'x' }],
    'POST /admin/directories/{id}/sync': ['gadmin', `/admin/directories/${none}/sync`],
    'PUT /admin/authentication': ['gadmin', '/admin/authentication', { loginForm: true, fallback: false }],
    'PUT /admin/authentication/entra': ['gadmin', '/admin/authentication/entra', { enabled: false, tenantId: '11111111-1111-4111-8111-111111111111', apiClientId: '22222222-2222-4222-8222-222222222222', webClientId: '33333333-3333-4333-8333-333333333333' }],
    'GET /priorities': ['any', '/priorities'], 'GET /resolutions': ['any', '/resolutions'],   // 0305.R1
    'POST /admin/priorities': ['gadmin', '/admin/priorities', { name: 'Matrix priority', color: '#123456', icon: 'flame' }],   // 0305.R1
    'PATCH /admin/priorities/{key}': ['gadmin', '/admin/priorities/low', { description: 'x' }],
    'DELETE /admin/priorities/{key}': ['gadmin', '/admin/priorities/p-000000000000?moveTo=low'],
    'POST /admin/resolutions': ['gadmin', '/admin/resolutions', { name: 'Matrix resolution' }],   // 0305.R5
    'PATCH /admin/resolutions/{id}': ['gadmin', `/admin/resolutions/${none}`, { description: 'x' }],
    'DELETE /admin/resolutions/{id}': ['gadmin', `/admin/resolutions/${none}?moveTo=${none}`],
    'GET /projects/{key}/fields/{id}/usage': ['read', `/projects/${K}/fields/${field}/usage`],   // 0105.R5
    'GET /projects/{key}': ['read', `/projects/${K}`], 'PATCH /projects/{key}': ['padmin', `/projects/${K}`, { name: 'x' }],
    'DELETE /projects/{key}': ['gadmin', `/projects/${K}`],
    'PUT /projects/{key}/star': ['viewer', `/projects/${K}/star`], 'DELETE /projects/{key}/star': ['viewer', `/projects/${K}/star`],
    'GET /projects/{key}/events': ['read', `/projects/${K}/events`],
    'PATCH /projects/{key}/statuses/{id}': ['padmin', `/projects/${K}/statuses/${p.statuses[0].id}`, { wipLimit: 2 }],
    'GET /projects/{key}/workflow': ['read', `/projects/${K}/workflow`],
    'PUT /projects/{key}/workflow-scheme': ['gadmin', `/projects/${K}/workflow-scheme`, { schemeId: p.workflowSchemeId, dryRun: true }],   // 0103.R5
    'GET /workflow-schemes': ['any', '/workflow-schemes'], 'GET /workflows': ['any', '/workflows'], 'GET /workflows/{id}': ['any', `/workflows/${wf}`],
    'GET /workflows/{id}/versions': ['any', `/workflows/${wf}/versions`], 'GET /workflows/{id}/versions/{version}': ['any', `/workflows/${wf}/versions/1`],
    'GET /admin/statuses': ['gadmin', '/admin/statuses'],
    'POST /admin/statuses': ['gadmin', '/admin/statuses', { name: 'Matrix status', color: '#000000', category: 'todo' }],
    'PATCH /admin/statuses/{id}': ['gadmin', `/admin/statuses/${gs}`, { color: '#000000' }],
    'DELETE /admin/statuses/{id}': ['gadmin', `/admin/statuses/${none}`],
    'POST /admin/workflows': ['gadmin', '/admin/workflows', { name: 'Matrix workflow' }],
    'PATCH /admin/workflows/{id}': ['gadmin', `/admin/workflows/${wf}`, { description: 'x' }],
    'DELETE /admin/workflows/{id}': ['gadmin', `/admin/workflows/${none}`],
    'GET /admin/workflows/{id}/projects': ['gadmin', `/admin/workflows/${wf}/projects`],
    'GET /admin/workflow-schemes/{id}/projects': ['gadmin', `/admin/workflow-schemes/${p.workflowSchemeId}/projects`],
    'GET /admin/workflows/applying': ['gadmin', '/admin/workflows/applying'],
    'GET /projects/{key}/boards': ['read', `/projects/${K}/boards`],
    'POST /projects/{key}/boards': ['padmin', `/projects/${K}/boards`, { name: 'Matrix board', type: 'kanban' }],
    'GET /boards/{id}': ['read', `/boards/${board}`],
    'PATCH /boards/{id}': ['padmin', `/boards/${board}`, { name: 'Matrix board' }],
    'DELETE /boards/{id}': ['padmin', `/boards/${board}`],
    'GET /boards/{id}/issues': ['read', `/boards/${board}/issues`],
    'GET /boards/{id}/statuses': ['read', `/boards/${board}/statuses`],
    'POST /jql/check': ['any', '/jql/check', { jql: 'project = MTX' }],
    'POST /admin/workflows/{id}/publish': ['gadmin', `/admin/workflows/${wf}/publish`, { statuses: [{ id: gs, name: 'To do', color: '#94a3b8', category: 'todo' }], transitions: [], dryRun: true }],
    'POST /admin/workflow-schemes': ['gadmin', '/admin/workflow-schemes', { name: 'Matrix scheme', defaultWorkflowId: wf }],
    'PATCH /admin/workflow-schemes/{id}': ['gadmin', `/admin/workflow-schemes/${p.workflowSchemeId}`, { description: 'x', dryRun: true }],
    'DELETE /admin/workflow-schemes/{id}': ['gadmin', `/admin/workflow-schemes/${none}`],
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
    'POST /projects/{key}/releases/{id}/merge': ['padmin', `/projects/${K}/releases/${release}/merge`, { from: ['00000000-0000-4000-8000-000000000000'] }],   // 0304.R3
    'GET /projects/{key}/releases/{id}/usage': ['read', `/projects/${K}/releases/${release}/usage`],   // 0304.R5
    'GET /projects/{key}/components/{id}/usage': ['read', `/projects/${K}/components/${component}/usage`],   // 0304.R5
    'GET /projects/{key}/sprints/{id}/report': ['read', `/projects/${K}/sprints/${sprint}/report`],   // 0402.R8
    'POST /projects/{key}/sprints/{id}/reopen': ['padmin', `/projects/${K}/sprints/${sprint}/reopen`],   // 0403.R1
    'POST /projects/{key}/sprints':['write', `/projects/${K}/sprints`, { name: 's' }],   // 0101.R8
    'PATCH /projects/{key}/sprints/{id}': ['write', `/projects/${K}/sprints/${sprint}`, { name: 'x' }],   // 0101.R8
    'DELETE /projects/{key}/sprints/{id}': ['write', `/projects/${K}/sprints/${sprint}`],   // 0101.R8
    'POST /projects/{key}/sprints/{id}/start': ['write', `/projects/${K}/sprints/${sprint}/start`, { endsAt: '2026-12-01T00:00:00.000Z' }],   // 0101.R8
    'POST /projects/{key}/sprints/{id}/complete': ['write', `/projects/${K}/sprints/${sprint}/complete`, {}],   // 0101.R8
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
    'DELETE /issues/{key}': ['padmin', `/issues/${I}`],   // 0202.R1
    'GET /issues/{key}/comments': ['read', `/issues/${I}/comments`], 'POST /issues/{key}/comments': ['viewer', `/issues/${I}/comments`, { body: 'x' }],
    'GET /issues/{key}/activity': ['read', `/issues/${I}/activity`],
    'POST /issues/{key}/clone': ['write', `/issues/${I}/clone`, {}],
    'GET /issues/{key}/transitions': ['read', `/issues/${I}/transitions`],
    'POST /issues/{key}/transitions': ['write', `/issues/${I}/transitions`, { transitionId: p.transitions[0].id }],
    'POST /issues/bulk/edit': ['write', '/issues/bulk/edit', { issues: [I], patch: { title: 'x' } }],
    'POST /issues/bulk/delete': ['padmin', '/issues/bulk/delete', { issues: [I] }],   // 0202.R1
    'POST /issues/bulk/restore': ['padmin', '/issues/bulk/restore', { issues: ['MTX-2'] }],   // 0202.R2
    'POST /issues/{key}/view': ['viewer', `/issues/${I}/view`], 'POST /issues/{key}/restore': ['padmin', '/issues/MTX-2/restore'],   // 0202.R2
    'GET /issues/{key}/delete-preview': ['padmin', `/issues/${I}/delete-preview`], 'GET /projects/{key}/deleted': ['padmin', `/projects/${K}/deleted`],   // 0202.R3 R7
    'POST /issues/{key}/links': ['write', `/issues/${I}/links`, { type: 'relates', targetKey: 'MTX-3' }],
    'DELETE /issues/{key}/links': ['write', `/issues/${I}/links?type=relates&target=MTX-3`],
    'PUT /issues/{key}/watch': ['viewer', `/issues/${I}/watch`], 'DELETE /issues/{key}/watch': ['viewer', `/issues/${I}/watch`],
    'PUT /issues/{key}/watchers/{userId}': ['padmin', `/issues/${I}/watchers/${ownerId}`], 'DELETE /issues/{key}/watchers/{userId}': ['padmin', `/issues/${I}/watchers/${ownerId}`],   // 0203.R8
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
    'POST /me/sign-in': ['any', '/me/sign-in'],
    'POST /admin/users/bulk': ['gadmin', '/admin/users/bulk', { userIds: [viewerId], action: 'reactivate' }],
    'GET /admin/users/refused-sign-ins': ['gadmin', '/admin/users/refused-sign-ins'],
    'GET /groups': ['any', '/groups'],
    'GET /groups/{id}/members': ['any', `/groups/${mgroup}/members`],
    'GET /groups/{id}': ['any', `/groups/${mgroup}`],
    'POST /groups': ['any', '/groups', { name: 'Matrix made group' }],
    'PATCH /groups/{id}': ['own', `/groups/${mgroup}`, { description: 'x' }],
    'DELETE /groups/{id}': ['own', `/groups/${mgroup}`],
    'POST /groups/{id}/members': ['own', `/groups/${mgroup}/members`, { userIds: [viewerId] }],
    'DELETE /groups/{id}/members/{userId}': ['own', `/groups/${mgroup}/members/${ownerId}`],
    'POST /groups/{id}/owners': ['own', `/groups/${mgroup}/owners`, { userIds: [viewerId] }],
    'DELETE /groups/{id}/owners/{userId}': ['own', `/groups/${mgroup}/owners/${ownerId}`],
    'PUT /projects/{key}/testing': ['padmin', `/projects/${K}/testing`, { enabled: false }],
    'GET /issues/{key}/tests': ['read', `/issues/${mset}/tests`],
    'POST /issues/{key}/tests': ['write', `/issues/${mset}/tests`, { keys: [mtest] }],
    'PATCH /issues/{key}/tests/{test}': ['write', `/issues/${mset}/tests/${mtest}`, { folder: 'x' }],
    'DELETE /issues/{key}/tests/{test}': ['write', `/issues/${mset}/tests/${mtest}`],
    'GET /issues/{key}/test-containers': ['read', `/issues/${mtest}/test-containers`],
    'GET /projects/{key}/test-folders': ['read', `/projects/${K}/test-folders`],
    'POST /projects/{key}/test-folders': ['write', `/projects/${K}/test-folders`, { name: 'Matrix folder 2' }],
    'PATCH /projects/{key}/test-folders/{folderId}': ['write', `/projects/${K}/test-folders/${tfolder}`, { name: 'Matrix folder 3' }],
    'DELETE /projects/{key}/test-folders/{folderId}': ['write', `/projects/${K}/test-folders/${tfolder}`],
    'GET /test-statuses': ['any', '/test-statuses'],
    'GET /issues/{key}/coverage': ['read', `/issues/${K}-1/coverage`],
    'GET /projects/{key}/test-results': ['read', `/projects/${K}/test-results`],
    'GET /projects/{key}/reports/traceability': ['read', `/projects/${K}/reports/traceability`],
    'GET /projects/{key}/reports/test-runs': ['read', `/projects/${K}/reports/test-runs`],
    'POST /testing/import/{format}': ['write', `/testing/import/xray?projectKey=${K}`, { tests: [{ testKey: mtest, status: 'PASS' }] }],
    'POST /admin/test-statuses': ['gadmin', '/admin/test-statuses', { kind: 'run', name: 'Matrix status', color: '#123456', mapsTo: 'unknown' }],
    'PATCH /admin/test-statuses/{kind}/{key}': ['gadmin', '/admin/test-statuses/run/PASS', { color: '#16A34A' }],
    'DELETE /admin/test-statuses/{kind}/{key}': ['gadmin', '/admin/test-statuses/run/c-nothinghere'],
    'GET /issues/{key}/runs': ['read', `/issues/${mexec}/runs`],
    'POST /issues/{key}/runs': ['write', `/issues/${mexec}/runs`, { keys: [mtest] }],
    'DELETE /issues/{key}/runs/{test}': ['write', `/issues/${mexec}/runs/${mtest}`],
    'GET /issues/{key}/executions': ['read', `/issues/${mset}/executions`],
    'POST /issues/{key}/executions': ['write', `/issues/${mset}/executions`, {}],
    'GET /issues/{key}/test-progress': ['read', `/issues/${mexec}/test-progress`],
    'GET /test-runs/{id}': ['read', `/test-runs/${mrun}`],
    'PATCH /test-runs/{id}': ['write', `/test-runs/${mrun}`, { comment: 'x' }],
    'POST /test-runs/{id}/reset': ['write', `/test-runs/${mrun}/reset`],
    'POST /test-runs/{id}/defects': ['write', `/test-runs/${mrun}/defects`, { title: 'Matrix defect' }],
    'DELETE /test-runs/{id}/defects/{defect}': ['write', `/test-runs/${mrun}/defects/00000000-0000-4000-8000-000000000000`],
    'POST /test-runs/{id}/evidence': ['write', `/test-runs/${mrun}/evidence`, { attachmentId: '00000000-0000-4000-8000-000000000000' }],
    'GET /projects/{key}/security-levels': ['read', `/projects/${K}/security-levels`],
    'POST /projects/{key}/security-levels': ['padmin', `/projects/${K}/security-levels`, { name: 'Matrix level', members: [{ kind: 'role', role: 'admin' }] }],
    'PATCH /projects/{key}/security-levels/{levelId}': ['padmin', `/projects/${K}/security-levels/${level}`, { description: 'x' }],
    'DELETE /projects/{key}/security-levels/{levelId}': ['padmin', `/projects/${K}/security-levels/${level}`],
    'GET /me/notification-prefs': ['any', '/me/notification-prefs'],
    'PUT /me/notification-prefs': ['any', '/me/notification-prefs', { prefs: [] }],
    'POST /projects/{key}/import': ['write', `/projects/${K}/import`, { csv: 'Title\nx', mapping: { title: 0 } }],
    'GET /projects/{key}/automation/runs': ['padmin', `/projects/${K}/automation/runs`],
    'POST /projects/{key}/automation/dry-run': ['padmin', `/projects/${K}/automation/dry-run`, { issue: I, actions: [] }],
    'GET /admin/views': ['gadmin', '/admin/views'],
    'POST /projects/{key}/components': ['padmin', `/projects/${K}/components`, { name: 'Matrix part' }],
    'PATCH /projects/{key}/components/{id}': ['padmin', `/projects/${K}/components/${component}`, { description: 'x' }],
    'DELETE /projects/{key}/components/{id}': ['padmin', `/projects/${K}/components/${component}`],
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
    // tests run the dev login without a secret, where no header means the default dev user: a bad token stands for "not signed in"
    const r = await app.inject({ method: method as any, url: `/api/v1${path}`, payload: body as any, headers: as ? { 'x-dev-user': as } : { authorization: 'Bearer not-a-token' } })
    return r.statusCode
  }
  const wrong: string[] = []
  const expect = (op: string, as: string, got: number, ok: number[]) => { if (!ok.includes(got)) wrong.push(`${op} as ${as}: ${got}, expected ${ok.join(' or ')}`) }
  for (const op of Object.keys(M)) {
    const rule = M[op]![0]
    if (rule === 'public') { expect(op, 'nobody', await send(op, null), [200, 204, 400, 401, 403]); continue }
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
  assert.deepEqual(all.map((s: any) => s.key), ['rateLimiting', 'attachments', 'accessTokens', 'searchAndBulk', 'signIn', 'groups', 'testing', 'dueReminders', 'email', 'deletedItems', 'projectKeys', 'timeTracking'])
  assert.equal(all.find((s: any) => s.key === 'rateLimiting').value.enabled, false)                  // no limit unless an admin sets one
  assert.equal((await call('GET', '/api/v1/admin/settings', undefined, 'set.member@x.com')).status, 403)
  assert.equal((await put('attachments', { enabled: true, maxSizeMb: 5 }, 'set.member@x.com')).status, 403)
  assert.equal((await put('nonsense', {})).status, 404)
  const bad = await put('accessTokens', { enabled: true, maxPerUser: 0, maxExpiryDays: 30, defaultExpiryDays: 60 })
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.maxPerUser && bad.body.errors.defaultExpiryDays)

  // public settings: what the web app needs, for anyone signed in (not rate limiting)
  const pub = (await call('GET', '/api/v1/settings/public', undefined, 'set.member@x.com')).body
  assert.deepEqual(Object.keys(pub).sort(), ['accessTokens', 'attachments', 'dueReminders', 'groups', 'priorities', 'projectKeys', 'resolutions', 'searchAndBulk', 'testing', 'timeTracking'])

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

test('[0301.R1][0301.R3][0301.R5][0301.R6][0301.R8] several fix versions: set, searched, moved on release, removed with the version, exported and imported', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Fix versions', key: 'FXV', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Fix versions elsewhere', key: 'FXO', template: 'kanban' })
  const rel = async (key: string, name: string) => (await call('POST', `/api/v1/projects/${key}/releases`, { name })).body.id as string
  const [a, b, c, other] = [await rel('FXV', '2.3'), await rel('FXV', '2.4'), await rel('FXV', '2.5'), await rel('FXO', '9.0')]
  // R1: a list of the project's versions; another project's is refused; the change is in the history
  const both = (await call('POST', '/api/v1/projects/FXV/issues', { title: 'Back-ported', fixReleaseIds: [a, b] })).body
  assert.deepEqual(both.fixReleaseIds, [a, b])
  assert.equal((await call('POST', '/api/v1/projects/FXV/issues', { title: 'x', fixReleaseIds: [other] })).status, 400)
  const one = (await call('POST', '/api/v1/projects/FXV/issues', { title: 'Only 2.3' })).body
  assert.deepEqual((await call('PATCH', `/api/v1/issues/${one.key}`, { fixReleaseIds: [a] })).body.fixReleaseIds, [a])
  assert.ok((await call('GET', `/api/v1/issues/${one.key}?expand=activity`)).body.activity.some((x: any) => x.field === 'fixReleaseIds'))
  const none = (await call('POST', '/api/v1/projects/FXV/issues', { title: 'Unplanned' })).body
  assert.deepEqual(none.fixReleaseIds, [])
  // R3: JQL matches any of an item's fix versions
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = FXV AND ${q} ORDER BY key`)}&limit=50`)).body.items.map((i: any) => i.key)
  assert.deepEqual(await jql('fixVersion = "2.4"'), [both.key])
  assert.deepEqual(await jql('fixVersion in ("2.3", "2.4")'), [both.key, one.key])
  assert.deepEqual(await jql('fixVersion is EMPTY'), [none.key])
  assert.deepEqual(await jql('fixVersion != "2.4"'), [one.key])
  assert.deepEqual(await jql('fixVersion not in ("2.4")'), [one.key])                    // as in Jira, an item with none matches neither
  assert.deepEqual(await jql('affectedVersion != "2.4"'), [])
  // R8: the export lists them all
  const csv = (await app.inject({ method: 'GET', url: '/api/v1/search/export.csv?q=Back-ported&resolution=all', headers: { 'x-dev-user': 'owner@x.com' } })).body
  assert.match(csv, /Fix versions/); assert.match(csv, /2\.3, 2\.4/)
  // R5: releasing 2.3 moves its unresolved work to 2.5 (2.3 replaced, other versions kept); finished work keeps 2.3
  const done = (await call('GET', '/api/v1/projects/FXV')).body.statuses.find((s: any) => s.category === 'done').id
  const finished = (await call('POST', '/api/v1/projects/FXV/issues', { title: 'Shipped', fixReleaseIds: [a] })).body
  await pool.query('update issues set status_id = $2 where id = $1', [finished.id, done])
  assert.equal((await call('POST', `/api/v1/projects/FXV/releases/${a}/release`, { moveTo: other })).status, 400)
  assert.equal((await call('POST', `/api/v1/projects/FXV/releases/${a}/release`, { moveTo: c })).status, 200)
  const fix = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body.fixReleaseIds
  assert.deepEqual(await fix(both.key), [c, b])
  assert.deepEqual(await fix(one.key), [c])
  assert.deepEqual(await fix(finished.key), [a])
  // …and with no version to move to, unresolved work keeps the released one (Jira's "ignore")
  await call('POST', `/api/v1/projects/FXV/releases/${b}/release`, { moveTo: null })
  assert.deepEqual(await fix(both.key), [c, b])
  // R6: deleting a version takes it off every item's fix and affects versions
  await call('PATCH', `/api/v1/issues/${both.key}`, { affectsReleaseIds: [b] })
  assert.equal((await call('DELETE', `/api/v1/projects/FXV/releases/${b}`)).status, 204)
  const after = (await call('GET', `/api/v1/issues/${both.key}`)).body
  assert.deepEqual([after.fixReleaseIds, after.affectsReleaseIds], [[c], []])
  // R8: the JSON import takes a list, and the single value of files from before
  const r = await call('POST', '/api/v1/import', {
    version: 4, starred: [], views: [], comments: [], activity: [], sprints: [],
    projects: [{ id: 'fp', key: 'FXI', name: 'Imported versions', template: 'kanban', color: '#112233', nextNumber: 3, createdAt: 1,
      statuses: [{ id: 's1', name: 'To do', color: '#000000', category: 'todo' }], transitions: [], fields: [], templates: [], rules: [],
      releases: [{ id: 'r1', name: '1.0' }, { id: 'r2', name: '1.1' }] }],
    issues: [
      { id: 'n1', key: 'FXI-1', projectId: 'fp', type: 'task', title: 'Old file', status: 's1', priority: 'none', labels: [], rank: 1, createdAt: 1, updatedAt: 1, custom: {}, releaseId: 'r1' },
      { id: 'n2', key: 'FXI-2', projectId: 'fp', type: 'task', title: 'New file', status: 's1', priority: 'none', labels: [], rank: 2, createdAt: 1, updatedAt: 1, custom: {}, fixReleaseIds: ['r1', 'r2'] },
    ],
  })
  assert.equal(r.status, 200)
  assert.equal((await fix('FXI-1')).length, 1)
  assert.equal((await fix('FXI-2')).length, 2)
})

test('[0302.R1][0302.R2][0302.R3][0302.R4] one rank order across projects: new work goes last, imports after it, and crowded ranks respread only their neighbours', { skip }, async () => {
  for (const [name, key] of [['Rank A', 'RKA'], ['Rank B', 'RKB']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  const make = async (key: string, title: string, extra = {}) => (await call('POST', `/api/v1/projects/${key}/issues`, { title, ...extra })).body
  const a1 = await make('RKA', 'a1'), b1 = await make('RKB', 'b1'), a2 = await make('RKA', 'a2'), b2 = await make('RKB', 'b2', { rank: -5 })
  // R2: each new item comes after every other in the workspace, whatever rank the request sent
  assert.ok(a1.rank < b1.rank && b1.rank < a2.rank && a2.rank < b2.rank)
  const order = async () => (await pool.query(`select id from issues where workspace_id = (select workspace_id from issues where id = $1) order by rank, id`, [a1.id])).rows.map(r => r.id)
  const ranks = async () => new Map((await pool.query(`select id, rank from issues where workspace_id = (select workspace_id from issues where id = $1)`, [a1.id])).rows.map(r => [r.id, r.rank]))
  for (let i = 0; i < 110; i++) await make('RKA', `filler ${i}`)                    // more than 50 neighbours after the crowded spot
  // R1, R4: crowd b1 and a2 together, then rank b2 between them: only neighbours move, and the order across both projects holds
  await pool.query('update issues set rank = $2 where id = $1', [a2.id, b1.rank + 1e-9])
  const before = (await order()).filter(id => id !== b2.id), was = await ranks()
  const moved = (await call('PATCH', `/api/v1/issues/${b2.key}`, { rank: b1.rank + 5e-10 })).body
  assert.equal(moved.version, b2.version + 1)
  const expected = [...before]; expected.splice(expected.indexOf(a2.id), 0, b2.id)
  assert.deepEqual(await order(), expected)
  const now = await ranks()
  const changed = [...now].filter(([id, r]) => was.get(id) !== r).length
  assert.ok(changed > 1 && changed <= 102, `respread ${changed} items`)
  const sorted = [...now.values()].sort((x, y) => x - y)
  assert.ok(sorted.every((r, i) => i === 0 || r - sorted[i - 1]! > 1e-6), 'ranks are apart again')
  // R3: an imported project keeps its order, after everything already there
  const top = Math.max(...now.values())
  const r = await call('POST', '/api/v1/import', {
    version: 4, starred: [], views: [], comments: [], activity: [], sprints: [],
    projects: [{ id: 'rp', key: 'RKI', name: 'Imported ranks', template: 'kanban', color: '#112233', nextNumber: 3, createdAt: 1,
      statuses: [{ id: 's1', name: 'To do', color: '#000000', category: 'todo' }], transitions: [], fields: [], templates: [], rules: [], releases: [] }],
    issues: [
      { id: 'q2', key: 'RKI-2', projectId: 'rp', type: 'task', title: 'Second', status: 's1', priority: 'none', labels: [], rank: 2, createdAt: 1, updatedAt: 1, custom: {} },
      { id: 'q1', key: 'RKI-1', projectId: 'rp', type: 'task', title: 'First', status: 's1', priority: 'none', labels: [], rank: 1, createdAt: 1, updatedAt: 1, custom: {} },
    ],
  })
  assert.equal(r.status, 200)
  const [first, second] = [(await call('GET', '/api/v1/issues/RKI-1')).body.rank, (await call('GET', '/api/v1/issues/RKI-2')).body.rank]
  assert.ok(top < first && first < second)
})

test('[0303.R1][0303.R2][0303.R3][0303.R4] the hierarchy is kept by the server: epic > item > sub-item, sub-items in their parent’s project, a parent you can see', { skip }, async () => {
  for (const [name, key] of [['Levels', 'LVL'], ['Levels too', 'LVB'], ['Hidden levels', 'LVH']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  await join('LVL', 'lvl.mem@x.com'); await join('LVB', 'lvl.mem@x.com')
  const mk = async (key: string, title: string, extra = {}, who = 'owner@x.com') => call('POST', `/api/v1/projects/${key}/issues`, { title, ...extra }, who)
  const epic = (await mk('LVL', 'Epic', { type: 'epic' })).body, other = (await mk('LVB', 'Other epic', { type: 'epic' })).body
  const item = (await mk('LVL', 'Item', { parentId: epic.id })).body
  const sub = (await mk('LVL', 'Sub', { parentId: item.id })).body
  const err = (r: any) => [r.status, r.body.error]
  // R1: an epic has no parent; a sub-item has no sub-items; an item with sub-items stays an item
  assert.deepEqual(err(await mk('LVL', 'x', { type: 'epic', parentId: epic.id })), [400, 'An epic has no parent'])
  assert.deepEqual(err(await mk('LVL', 'x', { parentId: sub.id })), [400, 'A sub-item can’t have sub-items'])
  const lone = (await mk('LVL', 'Lone')).body
  assert.deepEqual(err(await call('PATCH', `/api/v1/issues/${item.key}`, { parentId: lone.id })), [400, 'An item with sub-items can’t become a sub-item'])
  assert.deepEqual(err(await call('PATCH', `/api/v1/issues/${epic.key}`, { parentId: lone.id })), [400, 'An epic has no parent'])
  // R2: a sub-item stays in its parent's project; an epic may be in another project
  assert.deepEqual(err(await mk('LVB', 'x', { parentId: item.id })), [400, 'A sub-item is in its parent’s project'])
  assert.equal((await call('PATCH', `/api/v1/issues/${lone.key}`, { parentId: other.id })).status, 200)
  // R3: a parent in a project I can't see, or a deleted one, is no parent at all
  const hidden = (await mk('LVH', 'Hidden epic', { type: 'epic' })).body
  assert.deepEqual(err(await mk('LVL', 'x', { parentId: hidden.id }, 'lvl.mem@x.com')), [400, 'No such parent'])
  const gone = (await mk('LVL', 'Gone')).body
  await call('DELETE', `/api/v1/issues/${gone.key}`)
  assert.deepEqual(err(await mk('LVL', 'x', { parentId: gone.id })), [400, 'No such parent'])
  // strand: a parent hidden by a security level is no parent either
  const lvl = (await call('POST', '/api/v1/projects/LVL/security-levels', { name: 'Admins', members: [{ kind: 'role', role: 'admin' }] })).body
  const secret = (await mk('LVL', 'Secret item', { securityLevelId: lvl.id })).body
  assert.deepEqual(err(await mk('LVL', 'x', { parentId: secret.id }, 'lvl.mem@x.com')), [400, 'No such parent'])
  assert.equal((await mk('LVL', 'Under the secret', { parentId: secret.id })).status, 201)
  // R4: type changes keep the levels
  assert.equal((await call('PATCH', `/api/v1/issues/${epic.key}`, { type: 'task' })).status, 400)            // it has items
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { type: 'epic' })).status, 400)            // it has a parent (and sub-items)
  const solo = (await mk('LVL', 'Solo')).body
  await mk('LVL', 'Solo sub', { parentId: solo.id })
  assert.deepEqual(err(await call('PATCH', `/api/v1/issues/${solo.key}`, { type: 'epic' })), [400, 'An item with sub-items can’t become an epic'])
})

test('[0304.R1][0304.R2][0304.R3][0304.R4] versions and components as in Jira: delete with a move, merge, archive', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Versions admin', key: 'VAD', template: 'kanban' })
  const rel = async (name: string) => (await call('POST', '/api/v1/projects/VAD/releases', { name })).body.id as string
  const [v1, v2, v3, v4] = [await rel('1.0'), await rel('1.1'), await rel('2.0'), await rel('2.1')]
  const mk = async (title: string, extra = {}) => (await call('POST', '/api/v1/projects/VAD/issues', { title, ...extra })).body
  const get = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body
  const a = await mk('A', { fixReleaseIds: [v1, v2], affectsReleaseIds: [v1] }), b = await mk('B', { fixReleaseIds: [v1] })
  // R1: deleting 1.0 moves fix versions to 1.1 (no duplicate on A) and affects versions to 2.0; usage counts first
  assert.deepEqual((await call('GET', `/api/v1/projects/VAD/releases/${v1}/usage`)).body, { fix: 2, affects: 1 })
  assert.equal((await call('DELETE', `/api/v1/projects/VAD/releases/${v1}?fixTo=${v1}`)).status, 400)            // not into itself
  assert.equal((await call('DELETE', `/api/v1/projects/VAD/releases/${v1}?fixTo=${v2}&affectsTo=${v3}`)).status, 204)
  assert.deepEqual([(await get(a.key)).fixReleaseIds, (await get(a.key)).affectsReleaseIds, (await get(b.key)).fixReleaseIds], [[v2], [v3], [v2]])
  // R3: merging 2.0 into 2.1 rewrites fix and affects versions and deletes 2.0, audited
  const c = await mk('C', { fixReleaseIds: [v3] })
  assert.equal((await call('POST', `/api/v1/projects/VAD/releases/${v4}/merge`, { from: [v4] })).status, 400)
  assert.equal((await call('POST', `/api/v1/projects/VAD/releases/${v4}/merge`, { from: [v3] })).status, 200)
  assert.deepEqual([(await get(c.key)).fixReleaseIds, (await get(a.key)).affectsReleaseIds], [[v4], [v4]])
  assert.equal((await call('GET', '/api/v1/projects/VAD')).body.releases.some((r: any) => r.id === v3), false)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'project.release.merged'`)).rows.length)
  // R4: archived 2.1 stays on items but can't be added or removed, edited, released or merged; JQL still finds it; unarchive restores
  assert.equal((await call('PATCH', `/api/v1/projects/VAD/releases/${v4}`, { archived: true })).status, 200)
  const r = await call('PATCH', `/api/v1/issues/${c.key}`, { fixReleaseIds: [] })
  assert.deepEqual([r.status, r.body.error], [400, 'Version 2.1 is archived'])
  assert.equal((await call('PATCH', `/api/v1/issues/${b.key}`, { fixReleaseIds: [v2, v4] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${c.key}`, { title: 'C still' })).status, 200)                  // other edits are fine
  assert.equal((await call('PATCH', `/api/v1/projects/VAD/releases/${v4}`, { name: '2.1.0' })).status, 400)
  assert.equal((await call('POST', `/api/v1/projects/VAD/releases/${v4}/release`, {})).status, 400)
  assert.equal((await call('POST', `/api/v1/projects/VAD/releases/${v2}/merge`, { from: [v4] })).status, 400)
  assert.equal((await call('DELETE', `/api/v1/projects/VAD/releases/${v2}?fixTo=${v4}`)).status, 400)            // nor moved into
  assert.deepEqual((await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = VAD AND fixVersion = "2.1"')}`)).body.items.map((i: any) => i.key), [c.key])
  assert.equal((await call('PATCH', `/api/v1/projects/VAD/releases/${v4}`, { archived: false })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/issues/${c.key}`, { fixReleaseIds: [] })).status, 200)
  // Unrelease reaches the server
  await call('POST', `/api/v1/projects/VAD/releases/${v2}/release`, {})
  const un = (await call('PATCH', `/api/v1/projects/VAD/releases/${v2}`, { released: false })).body
  assert.deepEqual([un.released, un.releasedAt], [false, null])
  // R2: deleting a component moves its items to another
  const comp = async (name: string) => (await call('POST', '/api/v1/projects/VAD/components', { name })).body.id as string
  const [api, web] = [await comp('API'), await comp('Web')]
  const d = await mk('D', { componentIds: [api, web] }), e = await mk('E', { componentIds: [api] })
  assert.deepEqual((await call('GET', `/api/v1/projects/VAD/components/${api}/usage`)).body, { items: 2 })
  assert.equal((await call('DELETE', `/api/v1/projects/VAD/components/${api}?moveTo=${web}`)).status, 204)
  assert.deepEqual([(await get(d.key)).componentIds, (await get(e.key)).componentIds], [[web], [web]])
})

test('[0306.R1] time tracking settings: Jira’s defaults, public to everyone, checked when saved', { skip }, async () => {
  assert.deepEqual((await call('GET', '/api/v1/settings/public')).body.timeTracking, { hoursPerDay: 8, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' })
  const put = (value: object) => call('PUT', '/api/v1/admin/settings/timeTracking', value)
  assert.equal((await put({ hoursPerDay: 25, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' })).status, 400)
  assert.equal((await put({ hoursPerDay: 8, daysPerWeek: 5, format: 'weeks', defaultUnit: 'm' })).status, 400)
  assert.equal((await put({ hoursPerDay: 7.5, daysPerWeek: 4, format: 'days', defaultUnit: 'h' })).status, 200)
  assert.equal((await call('GET', '/api/v1/settings/public')).body.timeTracking.hoursPerDay, 7.5)
  await put({ hoursPerDay: 8, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' })
})

test('[0307.R1] a label is one word of at most 255 characters, wherever labels are taken', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Labels', key: 'LBL', template: 'kanban' })
  const r = await call('POST', '/api/v1/projects/LBL/issues', { title: 'Spaced', labels: ['ui polish'] })
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /one word/)
  const ok = (await call('POST', '/api/v1/projects/LBL/issues', { title: 'Fine', labels: ['ui_polish', 'x'.repeat(255)] }))
  assert.equal(ok.status, 201)
  assert.equal((await call('PATCH', `/api/v1/issues/${ok.body.key}`, { labels: ['x'.repeat(256)] })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${ok.body.key}`, { labels: ['two words'] })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/LBL/templates', { name: 't', type: 'task', title: 't', labels: ['a b'] })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/LBL/rules', { name: 'r', trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'a b' }] })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/LBL/rules', { name: 'r', trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'triage' }] })).status, 201)
})

test('[0308.R1][0308.R2][0308.R3] project keys follow System settings: Jira’s default pattern and length; a new pattern must be sane and fit existing keys', { skip }, async () => {
  const mk = (key: string) => call('POST', '/api/v1/projects', { name: `Key ${key}`, key, template: 'kanban' })
  const put = (value: object) => call('PUT', '/api/v1/admin/settings/projectKeys', value)
  assert.deepEqual((await call('GET', '/api/v1/settings/public')).body.projectKeys, { pattern: '[A-Z][A-Z]+', maxLength: 10 })
  // R2: two or more capital letters, at most 10; lowercase is made uppercase
  assert.equal((await mk('KA1')).status, 400)
  assert.equal((await mk('K')).status, 400)
  const r = await mk('KEYTOOLONGX'); assert.equal(r.status, 400); assert.equal(r.body.errors.key, '2–10 capital letters')
  assert.equal((await mk('kab')).body.key, 'KAB')
  // R3: patterns that allow a hyphen, a leading digit or underscore, that don't compile, or that an existing key breaks are refused
  for (const pattern of ['[A-Z][A-Z-]+', '[A-Z0-9]+', '[A-Z_][A-Z]+', '[A-Z(', '.+'])
    assert.equal((await put({ pattern, maxLength: 10 })).status, 400, pattern)
  const misfit = await put({ pattern: '[A-Z]{4,}', maxLength: 10 })
  assert.equal(misfit.status, 400); assert.match(misfit.body.error, /^Existing projects would not fit: [A-Z]/)
  assert.equal((await put({ pattern: '[A-Z][A-Z]+', maxLength: 2 })).status, 400)          // existing keys are longer
  // widened as Jira allows: digits after the first letter; a shorter maximum applies to new keys
  assert.equal((await put({ pattern: '[A-Z][A-Z0-9]+', maxLength: 10 })).status, 200)
  assert.equal((await mk('KA1')).status, 201)
  await put({ pattern: '[A-Z][A-Z]+', maxLength: 10 }).then(x => assert.equal(x.status, 400))   // KA1 no longer fits
  await call('DELETE', '/api/v1/projects/KA1')
})

test('[0309.R1][0309.R2][0309.R3] names Jira keeps unique: projects, versions and components per project, a person’s views', { skip }, async () => {
  const proj = (name: string, key: string) => call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  assert.equal((await proj('Unique Payments', 'UNQ')).status, 201)
  const dup = await proj('unique payments ', 'UNQB')
  assert.deepEqual([dup.status, dup.body.error, dup.body.errors?.name], [409, 'A project with that name already exists', 'Already used'])
  assert.equal((await proj('Unique Other', 'UNQC')).status, 201)
  assert.equal((await call('PATCH', '/api/v1/projects/UNQC', { name: 'UNIQUE PAYMENTS' })).status, 409)
  // R2: versions and components, per project, ignoring case
  assert.equal((await call('POST', '/api/v1/projects/UNQ/releases', { name: '2.0' })).status, 201)
  assert.deepEqual([(await call('POST', '/api/v1/projects/UNQ/releases', { name: ' 2.0' })).status], [409])
  assert.equal((await call('POST', '/api/v1/projects/UNQC/releases', { name: '2.0' })).status, 201)
  assert.equal((await call('POST', '/api/v1/projects/UNQ/components', { name: 'API' })).status, 201)
  assert.equal((await call('POST', '/api/v1/projects/UNQ/components', { name: 'api' })).body.error, 'This project already has a component with that name')
  // R3: a person's views; giving one to someone who has that name, or can't see it, is refused
  const view = (name: string, who: string, extra = {}) => call('POST', '/api/v1/views', { name, filters: {}, ...extra }, who)
  assert.equal((await view('Mine', 'unq.ann@x.com')).status, 201)
  assert.equal((await view('MINE', 'unq.ann@x.com')).status, 409)
  const bob = (await call('GET', '/api/v1/me', undefined, 'unq.bob@x.com')).body.id
  await view('Mine', 'unq.bob@x.com')
  const shared = (await view('Shared one', 'unq.ann@x.com', { shared: true })).body
  const hidden = (await view('Hidden one', 'unq.ann@x.com')).body
  assert.equal((await call('PATCH', `/api/v1/views/${hidden.id}`, { ownerId: bob }, 'unq.ann@x.com')).status, 400)    // Bob can't see it
  const ann = (await call('GET', '/api/v1/views', undefined, 'unq.ann@x.com')).body.find((v: any) => v.name === 'Mine')
  await call('PATCH', `/api/v1/views/${ann.id}`, { shared: true }, 'unq.ann@x.com')
  assert.equal((await call('PATCH', `/api/v1/views/${ann.id}`, { ownerId: bob }, 'unq.ann@x.com')).status, 409)        // Bob has a "Mine"
  assert.equal((await call('PATCH', `/api/v1/views/${shared.id}`, { ownerId: bob }, 'unq.ann@x.com')).status, 200)
})

test('[0305.R1][0305.R2][0305.R3][0305.R4][0305.R5] priorities and resolutions are lists admins edit: new work gets the default; search and order follow the list; renames and deletes carry to items', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Listed', key: 'LST', template: 'kanban' })
  // R2: new work gets the default, Medium out of the box (Jira's)
  assert.equal((await call('GET', '/api/v1/priorities')).body.find((p: any) => p.isDefault).key, 'medium')
  const plain = (await call('POST', '/api/v1/projects/LST/issues', { title: 'Plain' })).body
  assert.equal(plain.priority, 'medium')
  assert.equal((await call('POST', '/api/v1/projects/LST/issues', { title: 'x', priority: 'bogus' })).status, 400)
  // R1: an admin adds Blocker at the top and makes it the default; members can't
  assert.equal((await call('POST', '/api/v1/admin/priorities', { name: 'Blocker', color: '#7F1D1D', icon: 'flame' }, 'lst.member@x.com')).status, 403)
  const blocker = (await call('POST', '/api/v1/admin/priorities', { name: 'Blocker', color: '#7F1D1D', icon: 'flame', position: 0, isDefault: true })).body
  assert.equal((await call('POST', '/api/v1/admin/priorities', { name: 'blocker', color: '#7F1D1D', icon: 'flame' })).status, 409)
  const list = (await call('GET', '/api/v1/priorities')).body
  assert.deepEqual([list[0].name, list.filter((p: any) => p.isDefault).map((p: any) => p.name)], ['Blocker', ['Blocker']])
  const urgent = (await call('POST', '/api/v1/projects/LST/issues', { title: 'Now' })).body
  assert.equal(urgent.priority, blocker.key)
  // R4: JQL by name; ORDER BY and > follow the list's order
  const low = (await call('POST', '/api/v1/projects/LST/issues', { title: 'Later', priority: 'low' })).body
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = LST AND ${q}`)}&limit=50`)).body.items.map((i: any) => i.title)
  assert.deepEqual(await jql('priority = Blocker'), ['Now'])
  assert.deepEqual(await jql('priority > Medium ORDER BY priority DESC'), ['Now'])
  assert.deepEqual(await jql('priority >= Low ORDER BY priority DESC'), ['Now', 'Plain', 'Later'])
  await call('PATCH', `/api/v1/admin/priorities/${blocker.key}`, { position: 4 })                 // below Low now
  assert.deepEqual(await jql('priority < Low'), ['Now'])
  // R3: deleting moves its items, templates and rules; the replacement becomes the default
  await call('POST', '/api/v1/projects/LST/templates', { name: 'Hot', type: 'task', title: 'Hot', priority: blocker.key })
  assert.equal((await call('DELETE', `/api/v1/admin/priorities/${blocker.key}?moveTo=${blocker.key}`)).status, 400)
  assert.equal((await call('DELETE', `/api/v1/admin/priorities/${blocker.key}?moveTo=urgent`)).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${urgent.key}`)).body.priority, 'urgent')
  assert.equal((await call('GET', '/api/v1/projects/LST')).body.templates.find((t: any) => t.name === 'Hot').priority, 'urgent')
  assert.equal((await call('GET', '/api/v1/priorities')).body.find((p: any) => p.isDefault).key, 'urgent')
  assert.equal((await call('PATCH', '/api/v1/admin/priorities/medium', { isDefault: true })).body.isDefault, true)
  assert.deepEqual((await call('GET', '/api/v1/priorities')).body.filter((p: any) => p.isDefault).map((p: any) => p.key), ['medium'])
  // R5: resolutions: a rename carries to items; deleting moves them; an unknown one is refused
  const done = (await call('GET', '/api/v1/projects/LST')).body.statuses.find((s: any) => s.category === 'done').id
  await call('PATCH', `/api/v1/issues/${low.key}`, { statusId: done })
  const res = (await call('GET', '/api/v1/resolutions')).body
  const doneRes = res.find((r: any) => r.name === 'Done'), wont = res.find((r: any) => r.name === "Won't do")
  await call('PATCH', `/api/v1/admin/resolutions/${doneRes.id}`, { name: 'Fixed' })
  assert.equal((await call('GET', `/api/v1/issues/${low.key}`)).body.resolution, 'Fixed')
  assert.equal((await call('PATCH', `/api/v1/issues/${low.key}`, { resolution: 'Nope' })).status, 400)
  assert.equal((await call('DELETE', `/api/v1/admin/resolutions/${doneRes.id}?moveTo=${wont.id}`)).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${low.key}`)).body.resolution, "Won't do")
  // put the defaults back for later tests
  const r2 = (await call('POST', '/api/v1/admin/resolutions', { name: 'Done', position: 0, isDefault: true })).body
  assert.equal(r2.isDefault, true)
})

test('[0305.R6] each workflow says how its items get a resolution: on reaching Done, or only by transition rules', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Classic', key: 'CLS', template: 'kanban' })).body
  const done = p.statuses.find((s: any) => s.category === 'done'), todo = p.statuses[0]
  const wf = p.workflows[0].workflowId
  assert.equal(p.workflows[0].resolutionOnDone, true)
  const a = (await call('POST', '/api/v1/projects/CLS/issues', { title: 'Simplified' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done.id })).body.resolution, 'Done')
  // classic: reaching Done resolves nothing on its own; a rule (or the move) sets it; leaving Done clears it
  assert.equal((await call('PATCH', `/api/v1/admin/workflows/${wf}`, { resolutionOnDone: false })).body.resolutionOnDone, false)
  assert.equal((await call('GET', '/api/v1/projects/CLS')).body.workflows[0].resolutionOnDone, false)
  const b = (await call('POST', '/api/v1/projects/CLS/issues', { title: 'Classic' })).body
  const moved = (await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: done.id })).body
  assert.deepEqual([moved.resolution, moved.resolvedAt], [null, null])
  const set = (await call('PATCH', `/api/v1/issues/${b.key}`, { resolution: "Won't do" })).body
  assert.equal(set.resolution, "Won't do"); assert.ok(set.resolvedAt)
  assert.equal((await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: todo.id })).body.resolution, null)
  const c = (await call('POST', '/api/v1/projects/CLS/issues', { title: 'Chosen in the move' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${c.key}`, { statusId: done.id, resolution: 'Duplicate' })).body.resolution, 'Duplicate')
  await call('PATCH', `/api/v1/admin/workflows/${wf}`, { resolutionOnDone: true })
})

test('[0401.R1][0401.R2][0401.R4] completing a sprint: done means the board’s rightmost column, whatever the status category', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Rightmost', key: 'RGT', template: 'scrum' })).body
  const st = (cat: string, n = 0) => p.statuses.filter((x: any) => x.category === cat)[n]
  const [todo, doing, done] = [st('todo'), st('in-progress'), st('done')]
  const s1 = (await call('POST', '/api/v1/projects/RGT/sprints', { name: 'Sprint R' })).body
  // the board's rightmost column becomes In progress; Done sits in a column to its left
  await call('PATCH', `/api/v1/boards/${s1.boardId}`, { columns: [{ name: 'To do', statusIds: [todo.globalStatusId] }, { name: 'Done', statusIds: [done.globalStatusId] }, { name: 'Ready to ship', statusIds: [doing.globalStatusId] }, { name: 'Empty', statusIds: [] }] })
  const mk = (title: string, extra: object = {}) => call('POST', '/api/v1/projects/RGT/issues', { title, sprintId: s1.id, estimate: 3, ...extra }).then(r => r.body)
  const ready = await mk('Ready'), closed = await mk('Closed'), parent = await mk('Parent'), child = await mk('Child', { parentId: parent.id })
  await call('POST', `/api/v1/projects/RGT/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  for (const i of [ready, parent]) await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: doing.id })
  await call('PATCH', `/api/v1/issues/${closed.key}`, { statusId: done.id })
  const closedBefore = (await call('GET', `/api/v1/issues/${closed.key}`)).body
  // R2: the parent is in the rightmost column, its sub-item isn't: refused
  const blocked = await call('POST', `/api/v1/projects/RGT/sprints/${s1.id}/complete`, { moveTo: null })
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, `Complete the sub-items first: ${parent.key}`)
  await call('PATCH', `/api/v1/issues/${child.key}`, { statusId: doing.id })
  // R1: what is in Ready to ship stays; Done (not the rightmost column) goes back to the backlog; points count the first
  const r = await call('POST', `/api/v1/projects/RGT/sprints/${s1.id}/complete`, { moveTo: null })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.completed, 9)
  const sprintOf = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body.sprintId
  assert.deepEqual([await sprintOf(ready.key), await sprintOf(parent.key), await sprintOf(child.key), await sprintOf(closed.key)], [s1.id, s1.id, s1.id, null])
  // R4: completing changes no status or resolution
  const closedAfter = (await call('GET', `/api/v1/issues/${closed.key}`)).body
  assert.deepEqual([closedAfter.statusId, closedAfter.resolution], [closedBefore.statusId, closedBefore.resolution])
  assert.equal((await call('GET', `/api/v1/issues/${ready.key}`)).body.resolution, null)
})

test('[0402.R1][0402.R2][0402.R3][0402.R4][0402.R5][0402.R6][0402.R7][0402.R8] Sprint Report: completed, not completed, completed outside, removed; points at start; added marked', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Reported', key: 'RPT', template: 'scrum' })).body
  const [todo, done] = [p.statuses[0], p.statuses.find((s: any) => s.category === 'done')]
  await join('RPT', 'rpt.viewer@x.com', 'viewer')
  const s1 = (await call('POST', '/api/v1/projects/RPT/sprints', { name: 'Reported 1' })).body
  const mk = (title: string, extra: object = {}) => call('POST', '/api/v1/projects/RPT/issues', { title, ...extra }).then(r => r.body)
  const a = await mk('A', { sprintId: s1.id, estimate: 3 }), b = await mk('B', { sprintId: s1.id, estimate: 2 }), d = await mk('D', { sprintId: s1.id, estimate: 1 })
  const e = await mk('E', { estimate: 8 })
  await call('PATCH', `/api/v1/issues/${e.key}`, { statusId: done.id })                       // resolved before it joins
  assert.equal((await call('GET', `/api/v1/projects/RPT/sprints/${s1.id}/report`)).status, 400)   // planned: no report yet
  await call('POST', `/api/v1/projects/RPT/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  await call('PATCH', `/api/v1/issues/${a.key}`, { estimate: 13 })                            // later changes don't show (R7)
  const c = await mk('C', { estimate: 5 }); await call('PATCH', `/api/v1/issues/${c.key}`, { sprintId: s1.id })
  await call('PATCH', `/api/v1/issues/${e.key}`, { sprintId: s1.id })
  await call('PATCH', `/api/v1/issues/${d.key}`, { sprintId: null })                         // removed while it runs
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done.id })
  // active: a report of where things are now
  const live = (await call('GET', `/api/v1/projects/RPT/sprints/${s1.id}/report`, undefined, 'rpt.viewer@x.com')).body
  assert.deepEqual(live.completed.map((x: any) => x.key), [a.key])
  await call('POST', `/api/v1/projects/RPT/sprints/${s1.id}/complete`, { moveTo: null })
  await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: todo.id })
  const r = (await call('GET', `/api/v1/projects/RPT/sprints/${s1.id}/report`, undefined, 'rpt.viewer@x.com')).body
  const keys = (l: any[]) => l.map((x: any) => x.key)
  assert.deepEqual([keys(r.completed), keys(r.notCompleted).sort(), keys(r.completedOutside), keys(r.removed)], [[a.key], [b.key, c.key].sort(), [e.key], [d.key]])
  assert.deepEqual(r.completed[0], { key: a.key, title: 'A', type: 'task', priority: 'medium', status: done.name, points: 3, addedAfterStart: false })
  assert.equal(r.notCompleted.find((x: any) => x.key === c.key).addedAfterStart, true)
  assert.equal(r.completedOutside[0].addedAfterStart, true)
  assert.deepEqual(r.totals, { completed: 3, notCompleted: 7, completedOutside: 8, removed: 1 })
  // R8 (strand): an item outside the person's security level is left out
  const lvl = (await call('POST', '/api/v1/projects/RPT/security-levels', { name: 'Admins only', members: [{ kind: 'role', role: 'admin' }] })).body
  await call('PATCH', `/api/v1/issues/${b.key}`, { securityLevelId: lvl.id })
  assert.deepEqual(keys((await call('GET', `/api/v1/projects/RPT/sprints/${s1.id}/report`, undefined, 'rpt.viewer@x.com')).body.notCompleted), [c.key])
  // R8: someone who can't see the project gets nothing
  assert.equal((await call('GET', `/api/v1/projects/RPT/sprints/${s1.id}/report`, undefined, 'rpt.out@x.com')).status, 404)
})

test('[0403.R1][0403.R2][0403.R3] reopening and deleting a completed sprint, as in Jira', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Reopened', key: 'ROP', template: 'scrum' })).body
  await join('ROP', 'rop.member@x.com')
  const done = p.statuses.find((s: any) => s.category === 'done').id, todo = p.statuses[0].id
  const ends = { endsAt: new Date(Date.now() + 864e5).toISOString() }
  const sprint = async (name: string) => (await call('POST', '/api/v1/projects/ROP/sprints', { name })).body
  const mk = (title: string, sprintId: string) => call('POST', '/api/v1/projects/ROP/issues', { title, sprintId }).then(r => r.body)
  const sprintOf = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body.sprintId
  const s1 = await sprint('Reopen me')
  const a = await mk('A', s1.id), b = await mk('B', s1.id), c = await mk('C', s1.id)
  await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/start`, ends)
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done })
  await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/complete`, { moveTo: null })          // B and C go to the backlog
  // R1: a member can't; while another sprint is active it's refused; then it comes back with its work, except work in an active sprint
  const s2 = await sprint('Next one')
  await call('PATCH', `/api/v1/issues/${c.key}`, { sprintId: s2.id })
  await call('POST', `/api/v1/projects/ROP/sprints/${s2.id}/start`, ends)
  assert.equal((await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/reopen`, undefined, 'rop.member@x.com')).status, 403)
  const busy = await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/reopen`)
  assert.equal(busy.status, 409); assert.match(busy.body.error, /Next one is active/)
  await call('POST', `/api/v1/projects/ROP/sprints/${s2.id}/complete`, { moveTo: null })       // C back to the backlog, s2 closed
  await call('PATCH', `/api/v1/issues/${c.key}`, { sprintId: null })
  const s3 = await sprint('Active elsewhere')
  const reopened = await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/reopen`)
  assert.equal(reopened.status, 200); assert.deepEqual([reopened.body.state, reopened.body.completedAt], ['active', null])
  assert.deepEqual([await sprintOf(a.key), await sprintOf(b.key), await sprintOf(c.key)], [s1.id, s1.id, s1.id])
  assert.ok((await pool.query(`select 1 from audit_log where action = 'sprint.reopened'`)).rows.length)
  // R2: deleting an active sprint is refused; completed again and deleted, its unfinished work goes to the next planned sprint
  assert.equal((await call('DELETE', `/api/v1/projects/ROP/sprints/${s1.id}`)).status, 409)
  await call('POST', `/api/v1/projects/ROP/sprints/${s1.id}/complete`, { moveTo: s3.id })        // B, C to s3; A stays (completed)
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: todo })                           // A is unfinished again
  await call('PATCH', `/api/v1/issues/${b.key}`, { sprintId: null })
  assert.equal((await call('DELETE', `/api/v1/projects/ROP/sprints/${s1.id}`)).status, 204)
  assert.deepEqual([await sprintOf(a.key), await sprintOf(c.key)], [s3.id, s3.id])
  // with no planned sprint left: the backlog; completed work keeps no sprint
  const d = await mk('D', s3.id)
  await call('POST', `/api/v1/projects/ROP/sprints/${s3.id}/start`, ends)
  await call('PATCH', `/api/v1/issues/${d.key}`, { statusId: done })
  await call('POST', `/api/v1/projects/ROP/sprints/${s3.id}/complete`, { moveTo: null })
  await call('PATCH', `/api/v1/issues/${b.key}`, { sprintId: null })
  await pool.query('update issues set sprint_id = $1 where id = $2', [s3.id, a.id])             // unfinished work still in it
  assert.equal((await call('DELETE', `/api/v1/projects/ROP/sprints/${s3.id}`)).status, 204)
  assert.deepEqual([await sprintOf(a.key), await sprintOf(d.key)], [null, null])
  // R3: a planned sprint's work goes to the backlog
  const s4 = await sprint('Planned'); const e = await mk('E', s4.id)
  assert.equal((await call('DELETE', `/api/v1/projects/ROP/sprints/${s4.id}`)).status, 204)
  assert.equal(await sprintOf(e.key), null)
})

test('[0404.R1][0404.R2][0404.R4] each Scrum board’s estimation statistic: points, original time estimate or issue count, recorded per sprint', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Estimating', key: 'EST', template: 'scrum' })).body
  await join('EST', 'est.member@x.com')
  const done = p.statuses.find((s: any) => s.category === 'done').id
  const s1 = (await call('POST', '/api/v1/projects/EST/sprints', { name: 'Timed' })).body
  // R1: the board's admins set it; a member can't; Kanban boards have none
  assert.equal((await call('PATCH', `/api/v1/boards/${s1.boardId}`, { estimation: 'time' }, 'est.member@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/boards/${s1.boardId}`, { estimation: 'time' })).body.estimation, 'time')
  await call('POST', '/api/v1/projects', { name: 'Flowing', key: 'ESK', template: 'kanban' })
  const kb = (await call('GET', '/api/v1/projects/ESK/boards')).body[0]
  assert.equal((await call('PATCH', `/api/v1/boards/${kb.id}`, { estimation: 'count' })).status, 400)
  // R2: a sprint on a time board commits and completes minutes of original estimate
  const mk = (title: string, extra: object) => call('POST', '/api/v1/projects/EST/issues', { title, ...extra }).then(r => r.body)
  const a = await mk('A', { sprintId: s1.id, estimate: 5, timeEstimate: 120 }), b = await mk('B', { sprintId: s1.id, estimate: 3, timeEstimate: 60 })
  const started = (await call('POST', `/api/v1/projects/EST/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })).body
  assert.deepEqual([started.estimation, started.committed], ['time', 180])
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done })
  const closed = (await call('POST', `/api/v1/projects/EST/sprints/${s1.id}/complete`, { moveTo: null })).body
  assert.equal(closed.completed, 120)
  assert.equal((await call('GET', `/api/v1/projects/EST/sprints/${s1.id}/report`)).body.completed[0].points, 120)
  // changing the board leaves the past sprint as it was; R4: a count board counts items
  await call('PATCH', `/api/v1/boards/${s1.boardId}`, { estimation: 'count' })
  assert.equal((await call('GET', `/api/v1/projects/EST/sprints/${s1.id}/report`)).body.completed[0].points, 120)
  const s2 = (await call('POST', '/api/v1/projects/EST/sprints', { name: 'Counted' })).body
  await call('PATCH', `/api/v1/issues/${b.key}`, { sprintId: s2.id }); await mk('C', { sprintId: s2.id })
  const counted = (await call('POST', `/api/v1/projects/EST/sprints/${s2.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })).body
  assert.deepEqual([counted.estimation, counted.committed], ['count', 2])
})

test('[0405.R1] a board’s working days: weekdays and days off, set by its admins', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Workweek', key: 'WWK', template: 'scrum' })).body
  await join('WWK', 'wwk.member@x.com')
  const board = (await call('GET', '/api/v1/projects/WWK/boards')).body[0]
  assert.deepEqual((await call('GET', `/api/v1/boards/${board.id}`)).body.workingDays, { weekdays: [1, 2, 3, 4, 5], nonWorking: [] })
  const set = (workingDays: object, who?: string) => call('PATCH', `/api/v1/boards/${board.id}`, { workingDays }, who)
  assert.equal((await set({ weekdays: [1, 2, 3, 4], nonWorking: ['2026-12-25'] }, 'wwk.member@x.com')).status, 403)
  assert.equal((await set({ weekdays: [], nonWorking: [] })).status, 400)
  assert.equal((await set({ weekdays: [1], nonWorking: ['25/12/2026'] })).status, 400)
  assert.deepEqual((await set({ weekdays: [4, 1, 2, 3, 3], nonWorking: ['2026-12-25', '2026-12-24'] })).body.workingDays, { weekdays: [1, 2, 3, 4], nonWorking: ['2026-12-24', '2026-12-25'] })
  assert.ok(p.id)
})

test('[0408.R1][0408.R3][0408.R4] flagging a work item: members flag and unflag it (in its history), JQL finds it, CSV import carries it', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Flags', key: 'FLG', template: 'kanban' })
  await join('FLG', 'flg.member@x.com'); await join('FLG', 'flg.viewer@x.com', 'viewer')
  const a = (await call('POST', '/api/v1/projects/FLG/issues', { title: 'Stuck' })).body
  await call('POST', '/api/v1/projects/FLG/issues', { title: 'Fine' })
  assert.equal(a.flagged, false)
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { flagged: true }, 'flg.viewer@x.com')).status, 403)
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { flagged: true }, 'flg.member@x.com')).body.flagged, true)
  assert.ok((await call('GET', `/api/v1/issues/${a.key}?expand=activity`)).body.activity.some((x: any) => x.field === 'flagged'))
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = FLG AND ${q}`)}`)).body
  assert.deepEqual((await jql('flagged = Impediment')).items.map((i: any) => i.title), ['Stuck'])
  assert.deepEqual((await jql('flagged is EMPTY')).items.map((i: any) => i.title), ['Fine'])
  assert.match((await jql('flagged = yes')).error, /Impediment/)
  await call('PATCH', `/api/v1/issues/${a.key}`, { flagged: false }, 'flg.member@x.com')
  assert.deepEqual((await jql('flagged is not EMPTY')).items, [])
  // R4: a CSV Flagged column with "Impediment" flags the item
  const csv = 'Summary,Flagged\nImported stuck,Impediment\nImported fine,\n'
  const run = await call('POST', '/api/v1/projects/FLG/import', { csv, mapping: { title: 0, flagged: 1 }, dryRun: false, importId: '0192f0c0-0000-7000-8000-00000000f1a6' })
  assert.equal(run.status, 202)
  await (await import('../src/jobs.ts')).runJobs()
  assert.deepEqual((await jql('flagged = Impediment')).items.map((i: any) => i.title), ['Imported stuck'])
})

test('[0409.R1][0409.R2] card colours: by queries, the first match wins and is sent with the board’s items; switching keeps the other method’s colours', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Colours', key: 'CLR', template: 'kanban' })
  await join('CLR', 'clr.member@x.com')
  const board = (await call('GET', '/api/v1/projects/CLR/boards')).body[0]
  const a = (await call('POST', '/api/v1/projects/CLR/issues', { title: 'Hot', priority: 'high', labels: ['ui'] })).body
  const b = (await call('POST', '/api/v1/projects/CLR/issues', { title: 'UI only', priority: 'low', labels: ['ui'] })).body
  const c = (await call('POST', '/api/v1/projects/CLR/issues', { title: 'Plain', priority: 'low' })).body
  const set = (cardColors: object, who?: string) => call('PATCH', `/api/v1/boards/${board.id}`, { cardColors }, who)
  assert.equal((await set({ by: 'priorities' }, 'clr.member@x.com')).status, 403)
  const bad = await set({ by: 'queries', queries: [{ jql: 'priority = ', color: '#DC2626' }] })
  assert.equal(bad.status, 400); assert.match(bad.body.error, /cardColors/)
  assert.equal((await set({ by: 'priorities', priorities: { high: '#FF0000' } })).status, 200)
  const saved = (await set({ by: 'queries', queries: [{ jql: 'priority = High', color: '#DC2626' }, { jql: 'labels = ui', color: '#2563EB' }] })).body.cardColors
  assert.deepEqual([saved.by, saved.priorities, saved.queries.length], ['queries', { high: '#FF0000' }, 2])   // the priorities' colours stay
  const items = (await call('GET', `/api/v1/boards/${board.id}/issues`)).body.items
  const colorOf = (key: string) => items.find((i: any) => i.key === key).color
  assert.deepEqual([colorOf(a.key), colorOf(b.key), colorOf(c.key)], [saved.queries[0].id, saved.queries[1].id, ''])
})

test('[0711.R1][0711.R2][0711.R3][0711.R4][0711.R5][0711.R11] authentication methods: the public configuration, Entra seeded from the environment once, checked when turned on, and at least one way in', { skip }, async () => {
  const { startAuth, clearAuthConfigCache } = await import('../src/authConfig.ts')
  const pub = async () => JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/auth/config' })).body)
  // R2: seeded once from ENTRA_*; after that the stored configuration wins
  assert.equal((await pub()).entra, null)
  Object.assign(process.env, { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_WEB_CLIENT_ID: WEB, ENTRA_AUTHORITY: authority })
  await startAuth(app.log); clearAuthConfigCache()
  // R1: no sign-in needed, and nothing private
  const c = await pub()
  assert.deepEqual([c.loginForm, c.fallback, c.dev, c.entra.tenantId, c.entra.clientId, c.entra.name], [true, false, true, TENANT, WEB, 'Microsoft'])
  assert.equal('recovery' in c, false); assert.equal('apiClientId' in c.entra, false)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'auth.entra.seeded'`)).rows.length)
  process.env.ENTRA_TENANT_ID = '99999999-9999-4999-8999-999999999999'
  await startAuth(app.log); clearAuthConfigCache()
  assert.equal((await pub()).entra.tenantId, TENANT)
  for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_WEB_CLIENT_ID', 'ENTRA_AUTHORITY']) delete process.env[k]
  const entra = (await call('GET', '/api/v1/admin/authentication')).body.entra
  const put = (body: object, who?: string) => call('PUT', '/api/v1/admin/authentication/entra', { ...entra, ...body }, who)
  // R3: turning it on checks that Entra answers for this tenant
  const wrongTenant = await put({ tenantId: '44444444-4444-4444-8444-444444444444' })
  assert.equal(wrongTenant.status, 400); assert.ok(wrongTenant.body.errors.tenantId)
  assert.equal((await put({ name: 'Contoso' })).body.entra.name, 'Contoso')
  // R4: Entra's tokens work while it is on, are refused at once when it is off, and work again when back on
  const token = await new SignJWT({ oid: '55555555-5555-4555-8555-555555555555', preferred_username: 'entra.person@x.com', name: 'Entra Person' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(`${authority}/${TENANT}/v2.0`).setAudience(CLIENT).setIssuedAt().setExpirationTime('1h').sign(signingKey)
  const viaEntra = async () => (await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode
  assert.equal(await viaEntra(), 200)
  assert.equal((await put({ enabled: false })).status, 200)
  assert.equal(await viaEntra(), 401)
  await pool.query(`update auth_config set entra = jsonb_set(entra, '{enabled}', 'true')`); clearAuthConfigCache()
  assert.equal(await viaEntra(), 200)
  // R5: at least one way in stays
  assert.equal((await call('PUT', '/api/v1/admin/authentication', { loginForm: false, fallback: false })).status, 200)
  const lastOne = await put({ enabled: false })
  assert.deepEqual([lastOne.status, lastOne.body.error], [409, 'At least one authentication method must be shown on the login page'])
  assert.equal((await call('PUT', '/api/v1/admin/authentication', { loginForm: true, fallback: false })).status, 200)
  assert.equal((await put({ enabled: false })).status, 200)
  const hideForm = await call('PUT', '/api/v1/admin/authentication', { loginForm: false, fallback: false })
  assert.deepEqual([hideForm.status, hideForm.body.error], [409, 'At least one authentication method must be shown on the login page'])
  await pool.query(`update auth_config set entra = jsonb_set(entra, '{enabled}', 'true')`); clearAuthConfigCache()
  // R11: an access token can't change how people sign in; everything is audited
  const pat = (await call('POST', '/api/v1/me/tokens', { name: 'auth test' })).body.token
  const viaPat = await app.inject({ method: 'PUT', url: '/api/v1/admin/authentication', payload: { loginForm: true, fallback: true }, headers: { authorization: `Bearer ${pat}` } })
  assert.equal(viaPat.statusCode, 403)
  const actions = (await pool.query(`select action from audit_log where action like 'auth.%'`)).rows.map(r => r.action)
  assert.ok(actions.includes('auth.entra.updated') && actions.includes('auth.methods.updated'))
})

test('[0711.R6][0711.R8][0711.R9][0711.R10][0711.R12] the login form: recovery mode, sessions, the fallback gate and the lock after wrong passwords', { skip }, async () => {
  const { startAuth, clearAuthConfigCache } = await import('../src/authConfig.ts')
  const login = (body: object) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body })
  const as = (token: string, method = 'GET', url = '/api/v1/me', payload?: object) => app.inject({ method: method as any, url, payload, headers: { authorization: `Bearer ${token}` } })
  const secret = 'recovery-password-for-tests'
  // without recovery mode, recovery_admin can't sign in
  assert.equal((await login({ username: 'recovery_admin', password: secret })).statusCode, 401)
  await pool.query('delete from login_failures')
  process.env.STRAND_RECOVERY_PASSWORD = secret
  await startAuth(app.log)
  // R9: the same message for every failure; after three, the username is locked (429 with Retry-After)
  for (const password of ['wrong', '', 'wrong again']) {
    const r = await login({ username: 'recovery_admin', password })
    assert.deepEqual([r.statusCode, JSON.parse(r.body).error], [401, 'Sorry, your username and password are incorrect - please try again.'])
  }
  const locked = await login({ username: 'recovery_admin', password: secret })
  assert.equal(locked.statusCode, 429); assert.ok(Number(locked.headers['retry-after']) > 0)
  await pool.query('delete from login_failures')
  // R10: recovery_admin signs in, is a system admin, sees recovery mode; can't make access tokens (R12)
  const ok = await login({ username: 'Recovery_Admin', password: secret })
  assert.equal(ok.statusCode, 200)
  const { token } = JSON.parse(ok.body)
  assert.match(token, /^jbs_[A-Za-z0-9_-]{43}$/)
  const me = JSON.parse((await as(token)).body)
  assert.deepEqual([me.via, me.admin, me.recovery], ['recovery', true, true])
  assert.ok((await pool.query(`select 1 from audit_log where action = 'auth.recovery_sign_in'`)).rows.length)
  assert.equal((await as(token, 'POST', '/api/v1/me/tokens', { name: 'x' })).statusCode, 403)
  // …but it can change the authentication methods: that is what it is for (R10, R11)
  assert.equal((await as(token, 'PUT', '/api/v1/admin/authentication', { loginForm: true, fallback: true })).statusCode, 200)
  assert.equal((await as(token, 'PUT', '/api/v1/admin/authentication', { loginForm: true, fallback: false })).statusCode, 200)
  // R8: signing out ends it everywhere; an idle session ends; "remember" lasts days
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${token}` } })).statusCode, 204)
  assert.equal((await as(token)).statusCode, 401)
  const idle = JSON.parse((await login({ username: 'recovery_admin', password: secret })).body).token
  await pool.query(`update user_sessions set idle_until = now() - interval '1 minute' where via = 'recovery'`)
  assert.equal((await as(idle)).statusCode, 401)
  const kept = JSON.parse((await login({ username: 'recovery_admin', password: secret, remember: true })).body)
  assert.ok(new Date(kept.expiresAt).getTime() > Date.now() + 13 * 864e5)
  // a deactivated person's session is refused
  await pool.query(`update users set active = false where username = 'recovery_admin'`)
  assert.equal((await as(kept.token)).statusCode, 403)
  await pool.query(`update users set active = true where username = 'recovery_admin'`)
  // R6: with the form hidden, form sign-ins are refused unless the fallback is on (recovery_admin always gets in)
  await call('PUT', '/api/v1/admin/authentication', { loginForm: false, fallback: false })
  assert.equal((await login({ username: 'someone', password: 'x', fallback: true })).statusCode, 403)
  assert.equal((await login({ username: 'recovery_admin', password: secret })).statusCode, 200)
  await call('PUT', '/api/v1/admin/authentication', { loginForm: false, fallback: true })
  assert.equal((await login({ username: 'someone', password: 'x' })).statusCode, 403)
  assert.equal((await login({ username: 'someone', password: 'x', fallback: true })).statusCode, 401)   // reaches the password check
  await call('PUT', '/api/v1/admin/authentication', { loginForm: true, fallback: false })
  // R10: out of recovery mode, its sessions stop and it loses admin
  delete process.env.STRAND_RECOVERY_PASSWORD
  assert.equal((await as(kept.token)).statusCode, 401)
  await startAuth(app.log); clearAuthConfigCache()
  const [r] = (await pool.query(`select active, is_system_admin(id) as admin from users where username = 'recovery_admin'`)).rows
  assert.deepEqual([r.active, r.admin], [false, false])
  await pool.query('delete from login_failures')
})

test('[0712.R1][0712.R2][0712.R3][0712.R4][0712.R13] user directories: Jira’s presets, a write-only password bound to its row, Test settings, the order', { skip }, async () => {
  const { PRESETS } = await import('../src/directories.ts'), { unseal } = await import('../src/secrets.ts')
  corp.passwords = { [SVC]: 'svc-pass', [`CN=Jane Doe,OU=People,${BASE}`]: 'jane-pass' }
  corp.entries = [adUser('Jane Doe', 'jdoe', { groups: [`CN=Engineering,OU=Groups,${BASE}`] }), adGroup('Engineering')]
  // R2: Jira’s defaults for each type
  const presets = (await call('GET', '/api/v1/admin/directories/presets')).body
  assert.deepEqual([presets.ad.user.username, presets.ad.user.guid, presets.ad.membership.useMemberOf, presets.ldap.user.username, presets.ldap.user.guid], ['sAMAccountName', 'objectGUID', true, 'uid', 'entryUUID'])
  const body = { name: 'Corp AD', type: 'ad', enabled: false, config: { ...PRESETS.ad, ...corpConfig() }, password: 'svc-pass' }
  // R3: without STRAND_SECRET_KEY no password can be stored
  delete process.env.STRAND_SECRET_KEY
  const noKey = await call('POST', '/api/v1/admin/directories', body)
  assert.equal(noKey.status, 400); assert.ok(noKey.body.errors.password)
  process.env.STRAND_SECRET_KEY = 'a-secret-key-for-tests-only-0712-xxxxxxxx'
  const made = await call('POST', '/api/v1/admin/directories', body)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const dir = made.body
  assert.deepEqual([dir.hasPassword, 'password' in dir, 'passwordEnc' in dir, dir.position], [true, false, false, 1])
  // stored encrypted and bound to its row: the right row opens it, another row's id doesn't
  const [row] = (await pool.query('select password_enc from user_directories where id = $1', [dir.id])).rows
  assert.ok(!row.password_enc.toString('latin1').includes('svc-pass'))
  assert.equal(unseal(row.password_enc, dir.id), 'svc-pass')
  assert.throws(() => unseal(row.password_enc, '00000000-0000-4000-8000-000000000000'))
  // R3: the password can't be sent to another server without typing it again
  const elsewhere = await call('PUT', `/api/v1/admin/directories/${dir.id}`, { name: 'Corp AD', enabled: false, config: { ...dir.config, host: 'evil.example' } })
  assert.equal(elsewhere.status, 400); assert.ok(elsewhere.body.errors.password)
  assert.equal((await call('POST', '/api/v1/admin/directories/test', { id: dir.id, config: { ...dir.config, host: 'evil.example' } })).status, 400)
  assert.equal((await call('PUT', `/api/v1/admin/directories/${dir.id}`, { name: 'Corporate AD', enabled: false, config: { ...dir.config, syncMinutes: 30 } })).status, 200)
  // R4: Test settings, with the stored password, on unsaved changes, with a test user
  const test = (await call('POST', '/api/v1/admin/directories/test', { id: dir.id, config: dir.config, testUser: { username: 'jdoe', password: 'jane-pass' } })).body.steps
  assert.deepEqual(test.map((s: any) => [s.step, s.ok]), [['Connect and sign in', true], ['Find users', true], ['Find groups', true], ['Find the test user', true], ['The test user’s groups', true], ['The test user’s password', true]])
  assert.match(test[1].detail, /jdoe/)
  const wrong = (await call('POST', '/api/v1/admin/directories/test', { config: dir.config, password: 'nope' })).body.steps
  assert.deepEqual(wrong.map((s: any) => s.ok), [false])
  // R1: the order sign-in tries them in
  const ldap = (await call('POST', '/api/v1/admin/directories', { name: 'Other LDAP', type: 'ldap', enabled: false, config: { ...PRESETS.ldap, host: other.host, port: 389, security: 'none', bindDn: 'cn=svc,dc=other', baseDn: 'dc=other' }, password: 'x' })).body
  const order = (await call('PUT', '/api/v1/admin/directories/order', { ids: [ldap.id, dir.id] })).body
  assert.deepEqual(order.map((d: any) => [d.name, d.position]), [['Other LDAP', 1], ['Corporate AD', 2]])
  assert.equal((await call('PUT', '/api/v1/admin/directories/order', { ids: [dir.id] })).status, 400)
  // R13: not with an access token; every change audited, the password only as "set" / "changed"
  const pat = (await call('POST', '/api/v1/me/tokens', { name: 'directories' })).body.token
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/directories', headers: { authorization: `Bearer ${pat}` } })).statusCode, 403)
  const logged = (await pool.query(`select action, before::text || after::text as t from audit_log where action like 'directory.%'`)).rows
  assert.deepEqual(new Set(logged.map(r => r.action)), new Set(['directory.created', 'directory.updated', 'directory.reordered']))
  assert.ok(logged.every(r => !String(r.t).includes('svc-pass')))
  await call('PUT', '/api/v1/admin/directories/order', { ids: [dir.id, ldap.id] })
})

test('[0712.R5][0712.R6][0712.R12] the login form with user directories: first match decides, escaped usernames, no empty password, disabled accounts, unreachable', { skip }, async () => {
  const { signInWithDirectory } = await import('../src/directories.ts')
  const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
  const WRONG = 'Sorry, your username and password are incorrect - please try again.'
  const [corpDir, ldapDir] = (await call('GET', '/api/v1/admin/directories')).body
  const enable = (d: any, enabled = true) => call('PUT', `/api/v1/admin/directories/${d.id}`, { name: d.name, enabled, config: d.config })
  await pool.query('delete from login_failures')
  // R6: someone Entra already created is linked by email, not duplicated
  await call('GET', '/api/v1/me', undefined, 'linked.person@corp.test')
  corp.passwords = { [SVC]: 'svc-pass', [`CN=Jane Doe,OU=People,${BASE}`]: 'jane-pass', [`CN=Linked Person,OU=People,${BASE}`]: 'linked-pass', [`CN=Bob Smith,OU=People,${BASE}`]: 'bob-pass' }
  corp.entries = [
    adUser('Jane Doe', 'jdoe', { groups: [`CN=Engineering,OU=Groups,${BASE}`] }), adUser('Linked Person', 'lperson', { mail: 'linked.person@corp.test' }),
    adUser('Bob Smith', 'bsmith', { uac: '514' }), adGroup('Engineering'),
  ]
  // R12: a disabled directory takes no sign-ins
  assert.equal((await login('jdoe', 'jane-pass')).statusCode, 401)
  assert.equal((await enable(corpDir)).status, 200)
  await pool.query('delete from login_failures')
  const ok = await login('JDoe', 'jane-pass')
  assert.equal(ok.statusCode, 200, ok.body)
  const [jane] = (await pool.query('select username, active, directory_id, name from users where email = $1', ['jdoe@corp.test'])).rows
  assert.deepEqual([jane.username, jane.active, jane.directory_id, jane.name], ['jdoe', true, corpDir.id, 'Jane Doe'])
  assert.equal((await login('lperson', 'linked-pass')).statusCode, 200)
  assert.equal((await pool.query(`select count(*)::int as n from users where email = 'linked.person@corp.test'`)).rows[0].n, 1)
  assert.equal((await pool.query(`select directory_id from users where email = 'linked.person@corp.test'`)).rows[0].directory_id, corpDir.id)
  // an administrator's account is never linked by email: the directory's mail attribute can't take it over
  corp.passwords[`CN=Fake Owner,OU=People,${BASE}`] = 'fake-pass'
  corp.entries.push(adUser('Fake Owner', 'fowner', { mail: 'owner@x.com' }))
  assert.equal((await login('fowner', 'fake-pass')).statusCode, 401)
  assert.equal((await pool.query(`select directory_id from users where email = 'owner@x.com'`)).rows[0].directory_id, null)
  corp.entries.pop()
  // a wrong password, a disabled account: the same message
  for (const [u, p] of [['jdoe', 'nope'], ['bsmith', 'bob-pass']]) {
    const r = await login(u!, p!)
    assert.deepEqual([r.statusCode, JSON.parse(r.body).error], [401, WRONG])
  }
  await pool.query('delete from login_failures')
  // R5: the username is escaped: it can't widen the search to everyone
  corp.log!.searches.length = 0
  assert.equal((await login('*)(sAMAccountName=*', 'jane-pass')).statusCode, 401)
  assert.ok(corp.log!.searches.some(f => f.toLowerCase().includes('(samaccountname=\\2a\\29\\28samaccountname=\\2a)')), corp.log!.searches.join(' | '))
  // R5: an empty password is never sent (the directory would take it as an anonymous sign-in)
  corp.log!.binds.length = 0
  assert.equal(await signInWithDirectory('jdoe', ''), null)
  assert.ok(!corp.log!.binds.some(b => b.startsWith('CN=Jane Doe')))
  // R5: the first enabled directory that has the username decides
  other.passwords = { 'cn=svc,dc=other': 'x', 'uid=jdoe,ou=people,dc=other': 'other-pass' }
  other.entries = [{ dn: 'uid=jdoe,ou=people,dc=other', objectClass: ['inetOrgPerson'], uid: 'jdoe', mail: 'jdoe@other.test', entryUUID: 'u-1', displayName: 'Other Jane' }]
  await enable(ldapDir)
  await call('PUT', '/api/v1/admin/directories/order', { ids: [ldapDir.id, corpDir.id] })
  assert.equal((await login('jdoe', 'jane-pass')).statusCode, 401)                   // the other directory has jdoe: its password decides
  await call('PUT', '/api/v1/admin/directories/order', { ids: [corpDir.id, ldapDir.id] })
  assert.equal((await login('jdoe', 'jane-pass')).statusCode, 200)
  await enable(ldapDir, false)
  await pool.query('delete from login_failures')
  // unreachable: 503, and not counted as a wrong password
  corp.down = true
  const down = await login('jdoe', 'jane-pass')
  assert.equal(down.statusCode, 503)
  assert.equal((await pool.query(`select count(*)::int as n from login_failures where username = 'jdoe'`)).rows[0].n, 0)
  corp.down = false
})

test('[0712.R7][0712.R8][0712.R9][0712.R10][0712.R11] synchronising a directory: people and groups copied, never deleted, renames followed, nested groups, the zero-users guard', { skip }, async () => {
  const { syncDirectory } = await import('../src/directories.ts'), { runJobs } = await import('../src/jobs.ts')
  const [corpDir] = (await call('GET', '/api/v1/admin/directories')).body
  const eng = `CN=Engineering,OU=Groups,${BASE}`, platform = `CN=Platform,OU=Groups,${BASE}`
  await call('POST', '/api/v1/groups', { name: 'Clashing' })
  corp.entries = [
    adUser('Jane Doe', 'jdoe', { groups: [eng] }), adUser('Linked Person', 'lperson', { mail: 'linked.person@corp.test', groups: [eng] }),
    adUser('Bob Smith', 'bsmith', { uac: '514' }), adUser('Nomail Person', 'nomail', { mail: '' }), adUser('Kim Lee', 'klee', { groups: [platform] }),
    adGroup('Engineering'), adGroup('Platform', [eng]), adGroup('Clashing'),
  ]
  const sync = async () => { const r: any = await syncDirectory(corpDir.id); assert.ok(r.ok, JSON.stringify(r)); return r }
  const members = async (name: string) => (await pool.query(`select u.username from group_members gm join groups g on g.id = gm.group_id join users u on u.id = gm.user_id where g.display_name = $1 order by 1`, [name])).rows.map(r => r.username)
  // R7: created, linked, skipped
  const r1 = await sync()
  assert.equal(r1.users.created, 2)                                                   // bsmith and klee (jdoe and lperson came at sign-in)
  assert.deepEqual(r1.users.skipped.map((s: any) => [s.name, s.why]), [['nomail', 'No email address']])
  assert.equal((await pool.query(`select active from users where username = 'bsmith'`)).rows[0].active, false)   // R8: disabled there
  // R9: directory groups, read-only; a clash with a Strand group is skipped
  assert.deepEqual(r1.groups.skipped.map((s: any) => s.name), ['Clashing'])
  const [g] = (await pool.query(`select id, source, directory_dn, directory_guid from groups where display_name = 'Engineering'`)).rows
  assert.deepEqual([g.source, g.directory_dn], ['directory', eng])
  // R10: memberships from memberOf; nested groups only when asked
  assert.deepEqual([await members('Engineering'), await members('Platform')], [['jdoe', 'lperson'], ['klee']])
  await call('PUT', `/api/v1/admin/directories/${corpDir.id}`, { name: corpDir.name, enabled: true, config: { ...corpDir.config, membership: { ...corpDir.config.membership, nested: true } } })
  await sync()
  assert.deepEqual(await members('Platform'), ['jdoe', 'klee', 'lperson'])
  // R9: renamed in the directory (a new name and DN, the same id): the same group, renamed; gone: kept (with its grants), emptied
  const engineers = `CN=Engineers,OU=Groups,${BASE}`
  corp.entries = corp.entries.filter(e => e.dn !== platform && e.dn !== eng).map(e => ('memberOf' in e ? { ...e, memberOf: (e.memberOf as string[]).map(m => (m === eng ? engineers : m)) } : e))
  corp.entries.push(adGroup('Engineers', [], 'Engineering'))
  await sync()
  const [renamed] = (await pool.query(`select id, display_name, directory_dn from groups where directory_guid = $1`, [g.directory_guid])).rows
  assert.deepEqual([renamed.id, renamed.display_name, renamed.directory_dn], [g.id, 'Engineers', engineers])
  assert.deepEqual(await members('Engineers'), ['jdoe', 'lperson'])
  assert.ok((await pool.query(`select 1 from audit_log where action = 'group.renamed' and target_id = $1`, [g.id])).rows.length)
  assert.deepEqual(await members('Platform'), [])
  assert.equal((await pool.query(`select count(*)::int as n from groups where display_name = 'Platform'`)).rows[0].n, 1)
  // R8: missing from the directory: deactivated (never deleted); back: reactivated
  const kim = corp.entries.find(e => (e as any).sAMAccountName === 'klee')!
  corp.entries = corp.entries.filter(e => e !== kim)
  assert.equal((await sync()).users.deactivated, 1)
  assert.equal((await pool.query(`select active from users where username = 'klee'`)).rows[0].active, false)
  corp.entries.push(kim)
  assert.equal((await sync()).users.reactivated, 1)
  // R8: their status belongs to the directory: People bulk refuses
  const klee = (await pool.query(`select id from users where username = 'klee'`)).rows[0].id
  const bulk = await call('POST', '/api/v1/admin/users/bulk', { userIds: [klee], action: 'deactivate' })
  assert.equal(bulk.status, 409); assert.match(bulk.body.error, /Corporate AD/)
  const people = (await call('GET', '/api/v1/admin/users?query=klee')).body.items
  assert.equal(people[0].directory, 'Corporate AD')
  // R7: someone whose new email is another person's is skipped and reported, but still there: not deactivated
  const mail = (m: string) => { corp.entries = corp.entries.map(e => ((e as any).sAMAccountName === 'klee' ? { ...e, mail: m } : e)) }
  mail('owner@x.com')
  assert.ok((await sync()).users.skipped.some((s: any) => s.name === 'klee'))
  assert.equal((await pool.query(`select active, email from users where username = 'klee'`)).rows[0].active, true)
  // R7: a new email in the directory changes the field in Strand, recorded as a change
  mail('kim.lee@corp.test')
  assert.equal((await sync()).users.updated, 1)
  assert.equal((await pool.query(`select email from users where username = 'klee'`)).rows[0].email, 'kim.lee@corp.test')
  const [changed] = (await pool.query(`select before, after from audit_log where action = 'user.updated' and target = 'kim.lee@corp.test'`)).rows
  assert.deepEqual([changed.before.email, changed.after.email], ['klee@corp.test', 'kim.lee@corp.test'])
  mail('klee@corp.test')
  // R11: no users found where there were some: nothing changes
  const all = corp.entries
  corp.entries = all.filter(e => (e as any).objectCategory !== 'Person')
  const guarded: any = await syncDirectory(corpDir.id)
  assert.equal(guarded.ok, false); assert.match(guarded.error, /found no users/)
  assert.equal((await pool.query(`select count(*)::int as n from users where directory_id = $1 and active`, [corpDir.id])).rows[0].n, 3)   // jdoe, lperson, klee
  corp.entries = all
  // R11: one synchronisation at a time; "Synchronise now" runs one as a job
  const lock = await pool.connect()
  await lock.query('select pg_advisory_lock(hashtext($1))', [`directory.sync:${corpDir.id}`])
  assert.deepEqual(await syncDirectory(corpDir.id), { skipped: 'This directory is being synchronised already' })
  await lock.query('select pg_advisory_unlock(hashtext($1))', [`directory.sync:${corpDir.id}`]); lock.release()
  const started = await call('POST', `/api/v1/admin/directories/${corpDir.id}/sync`)
  assert.equal(started.status, 202)
  await runJobs()
  const [job] = (await pool.query('select status, result from jobs where id = $1', [started.body.jobId])).rows
  assert.deepEqual([job.status, job.result.ok], ['done', true])
  await call('PUT', `/api/v1/admin/directories/${corpDir.id}`, { name: corpDir.name, enabled: false, config: corpDir.config })
})

