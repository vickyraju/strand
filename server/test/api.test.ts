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

/** A custom field for one project (spec 0503: a field with a context for that project), made straight in the database. */
const projectField = async (projectId: string, name: string, kind: string, options: object[] | null = null) => {
  const [{ id }] = (await pool.query(`insert into custom_fields (workspace_id, name, kind) select workspace_id, $2, $3 from projects where id = $1 returning id`, [projectId, name, kind])).rows
  await pool.query(`insert into field_contexts (field_id, name, project_ids, options) values ($1, $2, array[$3::uuid], $4)`, [id, `Default context for ${name}`, projectId, options ? JSON.stringify(options) : null])
  return { id: id as string }
}
const call = async (method: string, path: string, body?: unknown, who = 'owner@x.com', headers: Record<string, string> = {}) => {
  // web app calls (its Origin): rate limiting leaves it alone (spec 0706)
  const r = await app.inject({ method: method as any, url: path, payload: body as any, headers: { origin: 'http://localhost:5173', 'x-dev-user': who, ...headers } })
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

  // unknown installations wait for an admin (spec 0707 R1), and failed deliveries
  assert.equal((await hook('pull_request', { ...prPayload(), installation: { id: 1 } })).body.ignored, 'waiting for an administrator to connect this installation')
  assert.equal((await pool.query(`select count(*)::int n from webhook_deliveries where status = 'processed'`)).rows[0].n > 5, true)

  // uninstall removes the integration and everything it collected
  await hook('installation', { action: 'deleted', installation: { id: 777 } })
  assert.equal((await pool.query('select count(*)::int n from dev_entities')).rows[0].n, 0)
  assert.equal((await dev('GH-2')).pullRequests.length, 0)
})

test('[0707.R1][0707.R2][0707.R5][0707.R6] Development tools: an unknown GitHub installation waits for an admin; connect, limit, pause, remove; development JQL', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Dev panel', key: 'DVP', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Dev other', key: 'DVO', template: 'kanban' })
  for (const t of ['one', 'two', 'three']) await call('POST', '/api/v1/projects/DVP/issues', { title: t })
  const repo = { id: 5151, full_name: 'stranger/app', default_branch: 'main', html_url: 'https://github.com/stranger/app' }
  const inst = { id: 999, account: { login: 'stranger' } }
  const pr = (n: number, title: string, over: object = {}) => ({ action: 'opened', number: n, repository: repo, installation: inst,
    pull_request: { number: n, html_url: `https://github.com/stranger/app/pull/${n}`, title, body: '', state: 'open', merged: false, updated_at: `2026-11-10T10:0${n}:00Z`, user: { login: 'dev' }, head: { ref: `b${n}` }, base: { ref: 'main' }, ...over } })
  const admin = async () => (await call('GET', '/api/v1/admin/development')).body
  const acct = async () => (await admin()).accounts.find((a: any) => a.installationId === 999)
  const dev = async (key: string) => (await call('GET', `/api/v1/issues/${key}/development`)).body
  const keys = async (jql: string) => {
    const r = await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = DVP AND ${jql}`)}&limit=50`)
    assert.equal(r.status, 200, `${jql}: ${JSON.stringify(r.body)}`)
    return r.body.items.map((i: any) => i.key).sort()
  }

  // R1: a delivery from an installation nobody connected adds it as waiting, and keeps nothing it sent
  assert.equal((await hook('pull_request', pr(1, 'DVP-1 first'))).status, 200)
  let a = await acct()
  assert.deepEqual([a.accountLogin, a.status, a.repositories.length], ['stranger', 'pending', 0])
  assert.equal((await dev('DVP-1')).pullRequests.length, 0)
  assert.equal((await admin()).secretSet, true)
  assert.equal((await call('GET', '/api/v1/admin/development', undefined, 'member@x.com')).status, 403)

  // connect: from now on its work is kept and linked; audited
  assert.equal((await call('PUT', `/api/v1/admin/development/accounts/${a.id}`, { status: 'active' })).status, 204)
  assert.equal((await pool.query(`select count(*)::int n from audit_log where action = 'development.connected' and target_id = $1`, [a.id])).rows[0].n, 1)
  await hook('pull_request', pr(1, 'DVP-1 first'))
  await hook('pull_request', pr(2, 'Fixes DVP-1', { state: 'closed', merged: true }))
  await hook('pull_request', pr(3, 'DVP-2 dropped', { state: 'closed', merged: false }))
  await hook('push', { ref: 'refs/heads/dvp-2-work', repository: repo, installation: inst, head_commit: { timestamp: '2026-11-10T11:00:00Z' },
    commits: [{ id: 'dvc1', message: 'DVP-2 a change', url: 'https://github.com/stranger/app/commit/dvc1', timestamp: '2026-11-10T11:00:00Z', author: { name: 'Dev' } }] })
  // R6: the panel's answer, each commit with its branch
  let d = await dev('DVP-1')
  assert.deepEqual(d.pullRequests.map((p: any) => p.state).sort(), ['merged', 'open'])
  d = await dev('DVP-2')
  assert.deepEqual([d.branches.map((b: any) => b.title), d.commits.map((c: any) => [c.title, c.branchTo])], [['dvp-2-work'], [['DVP-2 a change', 'dvp-2-work']]])

  // R5: Jira's development fields
  assert.deepEqual(await keys('development[pullrequests].all > 0'), ['DVP-1', 'DVP-2'])
  assert.deepEqual(await keys('development[pullrequests].open > 0'), ['DVP-1'])
  assert.deepEqual(await keys('development[pullrequests].merged = 1'), ['DVP-1'])
  assert.deepEqual(await keys('development[pullrequests].declined >= 1'), ['DVP-2'])
  assert.deepEqual(await keys('development[pullrequests].status = declined'), ['DVP-2'])
  assert.deepEqual(await keys('development[PullRequests].status in (open, merged)'), ['DVP-1'])
  assert.deepEqual(await keys('development[commits].all > 0 AND development[branches].all = 1'), ['DVP-2'])
  assert.deepEqual(await keys('development[pullrequests].all = 0'), ['DVP-3'])
  assert.deepEqual(await keys('development[builds].failing > 0 OR development[deployments].environment = prod OR development[reviews].open > 0'), [])
  assert.deepEqual(await keys('development[builds].all = 0'), ['DVP-1', 'DVP-2', 'DVP-3'])
  assert.equal((await call('GET', `/api/v1/search?jql=${encodeURIComponent('development[pullrequests].status = shipped')}`)).status, 400)

  // limited to other projects: a key from DVP no longer links
  a = await acct()
  const r = a.repositories[0]
  assert.equal((await call('PUT', `/api/v1/admin/development/repositories/${r.id}`, { projectKeys: ['NOPE'] })).status, 400)
  assert.equal((await call('PUT', `/api/v1/admin/development/repositories/${r.id}`, { projectKeys: ['dvo'] })).status, 204)
  assert.deepEqual((await acct()).repositories[0].projectKeys, ['DVO'])
  await hook('pull_request', pr(4, 'DVP-3 limited'))
  assert.equal((await dev('DVP-3')).pullRequests.length, 0)
  await call('PUT', `/api/v1/admin/development/repositories/${r.id}`, { projectKeys: [] })

  // paused: deliveries are dropped, what it sent stays
  await call('PUT', `/api/v1/admin/development/accounts/${a.id}`, { status: 'suspended' })
  assert.equal((await hook('pull_request', pr(5, 'DVP-3 paused'))).body.ignored, 'installation paused')
  assert.equal((await dev('DVP-3')).pullRequests.length, 0)
  assert.equal((await dev('DVP-1')).pullRequests.length, 2)

  // removed: everything it sent goes
  assert.equal((await call('DELETE', `/api/v1/admin/development/accounts/${a.id}`)).status, 204)
  assert.equal((await dev('DVP-1')).pullRequests.length, 0)
  assert.equal(await acct(), undefined)
  assert.equal((await pool.query(`select count(*)::int n from audit_log where action = 'development.removed'`)).rows[0].n, 1)
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

test('[0606.R2][0606.R3] mentions: @Full Name notifies that person (not twice), watchers hear "commented", the commenter starts watching and the mentioned don\'t', { skip }, async () => {
  const [ann, bob, cy] = ['mention.ann', 'mention.bob', 'mention.cy']
  await call('POST', '/api/v1/projects', { name: 'Mentions', key: 'MEN', template: 'kanban' })
  for (const n of [ann, bob, cy]) await join('MEN', `${n}@x.com`)
  const issue = (await call('POST', '/api/v1/projects/MEN/issues', { title: 'talk', assigneeId: (await call('GET', '/api/v1/me', undefined, `${cy}@x.com`)).body.id })).body
  const c1 = await call('POST', '/api/v1/issues/MEN-1/comments', { body: `Thanks @${bob}, can you look?` }, `${ann}@x.com`)
  assert.equal(c1.status, 201)
  assert.deepEqual((await inbox(`${bob}@x.com`)).filter(n => n.issueKey === 'MEN-1').map(n => n.kind), ['mentioned'])
  assert.deepEqual((await inbox(`${cy}@x.com`)).filter(n => n.issueKey === 'MEN-1' && n.kind !== 'updated').map(n => n.kind), ['commented'])   // the assignee hears, was not mentioned (creating it was "updated")
  assert.deepEqual((await inbox(`${ann}@x.com`)).filter(n => n.issueKey === 'MEN-1'), [])                                                       // never notified about their own comment
  // the commenter now watches (Autowatch); the mentioned person doesn't (as Jira's): a later comment reaches only the commenter
  await call('POST', '/api/v1/issues/MEN-1/comments', { body: 'a later comment' }, `${cy}@x.com`)
  assert.ok(!(await inbox(`${bob}@x.com`)).some(n => n.issueKey === 'MEN-1' && n.kind === 'commented'))
  assert.ok((await inbox(`${ann}@x.com`)).some(n => n.issueKey === 'MEN-1' && n.kind === 'commented'))
  // a person mentioned AND watching gets "mentioned" only
  await call('PUT', '/api/v1/issues/MEN-1/watch', undefined, `${bob}@x.com`)
  await call('POST', '/api/v1/issues/MEN-1/comments', { body: `@${bob} again` }, `${cy}@x.com`)
  const bobNow = (await inbox(`${bob}@x.com`)).filter(n => n.issueKey === 'MEN-1')
  assert.deepEqual(bobNow.map(n => n.kind).sort(), ['mentioned', 'mentioned'])
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
  const { id: f1 } = await projectField(p.id, 'Team', 'text')
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
  const { id: team } = await projectField(p.id, 'Team', 'text')
  const { id: pts } = await projectField(p.id, 'Risk', 'number')
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

test('[0709.R1][0709.R2][0709.R3][0709.R4] automation: JQL conditions, scheduled rules, and global rules over a category, chosen projects or all', { skip, timeout: 60_000 }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const { clearSettingsCache } = await import('../src/settings.ts')
  for (const [name, key] of [['Auto A', 'AUA'], ['Auto B', 'AUB'], ['Auto C', 'AUC']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  await join('AUA', 'aua.member@x.com', 'member')
  const me = (await call('GET', '/api/v1/me')).body.id
  const mk = async (key: string, o: object = {}, who?: string) => (await call('POST', `/api/v1/projects/${key}/issues`, { title: 'x', ...o }, who)).body
  const labels = async (k: string) => (await call('GET', `/api/v1/issues/${k}`)).body.labels
  const runsOf = async (rule: string) => (await pool.query('select result, steps from rule_runs where rule_id = $1 order by at', [rule])).rows

  // R1: a JQL condition; currentUser() is whoever made the change
  assert.equal((await call('POST', '/api/v1/projects/AUA/rules', { name: 'Bad', trigger: { kind: 'created' }, condition: 'type = = bug', actions: [{ kind: 'label', value: 'x' }] })).status, 400)
  const cond = (await call('POST', '/api/v1/projects/AUA/rules', { name: 'My bugs', trigger: { kind: 'created' }, condition: 'type = bug AND assignee = currentUser()', actions: [{ kind: 'label', value: 'triage' }] })).body
  const mine = await mk('AUA', { type: 'bug', assigneeId: me })
  const theirs = await mk('AUA', { type: 'bug', assigneeId: me }, 'aua.member@x.com')
  const task = await mk('AUA', { type: 'task', assigneeId: me })
  assert.deepEqual([await labels(mine.key), await labels(theirs.key), await labels(task.key)], [['triage'], [], []])
  assert.deepEqual((await runsOf(cond.id)).map(r => r.result), ['success', 'condition_not_met', 'condition_not_met'])
  const dry = (await call('POST', '/api/v1/projects/AUA/automation/dry-run', { issue: task.key, condition: 'type = bug', actions: [{ kind: 'label', value: 'x' }] })).body
  assert.deepEqual([dry.conditionMet, dry.steps], [false, []])
  await call('PATCH', `/api/v1/projects/AUA/rules/${cond.id}`, { enabled: false })

  // R2: scheduled rules
  const sched = (body: object) => call('POST', '/api/v1/projects/AUA/rules', { name: 'Sweep', actions: [{ kind: 'label', value: 'swept' }], ...body })
  assert.equal((await sched({ trigger: { kind: 'scheduled', everyMinutes: 1, jql: 'type = task' } })).status, 400)    // shorter than System settings allow
  assert.equal((await sched({ trigger: { kind: 'scheduled', everyMinutes: 60 } })).status, 400)                       // no JQL
  const sweep = (await sched({ trigger: { kind: 'scheduled', everyMinutes: 60, jql: 'type = task', changedSinceLastRun: true } })).body
  const queued = async () => (await pool.query(`select run_at from jobs where dedupe_key = $1 and status = 'queued'`, [`automation.scheduled:${sweep.id}`])).rows
  assert.equal((await queued()).length, 1)
  assert.ok(new Date((await queued())[0].run_at).getTime() > Date.now() + 59 * 60_000)
  const tick = async () => { await pool.query(`update jobs set run_at = now() where dedupe_key = $1 and status = 'queued'`, [`automation.scheduled:${sweep.id}`]); await runJobs() }
  await tick()
  assert.deepEqual([await labels(task.key), await labels(mine.key)], [['swept'], ['triage']])
  assert.equal((await queued()).length, 1)                                          // the next run is queued when one ends
  const before = (await runsOf(sweep.id)).length
  await tick()                                                                      // nobody changed anything: its own label doesn't count
  assert.equal((await runsOf(sweep.id)).length, before)
  await call('PATCH', `/api/v1/issues/${task.key}`, { title: 'changed by a person' })
  await tick()
  assert.equal((await runsOf(sweep.id)).length, before + 1)
  // at most maxItemsPerRun items a run; the log says the rest wait
  await call('PUT', '/api/v1/admin/settings/automation', { minScheduleMinutes: 5, maxItemsPerRun: 1 }); clearSettingsCache()
  await mk('AUA', { type: 'task' }); await mk('AUA', { type: 'task' })
  await tick()
  const last = (await runsOf(sweep.id)).slice(-2)
  assert.deepEqual(last.map(r => r.result), ['success', 'some_skipped'])
  assert.match(last[1].steps[0].note, /wait for the next run/)
  await call('PUT', '/api/v1/admin/settings/automation', { minScheduleMinutes: 5, maxItemsPerRun: 1000 }); clearSettingsCache()
  await call('PATCH', `/api/v1/projects/AUA/rules/${sweep.id}`, { enabled: false })
  assert.equal((await queued()).length, 0)

  // R3: a global rule over a category covers a project added to it later
  const cat = (await call('POST', '/api/v1/admin/project-categories', { name: 'Ops automation' })).body
  await call('PATCH', '/api/v1/projects/AUA', { categoryId: cat.id })
  const g = await call('POST', '/api/v1/admin/automation/rules', { name: 'Ops label', scope: { kind: 'category', categoryId: cat.id }, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'ops' }] })
  assert.equal(g.status, 200)
  assert.deepEqual(g.body.scope, { kind: 'category', categoryId: cat.id, categoryName: 'Ops automation' })
  assert.deepEqual([await labels((await mk('AUA')).key), await labels((await mk('AUB')).key)], [['ops'], []])
  await call('PATCH', '/api/v1/projects/AUC', { categoryId: cat.id })
  assert.deepEqual(await labels((await mk('AUC')).key), ['ops'])
  // chosen projects, statuses by name; a project without the status is skipped and logged
  assert.equal((await call('POST', '/api/v1/admin/automation/rules', { name: 'x', scope: { kind: 'projects', projectKeys: ['NOPE'] }, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'x' }] })).status, 400)
  const started = (await call('POST', '/api/v1/admin/automation/rules', { name: 'Started', scope: { kind: 'projects', projectKeys: ['aub'] },
    trigger: { kind: 'status', toName: 'in progress' }, actions: [{ kind: 'label', value: 'started' }, { kind: 'status', name: 'Nowhere' }] })).body
  assert.deepEqual(started.scope, { kind: 'projects', projectKeys: ['AUB'] })
  const b1 = await mk('AUB')
  const prog = (await call('GET', '/api/v1/projects/AUB')).body.statuses.find((s: any) => s.name === 'In progress')
  await call('PATCH', `/api/v1/issues/${b1.key}`, { statusId: prog.id })
  assert.deepEqual(await labels(b1.key), ['started'])
  const runs = (await call('GET', `/api/v1/admin/automation/runs?rule=${started.id}`)).body
  assert.deepEqual([runs[0].issueKey, runs[0].result, runs[0].steps[1].note], [b1.key, 'some_skipped', 'a status change: this project has no status “Nowhere”'])
  // project admins see the global rules that apply, read-only; only system admins change them
  assert.deepEqual((await call('GET', '/api/v1/projects/AUA/automation/global')).body.map((r: any) => r.name), ['Ops label'])
  assert.deepEqual((await call('GET', '/api/v1/projects/AUB/automation/global')).body.map((r: any) => r.name), ['Started'])
  assert.equal((await call('GET', '/api/v1/projects/AUA/automation/global', undefined, 'aua.member@x.com')).status, 403)
  assert.equal((await call('GET', '/api/v1/admin/automation/rules', undefined, 'aua.member@x.com')).status, 403)
  // R4: audited; removing it stops it
  assert.equal((await call('PUT', `/api/v1/admin/automation/rules/${g.body.id}`, { name: 'Ops label', scope: { kind: 'all' }, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'ops' }] })).status, 200)
  assert.deepEqual(await labels((await mk('AUB')).key), ['ops'])
  assert.equal((await call('DELETE', `/api/v1/admin/automation/rules/${g.body.id}`)).status, 204)
  assert.deepEqual(await labels((await mk('AUB')).key), [])
  assert.deepEqual((await pool.query(`select action from audit_log where target_id = $1 order by at`, [g.body.id])).rows.map(r => r.action),
    ['automation.global.created', 'automation.global.updated', 'automation.global.deleted'])
})

test('[0307.R3] CSV import: a dry run checks every row; the import runs as a job; running it again adds nothing twice', { skip, timeout: 60_000 }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'From CSV', key: 'CSV', template: 'kanban' })).body
  await join('CSV', 'imp.ann@x.com')
  await call('POST', '/api/v1/projects/CSV/components', { name: 'API' })
  const { id: team } = await projectField(p.id, 'Team', 'select', [{"id":"o1","name":"Core","disabled":false},{"id":"o2","name":"Web","disabled":false}])
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
  const assign = async (title: string) => {   // Issue Assigned (spec 0605): an edit that only changes the assignee
    const i = (await call('POST', '/api/v1/projects/MAL/issues', { title })).body
    await call('PATCH', `/api/v1/issues/${i.key}`, { assigneeId: ann }); await runJobs(); return i
  }
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
  // the reports' history too: when a hidden item joined a version is hidden with it (spec 0411)
  const rel = (await call('POST', '/api/v1/projects/SEC/releases', { name: 'Sec 1' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${hidden.key}`, { fixReleaseIds: [rel.id] })).status, 200)
  const bobs = (await as('/api/v1/projects/SEC/report-data')).body
  assert.deepEqual(keys(bobs.issues), [open.key])
  assert.deepEqual(bobs.joins.filter((j: any) => j.issueId === hidden.id), [])
  assert.ok((await call('GET', '/api/v1/projects/SEC/report-data', undefined, 'sec.ann@x.com')).body.joins.some((j: any) => j.issueId === hidden.id))
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
  assert.deepEqual(Object.fromEntries(['issues', 'comments', 'worklogs', 'issue_links', 'attachments', 'custom_fields', 'field_contexts', 'project_members'].map(k => [k, doc.tables[k].length])),
    { issues: 2, comments: 1, worklogs: 1, issue_links: 1, attachments: 1, custom_fields: 1, field_contexts: 1, project_members: 2 })
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
  const subscription = (await call('POST', `/api/v1/views/${view}/subscriptions`, { cron: '0 0 7 ? * *' })).body.id
  const plan = (await call('POST', '/api/v1/plans', { name: 'Matrix plan', projectKeys: ['MTX'] })).body.id
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
    'POST /auth/forgot': ['public', '/auth/forgot', { username: 'matrix.nobody' }], 'POST /auth/reset': ['public', '/auth/reset', { token: 'x', password: 'x' }],   // 0714.R6
    'PUT /me/password': ['any', '/me/password', { current: 'x', password: 'y' }],   // 0714.R8
    'POST /admin/users': ['gadmin', '/admin/users', { username: 'matrix.local', name: 'Matrix Local', email: 'matrix.local@x.com', password: 'matrix-password' }],   // 0714.R9
    'PATCH /admin/users/{id}': ['gadmin', `/admin/users/${none}`, { name: 'x' }], 'PUT /admin/users/{id}/password': ['gadmin', `/admin/users/${none}/password`, { password: 'matrix-password' }],
    'GET /admin/directories/internal': ['gadmin', '/admin/directories/internal'],
    'GET /look-and-feel': ['public', '/look-and-feel'],   // 0702.R2
    'GET /project-categories': ['any', '/project-categories'],   // 0703.R5
    'POST /issues/{key}/move': ['write', `/issues/${I}/move`, { projectKey: K, dryRun: true }], 'POST /issues/bulk/move': ['write', '/issues/bulk/move', { issues: [I], projectKey: K }],   // 0501.R1
    'GET /admin/custom-fields': ['gadmin', '/admin/custom-fields'], 'GET /admin/custom-fields/{id}': ['gadmin', `/admin/custom-fields/${none}`],   // 0503.R1
    'POST /admin/custom-fields': ['gadmin', '/admin/custom-fields', { name: 'Matrix field', kind: 'text', context: { projectKeys: [K] } }],
    'PATCH /admin/custom-fields/{id}': ['gadmin', `/admin/custom-fields/${none}`, { name: 'x' }], 'DELETE /admin/custom-fields/{id}': ['gadmin', `/admin/custom-fields/${none}`],
    'POST /admin/custom-fields/{id}/contexts': ['gadmin', `/admin/custom-fields/${none}/contexts`, { name: 'x', projectKeys: null }],
    'PATCH /admin/custom-fields/{id}/contexts/{contextId}': ['gadmin', `/admin/custom-fields/${none}/contexts/${none}`, { name: 'x' }],
    'DELETE /admin/custom-fields/{id}/contexts/{contextId}': ['gadmin', `/admin/custom-fields/${none}/contexts/${none}`],
    'GET /admin/field-configurations': ['gadmin', '/admin/field-configurations'], 'GET /admin/field-configurations/{id}': ['gadmin', `/admin/field-configurations/${none}`],   // 0504.R1
    'POST /admin/field-configurations': ['gadmin', '/admin/field-configurations', { name: 'Matrix config' }],
    'PATCH /admin/field-configurations/{id}': ['gadmin', `/admin/field-configurations/${none}`, { name: 'x' }], 'DELETE /admin/field-configurations/{id}': ['gadmin', `/admin/field-configurations/${none}`],
    'GET /admin/field-config-schemes': ['gadmin', '/admin/field-config-schemes'], 'GET /admin/field-config-schemes/{id}': ['gadmin', `/admin/field-config-schemes/${none}`],
    'POST /admin/field-config-schemes': ['gadmin', '/admin/field-config-schemes', { name: 'Matrix scheme', defaultConfigId: none }],
    'PATCH /admin/field-config-schemes/{id}': ['gadmin', `/admin/field-config-schemes/${none}`, { name: 'x' }], 'DELETE /admin/field-config-schemes/{id}': ['gadmin', `/admin/field-config-schemes/${none}`],
    'GET /admin/screens': ['gadmin', '/admin/screens'], 'GET /admin/screens/{id}': ['gadmin', `/admin/screens/${none}`], 'POST /admin/screens': ['gadmin', '/admin/screens', { name: 'Matrix screen' }],   // 0505.R1
    'PATCH /admin/screens/{id}': ['gadmin', `/admin/screens/${none}`, { name: 'x' }], 'DELETE /admin/screens/{id}': ['gadmin', `/admin/screens/${none}`],
    'GET /admin/screen-schemes': ['gadmin', '/admin/screen-schemes'], 'GET /admin/screen-schemes/{id}': ['gadmin', `/admin/screen-schemes/${none}`],
    'POST /admin/screen-schemes': ['gadmin', '/admin/screen-schemes', { name: 'Matrix ss', defaultScreenId: none }],
    'PATCH /admin/screen-schemes/{id}': ['gadmin', `/admin/screen-schemes/${none}`, { name: 'x' }], 'DELETE /admin/screen-schemes/{id}': ['gadmin', `/admin/screen-schemes/${none}`],
    'GET /admin/issue-type-screen-schemes': ['gadmin', '/admin/issue-type-screen-schemes'], 'GET /admin/issue-type-screen-schemes/{id}': ['gadmin', `/admin/issue-type-screen-schemes/${none}`],
    'POST /admin/issue-type-screen-schemes': ['gadmin', '/admin/issue-type-screen-schemes', { name: 'Matrix its', defaultSchemeId: none }],
    'PATCH /admin/issue-type-screen-schemes/{id}': ['gadmin', `/admin/issue-type-screen-schemes/${none}`, { name: 'x' }], 'DELETE /admin/issue-type-screen-schemes/{id}': ['gadmin', `/admin/issue-type-screen-schemes/${none}`],
    'PUT /issues/{key}/vote': ['read', `/issues/${I}/vote`], 'DELETE /issues/{key}/vote': ['read', `/issues/${I}/vote`], 'GET /issues/{key}/votes': ['read', `/issues/${I}/votes`],   // 0506.R1
    'GET /issues/{key}/remote-links': ['read', `/issues/${I}/remote-links`], 'POST /issues/{key}/remote-links': ['write', `/issues/${I}/remote-links`, { url: 'https://example.com', title: 'Matrix' }],   // 0507.R1
    'PUT /issues/{key}/remote-links/{id}': ['write', `/issues/${I}/remote-links/${none}`, { url: 'https://example.com', title: 'x' }], 'DELETE /issues/{key}/remote-links/{id}': ['write', `/issues/${I}/remote-links/${none}`],
    'POST /issues/{key}/archive': ['gadmin', `/issues/${I}/archive`], 'POST /issues/{key}/unarchive': ['gadmin', `/issues/${I}/unarchive`],   // 0508.R1
    'POST /issues/bulk/watch': ['viewer', '/issues/bulk/watch', { issues: [I], watching: true }],   // 0510.R1
    'POST /issues/bulk/transition': ['any', '/issues/bulk/transition', { issues: [I], toStatus: 'Nowhere' }],   // 0510.R2: every item's outcome, refusals included
    'POST /issues/bulk/archive': ['gadmin', '/issues/bulk/archive', { issues: ['NOPE-1'] }], 'GET /admin/archived-items': ['gadmin', '/admin/archived-items'],
    'POST /issues/{key}/convert': ['write', `/issues/${I}/convert`, { parentKey: null }],   // 0509.R1
    'GET /admin/automation/rules': ['gadmin', '/admin/automation/rules'], 'GET /admin/automation/runs': ['gadmin', '/admin/automation/runs'],   // 0709.R3
    'POST /admin/automation/rules': ['gadmin', '/admin/automation/rules', { name: 'Matrix rule', scope: { kind: 'all' }, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'matrix' }] }],
    'PUT /admin/automation/rules/{id}': ['gadmin', `/admin/automation/rules/${none}`, { name: 'x', scope: { kind: 'all' }, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: 'x' }] }],
    'DELETE /admin/automation/rules/{id}': ['gadmin', `/admin/automation/rules/${none}`], 'GET /projects/{key}/automation/global': ['padmin', `/projects/${K}/automation/global`],
    'GET /admin/development': ['gadmin', '/admin/development'], 'PUT /admin/development/accounts/{id}': ['gadmin', `/admin/development/accounts/${none}`, { status: 'active' }],   // 0707.R1
    'DELETE /admin/development/accounts/{id}': ['gadmin', `/admin/development/accounts/${none}`], 'PUT /admin/development/repositories/{id}': ['gadmin', `/admin/development/repositories/${none}`, { projectKeys: [] }],
    'GET /admin/webhooks': ['gadmin', '/admin/webhooks'], 'POST /admin/webhooks': ['gadmin', '/admin/webhooks', { name: 'Matrix hook', url: 'https://hooks.example.com/x' }],   // 0705.R1
    'GET /admin/webhooks/{id}': ['gadmin', `/admin/webhooks/${none}`], 'PUT /admin/webhooks/{id}': ['gadmin', `/admin/webhooks/${none}`, { name: 'x', url: 'https://hooks.example.com/x' }],
    'DELETE /admin/webhooks/{id}': ['gadmin', `/admin/webhooks/${none}`], 'POST /admin/webhooks/{id}/secret': ['gadmin', `/admin/webhooks/${none}/secret`],
    'POST /admin/webhooks/{id}/test': ['gadmin', `/admin/webhooks/${none}/test`], 'GET /admin/webhooks/{id}/calls': ['gadmin', `/admin/webhooks/${none}/calls`],
    'POST /admin/webhooks/{id}/calls/{callId}/redeliver': ['gadmin', `/admin/webhooks/${none}/calls/${none}/redeliver`],
    'GET /admin/users/{id}/anonymise': ['gadmin', `/admin/users/${none}/anonymise`], 'POST /admin/users/{id}/anonymise': ['gadmin', `/admin/users/${none}/anonymise`, {}],   // 0704.R1
    'POST /admin/project-categories': ['gadmin', '/admin/project-categories', { name: 'Matrix category' }],
    'PATCH /admin/project-categories/{id}': ['gadmin', `/admin/project-categories/${none}`, { name: 'x' }], 'DELETE /admin/project-categories/{id}': ['gadmin', `/admin/project-categories/${none}`],
    'PUT /projects/{key}/avatar': ['padmin', `/projects/${K}/avatar`, { image: 'eA==' }], 'DELETE /projects/{key}/avatar': ['padmin', `/projects/${K}/avatar`],   // 0703.R8
    'PUT /admin/look-and-feel': ['gadmin', '/admin/look-and-feel', { siteTitle: 'Strand', showTitle: true, brandColor: '#368727' }],   // 0702.R1
    'DELETE /admin/look-and-feel': ['gadmin', '/admin/look-and-feel'],
    'PUT /admin/look-and-feel/logo': ['gadmin', '/admin/look-and-feel/logo', { image: 'eA==' }], 'DELETE /admin/look-and-feel/logo': ['gadmin', '/admin/look-and-feel/logo'],
    'PUT /admin/look-and-feel/favicon': ['gadmin', '/admin/look-and-feel/favicon', { image: 'eA==' }], 'DELETE /admin/look-and-feel/favicon': ['gadmin', '/admin/look-and-feel/favicon'],
    'PUT /admin/look-and-feel/mark': ['gadmin', '/admin/look-and-feel/mark', { image: 'eA==' }], 'DELETE /admin/look-and-feel/mark': ['gadmin', '/admin/look-and-feel/mark'],   // 0719.R1
    'GET /boards/{id}/panels': ['read', `/boards/${board}/panels`],   // 0407.R2
    'GET /boards/{id}/reports/control': ['read', `/boards/${board}/reports/control?statuses=${none}`],   // 0410.R1
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
    'GET /comments/{id}/versions': ['own', `/comments/${comment}/versions`],   // 0601.R6: its author and admins
    'POST /issues/{key}/worklogs': ['write', `/issues/${I}/worklogs`, { minutes: 5, date: '2026-10-01' }],
    'PATCH /worklogs/{id}': ['own', `/worklogs/${worklog}`, { note: 'x' }],
    'DELETE /worklogs/{id}': ['own', `/worklogs/${worklog}`],
    'GET /search/export.csv': ['any', '/search/export.csv'], 'GET /search/export.{format}': ['any', '/search/export.xml'],   // 0608.R1
    'GET /issues/{key}/export.{format}': ['read', `/issues/${I}/export.xml`],
    'GET /search': ['any', '/search'], 'GET /labels': ['any', '/labels'],
    'GET /me/work': ['any', '/me/work'], 'GET /me/recent': ['any', '/me/recent'], 'GET /me/work/summary': ['any', '/me/work/summary'],
    'GET /me/projects/recent': ['any', '/me/projects/recent'], 'GET /me/viewed': ['any', '/me/viewed'],
    'GET /projects/{key}/summary': ['read', `/projects/${K}/summary`],
    'GET /notifications': ['any', '/notifications'], 'PATCH /notifications/{id}': ['own', `/notifications/${notification}`, { read: true }],
    'POST /notifications/read-all': ['any', '/notifications/read-all'],
    'GET /views': ['any', '/views'], 'POST /views': ['any', '/views', { name: 'v', filters: {} }],
    'PATCH /views/{id}': ['own', `/views/${view}`, { name: 'x' }], 'DELETE /views/{id}': ['own', `/views/${view}`],
    'PUT /projects/{key}/initiatives': ['padmin', `/projects/${K}/initiatives`, { enabled: false }], 'GET /initiatives': ['any', '/initiatives'],   // 0803.R1
    'GET /plans': ['any', '/plans'], 'POST /plans': ['any', '/plans', { name: `Plan ${Math.random()}`, projectKeys: [K] }], 'GET /plans/{id}': ['any', `/plans/${plan}`],   // 0803.R2
    'GET /plans/{id}/timeline': ['any', `/plans/${plan}/timeline`], 'PATCH /plans/{id}': ['own', `/plans/${plan}`, { doneDays: 30 }], 'DELETE /plans/{id}': ['own', `/plans/${plan}`],
    'POST /admin/jira-import/test': ['gadmin', '/admin/jira-import/test', { url: 'https://jira.invalid', token: 'x' }],   // 0802.R1
    'GET /admin/jira-imports': ['gadmin', '/admin/jira-imports'], 'GET /admin/jira-imports/{id}': ['gadmin', `/admin/jira-imports/${none}`],
    'POST /admin/jira-imports': ['gadmin', '/admin/jira-imports', { url: 'https://jira.invalid', token: 'x', projectKeys: ['ABC'], dryRun: true }],
    'GET /admin/mail-servers': ['gadmin', '/admin/mail-servers'], 'POST /admin/mail-servers': ['gadmin', '/admin/mail-servers', { name: 'x', config: { kind: 'graph', tenantId: 't', clientId: 'c', mailbox: 'a@b.co' }, secret: 's' }],   // 0607.R1
    'PUT /admin/mail-servers/{id}': ['gadmin', `/admin/mail-servers/${none}`, { name: 'x', config: { kind: 'files' } }], 'DELETE /admin/mail-servers/{id}': ['gadmin', `/admin/mail-servers/${none}`],
    'POST /admin/mail-servers/test': ['gadmin', '/admin/mail-servers/test', { config: { kind: 'graph', tenantId: 't', clientId: 'c', mailbox: 'a@b.co' }, secret: 's' }],
    'GET /admin/mail-handlers': ['gadmin', '/admin/mail-handlers'], 'POST /admin/mail-handlers': ['gadmin', '/admin/mail-handlers', { name: 'x', serverId: none, kind: 'comment_entire', params: {} }],
    'PUT /admin/mail-handlers/{id}': ['gadmin', `/admin/mail-handlers/${none}`, { name: 'x', serverId: none, kind: 'comment_entire', params: {} }],
    'DELETE /admin/mail-handlers/{id}': ['gadmin', `/admin/mail-handlers/${none}`], 'POST /admin/mail-handlers/{id}/run': ['gadmin', `/admin/mail-handlers/${none}/run`],
    'GET /admin/global-permissions': ['gadmin', '/admin/global-permissions'], 'POST /admin/global-permissions': ['gadmin', '/admin/global-permissions', { permission: 'bulk-change', groupId: none }], 'DELETE /admin/global-permissions/{id}': ['gadmin', `/admin/global-permissions/${none}`],   // 0717.R1
    'GET /admin/notification-schemes': ['gadmin', '/admin/notification-schemes'], 'POST /admin/notification-schemes': ['gadmin', '/admin/notification-schemes', { name: 'x' }],   // 0605.R1
    'GET /admin/notification-schemes/{id}': ['gadmin', `/admin/notification-schemes/${none}`], 'PATCH /admin/notification-schemes/{id}': ['gadmin', `/admin/notification-schemes/${none}`, { name: 'x' }],
    'DELETE /admin/notification-schemes/{id}': ['gadmin', `/admin/notification-schemes/${none}`], 'POST /admin/notification-schemes/{id}/copy': ['gadmin', `/admin/notification-schemes/${none}/copy`, {}],
    'POST /admin/notification-schemes/{id}/entries': ['gadmin', `/admin/notification-schemes/${none}/entries`, { event: 'issue_created', recipient: 'reporter' }],
    'DELETE /admin/notification-schemes/{id}/entries/{entryId}': ['gadmin', `/admin/notification-schemes/${none}/entries/${none}`],
    'GET /projects/{key}/notification-scheme': ['padmin', `/projects/${K}/notification-scheme`], 'PUT /projects/{key}/notification-scheme': ['gadmin', `/projects/${K}/notification-scheme`, { schemeId: none }],   // 0605.R2
    'GET /views/{id}/subscriptions': ['own', `/views/${view}/subscriptions`], 'POST /views/{id}/subscriptions': ['own', `/views/${view}/subscriptions`, { cron: '0 0 7 ? * *' }],   // 0604.R1
    'PATCH /subscriptions/{id}': ['own', `/subscriptions/${subscription}`, { emailWhenEmpty: true }], 'DELETE /subscriptions/{id}': ['own', `/subscriptions/${subscription}`],
    'POST /subscriptions/{id}/run': ['own', `/subscriptions/${subscription}/run`],
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
    if (rule === 'public') { expect(op, 'nobody', await send(op, null), [200, 202, 204, 400, 401, 403]); continue }
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
  assert.deepEqual(all.map((s: any) => s.key), ['rateLimiting', 'announcement', 'attachments', 'accessTokens', 'searchAndBulk', 'filterSubscriptions', 'plans', 'sprints', 'search', 'signIn', 'groups', 'voting', 'webhooks', 'automation', 'testing', 'dueReminders', 'email', 'emailBatching', 'userDefaults', 'deletedItems', 'projectKeys', 'timeTracking'])
  assert.equal(all.find((s: any) => s.key === 'rateLimiting').value.enabled, false)                  // no limit unless an admin sets one
  assert.equal((await call('GET', '/api/v1/admin/settings', undefined, 'set.member@x.com')).status, 403)
  assert.equal((await put('attachments', { enabled: true, maxSizeMb: 5 }, 'set.member@x.com')).status, 403)
  assert.equal((await put('nonsense', {})).status, 404)
  const bad = await put('accessTokens', { enabled: true, maxPerUser: 0, maxExpiryDays: 30, defaultExpiryDays: 60 })
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.maxPerUser && bad.body.errors.defaultExpiryDays)

  // public settings: what the web app needs, for anyone signed in (not rate limiting)
  const pub = (await call('GET', '/api/v1/settings/public', undefined, 'set.member@x.com')).body
  assert.deepEqual(Object.keys(pub).sort(), ['accessTokens', 'announcement', 'attachments', 'dueReminders', 'filterSubscriptions', 'groups', 'plans', 'priorities', 'projectKeys', 'resolutions', 'searchAndBulk', 'sprints', 'testing', 'timeTracking', 'userDefaults', 'voting'])

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

  // rate limiting: none by default, then a small limit; tokens always count; the web app is never limited; an exemption lifts it
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

test('[0714.R1][0714.R2][0714.R3][0714.R4][0714.R5][0714.R9] local users: an admin creates one, edits them and sets their password; the login form checks the internal directory first', { skip }, async () => {
  const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
  const as = (token: string, method = 'GET', url = '/api/v1/me', payload?: object) => app.inject({ method: method as any, url, payload, headers: { authorization: `Bearer ${token}` } })
  await pool.query('delete from login_failures')
  // R2: the rules for a new user
  const make = (b: object) => call('POST', '/api/v1/admin/users', { username: 'lena', name: 'Lena Local', email: 'Lena@Local.test', ...b })
  assert.equal((await make({})).status, 400)                                                   // no password, no email: no way in
  assert.ok((await make({ password: 'short' })).body.errors.password)                          // shorter than 8
  assert.equal((await make({ username: 'Recovery_Admin', password: 'long enough' })).status, 400)
  assert.equal((await make({ username: 'has space', password: 'long enough' })).status, 400)
  assert.ok((await make({ password: 'long enough', notify: true })).body.errors.notify)         // email isn't set up
  const made = await make({ password: 'lena-password-1' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const dup = await make({ username: 'LENA', email: 'other@local.test', password: 'long enough' })
  assert.deepEqual([dup.status, Object.keys(dup.body.errors)], [409, ['username']])
  assert.ok((await call('POST', '/api/v1/admin/users', { username: 'jdoe', name: 'X', email: 'x@local.test', password: 'long enough' })).body.errors.username)   // a directory user's
  const [row] = (await pool.query('select password_hash, email, is_system_admin(id) as admin from users where id = $1', [made.body.id])).rows
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes('lena-password-1'))
  assert.deepEqual([row.email, row.admin], ['lena@local.test', false])
  assert.ok((await pool.query(`select 1 from group_members gm join groups g on g.id = gm.group_id where g.system_role = 'default-users' and gm.user_id = $1`, [made.body.id])).rows.length)
  // R1, R5: the login form finds her in the internal directory
  const ok = await login('Lena', 'lena-password-1')
  assert.equal(ok.statusCode, 200, ok.body)
  const session = JSON.parse(ok.body).token
  const me = JSON.parse((await as(session)).body)
  assert.deepEqual([me.email, me.via, me.hasPassword, me.directory], ['lena@local.test', 'password', true, null])
  assert.equal((await login('lena', 'wrong-password')).statusCode, 401)
  await pool.query('delete from login_failures')
  // R5: no password, no form sign-in; R1: an internal user decides even when a directory has the same username
  await call('GET', '/api/v1/me', undefined, 'nopass@x.com')
  const nopass = (await pool.query(`select id from users where email = 'nopass@x.com'`)).rows[0].id
  assert.equal((await call('PATCH', `/api/v1/admin/users/${nopass}`, { username: 'nopass' })).status, 200)
  assert.equal((await login('nopass', '')).statusCode, 401)
  assert.equal((await login('nopass', 'anything-at-all')).statusCode, 401)
  await pool.query('delete from login_failures')
  // R3: edit details; the people list shows them
  assert.equal((await call('PATCH', `/api/v1/admin/users/${made.body.id}`, { username: 'lena.l', name: 'Lena Lind', email: 'lena.lind@local.test' })).status, 200)
  const listed = (await call('GET', '/api/v1/admin/users?query=lena')).body.items[0]
  assert.deepEqual([listed.username, listed.name, listed.email, listed.hasPassword, listed.directory], ['lena.l', 'Lena Lind', 'lena.lind@local.test', true, null])
  assert.equal((await login('lena.l', 'lena-password-1')).statusCode, 200)
  assert.deepEqual((await call('PATCH', `/api/v1/admin/users/${made.body.id}`, { email: 'owner@x.com' })).body.errors, { email: 'Someone already has this email' })
  // R3: directory users and recovery_admin are not edited here
  const jdoe = (await pool.query(`select id from users where username = 'jdoe'`)).rows[0].id
  assert.equal((await call('PATCH', `/api/v1/admin/users/${jdoe}`, { name: 'x' })).status, 409)
  assert.equal((await call('PUT', `/api/v1/admin/users/${jdoe}/password`, { password: 'long enough' })).status, 409)
  // R3: deactivating ends sign-in
  assert.equal((await call('PATCH', `/api/v1/admin/users/${made.body.id}`, { active: false })).status, 200)
  assert.equal((await as(session)).statusCode, 403)
  assert.equal((await call('PATCH', `/api/v1/admin/users/${made.body.id}`, { active: true })).status, 200)
  // R4: set password: the new one works, her sessions end
  assert.equal((await call('PUT', `/api/v1/admin/users/${made.body.id}/password`, { password: 'lena-password-2' })).status, 204)
  assert.equal((await as(session)).statusCode, 401)
  assert.equal((await login('lena.l', 'lena-password-1')).statusCode, 401)
  assert.equal((await login('lena.l', 'lena-password-2')).statusCode, 200)
  await pool.query('delete from login_failures')
  // R9: not with an access token; audited, the password never written down
  const pat = (await call('POST', '/api/v1/me/tokens', { name: 'local users' })).body.token
  assert.equal((await as(pat, 'POST', '/api/v1/admin/users', { username: 'patmade', name: 'X', email: 'patmade@local.test', password: 'long enough' })).statusCode, 403)
  const logged = (await pool.query(`select action, coalesce(before::text, '') || after::text as t from audit_log where action in ('user.created', 'user.updated', 'user.password_set') and target_id = $1`, [made.body.id])).rows
  assert.deepEqual(new Set(logged.map(r => r.action)), new Set(['user.created', 'user.updated', 'user.password_set']))
  assert.ok(logged.every(r => !/lena-password/.test(r.t)))
  assert.equal((await call('GET', '/api/v1/admin/directories/internal')).body.name, 'Strand internal directory')
})

test('[0714.R6][0714.R7][0714.R8] can’t access your account: one answer for everyone, an emailed link that works once; changing your own password', { skip }, async () => {
  const { sentEmails } = await import('../src/email.ts')
  const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })
  const forgot = (username: string) => app.inject({ method: 'POST', url: '/api/v1/auth/forgot', payload: { username } })
  const reset = (token: string, password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/reset', payload: { token, password } })
  const settle = () => new Promise(r => setTimeout(r, 300))
  const was = process.env.EMAIL_TRANSPORT
  process.env.EMAIL_TRANSPORT = 'memory'
  await call('PUT', '/api/v1/admin/settings/email', { enabled: false, from: 'strand@x.com', appUrl: 'https://strand.example' })
  await pool.query('delete from password_resets'); await pool.query('delete from login_failures'); sentEmails.length = 0
  // R6: the same answer for someone, nobody, and a directory user; only the internal user gets an email
  const answers = await Promise.all(['lena.lind@local.test', 'nobody-here', 'jdoe'].map(forgot))
  assert.deepEqual(answers.map(a => a.statusCode), [202, 202, 202])
  assert.equal(new Set(answers.map(a => a.body)).size, 1)
  await settle()
  assert.deepEqual(sentEmails.map(m => [m.to, m.subject]), [['lena.lind@local.test', 'Reset your Strand password']])
  const token = /\?reset=(jbr_[A-Za-z0-9_-]{43})/.exec(sentEmails[0]!.text)![1]!
  assert.ok(!(await pool.query('select token_hash::text from password_resets')).rows.some(r => r.token_hash.includes(token)))
  // R6: at most one every 5 minutes
  await forgot('lena.l'); await settle()
  assert.equal(sentEmails.length, 1)
  // R7: too short is refused (the link still works); then it sets the password, once
  assert.equal((await reset(token, 'short')).statusCode, 400)
  const before = JSON.parse((await login('lena.l', 'lena-password-2')).body).token
  assert.equal((await reset(token, 'lena-password-3')).statusCode, 204)
  assert.equal((await reset(token, 'lena-password-4')).statusCode, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${before}` } })).statusCode, 401)   // her sessions ended
  assert.equal((await login('lena.l', 'lena-password-3')).statusCode, 200)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'user.password_set' and after->>'by' = 'email link'`)).rows.length)
  // R7: an expired link doesn't work
  await pool.query(`update password_resets set created_at = now() - interval '1 hour'`)
  await forgot('lena.l'); await settle()
  const late = /\?reset=(jbr_[A-Za-z0-9_-]{43})/.exec(sentEmails.at(-1)!.text)![1]!
  await pool.query(`update password_resets set expires_at = now() - interval '1 second' where used_at is null`)
  assert.equal((await reset(late, 'lena-password-5')).statusCode, 400)
  // R2: a user created with the notification email gets the same kind of link
  const made = await call('POST', '/api/v1/admin/users', { username: 'nora', name: 'Nora New', email: 'nora@local.test', notify: true })
  assert.deepEqual([made.status, made.body.emailed], [201, true])
  const link = /\?reset=(jbr_[A-Za-z0-9_-]{43})/.exec(sentEmails.at(-1)!.text)![1]!
  assert.equal(sentEmails.at(-1)!.subject, 'Your Strand account')
  assert.equal((await reset(link, 'nora-password-1')).statusCode, 204)
  // R8: changing your own password needs the current one; your other sessions end, this one stays
  const s1 = JSON.parse((await login('nora', 'nora-password-1')).body).token, s2 = JSON.parse((await login('nora', 'nora-password-1')).body).token
  const change = (body: object) => app.inject({ method: 'PUT', url: '/api/v1/me/password', payload: body, headers: { authorization: `Bearer ${s1}` } })
  assert.equal((await change({ current: 'wrong', password: 'nora-password-2' })).statusCode, 400)
  assert.equal((await change({ current: 'nora-password-1', password: 'nora-password-2' })).statusCode, 204)
  const status = async (t: string) => (await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${t}` } })).statusCode
  assert.deepEqual([await status(s1), await status(s2)], [200, 401])
  assert.equal((await call('PUT', '/api/v1/me/password', { current: 'x', password: 'long enough' })).status, 409)   // the owner keeps no password here
  await pool.query('delete from login_failures')
  process.env.EMAIL_TRANSPORT = was
  if (was === undefined) delete process.env.EMAIL_TRANSPORT
})

test('[0406.R1][0406.R2][0406.R3][0406.R8] a Kanban backlog: its statuses leave the board for the Backlog tab, with the first column', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Kanban backlog', key: 'KBL', template: 'kanban' })).status, 201)
  const p = (await call('GET', '/api/v1/projects/KBL')).body
  const [board] = (await call('GET', '/api/v1/projects/KBL/boards')).body
  const b = (await call('GET', `/api/v1/boards/${board.id}`)).body
  assert.deepEqual(b.kanbanBacklog, [])
  const g = (name: string) => p.statuses.find((s: any) => s.name === name).globalStatusId
  const todo = g('To do'), doing = g('In progress')
  const item = async (title: string, status: string) => {
    const i = (await call('POST', '/api/v1/projects/KBL/issues', { title })).body
    if (status !== todo) await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: p.statuses.find((s: any) => s.globalStatusId === status).id })
    return i.key
  }
  const planned = await item('Planned later', todo), going = await item('Under way', doing)
  // R1: a status is in one place only; Scrum boards have none
  const both = await call('PATCH', `/api/v1/boards/${b.id}`, { kanbanBacklog: [todo] })
  assert.equal(both.status, 400); assert.ok(both.body.errors.columns)
  const columns = b.columns.map((c: any) => ({ ...c, statusIds: c.statusIds.filter((x: string) => x !== todo) })).filter((c: any) => c.statusIds.length)
  const on = await call('PATCH', `/api/v1/boards/${b.id}`, { columns, kanbanBacklog: [todo] })
  assert.equal(on.status, 200, JSON.stringify(on.body))
  assert.deepEqual(on.body.kanbanBacklog, [todo])
  const scrum = (await call('POST', '/api/v1/projects/KBL/boards', { name: 'Scrum one', type: 'scrum' })).body
  assert.equal((await call('PATCH', `/api/v1/boards/${scrum.id}`, { kanbanBacklog: [todo] })).status, 400)
  // R2, R3: the board leaves out the backlog's items; the backlog has them and the first column's
  const keys = async (scope: string) => (await call('GET', `/api/v1/boards/${b.id}/issues?scope=${scope}`)).body.items.map((i: any) => i.key).sort()
  assert.ok(!(await keys('board')).includes(planned)); assert.ok((await keys('board')).includes(going))
  assert.deepEqual((await keys('backlog')).filter((k: string) => k === planned || k === going).sort(), [planned, going].sort())
  // R8: a status the project loses leaves the Kanban backlog too
  const { followStatuses } = await import('../src/boards.ts'), { db } = await import('../src/db.ts')
  await followStatuses(db, { id: p.id, key: 'KBL' }, [], [], [todo])
  assert.deepEqual((await call('GET', `/api/v1/boards/${b.id}`)).body.kanbanBacklog, [])
})

test('[0407.R2][0407.R6][0407.R7][0407.R11] the backlog’s panels: open epics with their counts, versions’ counts; an epic’s colour; a Kanban backlog keeps epics off the board', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Panels', key: 'PNL', template: 'scrum' })).status, 201)
  const [board] = (await call('GET', '/api/v1/projects/PNL/boards')).body
  const make = async (b: object) => (await call('POST', '/api/v1/projects/PNL/issues', b)).body
  const epic = await make({ title: 'Checkout', type: 'epic' })
  const v = (await call('POST', '/api/v1/projects/PNL/releases', { name: '1.0' })).body
  const a = await make({ title: 'Pay by card', parentId: epic.id, estimate: 3, fixReleaseIds: [v.id] })
  await make({ title: 'Pay by link', parentId: epic.id })
  await make({ title: 'Loose end', estimate: 2 })
  const done = (await call('GET', '/api/v1/projects/PNL')).body.statuses.find((s: any) => s.category === 'done').id
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done })).status, 200)
  // R2, R7: counts over all the board's work, done included
  const p = (await call('GET', `/api/v1/boards/${board.id}/panels`)).body
  assert.deepEqual(p.epics.map((e: any) => e.key), [epic.key])
  assert.deepEqual([p.epicStats[epic.id].issues, p.epicStats[epic.id].completed, p.epicStats[epic.id].unestimated, p.epicStats[epic.id].estimate, p.epicStats[epic.id].done], [2, 1, 1, 3, 3])
  assert.deepEqual([p.epicStats.none.issues, p.epicStats.none.estimate], [1, 2])
  assert.deepEqual([p.versionStats[v.id].issues, p.versionStats[v.id].completed, p.versionStats.none.issues], [1, 1, 2])
  // R6: Jira's fourteen colours only
  assert.equal((await call('PATCH', `/api/v1/issues/${epic.key}`, { epicColor: 'ghx-label-7' })).body.epicColor, 'ghx-label-7')
  assert.equal((await call('PATCH', `/api/v1/issues/${epic.key}`, { epicColor: 'red' })).status, 400)
  // Jira's Epic Status (spec 0716): apart from the workflow; Mark as Done (Epic Status Done) leaves the panel
  assert.equal(epic.epicStatus, 'To Do')
  assert.equal(a.epicStatus, null)
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { epicStatus: 'Done' })).status, 400)            // epics only
  const moved = (await call('PATCH', `/api/v1/issues/${epic.key}`, { statusId: done })).body
  assert.equal(moved.epicStatus, 'To Do')                                                                        // the workflow leaves it
  assert.deepEqual((await call('GET', `/api/v1/boards/${board.id}/panels`)).body.epics.map((e: any) => e.key), [epic.key])
  const marked = (await call('PATCH', `/api/v1/issues/${epic.key}`, { epicStatus: 'Done' })).body
  assert.deepEqual([marked.epicStatus, marked.statusId], ['Done', done])                                         // and it leaves the workflow
  assert.deepEqual((await call('GET', `/api/v1/boards/${board.id}/panels`)).body.epics, [])
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = PNL AND ${q}`)}`)).body.items.map((i: any) => i.key)
  assert.deepEqual(await jql('"Epic Status" = Done'), [epic.key])
  assert.deepEqual(await jql('epicStatus in ("To Do", "In Progress")'), [])
  assert.equal((await jql('"Epic Status" is empty')).length, 3)
  // a type change: an item made an epic starts at To Do; one that stops being an epic loses it
  const loose = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = PNL AND summary ~ "Loose end"')}`)).body.items[0]
  assert.equal((await call('PATCH', `/api/v1/issues/${loose.key}`, { type: 'epic' })).body.epicStatus, 'To Do')
  assert.equal((await call('PATCH', `/api/v1/issues/${loose.key}`, { type: 'task' })).body.epicStatus, null)
  // R11: a Kanban board with a backlog leaves open epics off the board, and its backlog has them
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Panels K', key: 'PNK', template: 'kanban' })).status, 201)
  const kp = (await call('GET', '/api/v1/projects/PNK')).body
  const [kb] = (await call('GET', '/api/v1/projects/PNK/boards')).body
  const k = (await call('GET', `/api/v1/boards/${kb.id}`)).body
  const todo = kp.statuses.find((s: any) => s.name === 'To do').globalStatusId
  const kepic = (await call('POST', '/api/v1/projects/PNK/issues', { title: 'Big theme', type: 'epic' })).body
  const columns = k.columns.map((c: any) => ({ ...c, statusIds: c.statusIds.filter((x: string) => x !== todo) })).filter((c: any) => c.statusIds.length)
  assert.equal((await call('PATCH', `/api/v1/boards/${kb.id}`, { columns, kanbanBacklog: [todo] })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/issues/${kepic.key}`, { statusId: kp.statuses.find((s: any) => s.name === 'In progress').id })).status, 200)
  const keys = async (scope: string) => (await call('GET', `/api/v1/boards/${kb.id}/issues?scope=${scope}`)).body.items.map((i: any) => i.key)
  assert.ok(!(await keys('board')).includes(kepic.key))
  assert.ok((await keys('backlog')).includes(kepic.key))
})

test('[0410.R1][0410.R2][0410.R9] control chart: cycle time is the time in the chosen columns, every visit; items still there or outside the timeframe are left out', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Control', key: 'CTL', template: 'kanban' })).status, 201)
  const p = (await call('GET', '/api/v1/projects/CTL')).body
  const [board] = (await call('GET', '/api/v1/projects/CTL/boards')).body
  const st = (name: string) => p.statuses.find((s: any) => s.name === name)
  const todo = st('To do'), doing = st('In progress'), done = st('Done')
  const make = async (title: string, type = 'task') => (await call('POST', '/api/v1/projects/CTL/issues', { title, type })).body
  const a = await make('Reworked'), b = await make('Quick'), c = await make('Still going'), old = await make('Long ago'), bug = await make('A bug', 'bug')
  // history written as it would have happened: [hours ago, from, to]
  const history = async (i: any, created: number, moves: [number, any, any][]) => {
    await pool.query(`update issues set created_at = now() - make_interval(hours => $2), status_id = $3 where id = $1`, [i.id, created, moves.at(-1)![2].id])
    for (const [h, from, to] of moves)
      await pool.query(`insert into activity (issue_id, field, from_value, to_value, text, created_at) values ($1, 'statusId', $2, $3, 'Changed status id', now() - make_interval(hours => $4))`, [i.id, from.id, to.id, h])
  }
  await history(a, 100, [[90, todo, doing], [80, doing, done], [50, done, doing], [40, doing, done]])   // 10 h + 10 h in progress
  await history(b, 30, [[20, todo, doing], [15, doing, done]])                                          // 5 h
  await history(c, 30, [[20, todo, doing]])                                                              // still in progress
  await history(old, 2000, [[1900, todo, doing], [1800, doing, done]])                                   // left 75 days ago
  await history(bug, 30, [[10, todo, doing], [9, doing, done]])                                          // 1 h
  const report = async (q: string) => (await call('GET', `/api/v1/boards/${board.id}/reports/control?statuses=${doing.globalStatusId}${q}`)).body
  const r = await report('&days=30')
  assert.deepEqual(r.items.map((i: any) => [i.key, i.minutes]).sort(), [[a.key, 1200], [b.key, 300], [bug.key, 60]].sort())
  assert.equal(r.truncated, false)
  assert.ok(Math.abs(Date.parse(r.items.find((i: any) => i.key === a.key).leftAt) - (Date.now() - 40 * 3600e3)) < 60_000)   // when it last left
  // all time includes the old one; a quick filter narrows (R2)
  assert.equal((await report('')).items.length, 4)
  const k = (await call('GET', `/api/v1/boards/${board.id}`)).body
  const withBugs = await call('PATCH', `/api/v1/boards/${board.id}`, { quickFilters: [...k.quickFilters, { name: 'Bugs', jql: 'type = bug' }] })
  const bugs = withBugs.body.quickFilters.find((f: any) => f.name === 'Bugs').id
  assert.deepEqual((await report(`&quick=${bugs}`)).items.map((i: any) => i.key), [bug.key])
  assert.equal((await call('GET', `/api/v1/boards/${board.id}/reports/control?statuses=`)).status, 400)
})

test('[0701.R1][0701.R2] the announcement banner: saved and audited; signed-in people get it; the login page only when it is Public', { skip }, async () => {
  const pub = async () => JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/auth/config' })).body).announcement
  assert.equal((await call('PUT', '/api/v1/admin/settings/announcement', { text: 'Maintenance on Saturday 10:00 UTC', visibility: 'private' })).status, 200)
  assert.equal((await call('GET', '/api/v1/settings/public', undefined, 'someone.else@x.com')).body.announcement.text, 'Maintenance on Saturday 10:00 UTC')
  assert.equal(await pub(), null)                                                           // Private: not before signing in
  assert.equal((await call('PUT', '/api/v1/admin/settings/announcement', { text: 'Maintenance on Saturday 10:00 UTC', visibility: 'public' })).status, 200)
  const { clearSettingsCache } = await import('../src/settings.ts'); clearSettingsCache()
  assert.equal(await pub(), 'Maintenance on Saturday 10:00 UTC')
  assert.equal((await call('PUT', '/api/v1/admin/settings/announcement', { text: 'x', visibility: 'public' }, 'someone.else@x.com')).status, 403)
  assert.equal((await call('PUT', '/api/v1/admin/settings/announcement', { text: 'x'.repeat(2001), visibility: 'public' })).status, 400)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'settings.announcement.updated' and target = 'Announcement banner'`)).rows.length)
  await call('PUT', '/api/v1/admin/settings/announcement', { text: '', visibility: 'private' }); clearSettingsCache()
  assert.equal(await pub(), null)
})

test('[0702.R1][0702.R2][0702.R3][0702.R4][0702.R5] look and feel: title and colour saved, audited and public; images checked by content and served safely; reset', { skip }, async () => {
  const pub = async () => JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/look-and-feel' })).body)
  assert.deepEqual(await pub(), { siteTitle: 'Strand', showTitle: true, brandColor: '#368727', logo: null, favicon: null, mark: null })
  // R1, R4: saved and audited; a colour too light for white text is refused
  const saved = await call('PUT', '/api/v1/admin/look-and-feel', { siteTitle: 'Acme Work', showTitle: false, brandColor: '#1d4ed8' })
  assert.deepEqual([saved.status, saved.body.brandColor], [200, '#1D4ED8'])
  const light = await call('PUT', '/api/v1/admin/look-and-feel', { siteTitle: 'Acme Work', showTitle: false, brandColor: '#FACC15' })
  assert.equal(light.status, 400); assert.ok(light.body.errors.brandColor)
  assert.equal((await pub()).siteTitle, 'Acme Work')
  assert.ok((await pool.query(`select 1 from audit_log where action = 'look_and_feel.updated'`)).rows.length)
  // R3: a PNG is taken and served as one, with nosniff; SVG and HTML named as an image are refused; size limits
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  assert.equal((await call('PUT', '/api/v1/admin/look-and-feel/logo', { image: png.toString('base64') })).status, 200)
  const url = (await pub()).logo
  assert.match(url, /^\/look-and-feel\/logo\?v=/)
  const img = await app.inject({ method: 'GET', url: `/api/v1${url}` })
  assert.deepEqual([img.statusCode, img.headers['content-type'], img.headers['x-content-type-options']], [200, 'image/png', 'nosniff'])
  assert.ok(img.rawPayload.equals(png))
  for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html><script>alert(1)</script></html>'])
    assert.equal((await call('PUT', '/api/v1/admin/look-and-feel/logo', { image: Buffer.from(bad).toString('base64') })).status, 400)
  const big = Buffer.concat([png, Buffer.alloc(70 * 1024)])
  assert.equal((await call('PUT', '/api/v1/admin/look-and-feel/favicon', { image: big.toString('base64') })).status, 400)
  // not with an access token
  const pat = (await call('POST', '/api/v1/me/tokens', { name: 'look' })).body.token
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/admin/look-and-feel', headers: { authorization: `Bearer ${pat}` } })).statusCode, 403)
  // R5: reset defaults
  assert.deepEqual((await call('DELETE', '/api/v1/admin/look-and-feel')).body, { siteTitle: 'Strand', showTitle: true, brandColor: '#368727', logo: null, favicon: null, mark: null })
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/look-and-feel/logo' })).statusCode, 404)
})

test('[0703.R1][0703.R2][0703.R4] a project’s key changes: its items take the new key, and the old one still finds them in the API, JQL and a board’s filter', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Renamed', key: 'OLDK', template: 'kanban' })).status, 201)
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Neighbour', key: 'NBR', template: 'kanban' })).status, 201)
  const item = (await call('POST', '/api/v1/projects/OLDK/issues', { title: 'Keep finding me' })).body
  const board = (await call('POST', '/api/v1/projects/OLDK/boards', { name: 'Old filter', type: 'kanban', jql: 'project = OLDK' })).body
  await join('OLDK', 'oldk.member@x.com', 'admin')
  // R1: system administrators only; the key must fit and be free
  assert.equal((await call('PATCH', '/api/v1/projects/OLDK', { key: 'NEWK' }, 'oldk.member@x.com')).status, 403)
  assert.equal((await call('PATCH', '/api/v1/projects/OLDK', { key: 'nbr' })).status, 409)
  assert.equal((await call('PATCH', '/api/v1/projects/OLDK', { key: '9BAD' })).status, 400)
  const changed = await call('PATCH', '/api/v1/projects/OLDK', { key: 'newk' })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.deepEqual([changed.body.key, changed.body.keys], ['NEWK', ['NEWK', 'OLDK']])
  // R2: the item has the new key; the old key finds it and the project everywhere
  const n = item.key.split('-')[1]
  assert.equal((await call('GET', `/api/v1/issues/${item.key}`)).body.key, `NEWK-${n}`)
  assert.equal((await call('GET', '/api/v1/projects/OLDK')).body.key, 'NEWK')
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(q)}`)).body.items.map((i: any) => i.key)
  assert.deepEqual(await jql('project = OLDK'), [`NEWK-${n}`])
  assert.deepEqual(await jql(`key = OLDK-${n}`), [`NEWK-${n}`])
  assert.deepEqual((await call('GET', `/api/v1/search?q=OLDK-${n}&resolution=all`)).body.items.map((i: any) => i.key), [`NEWK-${n}`])
  assert.deepEqual((await call('GET', `/api/v1/boards/${board.id}/issues`)).body.items.map((i: any) => i.key), [`NEWK-${n}`])
  // nobody else can take the old key; the project can go back to it
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Thief', key: 'OLDK', template: 'kanban' })).status, 409)
  assert.equal((await call('PATCH', '/api/v1/projects/NBR', { key: 'OLDK' })).status, 409)
  const back = await call('PATCH', '/api/v1/projects/NEWK', { key: 'OLDK' })
  assert.deepEqual([back.status, back.body.keys], [200, ['OLDK', 'NEWK']])
  assert.ok((await pool.query(`select 1 from audit_log where action = 'project.key_changed'`)).rows.length)
})

test('[0703.R5][0703.R6][0703.R7][0703.R8] project categories and avatars: made by admins, filtered by JQL and the projects list; editing details keeps the category', { skip }, async () => {
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Categorised', key: 'CAT', template: 'kanban' })).status, 201)
  const item = (await call('POST', '/api/v1/projects/CAT/issues', { title: 'In a category' })).body
  // R5: system administrators make categories, names unique ignoring case
  const c = (await call('POST', '/api/v1/admin/project-categories', { name: 'Payments', description: 'Money moves' })).body
  assert.equal((await call('POST', '/api/v1/admin/project-categories', { name: 'payments' })).status, 409)
  assert.equal((await call('POST', '/api/v1/admin/project-categories', { name: 'X' }, 'someone.else@x.com')).status, 403)
  await join('CAT', 'cat.admin@x.com', 'admin')
  assert.equal((await call('PATCH', '/api/v1/projects/CAT', { categoryId: c.id }, 'cat.admin@x.com')).status, 403)
  assert.deepEqual((await call('PATCH', '/api/v1/projects/CAT', { categoryId: c.id })).body.category, { id: c.id, name: 'Payments' })
  // R7: editing other details, or the avatar, keeps it
  assert.equal((await call('PATCH', '/api/v1/projects/CAT', { name: 'Categorised again', description: 'x', color: '#123456' }, 'cat.admin@x.com')).body.category.name, 'Payments')
  // R6: JQL and the projects list
  const jql = async (q: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(q)}`)).body.items.map((i: any) => i.key)
  assert.deepEqual(await jql('category = "payments"'), [item.key])
  assert.ok(!(await jql('project = CAT AND category is EMPTY')).length)
  assert.deepEqual((await call('GET', `/api/v1/projects/search?category=${c.id}`)).body.items.map((p: any) => [p.key, p.category.name]), [['CAT', 'Payments']])
  assert.equal((await call('GET', '/api/v1/project-categories')).body.find((x: any) => x.id === c.id).projects, 1)
  // R8: a project admin sets an avatar: checked by content, served as an image
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const set = await call('PUT', '/api/v1/projects/CAT/avatar', { image: png.toString('base64') }, 'cat.admin@x.com')
  assert.equal(set.status, 200)
  assert.match(set.body.avatar, /^\/project-avatars\/[0-9a-f-]{36}\/[0-9a-f]{64}$/)
  const img = await app.inject({ method: 'GET', url: `/api/v1${set.body.avatar}` })                    // no sign-in: an <img> can't send one
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1${set.body.avatar.replace(/[0-9a-f]{64}$/, '0'.repeat(64))}` })).statusCode, 404)   // only at its own hash
  assert.deepEqual([img.statusCode, img.headers['content-type'], img.headers['x-content-type-options']], [200, 'image/png', 'nosniff'])
  assert.equal((await call('PUT', '/api/v1/projects/CAT/avatar', { image: Buffer.from('<svg/>').toString('base64') }, 'cat.admin@x.com')).status, 400)
  assert.equal((await call('GET', '/api/v1/projects/CAT')).body.category.name, 'Payments')     // R7 again, after the avatar
  // deleting the category leaves the project without one
  assert.equal((await call('DELETE', `/api/v1/admin/project-categories/${c.id}`)).status, 204)
  assert.equal((await call('GET', '/api/v1/projects/CAT')).body.category, null)
  assert.deepEqual(await jql('project = CAT AND category is EMPTY'), [item.key])
})

test('[0704.R1][0704.R2][0704.R3][0704.R4][0704.R5][0704.R6] anonymising a deactivated person: refused while active; the preview; transfers; their name gone everywhere; running it again is harmless', { skip }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const { aliasOf } = await import('../src/anonymise.ts')
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Leaver', key: 'LVR', template: 'kanban' })).status, 201)
  await join('LVR', 'lena.leaver@x.com', 'admin'); await join('LVR', 'mo.mate@x.com')
  const id = async (w: string) => (await call('GET', '/api/v1/me', undefined, w)).body.id as string
  const lena = await id('lena.leaver@x.com'), mo = await id('mo.mate@x.com')
  await pool.query(`update users set name = 'Lena Leaver', title = 'Engineer' where id = $1`, [lena])
  // her traces: she leads the project and a component, reports and comments, is mentioned, owns views, a group and a token
  assert.equal((await call('PATCH', '/api/v1/projects/LVR', { leadId: lena })).status, 200)
  const comp = (await call('POST', '/api/v1/projects/LVR/components', { name: 'Billing', leadId: lena })).body
  const item = (await call('POST', '/api/v1/projects/LVR/issues', { title: 'Hers', description: 'Ask @Lena Leaver first' }, 'lena.leaver@x.com')).body
  await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'Thanks @Lena Leaver, done' }, 'mo.mate@x.com')
  await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'My own note' }, 'lena.leaver@x.com')
  const shared = (await call('POST', '/api/v1/views', { name: 'Team view', shared: true, filters: { q: '' } }, 'lena.leaver@x.com')).body
  await call('POST', '/api/v1/views', { name: 'Just mine', shared: false, filters: { q: '' } }, 'lena.leaver@x.com')
  const mosView = (await call('POST', '/api/v1/views', { name: 'Lena’s work', shared: false, filters: { jql: `assignee = "lena.leaver@x.com"` } }, 'mo.mate@x.com')).body
  const group = (await call('POST', '/api/v1/groups', { name: 'lena-only' }, 'lena.leaver@x.com')).body
  await pool.query('delete from group_owners where group_id = $1 and user_id <> $2', [group.id, lena])
  assert.equal((await call('POST', '/api/v1/me/tokens', { name: 'leaver' }, 'lena.leaver@x.com')).status, 201)
  // R1: active people are refused; tokens can't do it
  assert.equal((await call('GET', `/api/v1/admin/users/${lena}/anonymise`)).status, 409)
  assert.equal((await call('POST', '/api/v1/admin/users/bulk', { userIds: [lena], action: 'deactivate' })).status, 200)
  // R4: the preview
  const pv = (await call('GET', `/api/v1/admin/users/${lena}/anonymise`)).body
  assert.equal(pv.alias, aliasOf(lena))
  assert.deepEqual([pv.transfer.projectsLed.map((p: any) => p.key), pv.transfer.componentsLed, pv.transfer.sharedViews, pv.transfer.groupsAloneOwned.map((g: any) => g.name)], [['LVR'], 1, 1, ['lena-only']])
  assert.deepEqual([pv.change.comments, pv.change.reported, pv.change.mentions, pv.remove.privateViews], [1, 1, 2, 1])
  assert.deepEqual(pv.actionsRequired.map((v: any) => v.id), [mosView.id])
  // R5: someone must take over what she leads and owns
  assert.equal((await call('POST', `/api/v1/admin/users/${lena}/anonymise`, {})).status, 400)
  const started = await call('POST', `/api/v1/admin/users/${lena}/anonymise`, { transferTo: mo })
  assert.equal(started.status, 202)
  await runJobs()
  assert.equal((await pool.query('select status from jobs where id = $1', [started.body.jobId])).rows[0].status, 'done')
  // R3: her row; what was only hers is gone; her work shows the alias
  const alias = aliasOf(lena)
  const [u] = (await pool.query('select name, email, username, title, entra_oid, active, anonymised_at from users where id = $1', [lena])).rows
  assert.deepEqual([u.name, u.username, u.title, u.entra_oid, u.active, !!u.anonymised_at], [alias, null, null, null, false, true])
  assert.match(u.email, /^anonymised-.*@invalid$/)
  for (const t of ['personal_access_tokens', 'user_sessions', 'stars', 'group_owners'])
    assert.equal((await pool.query(`select count(*)::int as n from ${t} where user_id = $1`, [lena])).rows[0].n, 0, t)
  const after = (await call('GET', `/api/v1/issues/${item.key}?expand=comments`)).body
  assert.equal(after.description, `Ask @${alias} first`)
  const bodies = (await pool.query('select body from comments where issue_id = $1 order by created_at', [item.id])).rows.map(r => r.body)
  assert.deepEqual(bodies, [`Thanks @${alias}, done`, 'My own note'])
  assert.equal((await pool.query(`select count(*)::int as n from audit_log where actor = 'lena.leaver@x.com' or target = 'lena.leaver@x.com'`)).rows[0].n, 0)
  assert.equal((await pool.query(`select count(*)::int as n from audit_log where coalesce(before::text, '') || coalesce(after::text, '') like '%lena.leaver@x.com%'`)).rows[0].n, 0)
  // the audit log is still append-only outside an anonymisation, and even inside one its ids and actions can't change
  await assert.rejects(pool.query(`update audit_log set target = 'x' where id = (select id from audit_log limit 1)`), /can only be added to/)
  await assert.rejects(pool.query(`delete from audit_log where id = (select id from audit_log limit 1)`), /can only be added to/)
  const c = await pool.connect()
  try {
    await c.query('begin'); await c.query(`select set_config('strand.anonymising', 'on', true)`)
    await assert.rejects(c.query(`update audit_log set action = 'forged' where id = (select id from audit_log limit 1)`), /can only be added to/)
  } finally { await c.query('rollback'); c.release() }
  // R5: transfers
  assert.equal((await call('GET', '/api/v1/projects/LVR')).body.leadId, mo)
  assert.equal((await pool.query('select lead_id from components where id = $1', [comp.id])).rows[0].lead_id, mo)
  assert.equal((await pool.query('select owner_id from saved_views where id = $1', [shared.id])).rows[0].owner_id, mo)
  assert.equal((await pool.query(`select count(*)::int as n from saved_views where owner_id = $1`, [lena])).rows[0].n, 0)
  assert.ok((await pool.query('select 1 from group_owners where group_id = $1 and user_id = $2', [group.id, mo])).rows.length)
  // R6: audited, and running it again changes nothing more
  assert.ok((await pool.query(`select 1 from audit_log where action = 'user.anonymised' and target_id = $1`, [lena])).rows.length)
  const again = await call('POST', `/api/v1/admin/users/${lena}/anonymise`, { transferTo: mo })
  assert.equal(again.status, 202); await runJobs()
  assert.equal((await pool.query('select name from users where id = $1', [lena])).rows[0].name, alias)
})

test('[0705.R1][0705.R2][0705.R3][0705.R4][0705.R5][0705.R6][0705.R7][0705.R8] outgoing webhooks: Jira-shaped events, signed, filtered by JQL, retried, never to the server’s own network', { skip }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const { createHmac } = await import('node:crypto')
  process.env.STRAND_SECRET_KEY ??= 'a-secret-key-for-tests-only-0705-xxxxxxxx'          // secrets are kept encrypted
  // a stand-in receiver; it answers 500 while `failing`
  const got: { url: string; headers: any; body: string }[] = []
  let failing = false
  const receiver = createServer((req, res) => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { got.push({ url: req.url!, headers: req.headers, body: b }); res.writeHead(failing ? 500 : 200).end('ok') }) })
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
  const add = (b: object) => call('POST', '/api/v1/admin/webhooks', { name: 'CI', ...b })
  // R2: http and private addresses only when the server allows them
  for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://localhost/x', 'https://user:pw@hooks.example.com/x'])
    assert.equal((await add({ url })).status, 400, url)
  process.env.STRAND_WEBHOOK_HTTP_HOSTS = '127.0.0.1'; process.env.STRAND_WEBHOOK_PRIVATE_HOSTS = '127.0.0.1'
  try {
    // R1, R4: a bad JQL is refused; a filtered webhook for issue events
    assert.equal((await add({ url: `${base}/x`, jql: 'project = = WHK' })).status, 400)
    assert.equal((await call('POST', '/api/v1/projects', { name: 'Hooked', key: 'WHK', template: 'kanban' })).status, 201)
    const made = await add({ url: `${base}/jira/{issue.key}?p={project.key}`, events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'], jql: 'project = WHK AND type = bug' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const hook = made.body
    assert.match(hook.secret, /^whsec_/)
    assert.equal((await call('GET', `/api/v1/admin/webhooks/${hook.id}`)).body.secret, undefined)            // shown once
    // R3, R5: a matching bug is created then updated: Jira's body, the changelog, the signature, the URL filled in
    const bug = (await call('POST', '/api/v1/projects/WHK/issues', { title: 'Broken', type: 'bug' })).body
    await call('POST', '/api/v1/projects/WHK/issues', { title: 'Not a bug', type: 'task' })                    // filtered out (R4)
    await call('PATCH', `/api/v1/issues/${bug.key}`, { title: 'Broken badly' })
    await call('POST', `/api/v1/issues/${bug.key}/comments`, { body: 'Seen it' })
    await runJobs(50); await runJobs(50)
    const bodies = got.map(g => JSON.parse(g.body))
    // a comment fires jira:issue_updated too, as Jira's (spec 0715 R2)
    assert.deepEqual(bodies.map(b => b.webhookEvent), ['jira:issue_created', 'jira:issue_updated', 'comment_created', 'jira:issue_updated'])
    assert.equal(got[0]!.url, `/jira/${bug.key}?p=WHK`)
    assert.deepEqual([bodies[0].issue.key, bodies[0].issue.fields.summary, bodies[0].issue.fields.issuetype.name, bodies[0].user.emailAddress], [bug.key, 'Broken', 'Bug', 'owner@x.com'])
    assert.deepEqual(bodies[1].changelog.items.map((i: any) => [i.field, i.fromString, i.toString]), [['summary', 'Broken', 'Broken badly']])
    assert.equal(bodies[2].comment.body, 'Seen it')
    assert.equal(got[0]!.headers['x-strand-signature'], `sha256=${createHmac('sha256', hook.secret).update(got[0]!.body).digest('hex')}`)
    assert.equal(got[0]!.headers['x-strand-event'], 'jira:issue_created')
    // R6, R7: a failing receiver is retried, then shown failed; redeliver sends it again
    failing = true; got.length = 0
    await call('PATCH', `/api/v1/issues/${bug.key}`, { title: 'Broken again' })
    await runJobs(50)
    const callsNow = async () => (await call('GET', `/api/v1/admin/webhooks/${hook.id}/calls`)).body
    let last = (await callsNow())[0]
    assert.deepEqual([last.event, last.state, last.statusCode], ['jira:issue_updated', 'retrying', 500])
    for (let n = 0; n < 6; n++) { await pool.query(`update jobs set run_at = now() where kind = 'webhook.deliver' and status = 'queued'`); await runJobs(50) }
    last = (await callsNow())[0]
    assert.deepEqual([last.state, last.attempts], ['failed', 6])
    failing = false
    assert.equal((await call('POST', `/api/v1/admin/webhooks/${hook.id}/calls/${last.id}/redeliver`)).status, 202)
    await runJobs(50)
    assert.equal((await callsNow())[0].state, 'delivered')
    // R7: ping; R8: disabled sends nothing (ping still works)
    await call('PUT', `/api/v1/admin/webhooks/${hook.id}`, { name: 'CI', url: hook.url, events: hook.events, jql: hook.jql, enabled: false })
    got.length = 0
    await call('PATCH', `/api/v1/issues/${bug.key}`, { title: 'Quiet now' }); await runJobs(50); await runJobs(50)
    assert.equal(got.length, 0)
    assert.equal((await call('POST', `/api/v1/admin/webhooks/${hook.id}/test`)).status, 202); await runJobs(50)
    assert.equal(JSON.parse(got[0]!.body).webhookEvent, 'ping')
    // Exclude body; regenerating the secret changes the signature
    const quiet = (await add({ url: `${base}/nobody`, events: ['project_updated'], excludeBody: true })).body
    const fresh = (await call('POST', `/api/v1/admin/webhooks/${quiet.id}/secret`)).body.secret
    got.length = 0
    await call('PATCH', '/api/v1/projects/WHK', { description: 'Changed' }); await runJobs(50); await runJobs(50)
    const q = got.find(g => g.url === '/nobody')!
    assert.equal(q.body, '')
    assert.equal(q.headers['x-strand-signature'], `sha256=${createHmac('sha256', fresh).update('').digest('hex')}`)
    assert.ok((await pool.query(`select 1 from audit_log where action = 'webhook.created'`)).rows.length)
  } finally {
    delete process.env.STRAND_WEBHOOK_HTTP_HOSTS; delete process.env.STRAND_WEBHOOK_PRIVATE_HOSTS
    await pool.query('delete from webhooks'); (await import('../src/webhooks.ts')).forgetWebhookCache()
    receiver.close()
  }
})

test('[0715.R1][0715.R2][0715.R3][0715.R4][0715.R5][0715.R6][0715.R7][0715.R8] webhooks: every Jira DC event, in Jira’s representations; the post function; Jira’s webhook REST', { skip, timeout: 60_000 }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  const { clearSettingsCache } = await import('../src/settings.ts')
  process.env.STRAND_SECRET_KEY ??= 'a-secret-key-for-tests-only-0705-xxxxxxxx'
  const got: { url: string; body: any }[] = []
  const receiver = createServer((req, res) => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { got.push({ url: req.url!, body: b ? JSON.parse(b) : null }); res.writeHead(200).end('ok') }) })
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
  process.env.STRAND_WEBHOOK_HTTP_HOSTS = '127.0.0.1'; process.env.STRAND_WEBHOOK_PRIVATE_HOSTS = '127.0.0.1'
  const flush = async () => { await runJobs(100); await runJobs(100) }
  const take = async () => { await flush(); const out = got.splice(0); return out }
  const of = (calls: { body: any }[], e: string) => calls.filter(c => c.body?.webhookEvent === e).map(c => c.body)
  try {
    assert.equal((await call('POST', '/api/v1/projects', { name: 'Jira shaped', key: 'WHJ', template: 'scrum' })).status, 201)
    const proj = (await call('GET', '/api/v1/projects/WHJ')).body
    const me = (await call('GET', '/api/v1/me')).body
    const v1 = (await call('POST', '/api/v1/projects/WHJ/releases', { name: '1.0' })).body
    const v2 = (await call('POST', '/api/v1/projects/WHJ/releases', { name: '1.1' })).body
    // R1, R8: a webhook for every event; Jira's URL variables, both spellings
    const hook = (await call('POST', '/api/v1/admin/webhooks', { name: 'All', url: `${base}/all?m={mergedVersion.id}&u=\${modifiedUser.key}` })).body
    assert.ok(hook.id)
    const item = (await call('POST', '/api/v1/projects/WHJ/issues', { title: 'Shaped', type: 'story', estimate: 5, labels: ['api'], fixReleaseIds: [v1.id], dueDate: '2026-12-01' })).body
    let calls = await take()
    // R3, R4, R5: the created item as Jira's REST returns it
    const created = of(calls, 'jira:issue_created')[0]
    const f = created.issue.fields
    assert.equal(created.issue_event_type_name, 'issue_created')
    assert.deepEqual([f.issuetype.name, f.issuetype.id, f.status.statusCategory.key, f.priority.name, f.labels, f.duedate], ['Story', 'story', 'new', 'Medium', ['api'], '2026-12-01'])
    assert.match(f.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+0000$/)
    assert.deepEqual([f.fixVersions[0].name, f.project.key, f.project.projectTypeKey, f.customfield_10106, f.reporter.key], ['1.0', 'WHJ', 'software', 5, me.id])
    assert.deepEqual([created.user.name, created.user.displayName, created.user.active], [me.email, me.name, true])
    assert.equal(calls[0]!.url, `/all?m=&u=${me.id}`)
    // R3: the assignee alone is issue_assigned; a move issue_generic; the changelog in Jira's names
    await join('WHJ', 'whj.dev@x.com')
    const dev = (await call('GET', '/api/v1/me', undefined, 'whj.dev@x.com')).body
    await call('PATCH', `/api/v1/issues/${item.key}`, { assigneeId: dev.id })
    const prog = proj.statuses.find((s: any) => s.category === 'in-progress')
    await call('PATCH', `/api/v1/issues/${item.key}`, { statusId: prog.id })
    await call('PATCH', `/api/v1/issues/${item.key}`, { estimate: 8, fixReleaseIds: [v2.id], timeEstimate: 90 })
    const ups = of(await take(), 'jira:issue_updated')
    assert.deepEqual(ups.map(u => u.issue_event_type_name), ['issue_assigned', 'issue_generic', 'issue_updated'])
    assert.deepEqual(ups[0].changelog.items, [{ field: 'assignee', fieldtype: 'jira', from: null, fromString: null, to: dev.email, toString: dev.name }])
    assert.deepEqual(ups[1].changelog.items.map((i: any) => [i.field, i.fromString, i.toString]), [['status', proj.statuses[0].name, prog.name]])
    // (a first original estimate starts the remaining one, as Jira's)
    assert.deepEqual(ups[2].changelog.items.map((i: any) => [i.field, i.fieldtype, i.from, i.fromString, i.to, i.toString]), [
      ['Story Points', 'custom', '5', '5', '8', '8'], ['timeoriginalestimate', 'jira', null, null, '5400', '5400'],
      ['Fix Version', 'jira', v1.id, '1.0', null, null], ['Fix Version', 'jira', null, null, v2.id, '1.1'], ['timeestimate', 'jira', null, null, '5400', '5400']])
    assert.deepEqual([ups[2].issue.fields.timeoriginalestimate, ups[2].issue.fields.assignee.key, ups[2].issue.fields.status.statusCategory.key], [5400, dev.id, 'indeterminate'])
    // R2: comments and work logs fire jira:issue_updated (and work log changes jira:worklog_updated), as Jira's
    const c = (await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'Looks right' })).body
    calls = await take()
    assert.deepEqual([of(calls, 'comment_created')[0].comment.body, of(calls, 'comment_created')[0].comment.author.key, of(calls, 'comment_created')[0].issue.key], ['Looks right', me.id, item.key])
    assert.deepEqual([of(calls, 'jira:issue_updated')[0].issue_event_type_name, of(calls, 'jira:issue_updated')[0].comment.id], ['issue_commented', c.id])
    await call('DELETE', `/api/v1/comments/${c.id}`)
    assert.equal(of(await take(), 'jira:issue_updated')[0].issue_event_type_name, 'issue_comment_deleted')
    const w = (await call('POST', `/api/v1/issues/${item.key}/worklogs`, { minutes: 30, date: '2026-11-10' })).body
    calls = await take()
    assert.deepEqual([of(calls, 'worklog_created')[0].worklog.timeSpentSeconds, of(calls, 'worklog_created')[0].worklog.timeSpent, of(calls, 'jira:issue_updated')[0].issue_event_type_name], [1800, '30m', 'issue_worklogged'])
    await call('PATCH', `/api/v1/worklogs/${w.id}`, { minutes: 60 })
    calls = await take()
    const wu = of(calls, 'jira:worklog_updated')[0]
    assert.deepEqual([wu.issue_event_type_name, wu.worklog.timeSpentSeconds, wu.issue.fields.timespent, of(calls, 'worklog_updated').length], ['issue_worklog_updated', 3600, 3600, 1])
    // R5: Jira Software's field ids come from System settings
    assert.equal((await call('PUT', '/api/v1/admin/settings/webhooks', { fieldIds: { sprint: 'customfield_10100', epicLink: 'customfield_10101', epicStatus: 'customfield_10102', epicName: 'customfield_10103', epicColour: 'customfield_10104', rank: 'customfield_10105', storyPoints: 'customfield_20002', flagged: 'customfield_10107' } })).status, 200)
    clearSettingsCache()
    await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'Shaped again' })
    assert.equal(of(await take(), 'jira:issue_updated')[0].issue.fields.customfield_20002, 8)
    // R2, R4: a sprint update carries its oldValue; a merge deletes the merged version with the one it went into
    const sp = (await call('POST', '/api/v1/projects/WHJ/sprints', { name: 'S1' })).body
    await take()
    await call('PATCH', `/api/v1/projects/WHJ/sprints/${sp.id}`, { name: 'S1 renamed' })
    const su = of(await take(), 'sprint_updated')[0]
    // Jira Software's Sprint field: the sprint as Jira prints it, with its board
    await call('PATCH', `/api/v1/issues/${item.key}`, { sprintId: sp.id }); await take()
    await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'In a sprint' })
    const inSprint = of(await take(), 'jira:issue_updated')[0].issue.fields
    assert.match(inSprint[Object.keys(inSprint).find(k => String(inSprint[k]).includes('greenhopper'))!][0], new RegExp(`\\[id=${sp.id},rapidViewId=[0-9a-f-]{36},state=FUTURE,name=S1 renamed,`))
    assert.deepEqual([su.sprint.name, su.oldValue.name, su.sprint.state], ['S1 renamed', 'S1', 'future'])
    await call('POST', `/api/v1/projects/WHJ/releases/${v2.id}/merge`, { from: [v1.id] })
    calls = await take()
    const del = calls.find(x => x.body.webhookEvent === 'jira:version_deleted')!
    assert.deepEqual([del.body.version.name, del.body.mergedTo.name, del.url.startsWith(`/all?m=${v2.id}`)], ['1.0', '1.1', true])
    // R2: a board's name is board_updated; its columns are board_configuration_changed
    const [board] = (await call('GET', '/api/v1/projects/WHJ/boards')).body
    await call('PATCH', `/api/v1/boards/${board.id}`, { name: 'Renamed board' })
    assert.deepEqual((await take()).map(x => x.body.webhookEvent).filter(e => e.startsWith('board')), ['board_updated'])
    const full = (await call('GET', `/api/v1/boards/${board.id}`)).body
    await call('PATCH', `/api/v1/boards/${board.id}`, { columns: full.columns.slice().reverse() })
    calls = await take()
    const bc = of(calls, 'board_configuration_changed')[0]
    assert.deepEqual([bc.board.name, bc.configuration.columnConfig.columns.length], ['Renamed board', full.columns.length])
    // R2: switching attachments is Jira's option_attachments_changed
    const att = (await call('GET', '/api/v1/admin/settings')).body.find((s: any) => s.key === 'attachments').value
    await call('PUT', '/api/v1/admin/settings/attachments', { ...att, enabled: !att.enabled })
    assert.equal(of(await take(), 'option_attachments_changed')[0].property.key, 'jira.option.allowattachments')
    await call('PUT', '/api/v1/admin/settings/attachments', att); clearSettingsCache(); await take()
    // R6: a transition's post function sends to its webhook, whatever that webhook subscribes to, with Jira's transition
    const post = (await call('POST', '/api/v1/admin/webhooks', { name: 'Post function', url: `${base}/post`, events: ['project_deleted'] })).body
    const done = proj.statuses.find((s: any) => s.category === 'done')
    const [t] = (await pool.query(`select id, name from transitions where project_id = $1 and to_id = $2 and (from_ids is null or $3 = any(from_ids))
      and (type_keys is null or 'story' = any(type_keys)) order by id limit 1`, [proj.id, done.id, prog.id])).rows   // the one the move uses
    await pool.query(`update transitions set rules = $2 where id = $1`, [t.id, JSON.stringify({ actions: [{ kind: 'webhook', webhookId: post.id }] })])
    const moved = await call('PATCH', `/api/v1/issues/${item.key}`, { statusId: done.id })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    const fired = (await take()).filter(x => x.url === '/post').map(x => x.body)
    assert.equal(fired.length, 1)
    assert.deepEqual([fired[0].webhookEvent, fired[0].issue_event_type_name, fired[0].transition.transitionName, fired[0].transition.from_status, fired[0].transition.to_status],
      ['jira:issue_updated', 'issue_generic', t.name, prog.name, done.name])
    assert.ok(fired[0].transition.workflowName)
    // R7: Jira's webhook REST, Jira 9's and Jira 10's shapes; system admins only
    const made = await call('POST', '/rest/webhooks/1.0/webhook', { name: 'From Jira', url: `${base}/jira9`, events: ['jira:issue_created'], filters: { 'issue-related-events-section': 'project = WHJ' }, excludeBody: false })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual([made.body.filters['issue-related-events-section'], made.body.enabled, made.body.lastUpdatedUser], ['project = WHJ', true, me.email])
    assert.match(made.body.secret, /^whsec_/)
    assert.ok((await call('GET', '/rest/webhooks/1.0/webhook')).body.some((x: any) => x.id === made.body.id))
    const changed = (await call('PUT', `/rest/webhooks/1.0/webhook/${made.body.id}`, { name: 'From Jira 10', url: `${base}/jira10`, events: ['jira:issue_created'], configuration: { FILTERS: '', EXCLUDE_BODY: 'true' }, active: false })).body
    assert.deepEqual([changed.name, changed.excludeBody, changed.enabled, changed.configuration.EXCLUDE_BODY], ['From Jira 10', true, false, 'true'])
    assert.equal((await call('GET', '/rest/webhooks/1.0/webhook', undefined, 'whj.dev@x.com')).status, 403)
    assert.equal((await call('POST', '/rest/webhooks/1.0/webhook', { name: 'x', url: `${base}/x`, events: ['not_an_event'] })).status, 400)
    assert.equal((await call('DELETE', `/rest/webhooks/1.0/webhook/${made.body.id}`)).status, 204)
    assert.equal((await call('GET', `/rest/webhooks/1.0/webhook/${made.body.id}`)).status, 404)
  } finally {
    delete process.env.STRAND_WEBHOOK_HTTP_HOSTS; delete process.env.STRAND_WEBHOOK_PRIVATE_HOSTS
    await pool.query('delete from webhooks'); (await import('../src/webhooks.ts')).forgetWebhookCache()
    await call('PUT', '/api/v1/admin/settings/webhooks', { fieldIds: { sprint: 'customfield_10100', epicLink: 'customfield_10101', epicStatus: 'customfield_10102', epicName: 'customfield_10103', epicColour: 'customfield_10104', rank: 'customfield_10105', storyPoints: 'customfield_10106', flagged: 'customfield_10107' } })
    clearSettingsCache()
    receiver.close()
  }
})

test('[0501.R1][0501.R2][0501.R3][0501.R4][0501.R5][0501.R6][0501.R7][0501.R8] moving work between projects: the preview, statuses, versions and fields by name, a new key while the old ones keep working', { skip, timeout: 60_000 }, async () => {
  for (const [name, key, template] of [['Move from', 'MVA', 'scrum'], ['Move to', 'MVB', 'scrum'], ['Kanban dest', 'MVK', 'kanban']]) await call('POST', '/api/v1/projects', { name, key, template })
  await join('MVA', 'mv.member@x.com', 'member'); await join('MVA', 'mv.viewer@x.com', 'viewer'); await join('MVB', 'mv.viewer@x.com', 'viewer')
  await join('MVA', 'mv.only.a@x.com', 'member')
  const a = (await call('GET', '/api/v1/projects/MVA')).body, b = (await call('GET', '/api/v1/projects/MVB')).body
  const va = (await call('POST', '/api/v1/projects/MVA/releases', { name: '2.0' })).body
  await call('POST', '/api/v1/projects/MVA/releases', { name: 'Only in A' })
  const vb = (await call('POST', '/api/v1/projects/MVB/releases', { name: '2.0' })).body
  const ca = (await call('POST', '/api/v1/projects/MVA/components', { name: 'API' })).body
  const cb = (await call('POST', '/api/v1/projects/MVB/components', { name: 'api' })).body
  const fa = (await call('POST', '/api/v1/projects/MVA/fields', { name: 'Team', kind: 'text' })).body
  const fb = (await call('POST', '/api/v1/projects/MVB/fields', { name: 'Team', kind: 'text' })).body
  const fOnlyA = (await call('POST', '/api/v1/projects/MVA/fields', { name: 'Budget', kind: 'number' })).body
  const only = (await call('GET', '/api/v1/me', undefined, 'mv.only.a@x.com')).body
  const sprint = (await call('POST', '/api/v1/projects/MVA/sprints', { name: 'A1' })).body
  const prog = a.statuses.find((s: any) => s.category === 'in-progress')
  const item = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'Travels', type: 'story', fixReleaseIds: [va.id], componentIds: [ca.id], sprintId: sprint.id,
    assigneeId: only.id, labels: ['keep'], estimate: 3, custom: { [fa.id]: 'Core', [fOnlyA.id]: 9 } })).body
  await call('PATCH', `/api/v1/issues/${item.key}`, { statusId: prog.id })
  const sub = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'Its sub-item', type: 'task', parentId: item.id })).body
  await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'Comes along' })
  const move = (key: string, body: object, who?: string) => call('POST', `/api/v1/issues/${key}/move`, body, who)
  // R1, R2: who and what
  assert.equal((await move(item.key, { projectKey: 'MVB' }, 'mv.viewer@x.com')).status, 403)          // no Move issues in the source
  assert.equal((await move(item.key, { projectKey: 'MVB' }, 'mv.member@x.com')).status, 404)          // can't see the target
  assert.equal((await move(item.key, { projectKey: 'MVA' })).status, 400)                             // same project
  assert.equal((await move(sub.key, { projectKey: 'MVB' })).status, 400)                              // a sub-item moves with its parent
  // R6: the preview changes nothing
  const dry = (await move(item.key, { projectKey: 'MVB', dryRun: true })).body
  assert.deepEqual(dry.items.map((x: any) => x.key), [item.key, sub.key])
  const fields = (x: any) => Object.fromEntries(x.changes.map((c: any) => [c.field, [c.from, c.to]]))
  const pre = fields(dry.items[0])
  assert.deepEqual([pre.Project, pre.Status, pre['Fix versions'], pre.Components, pre.Sprint, pre.Budget, pre.Assignee[1]], [['MVA', 'MVB'], undefined, undefined, ['API', 'api'], ['A1', null], [9, null], null])   // components match by name, whatever the case
  assert.equal((await call('GET', `/api/v1/issues/${item.key}`)).body.projectId, a.id)
  // R3, R4, R5: the move
  const moved = (await move(item.key, { projectKey: 'MVB' })).body
  assert.match(moved.key, /^MVB-\d+$/)
  assert.deepEqual([moved.projectId, moved.statusId, moved.fixReleaseIds, moved.componentIds, moved.sprintId, moved.assigneeId, moved.labels, moved.estimate, moved.custom],
    [b.id, b.statuses.find((s: any) => s.name === prog.name).id, [vb.id], [cb.id], null, null, ['keep'], 3, { [fb.id]: 'Core' }])
  assert.equal((await call('GET', `/api/v1/issues/${moved.key}`)).body.comments.length, 1)
  const movedSub = (await call('GET', `/api/v1/issues/${sub.key}`)).body
  assert.deepEqual([movedSub.projectId, movedSub.parentId, movedSub.key.startsWith('MVB-')], [b.id, item.id, true])
  // R5: the old key opens it, and finds it in JQL and search
  assert.equal((await call('GET', `/api/v1/issues/${item.key}`)).body.key, moved.key)
  const jql = (await call('GET', `/api/v1/search?jql=${encodeURIComponent(`key = ${item.key}`)}`)).body.items.map((i: any) => i.key)
  assert.deepEqual(jql, [moved.key])
  assert.ok((await call('GET', `/api/v1/search?q=${item.key}`)).body.items.some((i: any) => i.key === moved.key))
  // a new item in MVA never takes the old number; moved again, both earlier keys still open it
  const fresh = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'New one' })).body
  assert.notEqual(fresh.key, item.key)
  const kanbanStatus = (await call('GET', '/api/v1/projects/MVK')).body.statuses[0].id
  const again = (await move(moved.key, { projectKey: 'MVK', statusId: kanbanStatus })).body
  for (const k of [item.key, moved.key]) assert.equal((await call('GET', `/api/v1/issues/${k}`)).body.key, again.key)
  // R8: history and webhook changelog
  const hist = (await call('GET', `/api/v1/issues/${again.key}`)).body.activity ?? (await pool.query(`select text from activity where issue_id = $1 and field = 'key' order by created_at`, [item.id])).rows
  assert.ok(JSON.stringify(hist).includes(`Moved from ${moved.key}`))
  // strand: a security level is the source project's, so a move clears it
  const lvl = (await call('POST', '/api/v1/projects/MVA/security-levels', { name: 'Secret', members: [{ kind: 'role', role: 'admin' }] })).body
  assert.ok(lvl.id, JSON.stringify(lvl))
  const hidden = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'Secret one', securityLevelId: lvl.id })).body
  assert.equal((await move(hidden.key, { projectKey: 'MVB' })).body.securityLevelId, null)
  // R7: bulk move
  const x1 = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'Bulk one' })).body, x2 = (await call('POST', '/api/v1/projects/MVA/issues', { title: 'Bulk two' })).body
  const bulk = (await call('POST', '/api/v1/issues/bulk/move', { issues: [x1.key, x2.key], projectKey: 'MVB' })).body
  assert.deepEqual(bulk.moved.map((m: any) => m.key), [x1.key, x2.key])
  assert.ok(bulk.moved.every((m: any) => m.newKey.startsWith('MVB-')))
})

test('[0502.R1][0502.R2][0502.R4][0502.R5] custom field types: every one of Jira’s twenty, its values, options carried into lists, JQL, CSV import', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Field types', key: 'CFT', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Other place', key: 'CFO', template: 'kanban' })
  await join('CFT', 'cft.ann@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'cft.ann@x.com')).body, me = (await call('GET', '/api/v1/me')).body
  const grp = (await call('POST', '/api/v1/groups', { name: 'cft-crew' })).body
  const v1 = (await call('POST', '/api/v1/projects/CFT/releases', { name: '3.0' })).body
  const other = (await call('GET', '/api/v1/projects/CFO')).body
  const vOther = (await call('POST', '/api/v1/projects/CFO/releases', { name: '9.9' })).body
  const opts = (names: string[]) => names.map(n => ({ id: `o-${n}`, name: n }))
  const field = async (name: string, kind: string, options?: object[]) => {
    const r = await call('POST', '/api/v1/projects/CFT/fields', { name, kind, ...(options ? { options } : {}) })
    assert.equal(r.status, 201, `${kind}: ${JSON.stringify(r.body)}`)
    return r.body.id as string
  }
  const f: Record<string, string> = {}
  for (const k of ['text', 'textarea', 'readonly', 'number', 'date', 'datetime', 'url', 'labels', 'user', 'users', 'group', 'groups', 'project', 'version', 'versions'])
    f[k] = await field(`F ${k}`, k)
  for (const k of ['select', 'radio', 'multiselect', 'checkboxes']) f[k] = await field(`F ${k}`, k, opts(['Red', 'Green', 'Blue']))
  f.cascading = await field('Region', 'cascading', [{ id: 'eu', name: 'Europe' }, { id: 'am', name: 'Americas' }, { id: 'de', name: 'Germany', parentId: 'eu' }, { id: 'fr', name: 'France', parentId: 'eu' }, { id: 'us', name: 'US', parentId: 'am' }])
  // R2: a child option belongs under an option of a cascading field
  assert.equal((await call('POST', '/api/v1/projects/CFT/fields', { name: 'Bad', kind: 'select', options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }] })).status, 400)
  const good = {
    [f.text]: 'Short', [f.textarea]: 'Line one\nLine two', [f.readonly]: 'Set by a script', [f.number]: 4.5, [f.date]: '2026-12-01', [f.datetime]: '2026-12-01T09:30:00.000Z',
    [f.url]: 'https://example.com/a', [f.labels]: ['alpha', 'beta'], [f.user]: ann.id, [f.users]: [ann.id, me.id], [f.group]: grp.id, [f.groups]: [grp.id],
    [f.project]: other.id, [f.version]: v1.id, [f.versions]: [v1.id], [f.select]: 'Red', [f.radio]: 'Green', [f.multiselect]: ['Red', 'Blue'], [f.checkboxes]: ['Green'],
    [f.cascading]: ['Europe', 'Germany'],
  }
  const item = (await call('POST', '/api/v1/projects/CFT/issues', { title: 'Every type', custom: good })).body
  assert.deepEqual(item.custom, good)
  // R1: what each refuses
  const bad: [string, unknown][] = [[f.text, 'x'.repeat(256)], [f.number, '4'], [f.date, '2026-13-40'], [f.datetime, 'soon'], [f.url, 'ftp://x'], [f.labels, ['two words']],
    [f.user, 'not-an-id'], [f.users, [ann.id, ann.id]], [f.version, vOther.id], [f.select, 'Purple'], [f.multiselect, ['Red', 'Pink']], [f.checkboxes, 'Green'],
    [f.cascading, ['Europe', 'US']], [f.cascading, ['Asia']]]
  for (const [k, v] of bad) assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { custom: { ...good, [k]: v } })).status, 400, JSON.stringify(v))
  // R2: renaming options carries into single, multiple and cascading values
  const cur = (await call('GET', '/api/v1/projects/CFT')).body.fields
  const rename = (id: string, from: string, to: string) => call('PATCH', `/api/v1/projects/CFT/fields/${id}`, { options: cur.find((x: any) => x.id === id).options.map((o: any) => (o.name === from ? { ...o, name: to } : o)) })
  await rename(f.multiselect, 'Blue', 'Navy'); await rename(f.cascading, 'Germany', 'Deutschland')
  await call('PATCH', `/api/v1/projects/CFT/fields/${f.checkboxes}`, { options: cur.find((x: any) => x.id === f.checkboxes).options.filter((o: any) => o.name !== 'Green') })
  const after = (await call('GET', `/api/v1/issues/${item.key}`)).body.custom
  assert.deepEqual([after[f.multiselect], after[f.cascading], after[f.checkboxes]], [['Red', 'Navy'], ['Europe', 'Deutschland'], undefined])
  const usage = (await call('GET', `/api/v1/projects/CFT/fields/${f.multiselect}/usage`)).body.options
  assert.deepEqual([usage['o-Red'], usage['o-Blue']], [1, 1])
  // R4: JQL on each kind of value
  const keys = async (q: string) => {
    const r = await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = CFT AND ${q}`)}`)
    assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`)
    return r.body.items.map((i: any) => i.key)
  }
  const plain = (await call('POST', '/api/v1/projects/CFT/issues', { title: 'Plain' })).body
  assert.deepEqual(await keys('"F multiselect" = Navy'), [item.key])
  assert.deepEqual(await keys('"F multiselect" in (Pink, red)'), [item.key])
  assert.deepEqual(await keys('"F labels" = beta'), [item.key])
  assert.deepEqual(await keys('"F users" = currentUser()'), [item.key])
  assert.deepEqual(await keys('"F user" = "cft.ann@x.com"'), [item.key])
  assert.deepEqual(await keys('"F group" = "cft-crew"'), [item.key])
  assert.deepEqual(await keys('"F version" = "3.0"'), [item.key])
  assert.deepEqual(await keys('"F project" = CFO'), [item.key])
  assert.deepEqual(await keys('Region in cascadeOption("Europe")'), [item.key])
  assert.deepEqual(await keys('Region in cascadeOption("Europe", "Deutschland")'), [item.key])
  assert.deepEqual(await keys('Region in cascadeOption("Europe", "France")'), [])
  assert.deepEqual(await keys('"F datetime" > "2026-12-01 09:00"'), [item.key])
  assert.deepEqual(await keys('"F number" >= 4'), [item.key])
  assert.deepEqual(await keys('"F url" ~ "example.com"'), [item.key])
  assert.deepEqual(await keys('"F checkboxes" is empty').then(k => k.sort()), [item.key, plain.key].sort())
  // R5: the CSV importer reads every kind
  const csv = ['Summary,Multi,Users,Region,Versions,When', 'From CSV,"Red, Navy","cft.ann@x.com, owner@x.com",Europe › Deutschland,3.0,2026-12-02T10:00:00Z'].join('\n')
  const mapping = { title: 0, [`custom.${f.multiselect}`]: 1, [`custom.${f.users}`]: 2, [`custom.${f.cascading}`]: 3, [`custom.${f.versions}`]: 4, [`custom.${f.datetime}`]: 5 }
  const dry = (await call('POST', '/api/v1/projects/CFT/import', { csv, mapping })).body
  assert.deepEqual(dry.report[0].warnings, [])
})

test('[0503.R1][0503.R2][0503.R3][0503.R4][0503.R5][0503.R6][0503.R8] global custom fields with contexts: global, a project’s own context, work types, defaults, options across projects, project admins’ own fields', { skip, timeout: 60_000 }, async () => {
  for (const [name, key] of [['Ctx one', 'CXA'], ['Ctx two', 'CXB'], ['Ctx three', 'CXC']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  await join('CXA', 'cx.admin@x.com', 'admin')
  const fieldsOf = async (key: string) => (await call('GET', `/api/v1/projects/${key}`)).body.fields
  // R1, R2: a global field with options applies in every project
  const made = await call('POST', '/api/v1/admin/custom-fields', { name: 'Customer tier', kind: 'select', context: { projectKeys: null, options: [{ id: 'g', name: 'Gold' }, { id: 's', name: 'Silver' }], defaultValue: 'Silver' } })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const tier = made.body
  for (const k of ['CXA', 'CXB', 'CXC']) assert.ok((await fieldsOf(k)).some((f: any) => f.id === tier.id && f.shared), k)
  // R3: the default fills in
  const a1 = (await call('POST', '/api/v1/projects/CXA/issues', { title: 'Defaulted' })).body
  assert.equal(a1.custom[tier.id], 'Silver')
  assert.equal((await call('POST', '/api/v1/projects/CXA/issues', { title: 'Chosen', custom: { [tier.id]: 'Gold' } })).body.custom[tier.id], 'Gold')
  // R2: a project's own context overrides the global one, with its own options; one context per project; one global
  const own = await call('POST', `/api/v1/admin/custom-fields/${tier.id}/contexts`, { name: 'Partners', projectKeys: ['CXB'], options: [{ id: 'p', name: 'Partner' }] })
  assert.equal(own.status, 201, JSON.stringify(own.body))
  assert.equal((await call('POST', `/api/v1/admin/custom-fields/${tier.id}/contexts`, { name: 'Again', projectKeys: ['cxb'] })).status, 400)
  assert.equal((await call('POST', `/api/v1/admin/custom-fields/${tier.id}/contexts`, { name: 'Second global', projectKeys: null })).status, 400)
  const inB = (await fieldsOf('CXB')).find((f: any) => f.id === tier.id)
  assert.deepEqual(inB.options.map((o: any) => o.name), ['Partner'])
  assert.equal((await call('POST', '/api/v1/projects/CXB/issues', { title: 'x', custom: { [tier.id]: 'Gold' } })).status, 400)
  const b1 = (await call('POST', '/api/v1/projects/CXB/issues', { title: 'Partnered', custom: { [tier.id]: 'Partner' } })).body
  // R2: work types limit a context
  const bugsOnly = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Severity note', kind: 'text', context: { projectKeys: ['CXC'], typeKeys: ['bug'] } })).body
  assert.equal((await call('POST', '/api/v1/projects/CXC/issues', { title: 'A task', type: 'task', custom: { [bugsOnly.id]: 'x' } })).status, 400)
  assert.equal((await call('POST', '/api/v1/projects/CXC/issues', { title: 'A bug', type: 'bug', custom: { [bugsOnly.id]: 'x' } })).status, 201)
  // R4: renaming a global option carries to every project it covers
  const global = tier.contexts.find((c: any) => c.projectKeys === null)
  await call('PATCH', `/api/v1/admin/custom-fields/${tier.id}/contexts/${global.id}`, { options: [{ id: global.options[0].id, name: 'Platinum' }, global.options[1]], defaultValue: 'Silver' })
  assert.equal((await call('GET', `/api/v1/issues/${a1.key}`)).body.custom[tier.id], 'Silver')
  const chosen = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = CXA AND "Customer tier" = Platinum')}`)).body.items
  assert.equal(chosen.length, 1)
  // R6: deleting the project's own context: CXB falls back to the global one, its values not in it are cleared
  await call('DELETE', `/api/v1/admin/custom-fields/${tier.id}/contexts/${own.body.contexts.find((c: any) => c.name === 'Partners').id}`)
  assert.equal((await call('GET', `/api/v1/issues/${b1.key}`)).body.custom[tier.id], undefined)
  assert.deepEqual((await fieldsOf('CXB')).find((f: any) => f.id === tier.id).options.map((o: any) => o.name), ['Platinum', 'Silver'])
  // R5: project admins add and change their own field, not a shared one
  const mine = await call('POST', '/api/v1/projects/CXA/fields', { name: 'Local only', kind: 'text' }, 'cx.admin@x.com')
  assert.equal(mine.status, 201)
  assert.equal(mine.body.shared, false)
  assert.equal((await call('PATCH', `/api/v1/projects/CXA/fields/${mine.body.id}`, { name: 'Local renamed' }, 'cx.admin@x.com')).status, 200)
  assert.equal((await call('PATCH', `/api/v1/projects/CXA/fields/${tier.id}`, { name: 'Mine now' }, 'cx.admin@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/projects/CXA/fields/${tier.id}`, undefined, 'cx.admin@x.com')).status, 403)
  assert.equal((await call('GET', '/api/v1/admin/custom-fields', undefined, 'cx.admin@x.com')).status, 403)
  const listed = (await call('GET', '/api/v1/admin/custom-fields?query=renamed')).body.items
  assert.deepEqual(listed.map((f: any) => [f.name, f.contexts[0].projectKeys]), [['Local renamed', ['CXA']]])
  // R6: deleting a field clears every value
  assert.equal((await call('DELETE', `/api/v1/admin/custom-fields/${tier.id}`)).status, 204)
  assert.equal((await call('GET', `/api/v1/issues/${a1.key}`)).body.custom[tier.id], undefined)
  // R8: a deleted project leaves the contexts it was in, and takes a field it alone used
  const { db } = await import('../src/db.ts')
  await db.query(`delete from projects where key = 'CXC'`)
  assert.equal((await pool.query('select count(*)::int as n from custom_fields where id = $1', [bugsOnly.id])).rows[0].n, 0)
})

test('[0504.R1][0504.R2][0504.R3][0504.R4] field configurations: hidden and required per work type through a scheme; create, edit, bulk and move checked; the default can’t go', { skip, timeout: 60_000 }, async () => {
  for (const [name, key] of [['Configured', 'FCA'], ['Configured to', 'FCB']]) await call('POST', '/api/v1/projects', { name, key, template: 'kanban' })
  const team = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Owning team', kind: 'text', context: { projectKeys: ['FCA', 'FCB'], defaultValue: 'Core' } })).body
  const configs = (await call('GET', '/api/v1/admin/field-configurations')).body
  const def = configs.find((c: any) => c.isDefault)
  assert.equal(def.name, 'Default Field Configuration')
  // R1, R2: a configuration; a hidden field can't be required; unknown fields refused
  assert.equal((await call('POST', '/api/v1/admin/field-configurations', { name: 'Bad', items: { dueDate: { hidden: true, required: true } } })).status, 400)
  assert.equal((await call('POST', '/api/v1/admin/field-configurations', { name: 'Bad', items: { nonsense: { hidden: true } } })).status, 400)
  const strict = (await call('POST', '/api/v1/admin/field-configurations', { name: 'Strict bugs', items: {
    dueDate: { required: true, description: 'When it must be fixed by' }, labels: { hidden: true }, [`custom.${team.id}`]: { hidden: true } } })).body
  // R3: a scheme gives bugs the strict configuration; FCA uses it
  const scheme = (await call('POST', '/api/v1/admin/field-config-schemes', { name: 'Bug discipline', defaultConfigId: def.id, mappings: { bug: strict.id } })).body
  assert.equal((await call('PATCH', '/api/v1/projects/FCA', { fieldConfigSchemeId: scheme.id })).status, 200)
  const rules = (await call('GET', '/api/v1/projects/FCA')).body.fieldRules
  assert.deepEqual([rules.bug.dueDate.required, rules.task.dueDate], [true, undefined])
  // R4: create: a bug needs a due date; a task doesn't; a hidden field can't be set and gets no default
  const noDue = await call('POST', '/api/v1/projects/FCA/issues', { title: 'Crash', type: 'bug' })
  assert.deepEqual([noDue.status, noDue.body.errors?.dueDate], [400, 'Due Date is required'])
  assert.equal((await call('POST', '/api/v1/projects/FCA/issues', { title: 'Crash', type: 'bug', dueDate: '2026-12-01', labels: ['x'] })).status, 400)
  const bug = (await call('POST', '/api/v1/projects/FCA/issues', { title: 'Crash', type: 'bug', dueDate: '2026-12-01' })).body
  assert.equal(bug.custom[team.id], undefined)
  const task = (await call('POST', '/api/v1/projects/FCA/issues', { title: 'Chore', type: 'task' })).body
  assert.equal(task.custom[team.id], 'Core')
  // edit: clearing a required field is refused; other edits of an item that already lacks a value still work
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { dueDate: null })).status, 400)
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { title: 'Crash on start' })).status, 200)
  const retyped = await call('PATCH', `/api/v1/issues/${task.key}`, { type: 'bug' })
  assert.equal(retyped.status, 200)                                                     // it lacks a due date: left as it is
  assert.equal((await call('PATCH', `/api/v1/issues/${task.key}`, { labels: ['now-hidden'] })).status, 400)
  // bulk edits are checked the same way
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: [bug.key], patch: { dueDate: null } })).status, 400)
  // moving into a project whose configuration requires something it lacks is refused
  await call('PATCH', '/api/v1/projects/FCB', { fieldConfigSchemeId: scheme.id })
  const plain = (await call('POST', '/api/v1/projects/FCB/issues', { title: 'Loose', type: 'task' })).body
  await call('PATCH', '/api/v1/projects/FCA', { fieldConfigSchemeId: null })
  const looseBug = (await call('POST', '/api/v1/projects/FCA/issues', { title: 'No date', type: 'bug' })).body
  assert.equal(looseBug.status ?? 201, 201)
  const moved = await call('POST', `/api/v1/issues/${looseBug.key}/move`, { projectKey: 'FCB' })
  assert.deepEqual([moved.status, moved.body.errors?.dueDate], [400, 'Due Date is required'])
  assert.ok(plain.key)
  // R1: the default can't be deleted; a configuration a scheme uses can't be either; a scheme can
  assert.equal((await call('DELETE', `/api/v1/admin/field-configurations/${def.id}`)).status, 400)
  assert.equal((await call('DELETE', `/api/v1/admin/field-configurations/${strict.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/field-config-schemes/${scheme.id}`)).status, 204)
  assert.equal((await call('GET', '/api/v1/projects/FCB')).body.fieldConfigScheme, null)
  assert.equal((await call('DELETE', `/api/v1/admin/field-configurations/${strict.id}`)).status, 204)
  // only system admins choose a project's scheme
  await join('FCA', 'fc.admin@x.com', 'admin')
  assert.equal((await call('PATCH', '/api/v1/projects/FCA', { fieldConfigSchemeId: null }, 'fc.admin@x.com')).status, 403)
})

test('[0505.R1][0505.R2][0505.R3][0505.R4] screens: create, edit and view screens per work type through schemes; fields off a screen refused; agile actions unaffected', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Screened', key: 'SCR', template: 'scrum' })
  const env = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Environment', kind: 'text', context: { projectKeys: ['SCR'] } })).body
  const screens = (await call('GET', '/api/v1/admin/screens')).body
  const def = screens.find((s: any) => s.isDefault)
  assert.deepEqual([def.name, def.tabs], ['Default Screen', null])
  // R1: screens with tabs; unknown or repeated fields refused
  assert.equal((await call('POST', '/api/v1/admin/screens', { name: 'Bad', tabs: [{ name: 'Main', fields: ['nonsense'] }] })).status, 400)
  assert.equal((await call('POST', '/api/v1/admin/screens', { name: 'Bad', tabs: [{ name: 'A', fields: ['labels'] }, { name: 'B', fields: ['labels'] }] })).status, 400)
  const create = (await call('POST', '/api/v1/admin/screens', { name: 'Quick create', tabs: [{ name: 'Field tab', fields: ['description', 'assigneeId', 'priority'] }] })).body
  const edit = (await call('POST', '/api/v1/admin/screens', { name: 'Edit without priority', tabs: [{ name: 'Main', fields: ['description', 'assigneeId', 'labels', `custom.${env.id}`] }, { name: 'Dates', fields: ['dueDate'] }] })).body
  // R2, R3: a screen scheme for bugs; the project uses it through its issue type screen scheme
  const defScheme = (await call('GET', '/api/v1/admin/screen-schemes')).body.find((s: any) => s.isDefault)
  const bugScreens = (await call('POST', '/api/v1/admin/screen-schemes', { name: 'Bug screens', defaultScreenId: def.id, createScreenId: create.id, editScreenId: edit.id })).body
  const its = (await call('POST', '/api/v1/admin/issue-type-screen-schemes', { name: 'SCR screens', defaultSchemeId: defScheme.id, mappings: { bug: bugScreens.id } })).body
  assert.equal((await call('PATCH', '/api/v1/projects/SCR', { issueTypeScreenSchemeId: its.id })).status, 200)
  const proj = (await call('GET', '/api/v1/projects/SCR')).body
  assert.deepEqual([proj.screens.bug.create[0].fields, proj.screens.bug.view, proj.screens.task.edit, proj.issueTypeScreenScheme.name], [['description', 'assigneeId', 'priority'], null, null, 'SCR screens'])
  // R4: create: a field off the create screen is refused; a task (Default Screen) takes anything
  const off = await call('POST', '/api/v1/projects/SCR/issues', { title: 'Bug', type: 'bug', labels: ['ui'] })
  assert.deepEqual([off.status, off.body.errors?.labels], [400, 'Not on the create screen'])
  const bug = (await call('POST', '/api/v1/projects/SCR/issues', { title: 'Bug', type: 'bug', priority: 'high' })).body
  assert.equal((await call('POST', '/api/v1/projects/SCR/issues', { title: 'Task', type: 'task', labels: ['ui'] })).status, 201)
  // edit: priority isn't on the edit screen; labels and the custom field are
  const pr = await call('PATCH', `/api/v1/issues/${bug.key}`, { priority: 'low' })
  assert.deepEqual([pr.status, pr.body.errors?.priority], [400, 'Not on the edit screen'])
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { labels: ['ok'], custom: { [env.id]: 'staging' } })).status, 200)
  // agile actions aren't checked against screens: rank, sprint, flag, a move through the workflow
  const sprint = (await call('POST', '/api/v1/projects/SCR/sprints', { name: 'S1' })).body
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { sprintId: sprint.id, rank: 5, flagged: true })).status, 200)
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { statusId: proj.statuses.find((s: any) => s.category === 'in-progress').id })).status, 200)
  // R1: the default screen can't go; a used screen can't go; an unused one can
  assert.equal((await call('DELETE', `/api/v1/admin/screens/${def.id}`)).status, 400)
  assert.equal((await call('DELETE', `/api/v1/admin/screens/${edit.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/screen-schemes/${bugScreens.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/issue-type-screen-schemes/${its.id}`)).status, 204)
  assert.equal((await call('PATCH', `/api/v1/issues/${bug.key}`, { priority: 'low' })).status, 200)          // back to the Default Screen
  assert.equal((await call('DELETE', `/api/v1/admin/screen-schemes/${bugScreens.id}`)).status, 204)
  assert.equal((await call('DELETE', `/api/v1/admin/screens/${edit.id}`)).status, 204)
})

test('[0506.R1][0506.R2][0506.R3][0506.R4] voting: once each, not the reporter, not once resolved; who voted for those who may see; the switch; JQL', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Voted', key: 'VOT', template: 'kanban' })
  await join('VOT', 'vot.member@x.com', 'member'); await join('VOT', 'vot.viewer@x.com', 'viewer')
  const mine = (await call('POST', '/api/v1/projects/VOT/issues', { title: 'Mine' })).body
  const theirs = (await call('POST', '/api/v1/projects/VOT/issues', { title: 'Theirs' }, 'vot.member@x.com')).body
  const vote = (key: string, who?: string, method = 'PUT') => call(method, `/api/v1/issues/${key}/vote`, undefined, who)
  // R1: the reporter can't vote; others can, once; a viewer may vote and see who voted
  assert.equal((await vote(mine.key)).status, 400)
  assert.equal((await vote(mine.key, 'vot.member@x.com')).status, 204)
  assert.equal((await vote(mine.key, 'vot.member@x.com')).status, 204)
  assert.equal((await vote(mine.key, 'vot.viewer@x.com')).status, 204)
  assert.equal((await vote(theirs.key)).status, 204)
  let v = (await call('GET', `/api/v1/issues/${mine.key}/votes`, undefined, 'vot.viewer@x.com')).body
  assert.deepEqual([v.votes, v.hasVoted, v.voters.length], [2, true, 2])
  // R3: JQL
  const keys = async (q: string, who?: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(q)}`, undefined, who)).body.items.map((i: any) => i.key)
  assert.deepEqual(await keys('project = VOT AND votes >= 2'), [mine.key])
  assert.deepEqual(await keys('project = VOT AND issue in votedIssues()', 'vot.member@x.com'), [mine.key])
  assert.deepEqual(await keys('project = VOT ORDER BY votes DESC'), [mine.key, theirs.key])
  // R1: votes on a resolved item can't change
  const done = (await call('GET', '/api/v1/projects/VOT')).body.statuses.find((s: any) => s.category === 'done')
  await call('PATCH', `/api/v1/issues/${mine.key}`, { statusId: done.id })
  assert.equal((await vote(mine.key, 'vot.member@x.com', 'DELETE')).status, 400)
  // R2: the switch: off, voting is refused and votes are kept
  assert.equal((await call('PUT', '/api/v1/admin/settings/voting', { enabled: false })).status, 200)
  const { clearSettingsCache } = await import('../src/settings.ts'); clearSettingsCache()
  assert.equal((await vote(theirs.key, 'vot.viewer@x.com')).status, 403)
  v = (await call('GET', `/api/v1/issues/${theirs.key}/votes`)).body
  assert.equal(v.votes, 1)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'settings.voting.updated'`)).rows.length)
  await call('PUT', '/api/v1/admin/settings/voting', { enabled: true }); clearSettingsCache()
})

test('[0507.R1][0507.R2][0507.R3][0507.R4][0507.R5] remote links: web links added, changed, removed; Jira’s REST with globalId; safety; history and JQL; moves keep them', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Linked out', key: 'RLK', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Linked dest', key: 'RLD', template: 'kanban' })
  await join('RLK', 'rl.viewer@x.com', 'viewer')
  const item = (await call('POST', '/api/v1/projects/RLK/issues', { title: 'Has links' })).body
  const base = `/api/v1/issues/${item.key}/remote-links`
  // R1, R3: add, refuse javascript:, viewers can't add
  assert.equal((await call('POST', base, { url: 'javascript:alert(1)', title: 'x' })).status, 400)
  assert.equal((await call('POST', base, { url: 'https://example.com/spec', title: 'Spec' }, 'rl.viewer@x.com')).status, 403)
  const spec = (await call('POST', base, { url: 'https://example.com/spec', title: 'Spec' })).body
  assert.equal((await call('PUT', `${base}/${spec.id}`, { url: 'https://example.com/spec-v2', title: 'Spec v2' })).body.title, 'Spec v2')
  assert.deepEqual((await call('GET', base, undefined, 'rl.viewer@x.com')).body.map((l: any) => l.title), ['Spec v2'])
  // R2: Jira's REST: create, upsert by globalId, read by globalId, delete by globalId
  const jira = (path: string, method = 'GET', body?: unknown) => call(method, `/rest/api/2/issue/${item.key}/remotelink${path}`, body)
  const made = await jira('', 'POST', { globalId: 'gh=1', application: { type: 'com.github', name: 'GitHub' }, relationship: 'mentioned in', object: { url: 'https://github.com/acme/x/pull/1', title: 'PR #1', status: { resolved: false } } })
  assert.equal(made.status, 201)
  await jira('', 'POST', { globalId: 'gh=1', object: { url: 'https://github.com/acme/x/pull/1', title: 'PR #1 merged', status: { resolved: true } } })
  const byGlobal = (await jira('?globalId=gh%3D1')).body
  assert.deepEqual([byGlobal.object.title, byGlobal.object.status.resolved, byGlobal.application], ['PR #1 merged', true, undefined])
  assert.equal((await jira('')).body.length, 2)
  // R4: JQL and history
  const found = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('issue in remoteLinksByGlobalId("gh=1")')}`)).body.items.map((i: any) => i.key)
  assert.deepEqual(found, [item.key])
  const hist = (await pool.query(`select text from activity where issue_id = $1 and field = 'remoteLink' order by created_at`, [item.id])).rows.map(r => r.text)
  assert.deepEqual(hist, ['Added the web link “Spec”', 'Changed the web link “Spec v2”', 'Added the web link “PR #1”', 'Changed the web link “PR #1 merged”'])
  assert.equal((await jira('?globalId=gh%3D1', 'DELETE')).status, 204)
  assert.equal((await jira('?globalId=gh%3D1', 'DELETE')).status, 404)
  // R5: a moved item keeps its web links
  const moved = (await call('POST', `/api/v1/issues/${item.key}/move`, { projectKey: 'RLD' })).body
  assert.deepEqual((await call('GET', `/api/v1/issues/${moved.key}/remote-links`)).body.map((l: any) => l.title), ['Spec v2'])
  assert.equal((await call('DELETE', `/api/v1/issues/${moved.key}/remote-links/${spec.id}`)).status, 204)
})

test('[0508.R1][0508.R2][0508.R3][0508.R4] archiving single items: with sub-items, not an epic’s items; read-only; out of lists, search and boards; opens by key; restored', { skip, timeout: 60_000 }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Archiving', key: 'ARC', template: 'kanban' })
  await join('ARC', 'arc.admin@x.com', 'admin')
  const epic = (await call('POST', '/api/v1/projects/ARC/issues', { title: 'Big theme', type: 'epic' })).body
  const item = (await call('POST', '/api/v1/projects/ARC/issues', { title: 'Old work', parentId: epic.id })).body
  const sub = (await call('POST', '/api/v1/projects/ARC/issues', { title: 'Old sub-item', parentId: item.id })).body
  const kept = (await call('POST', '/api/v1/projects/ARC/issues', { title: 'Still live', parentId: epic.id })).body
  // R1: system admins only (not a project admin)
  assert.equal((await call('POST', `/api/v1/issues/${item.key}/archive`, undefined, 'arc.admin@x.com')).status, 403)
  assert.deepEqual((await call('POST', `/api/v1/issues/${item.key}/archive`)).body.archived.sort(), [item.key, sub.key].sort())
  // R2: out of lists, search and JQL; still opens by its key; read-only
  const listed = (await call('GET', '/api/v1/projects/ARC/issues')).body.items.map((i: any) => i.key)
  assert.deepEqual(listed.sort(), [epic.key, kept.key].sort())
  assert.deepEqual((await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = ARC')}`)).body.items.map((i: any) => i.key).sort(), [epic.key, kept.key].sort())
  const opened = (await call('GET', `/api/v1/issues/${item.key}`)).body
  assert.ok(opened.archivedAt)
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'x' })).status, 403)
  assert.equal((await call('POST', `/api/v1/issues/${sub.key}/comments`, { body: 'x' })).status, 403)
  assert.equal((await call('PUT', `/api/v1/issues/${item.key}/watch`)).status, 403)
  // the epic and its other items stay
  assert.equal((await call('GET', `/api/v1/issues/${kept.key}`)).body.archivedAt, null)
  // R3: the list, then restore with the sub-item
  const arch = (await call('GET', '/api/v1/admin/archived-items?query=old')).body.items.map((i: any) => i.key)
  assert.deepEqual(arch.sort(), [item.key, sub.key].sort())
  assert.equal((await call('GET', '/api/v1/admin/archived-items', undefined, 'arc.admin@x.com')).status, 403)
  assert.deepEqual((await call('POST', `/api/v1/issues/${item.key}/unarchive`)).body.restored.sort(), [item.key, sub.key].sort())
  assert.equal((await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'Back again' })).status, 200)
  // bulk
  assert.deepEqual((await call('POST', '/api/v1/issues/bulk/archive', { issues: [kept.key] })).body.archived, [kept.key])
  // R4: audited and in history
  assert.deepEqual((await pool.query(`select action from audit_log where target = $1 and action like 'issue.%archived' order by at`, [item.key])).rows.map(r => r.action), ['issue.archived', 'issue.unarchived'])
})

test('[0509.R1][0509.R2][0509.R3] converting to and from sub-items: the parent decides; epics, items with sub-items and other projects refused; history', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Converting', key: 'CNV', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Elsewhere', key: 'CNX', template: 'kanban' })
  const mk = async (b: object, key = 'CNV') => (await call('POST', `/api/v1/projects/${key}/issues`, b)).body
  const epic = await mk({ title: 'Epic', type: 'epic' }), parent = await mk({ title: 'Parent' }), item = await mk({ title: 'Becomes a sub-item', parentId: epic.id })
  const withSubs = await mk({ title: 'Has sub-items' }); await mk({ title: 'Its sub-item', parentId: withSubs.id })
  const other = await mk({ title: 'Other project' }, 'CNX')
  const conv = (key: string, parentKey: string | null) => call('POST', `/api/v1/issues/${key}/convert`, { parentKey })
  assert.equal((await conv(epic.key, parent.key)).status, 400)
  assert.equal((await conv(withSubs.key, parent.key)).status, 400)
  assert.equal((await conv(item.key, epic.key)).status, 400)
  assert.equal((await conv(item.key, other.key)).status, 400)
  const sub = (await conv(item.key, parent.key)).body
  assert.equal(sub.parentId, parent.id)
  assert.equal((await conv(item.key, parent.key)).status, 400)
  const back = (await conv(item.key, null)).body
  assert.equal(back.parentId, null)
  assert.equal((await conv(item.key, null)).status, 400)
  const hist = (await pool.query(`select text from activity where issue_id = $1 and text like 'Converted%' order by created_at`, [item.id])).rows.map(r => r.text)
  assert.deepEqual(hist, [`Converted to a sub-item of ${parent.key}`, 'Converted to an item'])
})

test('[0601.R1][0601.R2][0601.R3][0601.R4][0601.R5] every change keeps its names as they read then, a list change per value, indexed for history search', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'History', key: 'HIS', template: 'kanban' })
  const [todo, doing] = (await call('GET', '/api/v1/projects/HIS')).body.statuses
  await call('POST', '/api/v1/projects/HIS/rules', { name: 'Escalate', trigger: { kind: 'status', to: doing.id }, actions: [{ kind: 'priority', value: 'high' }] })
  const me = (await call('GET', '/api/v1/me')).body
  const i = (await call('POST', '/api/v1/projects/HIS/issues', { title: 'Tracked', priority: 'low' })).body
  const v1 = (await call('POST', '/api/v1/projects/HIS/releases', { name: '1.0' })).body, v2 = (await call('POST', '/api/v1/projects/HIS/releases', { name: '2.0' })).body
  await call('PATCH', `/api/v1/issues/${i.key}`, { assigneeId: me.id })
  await call('PATCH', `/api/v1/issues/${i.key}`, { statusId: doing.id })            // the rule raises the priority (automation)
  await call('PATCH', `/api/v1/issues/${i.key}`, { fixReleaseIds: [v1.id, v2.id] })
  await call('PATCH', `/api/v1/issues/${i.key}`, { fixReleaseIds: [v2.id] })
  // a write straight into the history (as a bulk workflow change does) is named too
  await pool.query(`insert into activity (issue_id, field, from_value, to_value, text) values ($1, 'statusId', $2, $3, 'Changed status (workflow change)')`, [i.id, doing.id, todo.id])
  await pool.query('update statuses set name = $2 where id = $1', [doing.id, 'Doing now'])   // a later rename doesn't change the history
  const rows = (await call('GET', `/api/v1/issues/${i.key}/activity?limit=100`)).body.items
  const of = (f: string) => rows.filter((r: any) => r.field === f).map((r: any) => [r.fromString, r.toString])
  assert.deepEqual(of('statusId'), [[doing.name, todo.name], [todo.name, doing.name]])
  assert.deepEqual(of('assigneeId'), [[null, me.name]])
  assert.deepEqual(of('priority'), [['Low', 'High']])
  assert.deepEqual(of('fixReleaseIds').map(String).sort(), [',1.0', ',2.0', '1.0,'])
  assert.ok(rows.find((r: any) => r.field === 'statusId').text.startsWith('Changed status'))
  const plan = await pool.query(`set enable_seqscan = off; explain select issue_id from activity where field = 'statusId' and to_value = '${doing.id}'; explain select issue_id from activity where field = 'assigneeId' and lower(to_string) = 'x'; reset enable_seqscan`) as any
  for (const r of [plan[1], plan[2]]) assert.match(r.rows.map((x: any) => x['QUERY PLAN']).join(' '), /Index.* activity_history_/)
})

test('[0602.R1][0602.R2][0602.R3][0602.R4] JQL history search: WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED with AFTER, BEFORE, ON, DURING, BY, FROM and TO', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'History search', key: 'HSQ', template: 'kanban' })
  const [todo, doing, done] = (await call('GET', '/api/v1/projects/HSQ')).body.statuses
  await join('HSQ', 'hsq.ann@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'hsq.ann@x.com')).body
  const v1 = (await call('POST', '/api/v1/projects/HSQ/releases', { name: '1.0' })).body, v2 = (await call('POST', '/api/v1/projects/HSQ/releases', { name: '2.0' })).body
  const mk = async (b: object) => (await call('POST', '/api/v1/projects/HSQ/issues', { title: 'Item', ...b })).body
  const [a, b, c, d, e] = [await mk({}), await mk({}), await mk({}), await mk({ fixReleaseIds: [v1.id] }), await mk({ fixReleaseIds: [v1.id] })]
  const edit = (i: any, patch: object) => call('PATCH', `/api/v1/issues/${i.key}`, patch)
  await edit(a, { statusId: doing.id }); await edit(a, { statusId: done.id }); await edit(a, { assigneeId: ann.id }); await edit(a, { priority: 'high' })
  await edit(c, { fixReleaseIds: [v1.id] }); await edit(c, { fixReleaseIds: [v1.id, v2.id] }); await edit(c, { fixReleaseIds: [v2.id] })
  await edit(e, { fixReleaseIds: [v2.id] })
  // A was created ten days ago, started five days ago and finished two days ago
  await pool.query(`update issues set created_at = now() - interval '10 days' where id = $1`, [a.id])
  await pool.query(`update activity set created_at = now() - interval '5 days' where issue_id = $1 and field = 'statusId' and to_value = $2`, [a.id, doing.id])
  await pool.query(`update activity set created_at = now() - interval '2 days' where issue_id = $1 and field = 'statusId' and to_value = $2`, [a.id, done.id])
  const [{ day }] = (await pool.query(`select to_char(now() - interval '5 days', 'YYYY-MM-DD') as day`)).rows
  await pool.query('update statuses set name = $2 where id = $1', [doing.id, 'Doing now'])   // the history keeps the name it had
  const keys = async (jql: string) => {
    const r = await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = HSQ AND ${jql}`)}&limit=50`)
    assert.equal(r.status, 200, `${jql}: ${JSON.stringify(r.body)}`)
    return r.body.items.map((i: any) => i.key).sort()
  }
  const K = (...xs: any[]) => xs.map(x => x.key).sort()
  // R1, R2: values now, at creation and in between; old names and ids; WAS NOT; lists; NOT
  assert.deepEqual(await keys(`status WAS "${doing.name}"`), K(a))
  assert.deepEqual(await keys(`status WAS "${doing.id}"`), K(a))
  assert.deepEqual(await keys(`status WAS "${todo.name}"`), K(a, b, c, d, e))
  assert.deepEqual(await keys(`status WAS NOT "${doing.name}"`), K(b, c, d, e))
  assert.deepEqual(await keys(`status WAS IN ("${doing.name}", "${done.name}")`), K(a))
  assert.deepEqual(await keys(`status WAS NOT IN ("${doing.name}", "${done.name}")`), K(b, c, d, e))
  assert.deepEqual(await keys(`NOT status WAS "${doing.name}"`), K(b, c, d, e))
  assert.deepEqual(await keys(`assignee WAS "hsq.ann@x.com"`), K(a))
  assert.deepEqual(await keys(`assignee WAS EMPTY`), K(a, b, c, d, e))
  assert.deepEqual(await keys(`priority WAS High`), K(a))
  assert.deepEqual(await keys(`status CHANGED`), K(a))
  // R3: predicates
  assert.deepEqual(await keys(`status WAS "${doing.name}" BEFORE "-6d"`), [])
  assert.deepEqual(await keys(`status WAS "${doing.name}" BEFORE "-4d"`), K(a))
  assert.deepEqual(await keys(`status WAS "${doing.name}" AFTER "-1d"`), [])
  assert.deepEqual(await keys(`status WAS "${doing.name}" AFTER "-3d"`), K(a))
  assert.deepEqual(await keys(`status WAS "${doing.name}" DURING ("-4d", "-3d")`), K(a))
  assert.deepEqual(await keys(`status WAS "${done.name}" DURING ("-9d", "-6d")`), [])
  assert.deepEqual(await keys(`status WAS "${todo.name}" ON "${day}"`), K(a))   // the others were created today
  assert.deepEqual(await keys(`status CHANGED ON "${day}"`), K(a))
  assert.deepEqual(await keys(`status CHANGED FROM "${todo.name}" TO "${doing.name}" BY currentUser()`), K(a))
  assert.deepEqual(await keys(`status CHANGED FROM "${done.name}"`), [])
  assert.deepEqual(await keys(`status CHANGED BY "hsq.ann@x.com"`), [])
  assert.deepEqual(await keys(`assignee WAS "hsq.ann@x.com" BY currentUser()`), K(a))
  assert.deepEqual(await keys(`assignee CHANGED FROM EMPTY TO "hsq.ann@x.com" AFTER "-1d"`), K(a))
  // R4: fix versions
  assert.deepEqual(await keys(`fixVersion WAS "1.0"`), K(c, d, e))
  assert.deepEqual(await keys(`fixVersion WAS EMPTY`), K(a, b, c))
  assert.deepEqual(await keys(`fixVersion WAS NOT EMPTY`), K(d, e))
  assert.deepEqual(await keys(`fixVersion CHANGED FROM "1.0"`), K(c, e))
  assert.deepEqual(await keys(`fixVersion CHANGED FROM "1.0" TO "2.0"`), K(e))
  assert.deepEqual(await keys(`fixVersion WAS "2.0" BY currentUser()`), K(c, e))
  // other fields: Jira's six only
  for (const q of ['labels WAS x', 'type CHANGED']) assert.equal((await call('GET', `/api/v1/search?jql=${encodeURIComponent(q)}`)).status, 400)
})

test('[0603.R1][0603.R2][0603.R3][0603.R4][0603.R5][0603.R6] the rest of Jira\'s JQL functions, and the voter and watcher fields', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Functions', key: 'FNQ', template: 'scrum' })
  await call('POST', '/api/v1/projects', { name: 'Functions two', key: 'FNR', template: 'kanban' })
  await join('FNQ', 'fnq.bea@x.com')
  const me = (await call('GET', '/api/v1/me')).body, bea = (await call('GET', '/api/v1/me', undefined, 'fnq.bea@x.com')).body
  const mk = async (b: object, key = 'FNQ') => (await call('POST', `/api/v1/projects/${key}/issues`, { title: 'Item', ...b })).body
  const r = async (name: string, b: object = {}) => (await call('POST', '/api/v1/projects/FNQ/releases', { name, ...b })).body
  const v1 = await r('1.0', { releaseDate: '2026-01-01' }), v2 = await r('2.0', { releaseDate: '2026-03-01' }), v3 = await r('3.0', { releaseDate: '2026-06-01' })
  await call('POST', `/api/v1/projects/FNQ/releases/${v1.id}/release`, {})
  await call('POST', `/api/v1/projects/FNQ/releases/${v2.id}/release`, {})
  const comp = (await call('POST', '/api/v1/projects/FNQ/components', { name: 'Core', leadId: bea.id })).body
  const a = await mk({ fixReleaseIds: [v1.id] }), b = await mk({ fixReleaseIds: [v2.id], componentIds: [comp.id] }), c = await mk({ fixReleaseIds: [v3.id] })
  const sub = await mk({ parentId: a.id }), other = await mk({}, 'FNR')
  const fut = (await call('POST', '/api/v1/projects/FNQ/sprints', { name: 'Later' })).body
  await call('PATCH', `/api/v1/issues/${c.key}`, { sprintId: fut.id })
  await call('POST', `/api/v1/issues/${a.key}/links`, { type: 'blocks', targetKey: b.key })
  await call('POST', `/api/v1/issues/${c.key}/links`, { type: 'relates', targetKey: a.key })
  await call('PUT', `/api/v1/issues/${b.key}/watch`, undefined, 'fnq.bea@x.com')
  await call('PUT', `/api/v1/issues/${c.key}/vote`, undefined, 'fnq.bea@x.com')
  await call('POST', `/api/v1/issues/${b.key}/view`)
  await call('POST', `/api/v1/issues/${b.key}/comments`, { body: 'Seen' }, 'fnq.bea@x.com')
  const keys = async (jql: string) => {
    const res = await call('GET', `/api/v1/search?jql=${encodeURIComponent(jql)}&limit=50`)
    assert.equal(res.status, 200, `${jql}: ${JSON.stringify(res.body)}`)
    return res.body.items.map((i: any) => i.key).filter((k: string) => /^FN[QR]-/.test(k)).sort()
  }
  const K = (...xs: any[]) => xs.map(x => x.key).sort()
  const Q = 'project in (FNQ, FNR) AND '
  // R1: dates
  assert.deepEqual(await keys(`${Q}created >= startOfMonth() AND created <= endOfYear() AND created > startOfYear(-1)`), K(a, b, c, sub, other))
  assert.deepEqual(await keys(`${Q}created < startOfDay(-1)`), [])
  await call('POST', '/api/v1/me/sign-in')
  await pool.query(`update users set last_sign_in_at = now() - interval '1 hour' where id = $1`, [me.id])
  await call('POST', '/api/v1/me/sign-in')                       // a new sign-in: the one an hour ago is lastLogin()
  assert.deepEqual(await keys(`${Q}created > lastLogin()`), K(a, b, c, sub, other))
  assert.deepEqual(await keys(`${Q}created > currentLogin()`), [])
  // R2: versions
  assert.deepEqual(await keys(`${Q}fixVersion in releasedVersions()`), K(a, b))
  assert.deepEqual(await keys(`${Q}fixVersion in unreleasedVersions(FNQ)`), K(c))
  assert.deepEqual(await keys(`${Q}fixVersion not in releasedVersions(FNQ)`), K(c))
  assert.deepEqual(await keys(`${Q}fixVersion = earliestUnreleasedVersion(FNQ)`), K(c))
  assert.deepEqual(await keys(`${Q}fixVersion = latestReleasedVersion(FNQ)`), K(b))
  // R3: sprints and items
  assert.deepEqual(await keys(`${Q}sprint in futureSprints()`), K(c))
  assert.deepEqual(await keys(`${Q}issue in linkedIssues(${a.key})`), K(b, c))
  assert.deepEqual(await keys(`${Q}issue in linkedIssues(${a.key}, "blocks")`), K(b))
  assert.deepEqual(await keys(`${Q}issue in linkedIssues(${b.key}, "is blocked by")`), K(a))
  assert.deepEqual(await keys(`${Q}issue in linkedIssues(${b.key}, "blocks")`), K(a))
  assert.deepEqual(await keys(`${Q}issue in issueHistory()`), K(b))
  assert.deepEqual(await keys(`${Q}issue in updatedBy("fnq.bea@x.com")`), K(b))
  assert.deepEqual(await keys(`${Q}issue in updatedBy("fnq.bea@x.com", "-1d", "+1d")`), K(b))
  assert.deepEqual(await keys(`${Q}issue in updatedBy("fnq.bea@x.com", "2020/01/01", "2020/12/31")`), [])
  assert.deepEqual(await keys(`${Q}issue in updatedBy("${me.email}")`), K(a, b, c, sub, other))
  // R4: people and projects
  assert.deepEqual(await keys(`${Q}component in componentsLeadByUser("fnq.bea@x.com")`), K(b))
  assert.deepEqual(await keys(`${Q}project in projectsLeadByUser()`), K(a, b, c, sub, other))
  assert.deepEqual(await keys(`${Q}project in projectsWhereUserHasPermission("Edit issues")`), K(a, b, c, sub, other))
  assert.deepEqual(await keys(`${Q}project in projectsWhereUserHasRole(Administrators)`), K(a, b, c, sub, other))
  const beaKeys = async (jql: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(jql)}&limit=50`, undefined, 'fnq.bea@x.com')).body.items.map((i: any) => i.key).sort()
  assert.deepEqual(await beaKeys('project in projectsWhereUserHasRole(Administrators)'), [])
  assert.deepEqual(await beaKeys('issue in watchedIssues()'), K(b))
  assert.deepEqual(await beaKeys('project in projectsWhereUserHasPermission(EDIT_ISSUES)'), K(a, b, c, sub))
  // R5: types and fields
  assert.deepEqual(await keys(`${Q}type in subtaskIssueTypes()`), K(sub))
  assert.deepEqual(await keys(`${Q}type in standardIssueTypes()`), K(a, b, c, other))
  assert.deepEqual(await keys(`${Q}voter = "fnq.bea@x.com"`), K(c))
  assert.deepEqual(await keys(`${Q}watcher = "fnq.bea@x.com"`), K(b))
  assert.deepEqual(await keys(`${Q}watcher in membersOf("missing group")`), [])
  assert.deepEqual(await keys(`${Q}watchers >= 1 AND watcher = "fnq.bea@x.com"`), K(b))
  assert.deepEqual(await keys(`${Q}voter is empty`), K(a, b, sub, other))
  // R6: mistakes
  for (const q of ['issue in linkedIssues(NOPE-1)', 'issue in linkedIssues(FNQ-1, "eats")', 'issue in updatedBy("nobody@x.com")', 'project in projectsWhereUserHasRole(Owners)',
    'project in projectsWhereUserHasPermission("Fly")', 'fixVersion = latestReleasedVersion()', 'priority = releasedVersions()', 'created > startOfDay("soon")',
    `issue in issuesWithRemoteLinksByGlobalId()`]) assert.equal((await call('GET', `/api/v1/search?jql=${encodeURIComponent(q)}`)).status, 400, q)
})

test('[0604.R1][0604.R2][0604.R3][0604.R4][0604.R5][0604.R6] filter subscriptions: yourself or a group, on a schedule, each recipient sees what they may', { skip }, async () => {
  process.env.EMAIL_TRANSPORT = 'memory'
  const { sentEmails } = await import('../src/email.ts')
  const { runJobs } = await import('../src/jobs.ts')
  await call('PUT', '/api/v1/admin/settings/email', { enabled: true, from: 'Strand <strand@example.com>', appUrl: 'https://strand.example.com' })
  await call('POST', '/api/v1/projects', { name: 'Subscribed', key: 'SBA', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Subscribed secret', key: 'SBB', template: 'kanban' })
  await join('SBA', 'sb.ann@x.com'); await join('SBA', 'sb.bob@x.com'); await join('SBA', 'sb.gone@x.com')
  const id = async (e: string) => (await call('GET', '/api/v1/me', undefined, e)).body.id
  const [ann, bob, gone] = [await id('sb.ann@x.com'), await id('sb.bob@x.com'), await id('sb.gone@x.com')]
  await call('POST', '/api/v1/projects/SBA/issues', { title: 'Open to all' })
  const secret = (await call('POST', '/api/v1/projects/SBB/issues', { title: 'Only the owner sees this' })).body
  const team = (await call('POST', '/api/v1/groups', { name: 'sb-team' })).body
  await call('POST', `/api/v1/groups/${team.id}/members`, { userIds: [ann, bob, gone] })
  await pool.query('delete from group_members where group_id = $1 and user_id = $2', [team.id, (await call('GET', '/api/v1/me')).body.id])   // its creator joined it
  const view = (await call('POST', '/api/v1/views', { name: 'Both projects', shared: true, filters: { q: '', resolution: 'open', jql: 'project in (SBA, SBB) ORDER BY key' } })).body
  const hidden = (await call('POST', '/api/v1/views', { name: 'Private', filters: { q: '', resolution: 'open', jql: 'project = SBA AND summary ~ nothing' } })).body
  await pool.query('update users set active = false where id = $1', [gone])
  const mails = () => sentEmails.filter(m => m.subject.startsWith('[Strand] Subscription:'))
  const before = mails().length
  // R2: Jira's cron, checked
  assert.equal((await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 7 * *' })).status, 400)
  assert.equal((await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 9 31 2 ?' })).status, 400)
  // R1, R5: personal, Run now
  const mine = (await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 7 ? * MON-FRI' })).body
  assert.equal(mine.groupId, null); assert.ok(Date.parse(mine.nextRunAt) > Date.now())
  assert.equal((await call('POST', `/api/v1/subscriptions/${mine.id}/run`)).status, 202)
  await runJobs(); await runJobs()
  const m1 = mails().slice(before)
  assert.equal(m1.length, 1)
  assert.match(m1[0]!.text, new RegExp(`2 work items in “Both projects”[\\s\\S]*${secret.key}`))
  assert.equal((await call('GET', `/api/v1/views/${view.id}/subscriptions`)).body[0].lastRunAt !== null, true)
  // R3: a group: each active member, as they see it (not the other project); not the deactivated one
  const grp = (await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 8 ? * *', groupId: team.id }, 'sb.ann@x.com')).body
  await call('POST', `/api/v1/subscriptions/${grp.id}/run`, undefined, 'sb.ann@x.com'); await runJobs(); await runJobs()
  const m2 = mails().slice(before + 1)
  assert.deepEqual(m2.map(m => m.to).sort(), ['sb.ann@x.com', 'sb.bob@x.com'])
  assert.ok(m2.every(m => /1 work item in/.test(m.text) && !m.text.includes(secret.key)))
  // R4: nothing found: no email unless asked; the item limit
  const empty = (await call('POST', `/api/v1/views/${hidden.id}/subscriptions`, { cron: '0 0 8 ? * *' })).body
  await call('POST', `/api/v1/subscriptions/${empty.id}/run`); await runJobs(); await runJobs()
  assert.equal(mails().length, before + 3)
  await call('PATCH', `/api/v1/subscriptions/${empty.id}`, { emailWhenEmpty: true })
  await call('POST', `/api/v1/subscriptions/${empty.id}/run`); await runJobs(); await runJobs()
  assert.equal(mails().length, before + 4)
  await call('PUT', '/api/v1/admin/settings/filterSubscriptions', { maxItems: 1 })
  await call('POST', `/api/v1/subscriptions/${mine.id}/run`); await runJobs(); await runJobs()
  assert.match(mails().at(-1)!.text, /… and 1 more/)
  // R1: who may subscribe groups (Manage group filter subscriptions, spec 0717), change and delete; a hidden view is not found
  await call('PUT', '/api/v1/admin/settings/filterSubscriptions', { maxItems: 200 })
  const subsGrant = (await call('GET', '/api/v1/admin/global-permissions')).body.find((p: any) => p.key === 'group-subscriptions').groups[0]
  await call('DELETE', `/api/v1/admin/global-permissions/${subsGrant.id}`)
  assert.equal((await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 8 ? * *', groupId: team.id }, 'sb.bob@x.com')).status, 403)
  assert.equal((await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 8 ? * *' }, 'sb.bob@x.com')).status, 201)
  assert.equal((await call('POST', `/api/v1/views/${hidden.id}/subscriptions`, { cron: '0 0 8 ? * *' }, 'sb.bob@x.com')).status, 404)
  assert.equal((await call('PATCH', `/api/v1/subscriptions/${grp.id}`, { cron: '0 0 9 ? * *' }, 'sb.bob@x.com')).status, 404)
  assert.equal((await call('GET', `/api/v1/views/${view.id}/subscriptions`, undefined, 'sb.bob@x.com')).body.length, 1)
  assert.equal((await call('GET', `/api/v1/views/${view.id}/subscriptions`)).body.length, 3)   // a system administrator sees all
  assert.equal((await call('PATCH', `/api/v1/subscriptions/${grp.id}`, { cron: '0 0 9 ? * *' })).status, 200)
  // R6: audited; deleting the view deletes its subscriptions
  assert.ok((await pool.query(`select 1 from audit_log where action in ('subscription.group_added', 'subscription.changed')`)).rows.length >= 2)
  await call('DELETE', `/api/v1/views/${hidden.id}`)
  assert.equal((await pool.query('select count(*)::int as n from filter_subscriptions where view_id = $1', [hidden.id])).rows[0].n, 0)
  // a scheduled run: due now, it sends and queues the next
  await pool.query(`update filter_subscriptions set next_run_at = now() - interval '1 minute' where id = $1`, [mine.id])
  await pool.query(`insert into jobs (kind, payload, workspace_id) select 'filter-subscription.run', jsonb_build_object('id', id, 'at', next_run_at::text), workspace_id from filter_subscriptions where id = $1`, [mine.id])
  const n = mails().length
  await runJobs(); await runJobs()
  assert.equal(mails().length, n + 1)
  assert.ok((await pool.query('select next_run_at > now() as later from filter_subscriptions where id = $1', [mine.id])).rows[0].later)
  await call('POST', '/api/v1/admin/global-permissions', { permission: 'group-subscriptions', groupId: subsGrant.groupId })
  await call('PUT', '/api/v1/admin/settings/email', { enabled: false, from: '', appUrl: '' })
})

test('[0605.R1][0605.R2][0605.R3][0605.R4][0605.R5][0605.R6] notification schemes: each event reaches the recipients its project\'s scheme gives it', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Schemes', key: 'NSA', template: 'kanban' })
  for (const n of ['ns.ann', 'ns.bob', 'ns.dan']) await join('NSA', `${n}@x.com`)
  await join('NSA', 'ns.cy@x.com', 'viewer')
  const id = async (e: string) => (await call('GET', '/api/v1/me', undefined, e)).body.id
  const [ann, bob, cy, dan] = [await id('ns.ann@x.com'), await id('ns.bob@x.com'), await id('ns.cy@x.com'), await id('ns.dan@x.com')]
  const box = async (who: string, key: string) => (await inbox(`${who}@x.com`)).filter(n => n.issueKey === key).map(n => `${n.kind}:${n.text}`)
  // R1, R2: Jira's default scheme, and every project has it
  const list = (await call('GET', '/api/v1/admin/notification-schemes')).body
  const def = list.find((x: any) => x.isDefault)
  assert.equal(def.name, 'Default Notification Scheme')
  const full = (await call('GET', `/api/v1/admin/notification-schemes/${def.id}`)).body
  assert.equal(full.entries.length, 51)
  assert.deepEqual((await call('GET', '/api/v1/projects/NSA/notification-scheme')).body.scheme, { id: def.id, name: def.name })
  // the default sends Issue Created to the assignee (not the actor, who is the reporter)
  const a = (await call('POST', '/api/v1/projects/NSA/issues', { title: 'First', assigneeId: bob }, 'ns.ann@x.com')).body
  assert.deepEqual(await box('ns.bob', a.key), ['updated:created a work item'])
  assert.deepEqual(await box('ns.ann', a.key), [])
  // a scheme of our own: comments go to a group only; creation to the viewers too; updates to the component lead
  const team = (await call('POST', '/api/v1/groups', { name: 'ns-team' })).body
  await call('POST', `/api/v1/groups/${team.id}/members`, { userIds: [dan] })
  const mine = (await call('POST', `/api/v1/admin/notification-schemes/${def.id}/copy`, { name: 'Team scheme' })).body
  for (const e of mine.entries.filter((x: any) => x.event === 'issue_commented')) await call('DELETE', `/api/v1/admin/notification-schemes/${mine.id}/entries/${e.id}`)
  await call('POST', `/api/v1/admin/notification-schemes/${mine.id}/entries`, { event: 'issue_commented', recipient: 'group', value: team.id })
  await call('POST', `/api/v1/admin/notification-schemes/${mine.id}/entries`, { event: 'issue_created', recipient: 'project_role', value: 'viewer' })
  await call('POST', `/api/v1/admin/notification-schemes/${mine.id}/entries`, { event: 'issue_updated', recipient: 'component_lead' })
  assert.equal((await call('POST', `/api/v1/admin/notification-schemes/${mine.id}/entries`, { event: 'issue_updated', recipient: 'group', value: null })).status, 400)
  assert.equal((await call('PUT', '/api/v1/projects/NSA/notification-scheme', { schemeId: mine.id })).status, 200)
  const b = (await call('POST', '/api/v1/projects/NSA/issues', { title: 'Second', assigneeId: bob }, 'ns.ann@x.com')).body
  assert.deepEqual([await box('ns.bob', b.key), await box('ns.cy', b.key)], [['updated:created a work item'], ['updated:created a work item']])
  // R3: Issue Commented reaches the group, not the reporter; a restricted comment only those who may read it
  await call('POST', `/api/v1/issues/${b.key}/comments`, { body: 'Looks good' }, 'ns.bob@x.com')
  assert.deepEqual([await box('ns.dan', b.key), await box('ns.ann', b.key)], [['commented:commented on a work item'], []])
  await call('POST', `/api/v1/issues/${b.key}/comments`, { body: 'Admins only', visibility: { kind: 'role', role: 'admin' } })
  assert.equal((await box('ns.dan', b.key)).length, 1)
  // R4: Issue Assigned says so to the assignee; a transition into Done is Issue Resolved, out of it Issue Reopened
  const [todo, , done] = (await call('GET', '/api/v1/projects/NSA')).body.statuses
  await call('PATCH', `/api/v1/issues/${b.key}`, { assigneeId: ann })
  assert.ok((await box('ns.ann', b.key)).includes('assigned:assigned you a work item'))
  assert.ok((await box('ns.bob', b.key)).includes('assigned:assigned a work item'))   // Bob watches: he commented
  await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: done.id }, 'ns.bob@x.com')
  assert.ok((await box('ns.ann', b.key)).includes('status:resolved a work item'))
  await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: todo.id }, 'ns.bob@x.com')
  assert.ok((await box('ns.ann', b.key)).includes('status:reopened a work item'))
  // the component lead hears about updates
  const comp = (await call('POST', '/api/v1/projects/NSA/components', { name: 'Core', leadId: dan })).body
  await call('PATCH', `/api/v1/issues/${b.key}`, { componentIds: [comp.id] }, 'ns.ann@x.com')
  assert.ok((await box('ns.dan', b.key)).includes('updated:updated a work item'))
  // R5: a bulk change without notifications: project admins and system administrators only; then nobody hears
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: [b.key], patch: { priority: 'high' }, sendNotifications: false }, 'ns.ann@x.com')).status, 403)
  const before = (await box('ns.dan', b.key)).length
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: [b.key], patch: { priority: 'low' }, sendNotifications: false })).status, 200)
  assert.equal((await box('ns.dan', b.key)).length, before)
  await call('POST', '/api/v1/issues/bulk/edit', { issues: [b.key], patch: { priority: 'high' } })
  assert.equal((await box('ns.dan', b.key)).length, before + 1)
  // R2: None sends nothing; @mentions still go
  await call('PUT', '/api/v1/projects/NSA/notification-scheme', { schemeId: null })
  assert.equal((await call('GET', '/api/v1/projects/NSA/notification-scheme')).body.scheme, null)
  const n = (await box('ns.ann', b.key)).length
  await call('POST', `/api/v1/issues/${b.key}/comments`, { body: 'ping @ns.ann' }, 'ns.bob@x.com')
  assert.deepEqual((await box('ns.ann', b.key)).slice(0, (await box('ns.ann', b.key)).length - n), ['mentioned:mentioned you in a comment'])
  await call('PATCH', `/api/v1/issues/${b.key}`, { title: 'Quiet' }, 'ns.bob@x.com')
  assert.equal((await box('ns.ann', b.key)).length, n + 1)
  // R1: deleting a scheme in use or the default is refused; another can become the default, and new projects get it
  await call('PUT', '/api/v1/projects/NSA/notification-scheme', { schemeId: mine.id })
  assert.equal((await call('DELETE', `/api/v1/admin/notification-schemes/${mine.id}`)).status, 409)
  assert.equal((await call('DELETE', `/api/v1/admin/notification-schemes/${def.id}`)).status, 409)
  await call('PATCH', `/api/v1/admin/notification-schemes/${mine.id}`, { isDefault: true })
  await call('POST', '/api/v1/projects', { name: 'Schemes two', key: 'NSB', template: 'kanban' })
  assert.equal((await call('GET', '/api/v1/projects/NSB/notification-scheme')).body.scheme.id, mine.id)
  await call('PATCH', `/api/v1/admin/notification-schemes/${def.id}`, { isDefault: true })
  const spare = (await call('POST', '/api/v1/admin/notification-schemes', { name: 'Spare' })).body
  assert.equal((await call('DELETE', `/api/v1/admin/notification-schemes/${spare.id}`)).status, 204)
  assert.equal((await call('POST', '/api/v1/admin/notification-schemes', { name: 'team SCHEME' })).status, 409)
  // R6: audited
  assert.ok((await pool.query(`select 1 from audit_log where action = 'project.notification_scheme_changed'`)).rows.length >= 3)
})

test('[0501.R1] a move is refused when a sub-item is behind a security level the mover isn\'t in', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Move levels', key: 'MVL', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Move target', key: 'MVT', template: 'kanban' })
  await join('MVL', 'mvl.bob@x.com', 'admin'); await join('MVT', 'mvl.bob@x.com', 'admin')
  const lvl = (await call('POST', '/api/v1/projects/MVL/security-levels', { name: 'Owner only', members: [{ kind: 'user', id: (await call('GET', '/api/v1/me')).body.id }] })).body
  const parent = (await call('POST', '/api/v1/projects/MVL/issues', { title: 'Parent' })).body
  await call('POST', '/api/v1/projects/MVL/issues', { title: 'Hidden sub-item', parentId: parent.id, securityLevelId: lvl.id })
  const r = await call('POST', `/api/v1/issues/${parent.key}/move`, { projectKey: 'MVT' }, 'mvl.bob@x.com')
  assert.equal(r.status, 403)
  assert.match(r.body.error, /1 of its sub-items is behind a security level/)
  assert.equal((await call('GET', `/api/v1/issues/${parent.key}`)).body.key, parent.key)   // nothing moved
})

test('[0803.R1][0803.R3] plans and the initiative picker leave out work behind a security level I\'m not in', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Level plans', key: 'LVP', template: 'kanban' })
  await join('LVP', 'lvp.dev@x.com')
  await call('PUT', '/api/v1/projects/LVP/initiatives', { enabled: true })
  const lvl = (await call('POST', '/api/v1/projects/LVP/security-levels', { name: 'Owner only', members: [{ kind: 'user', id: (await call('GET', '/api/v1/me')).body.id }] })).body
  await call('POST', '/api/v1/projects/LVP/issues', { title: 'Secret initiative', type: 'initiative', securityLevelId: lvl.id })
  await call('POST', '/api/v1/projects/LVP/issues', { title: 'Secret task', securityLevelId: lvl.id })
  await call('POST', '/api/v1/projects/LVP/issues', { title: 'Open task' })
  const plan = (await call('POST', '/api/v1/plans', { name: 'Level plan', projectKeys: ['LVP'] })).body
  const titles = async (who?: string) => (await call('GET', `/api/v1/plans/${plan.id}/timeline`, undefined, who)).body.items.map((i: any) => i.title).sort()
  assert.deepEqual(await titles(), ['Open task', 'Secret initiative', 'Secret task'])
  assert.deepEqual(await titles('lvp.dev@x.com'), ['Open task'])
  assert.deepEqual((await call('GET', '/api/v1/initiatives?query=Secret', undefined, 'lvp.dev@x.com')).body, [])
})

test('projects list: the open count leaves out items behind a security level I\'m not in', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Counted', key: 'CNT', template: 'kanban' })
  await join('CNT', 'cnt.bob@x.com')
  const lvl = (await call('POST', '/api/v1/projects/CNT/security-levels', { name: 'Admins', members: [{ kind: 'role', role: 'admin' }] })).body
  await call('POST', '/api/v1/projects/CNT/issues', { title: 'Open to all' })
  await call('POST', '/api/v1/projects/CNT/issues', { title: 'Hidden', securityLevelId: lvl.id })
  const count = async (who?: string) => Number((await call('GET', '/api/v1/projects', undefined, who)).body.find((p: any) => p.key === 'CNT').openCount)
  assert.deepEqual([await count(), await count('cnt.bob@x.com')], [2, 1])
  assert.equal(Number((await call('GET', '/api/v1/projects/search?query=Counted', undefined, 'cnt.bob@x.com')).body.items[0].openCount), 1)
})

test('[0605.R3] a notification scheme never tells someone outside an item\'s security level', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Scheme levels', key: 'NSL', template: 'kanban' })
  await join('NSL', 'nsl.ann@x.com'); await join('NSL', 'nsl.bob@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'nsl.ann@x.com')).body.id
  const scheme = (await call('POST', '/api/v1/admin/notification-schemes', { name: 'Members hear everything' })).body
  await call('POST', `/api/v1/admin/notification-schemes/${scheme.id}/entries`, { event: 'issue_created', recipient: 'project_role', value: 'member' })
  await call('PUT', '/api/v1/projects/NSL/notification-scheme', { schemeId: scheme.id })
  const lvl = (await call('POST', '/api/v1/projects/NSL/security-levels', { name: 'Ann and admins', members: [{ kind: 'role', role: 'admin' }, { kind: 'user', id: ann }] })).body
  const hidden = (await call('POST', '/api/v1/projects/NSL/issues', { title: 'Hidden', securityLevelId: lvl.id })).body
  const open = (await call('POST', '/api/v1/projects/NSL/issues', { title: 'Open' })).body
  const heard = async (who: string) => (await inbox(`${who}@x.com`)).map(n => n.issueKey).filter(k => k.startsWith('NSL-')).sort()
  assert.deepEqual(await heard('nsl.ann'), [hidden.key, open.key].sort())   // a member in the level
  assert.deepEqual(await heard('nsl.bob'), [open.key])
})

test('[0606.R1][0606.R2][0606.R3][0606.R4][0606.R5] batched email, Autowatch, My changes and their defaults', { skip }, async () => {
  process.env.EMAIL_TRANSPORT = 'memory'
  const { sentEmails } = await import('../src/email.ts')
  const { runJobs } = await import('../src/jobs.ts')
  await call('PUT', '/api/v1/admin/settings/email', { enabled: true, from: 'Strand <strand@example.com>', appUrl: 'https://strand.example.com' })
  await call('POST', '/api/v1/projects', { name: 'Batched', key: 'BTE', template: 'kanban' })
  await join('BTE', 'bt.ann@x.com'); await join('BTE', 'bt.bob@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'bt.ann@x.com')).body.id
  const mailsTo = (who: string) => sentEmails.filter(m => m.to === who)
  const watching = async (key: string, who: string) => (await call('GET', `/api/v1/issues/${key}`, undefined, who)).body.watcherIds.includes((await call('GET', '/api/v1/me', undefined, who)).body.id)
  const due = () => pool.query(`update jobs set run_at = now() where kind = 'email.batch' and status = 'queued'`)
  // R1: batching off: one email per change
  const a = (await call('POST', '/api/v1/projects/BTE/issues', { title: 'Unbatched', assigneeId: ann })).body
  await runJobs()
  const n0 = mailsTo('bt.ann@x.com').length
  await call('PATCH', `/api/v1/issues/${a.key}`, { title: 'Unbatched 2' }); await call('PATCH', `/api/v1/issues/${a.key}`, { priority: 'high' }); await runJobs()
  assert.equal(mailsTo('bt.ann@x.com').length, n0 + 2)
  // R1: batching on: three changes, one email listing them; nothing before the window ends; a mention at once
  await call('PUT', '/api/v1/admin/settings/emailBatching', { enabled: true, minutes: 10 })
  const n1 = mailsTo('bt.ann@x.com').length
  await call('PATCH', `/api/v1/issues/${a.key}`, { title: 'Batched' }); await call('PATCH', `/api/v1/issues/${a.key}`, { priority: 'low' })
  await call('POST', `/api/v1/issues/${a.key}/comments`, { body: 'One more thing' })
  await runJobs()
  assert.equal(mailsTo('bt.ann@x.com').length, n1)
  const mentionedName = (await call('GET', '/api/v1/me', undefined, 'bt.bob@x.com')).body.name
  await call('POST', `/api/v1/issues/${a.key}/comments`, { body: `@${mentionedName} have a look` }); await runJobs()
  assert.match(mailsTo('bt.bob@x.com').at(-1)!.text, /mentioned you/)
  await due(); await runJobs()
  const batch = mailsTo('bt.ann@x.com').slice(n1)
  assert.equal(batch.length, 1)
  assert.match(batch[0]!.text, /^4 changes to /)      // two edits and two comments
  assert.equal((await pool.query('select count(*)::int as n from email_batch_items')).rows[0].n, 0)
  await call('PUT', '/api/v1/admin/settings/emailBatching', { enabled: false, minutes: 10 })
  // R2, R3: creating and commenting make you a watcher; a mention doesn't
  const b = (await call('POST', '/api/v1/projects/BTE/issues', { title: 'Watch me' }, 'bt.ann@x.com')).body
  assert.ok(await watching(b.key, 'bt.ann@x.com'))
  await call('POST', `/api/v1/issues/${b.key}/comments`, { body: 'Hi' }, 'bt.bob@x.com')
  assert.ok(await watching(b.key, 'bt.bob@x.com'))
  // R2, R5: Autowatch off (mine), then the default off for those who haven't chosen
  const prefs = (await call('PUT', '/api/v1/me/notification-prefs', { autowatch: false }, 'bt.bob@x.com')).body
  assert.deepEqual([prefs.autowatch, prefs.notifyOwnChanges, prefs.defaults], [false, null, { autowatch: true, notifyOwnChanges: false }])
  const c = (await call('POST', '/api/v1/projects/BTE/issues', { title: 'Not watched' }, 'bt.bob@x.com')).body
  assert.ok(!(await watching(c.key, 'bt.bob@x.com')))
  await call('PUT', '/api/v1/admin/settings/userDefaults', { autowatch: false, notifyOwnChanges: false })
  const d2 = (await call('POST', '/api/v1/projects/BTE/issues', { title: 'Default off' }, 'bt.ann@x.com')).body
  assert.ok(!(await watching(d2.key, 'bt.ann@x.com')))
  await call('PUT', '/api/v1/admin/settings/userDefaults', { autowatch: true, notifyOwnChanges: false })
  // R4: My changes: off, my own change doesn't reach me; on, it does
  const mine = async () => (await inbox('bt.ann@x.com')).filter(x => x.issueKey === b.key && x.text === 'updated a work item').length
  await call('PATCH', `/api/v1/issues/${b.key}`, { title: 'Mine' }, 'bt.ann@x.com')
  assert.equal(await mine(), 0)
  await call('PUT', '/api/v1/me/notification-prefs', { notifyOwnChanges: true }, 'bt.ann@x.com')
  await call('PATCH', `/api/v1/issues/${b.key}`, { title: 'Mine again' }, 'bt.ann@x.com')
  assert.equal(await mine(), 1)
  await call('PUT', '/api/v1/admin/settings/email', { enabled: false, from: '', appUrl: '' })
})

test('[0607.R1][0607.R2][0607.R3][0607.R4][0607.R5][0607.R7][0607.R8] incoming mail: handlers make work items and comments from email, as Jira\'s', { skip }, async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { runJobs } = await import('../src/jobs.ts')
  const dir = mkdtempSync(`${tmpdir()}/strand-mail-`)
  process.env.STRAND_MAIL_DIR = dir
  await call('POST', '/api/v1/projects', { name: 'Mailbox', key: 'MLB', template: 'kanban' })
  await join('MLB', 'ml.ann@x.com'); await join('MLB', 'ml.bob@x.com')
  await call('GET', '/api/v1/me', undefined, 'ml.outsider@x.com')
  let n = 0
  const mail = (h: Record<string, string>, body: string) => writeFileSync(`${dir}/${String(++n).padStart(3, '0')}.eml`,
    [...Object.entries({ 'Message-ID': `<m${n}@mail.test>`, Date: new Date().toUTCString(), To: 'support@x.com', ...h }).map(([k, v]) => `${k}: ${v}`), 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'))
  // R1: a server (message files) and a handler; the secret rules for IMAP
  assert.equal((await call('POST', '/api/v1/admin/mail-servers', { name: 'Inbox', config: { kind: 'imap', host: 'mail.x.com', username: 'support' } })).status, 400)   // no password
  assert.equal((await call('POST', '/api/v1/admin/mail-servers', { name: 'Escape', config: { kind: 'files', folder: '../..' } })).status, 400)
  const srv = (await call('POST', '/api/v1/admin/mail-servers', { name: 'Support box', config: { kind: 'files', folder: '', authservId: 'mx.x.com' } })).body
  assert.deepEqual((await call('POST', '/api/v1/admin/mail-servers/test', { config: { kind: 'files', folder: '' } })).body, { ok: true, unread: 0 })
  assert.equal((await call('POST', '/api/v1/admin/mail-handlers', { name: 'Bad', serverId: srv.id, kind: 'create_or_comment', params: { project: 'MLB', splitRegex: '/x/' } })).status, 400)   // not this handler's
  assert.equal((await call('POST', '/api/v1/admin/mail-handlers', { name: 'Bad', serverId: srv.id, kind: 'create_or_comment', params: {} })).status, 400)                        // no project
  const h = (await call('POST', '/api/v1/admin/mail-handlers', { name: 'Support', serverId: srv.id, kind: 'create_or_comment', delayMinutes: 5, enabled: false,   // Run now only, below
    params: { project: 'MLB', issueType: 'bug', stripQuotes: true, defaultReporter: 'ml.bob@x.com', ccWatchers: true, bulk: 'ignore', verifiedSenders: false } })).body
  const run = async () => { await call('POST', `/api/v1/admin/mail-handlers/${h.id}/run`); await runJobs(); return (await call('GET', '/api/v1/admin/mail-handlers')).body.find((x: any) => x.id === h.id).lastResult }
  // R2, R3: a person's email makes a bug, Cc'd people watch; an unknown sender's goes in as the default reporter
  mail({ From: 'Ann <ml.ann@x.com>', Cc: 'ml.bob@x.com', Subject: 'Printer on fire', 'X-Priority': '1' }, 'It is very hot.\n> earlier text')
  mail({ From: 'stranger@elsewhere.com', Subject: 'Hello from outside' }, 'Who reads this?')
  mail({ From: 'robot@x.com', Subject: 'Out of office', 'Auto-Submitted': 'auto-replied' }, 'Away')   // R5: automatic mail ignored
  let r = await run()
  assert.deepEqual(r.counts, { created: 2, commented: 0, ignored: 1, forwarded: 0, failed: 0 })
  const fire = (await call('GET', `/api/v1/issues/${r.messages[0].key}`)).body
  assert.deepEqual([fire.title, fire.type, fire.priority, fire.description, fire.reporterId], ['Printer on fire', 'bug', 'high', 'It is very hot.', (await call('GET', '/api/v1/me', undefined, 'ml.ann@x.com')).body.id])
  assert.ok(fire.watcherIds.includes((await call('GET', '/api/v1/me', undefined, 'ml.bob@x.com')).body.id))
  const outside = (await call('GET', `/api/v1/issues/${r.messages[1].key}`)).body
  assert.match(outside.description, /\(Sent by stranger@elsewhere.com\)/)
  assert.deepEqual(readdirSync(dir), [])                                     // dealt with: removed
  // R4: a key in the subject comments; a reply to the email that made an item comments on it; quoted lines left out
  mail({ From: 'ml.bob@x.com', Subject: `Re: ${fire.key} Printer on fire` }, 'Fire is out.\n> It is very hot.')
  mail({ From: 'ml.ann@x.com', Subject: 'Re: Printer on fire', 'In-Reply-To': '<m1@mail.test>' }, 'Thanks!')
  r = await run()
  assert.deepEqual(r.counts.commented, 2)
  const comments = (await call('GET', `/api/v1/issues/${fire.key}`)).body.comments.map((c: any) => c.body)
  assert.deepEqual(comments.sort(), ['Fire is out.', 'Thanks!'])
  // R3, R7: no default reporter and an unknown sender: it fails and stays for next time
  await call('PUT', `/api/v1/admin/mail-handlers/${h.id}`, { name: 'Support', serverId: srv.id, kind: 'create_or_comment', delayMinutes: 5, enabled: false, params: { project: 'MLB', verifiedSenders: false } })
  mail({ From: 'nobody@nowhere.com', Subject: 'Lost' }, 'Hm')
  r = await run()
  assert.deepEqual([r.counts.failed, r.messages[0].reason], [1, 'Nobody in Strand has the address nobody@nowhere.com'])
  assert.equal(readdirSync(dir).length, 1)
  // R4: Jira's other handlers: before a marker; comment-only refuses a new item
  const marker = (await call('POST', '/api/v1/admin/mail-handlers', { name: 'Marker', serverId: srv.id, kind: 'comment_before_marker', enabled: false, params: { verifiedSenders: false, splitRegex: '/-{4}\\s*Original Message/' } })).body
  for (const x of readdirSync(dir)) (await import('node:fs')).unlinkSync(`${dir}/${x}`)
  mail({ From: 'ml.ann@x.com', Subject: `${fire.key}` }, 'Above the line\n---- Original Message ----\nbelow')
  mail({ From: 'ml.ann@x.com', Subject: 'No key here' }, 'Nothing to comment on')
  await call('POST', `/api/v1/admin/mail-handlers/${marker.id}/run`); await runJobs()
  const mr = (await call('GET', '/api/v1/admin/mail-handlers')).body.find((x: any) => x.id === marker.id).lastResult
  assert.deepEqual([mr.counts.commented, mr.counts.failed], [1, 1])
  assert.ok((await call('GET', `/api/v1/issues/${fire.key}`)).body.comments.some((c: any) => c.body === 'Above the line'))
  // R3: the spoofing guard (on unless turned off): only a sender the receiving server verified; a forged header below it doesn't count
  const guard = (await call('POST', '/api/v1/admin/mail-handlers', { name: 'Guarded', serverId: srv.id, kind: 'create_each', enabled: false, params: { project: 'MLB' } })).body
  for (const x of readdirSync(dir)) (await import('node:fs')).unlinkSync(`${dir}/${x}`)
  mail({ 'Authentication-Results': 'mx.x.com; spf=pass; dkim=pass header.d=x.com; dmarc=pass header.from=x.com', From: 'ml.ann@x.com', Subject: 'Verified' }, 'ok')
  mail({ From: 'ml.ann@x.com', Subject: 'Not verified' }, 'who knows')
  mail({ 'Authentication-Results': 'evil.example; dmarc=pass header.from=x.com', From: 'ml.ann@x.com', Subject: 'Forged' }, 'Pretending to be Ann')   // not our server's verdict
  await call('POST', `/api/v1/admin/mail-handlers/${guard.id}/run`); await runJobs()
  const gr = (await call('GET', '/api/v1/admin/mail-handlers')).body.find((x: any) => x.id === guard.id).lastResult
  assert.deepEqual(gr.messages.map((x: any) => [x.subject, x.result]), [['Verified', 'created'], ['Not verified', 'failed'], ['Forged', 'failed']])
  assert.equal(gr.messages[1].reason, 'The mail server didn’t verify the sender ml.ann@x.com')
  await call('DELETE', `/api/v1/admin/mail-handlers/${guard.id}`)
  for (const x of readdirSync(dir)) (await import('node:fs')).unlinkSync(`${dir}/${x}`)
  // R8: permissions and records
  assert.equal((await call('GET', '/api/v1/admin/mail-servers', undefined, 'ml.ann@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/admin/mail-servers/${srv.id}`)).status, 409)          // handlers read it
  assert.ok((await pool.query(`select 1 from audit_log where action = 'mail_handler.created'`)).rows.length >= 2)
  for (const x of [h.id, marker.id]) await call('DELETE', `/api/v1/admin/mail-handlers/${x}`)
  assert.equal((await call('DELETE', `/api/v1/admin/mail-servers/${srv.id}`)).status, 204)
  delete process.env.STRAND_MAIL_DIR
})

test('[0607.R3][0607.R4] mail: who is verified, and what a handler keeps of an email\'s text', async () => {
  const { bodyFor, senderVerified } = await import('../src/mail.ts')
  const ar = (line: string): [string, string] => ['authentication-results', `Authentication-Results: ${line}`]
  const v = (lines: [string, string][], from: string, kind: 'imap' | 'graph' | 'files' = 'imap', authservId = 'mx.x.com') =>
    senderVerified({ headerLines: lines.map(([key, line]) => ({ key, line })) } as any, from, { kind, config: { authservId } })
  assert.equal(v([ar('mx.x.com; dmarc=pass header.from=x.com')], 'a@x.com'), true)
  assert.equal(v([ar('mx.x.com; dkim=pass header.d=x.com')], 'a@mail.x.com'), true)
  assert.equal(v([ar('mx.x.com; dkim=pass header.d=other.com')], 'a@x.com'), false)
  assert.equal(v([ar('mx.x.com; dmarc=pass header.from=other.com')], 'a@x.com'), false)                  // DMARC for another domain
  assert.equal(v([ar('mx.x.com; dmarc=fail (dmarc=pass) header.from=x.com')], 'a@x.com'), false)       // a comment doesn't count
  assert.equal(v([ar('evil.example; dmarc=pass header.from=x.com')], 'a@x.com'), false)                // not our server's verdict
  assert.equal(v([ar('evil.example; dmarc=pass header.from=x.com'), ar('mx.x.com; dmarc=pass header.from=x.com')], 'a@x.com'), true)
  assert.equal(v([ar('mx.x.com; dmarc=pass header.from=x.com')], 'a@x.com', 'imap', ''), false)        // no trusted host set: nobody is verified
  assert.equal(v([ar('spf=pass smtp.mailfrom=x.com; dkim=pass header.d=x.com; dmarc=pass action=none header.from=x.com')], 'a@x.com', 'graph'), true)   // Exchange's own, topmost
  assert.equal(v([['x-ms-exchange-organization-authas', 'X-MS-Exchange-Organization-AuthAs: Internal']], 'a@x.com', 'graph'), true)
  assert.equal(v([['x-ms-exchange-organization-authas', 'X-MS-Exchange-Organization-AuthAs: Internal']], 'a@x.com', 'imap'), false)
  assert.equal(v([], 'a@x.com'), false)
  assert.equal(bodyFor('comment_non_quoted', {}, 'Mine\n> theirs\n| also theirs\nMine too'), 'Mine\nMine too')
  assert.equal(bodyFor('comment_entire', {}, 'All\n> of it'), 'All\n> of it')
  assert.equal(bodyFor('create_or_comment', { stripQuotes: true }, 'A\n>b'), 'A')
  assert.equal(bodyFor('comment_before_marker', { splitRegex: '/^--$/m' }, 'Top\n--\nsig'), 'Top')
  assert.equal(bodyFor('comment_before_marker', { splitRegex: '/[/' }, 'Broken regex keeps all'), 'Broken regex keeps all')
})

test('[0608.R1][0608.R2][0608.R3][0608.R4][0608.R5] print and XML export: Jira\'s XML, RSS, Printable, Full content and Word, as each person may read them', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Exports', key: 'XPT', template: 'kanban' })
  await join('XPT', 'xp.mia@x.com')
  const [, doing] = (await call('GET', '/api/v1/projects/XPT')).body.statuses
  const a = (await call('POST', '/api/v1/projects/XPT/issues', { title: 'Export me & you', description: 'The <whole> story', labels: ['api'] })).body
  const b = (await call('POST', '/api/v1/projects/XPT/issues', { title: 'Second' })).body
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: doing.id })
  await call('POST', `/api/v1/issues/${a.key}/comments`, { body: 'Everyone sees this' })
  await call('POST', `/api/v1/issues/${a.key}/comments`, { body: 'Admins only note', visibility: { kind: 'role', role: 'admin' } })
  await call('POST', `/api/v1/issues/${a.key}/remote-links`, { url: 'https://docs.example.com/spec', title: 'The spec' })
  await call('POST', '/api/v1/projects', { name: 'Exports hidden', key: 'XPH', template: 'kanban' })
  const hidden = (await call('POST', '/api/v1/projects/XPH/issues', { title: 'Secret neighbour' })).body
  await call('POST', `/api/v1/issues/${a.key}/links`, { type: 'relates', targetKey: hidden.key })
  const lvl = (await call('POST', '/api/v1/projects/XPT/security-levels', { name: 'Admins only', members: [{ kind: 'role', role: 'admin' }] })).body
  const levelled = (await call('POST', '/api/v1/projects/XPT/issues', { title: 'Behind a level', securityLevelId: lvl.id })).body
  await call('POST', `/api/v1/issues/${a.key}/links`, { type: 'relates', targetKey: levelled.key })
  const get = async (url: string, who = 'owner@x.com') => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-dev-user': who } })
  const jql = encodeURIComponent('project = XPT ORDER BY key')
  // R2: Jira's XML: rss 0.92, an item per work item with Jira's elements; a restricted comment only for those who may read it
  const xml = await get(`/search/export.xml?jql=${jql}`)
  assert.equal(xml.statusCode, 200)
  assert.match(String(xml.headers['content-type']), /application\/xml/)
  assert.match(xml.body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="0.92">/)
  assert.equal(xml.body.match(/<item>/g)?.length, 3)
  assert.match(xml.body, new RegExp(`<key id="${a.id}">${a.key}</key>`))
  assert.match(xml.body, /<summary>Export me &amp; you<\/summary>/)
  assert.match(xml.body, /<description>The &lt;whole&gt; story<\/description>/)
  assert.match(xml.body, new RegExp(`<status id="${doing.id}" description="">${doing.name}</status>`))
  assert.match(xml.body, /<labels><label>api<\/label><\/labels>/)
  assert.match(xml.body, /<created>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000<\/created>/)
  assert.match(xml.body, /Admins only note/)
  const mia = await get(`/search/export.xml?jql=${jql}`, 'xp.mia@x.com')
  assert.ok(mia.body.includes('Everyone sees this') && !mia.body.includes('Admins only note'))
  assert.ok(xml.body.includes(hidden.key) && !mia.body.includes(hidden.key))                    // a linked item Mia can't see isn't named
  assert.ok(xml.body.includes(levelled.key) && !mia.body.includes(levelled.key))                // nor one behind a security level
  assert.ok(!(await get(`/issues/${a.key}/export.html`, 'xp.mia@x.com')).body.includes('Secret neighbour'))
  // RSS, with and without comments
  const rss = await get(`/search/export.rss?jql=${jql}`), rssC = await get(`/search/export.rss?jql=${jql}&comments=1`)
  assert.ok(rss.body.includes(`<guid>${a.key}</guid>`) && !rss.body.includes('Everyone sees this'))
  assert.ok(rssC.body.includes('Everyone sees this'))
  // R3: Printable lists; Full content has description, comments, web links and history
  const printable = await get(`/search/export.html?jql=${jql}`)
  assert.match(String(printable.headers['content-type']), /text\/html/)
  assert.ok(printable.body.includes(a.key) && printable.body.includes(b.key) && !printable.body.includes('Everyone sees this'))
  const full = await get(`/search/export.html?jql=${jql}&full=1`)
  for (const t of ['The &lt;whole&gt; story', 'Everyone sees this', 'The spec', `To do → ${doing.name}`]) assert.ok(full.body.includes(t), t)
  // R4: Word
  const doc = await get(`/issues/${a.key}/export.doc`)
  assert.match(String(doc.headers['content-type']), /application\/msword/)
  assert.match(String(doc.headers['content-disposition']), new RegExp(`${a.key}.doc`))
  assert.ok(doc.body.includes('urn:schemas-microsoft-com:office:word') && doc.body.includes('The spec'))
  assert.equal((await get(`/issues/${a.key}/export.xml`)).body.match(/<item>/g)?.length, 1)
  assert.equal((await get(`/issues/${a.key}/export.html`, 'outsider@x.com')).statusCode, 404)
  // R1: the limit
  await call('PUT', '/api/v1/admin/settings/searchAndBulk', { exportMaxRows: 20000, bulkMaxItems: 200, importMaxRows: 10000, viewsMaxItems: 1 })
  assert.equal((await get(`/search/export.xml?jql=${jql}`)).statusCode, 400)
  await call('PUT', '/api/v1/admin/settings/searchAndBulk', { exportMaxRows: 20000, bulkMaxItems: 200, importMaxRows: 10000, viewsMaxItems: 1000 })
  // R5: audited
  const actions = (await pool.query(`select action from audit_log where action like 'export.%' and action <> 'export.csv'`)).rows.map(r => r.action)
  for (const x of ['export.xml', 'export.rss', 'export.printable', 'export.full-content', 'export.doc']) assert.ok(actions.includes(x), x)
})

test('[0802.R1][0802.R2][0802.R3][0802.R4][0802.R5][0802.R6][0802.R7] the Jira importer: a dry run that writes nothing, an import that keeps keys, people, history and links, run again safely', { skip }, async () => {
  const { createServer } = await import('node:http')
  const { runJobs } = await import('../src/jobs.ts')
  process.env.STRAND_SECRET_KEY ??= 'jira-import-test-secret-key-0802-at-least-32'   // the token is sealed
  // a made-up Jira Data Center (nobody's real data)
  const at = '2026-01-05T09:00:00.000+0000'
  const ann = { key: 'ann', name: 'ann', displayName: 'Ann Jira', emailAddress: 'mig.ann@x.com' }, bob = { key: 'bob', name: 'bob', displayName: 'Bob Jira', emailAddress: 'mig.bob@x.com' }
  const st = (id: string, name: string, key: string) => ({ id, name, statusCategory: { key } })
  const F = { team: 'customfield_10001', sprint: 'customfield_10002', epic: 'customfield_10003', points: 'customfield_10004', rank: 'customfield_10005', mood: 'customfield_10006',
    plink: 'customfield_10008', tstart: 'customfield_10009', tend: 'customfield_10010' }
  const issue = (id: string, key: string, type: { id: string; name: string }, fields: Record<string, unknown>, histories: unknown[] = []) => ({ id, key, fields: {
    summary: key, issuetype: type, status: st('10', 'Backlog', 'new'), priority: { name: 'Medium' }, reporter: ann, creator: ann, created: at, updated: at, labels: [],
    comment: { total: 0, comments: [] }, worklog: { total: 0, worklogs: [] }, watches: { watchCount: 0 }, votes: { votes: 0 }, issuelinks: [], attachment: [], ...fields }, changelog: { histories } })
  const EPIC = { id: '2', name: 'Epic' }, BUG = { id: '1', name: 'Bug' }, SUB = { id: '3', name: 'Sub-task', subtask: true }, INI = { id: '9', name: 'Initiative' }
  const issues: Record<string, unknown[]> = {
    MIG: [
      issue('1001', 'MIG-1', EPIC, { summary: 'Big epic', status: st('11', 'Doing it', 'indeterminate'), [F.plink]: { data: { id: 1009, key: 'MIG-9' } }, [F.tstart]: '2026-03-01', [F.tend]: '2026-05-31' }),
      issue('1002', 'MIG-2', BUG, { summary: 'Broken thing', description: 'h2. Steps\n* *Open* the page for [~ann]\n||A||B||\n|1|2|', status: st('12', 'Shipped', 'done'), resolution: { name: 'Done' }, resolutiondate: '2026-02-02T10:00:00.000+0000',
        assignee: bob, priority: { name: 'High' }, labels: ['api'], components: [{ id: '200' }], fixVersions: [{ id: '100' }], timeoriginalestimate: 7200,
        [F.team]: { value: 'Core' }, [F.mood]: 'happy', [F.points]: 5, [F.rank]: '0|i0001:', [F.sprint]: ['com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,rapidViewId=5,state=ACTIVE,name=Sprint 1]'], [F.epic]: 'MIG-1',
        comment: { total: 2, comments: [{ id: 'c1', author: ann, body: '*First*', created: at }, { id: 'c2', author: bob, body: 'Secret', created: '2026-01-05T10:00:00.000+0000', visibility: { type: 'role', value: 'Administrators' } }] },
        worklog: { total: 1, worklogs: [{ author: bob, timeSpentSeconds: 3600, started: '2026-02-01T10:00:00.000+0000', comment: 'Fixed', created: at }] },
        watches: { watchCount: 1 }, votes: { votes: 1 },
        issuelinks: [{ type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { id: '1005', key: 'MIG-5' } }, { type: { name: 'Relates', outward: 'relates to', inward: 'relates to' }, outwardIssue: { id: '2001', key: 'NXT-1' } }] },
        [{ author: ann, created: '2026-01-06T09:00:00.000+0000', items: [{ field: 'status', from: '10', fromString: 'Backlog', to: '11', toString: 'Doing it' }] },
         { author: bob, created: '2026-01-07T09:00:00.000+0000', items: [{ field: 'status', from: '11', fromString: 'Doing it', to: '12', toString: 'Shipped' }, { field: 'assignee', from: null, fromString: null, to: 'bob', toString: 'Bob Jira' }] }]),
      issue('1005', 'MIG-5', SUB, { summary: 'Small part', parent: { id: '1002', key: 'MIG-2' } }),
      issue('1009', 'MIG-9', INI, { summary: 'The big goal' }),                // after the epic that links to it
    ],
    NXT: [issue('2001', 'NXT-1', BUG, { summary: 'Next door' })],
  }
  const projects: Record<string, unknown> = {
    MIG: { id: '10000', key: 'MIG', name: 'Migrated', description: 'From Jira', lead: ann, issueTypes: [BUG, EPIC, SUB, { id: '4', name: 'Spike' }, INI] },
    NXT: { id: '10001', key: 'NXT', name: 'Next', description: '', lead: ann, issueTypes: [BUG] },
  }
  let base = ''
  const routes = (u: URL): unknown => {
    const p = u.pathname, q = u.searchParams
    if (p === '/rest/api/2/serverInfo') return { version: '9.12.4', serverTitle: 'Made-up Jira' }
    if (p === '/rest/api/2/myself') return { displayName: 'Importer' }
    if (p === '/rest/api/2/field') return [{ id: 'summary', custom: false },
      { id: F.team, name: 'Migration squad', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
      { id: F.sprint, name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      { id: F.epic, name: 'Epic Link', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
      { id: F.points, name: 'Story Points', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
      { id: F.rank, name: 'Rank', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
      { id: F.mood, name: 'Mood', custom: true, schema: { custom: 'com.example:mood' } },
      { id: F.plink, name: 'Parent Link', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-custom-field-parent' } },
      { id: F.tstart, name: 'Target start', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-custom-field-baseline-start' } },
      { id: F.tend, name: 'Target end', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-custom-field-baseline-end' } }]
    const proj = /^\/rest\/api\/2\/project\/([A-Z]+)(\/.*)?$/.exec(p)
    if (proj) {
      const [, k, rest] = proj
      if (!rest) return projects[k!]
      if (rest === '/statuses') return [{ statuses: [st('10', 'Backlog', 'new'), st('11', 'Doing it', 'indeterminate'), st('12', 'Shipped', 'done')] }]
      if (rest === '/versions') return k === 'MIG' ? [{ id: '100', name: '1.0', released: true, releaseDate: '2026-01-10' }] : []
      if (rest === '/components') return k === 'MIG' ? [{ id: '200', name: 'API', lead: bob }] : []
      if (rest === '/role') return k === 'NXT' ? { Elsewhere: 'http://169.254.169.254/latest/meta-data/' }   // an answer pointing elsewhere: not followed
        : { Administrators: `${base}/rest/api/2/project/${k}/role/1`, Developers: `${base}/rest/api/2/project/${k}/role/2` }
      if (rest === '/role/1') return { actors: [{ type: 'atlassian-user-role-actor', name: 'ann', displayName: 'Ann Jira' }] }
      if (rest === '/role/2') return { actors: [{ type: 'atlassian-user-role-actor', name: 'bob', displayName: 'Bob Jira' }] }
    }
    if (p === '/rest/api/2/user') return q.get('username') === 'bob' ? bob : ann
    if (p === '/rest/agile/1.0/board') return { isLast: true, values: q.get('projectKeyOrId') === 'MIG' ? [{ id: 5, type: 'scrum' }] : [] }
    if (p === '/rest/agile/1.0/board/5/sprint') return { isLast: true, values: [{ id: 7, name: 'Sprint 1', state: 'active', goal: 'Ship', originBoardId: 5, startDate: at, endDate: '2026-01-19T09:00:00.000+0000' }] }
    if (p === '/rest/api/2/search') {
      const k = /project = "([A-Z]+)"/.exec(q.get('jql') ?? '')![1]!
      const all = issues[k] ?? []
      if (q.get('maxResults') === '0') return { total: all.length, issues: [] }
      const from = Number(q.get('startAt') ?? 0)
      return { total: all.length, issues: all.slice(from, from + Number(q.get('maxResults'))) }
    }
    const one = /^\/rest\/api\/2\/issue\/([A-Z]+-\d+)\/(watchers|votes|remotelink)$/.exec(p)
    if (one) {
      if (one[2] === 'watchers') return { watchers: one[1] === 'MIG-2' ? [ann] : [] }
      if (one[2] === 'votes') return { voters: one[1] === 'MIG-2' ? [bob] : [] }
      return one[1] === 'MIG-2' ? [{ globalId: 'g1', object: { url: 'https://wiki.example.com/doc', title: 'Design doc' } }] : []
    }
    return undefined
  }
  const seen: string[] = []
  const jiraServer = createServer((q, r) => {
    seen.push(`${q.method} ${q.headers.authorization}`)
    const body = routes(new URL(q.url!, base))
    if (body === undefined) { r.statusCode = 404; r.end('{}'); return }
    r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body))
  })
  await new Promise<void>(ok => jiraServer.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(jiraServer.address() as any).port}`
  try {
    await call('GET', '/api/v1/me'); await call('GET', '/api/v1/me', undefined, 'mig.ann@x.com')   // Ann is in Strand already; Bob isn't
    // R1: cloud metadata addresses in any spelling; private addresses (a company's Jira) are fine
    const { metadataAddress } = await import('../src/jiraImport.ts')
    for (const a of ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe', 'fe80::1', 'fd00:ec2::254', '100.100.100.200', 'not-an-ip:::'])
      assert.equal(metadataAddress(a), true, a)
    for (const a of ['10.0.0.5', '192.168.1.10', '127.0.0.1', '2001:4860::1', '::ffff:10.0.0.5']) assert.equal(metadataAddress(a), false, a)
    // R1: Test; a cloud metadata address is never a Jira
    assert.deepEqual((await call('POST', '/api/v1/admin/jira-import/test', { url: base, token: 'pat-123' })).body, { ok: true, version: '9.12.4', title: 'Made-up Jira', user: 'Importer' })
    assert.deepEqual((await call('POST', '/api/v1/admin/jira-import/test', { url: 'http://169.254.169.254', token: 'pat-123' })).body, { ok: false, error: 'That address isn’t a Jira' })
    assert.equal((await call('POST', '/api/v1/admin/jira-imports', { url: 'http://169.254.169.254', token: 'pat-123', projectKeys: ['X'], dryRun: true })).status, 400)
    assert.equal((await call('POST', '/api/v1/admin/jira-import/test', { url: base, token: 'x' }, 'mig.ann@x.com')).status, 403)
    let token: string | undefined = 'pat-123'                                   // given once; later runs reuse it
    const start = async (keys: string[], dryRun: boolean) => {
      const r = (await call('POST', '/api/v1/admin/jira-imports', { url: base, projectKeys: keys, dryRun, ...(token ? { token } : {}) })).body
      token = undefined
      await runJobs()
      return (await call('GET', `/api/v1/admin/jira-imports/${r.id}`)).body
    }
    // R2: a dry run reports and writes nothing
    const dry = await start(['MIG'], true)
    assert.equal(dry.status, 'done')
    const dp = dry.report.projects[0]
    assert.deepEqual([dp.key, dp.workItems, dp.versions, dp.components, dp.sprints, dp.stop], ['MIG', 4, 1, 1, 1, null])
    assert.deepEqual(dp.issueTypes.map((t: any) => [t.name, t.existing]), [['Bug', true], ['Epic', true], ['Sub-task', true], ['Spike', false], ['Initiative', true]])
    assert.deepEqual(dp.customFields.map((f: any) => [f.name, f.as]).sort(), [['Epic Link', 'Strand’s own'], ['Migration squad', 'new'], ['Mood', 'left out'], ['Parent Link', 'Strand’s own'], ['Rank', 'Strand’s own'], ['Sprint', 'Strand’s own'], ['Story Points', 'Strand’s own'], ['Target end', 'Strand’s own'], ['Target start', 'Strand’s own']])
    assert.deepEqual([dry.report.people.matched, dry.report.people.new], [1, 1])
    assert.equal((await pool.query(`select 1 from projects where key = 'MIG'`)).rows.length, 0)
    // R3, R4, R5: the import
    const run = await start(['MIG'], false)
    assert.equal(run.status, 'done', JSON.stringify(run.report))
    const rec = run.report.projects[0]
    assert.equal(rec.error, undefined)
    assert.deepEqual(rec.reconciliation.filter((x: any) => !x.same), [])
    const p = (await call('GET', '/api/v1/projects/MIG')).body
    assert.deepEqual([p.name, p.description, p.statuses.map((x: any) => x.name)], ['Migrated', 'From Jira', ['Backlog', 'Doing it', 'Shipped']])
    const keys = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = MIG ORDER BY key')}`)).body.items.map((i: any) => i.key)
    assert.deepEqual(keys, ['MIG-1', 'MIG-2', 'MIG-5', 'MIG-9'])
    // spec 0803 R7: Advanced Roadmaps' Parent Link (to an initiative imported after its epic) and Target dates
    const mig1 = (await call('GET', '/api/v1/issues/MIG-1')).body, mig9 = (await call('GET', '/api/v1/issues/MIG-9')).body
    assert.deepEqual([mig9.type, mig1.parentLinkId, mig1.startDate, mig1.dueDate, p.initiatives], ['initiative', mig9.id, '2026-03-01', '2026-05-31', true])
    const b = (await call('GET', '/api/v1/issues/MIG-2')).body
    const people = (await pool.query(`select email, active from users where email in ('mig.ann@x.com', 'mig.bob@x.com') order by email`)).rows
    assert.deepEqual(people, [{ email: 'mig.ann@x.com', active: true }, { email: 'mig.bob@x.com', active: false }])   // Bob made, deactivated
    const bobId = (await pool.query(`select id from users where email = 'mig.bob@x.com'`)).rows[0].id
    assert.deepEqual([b.title, b.type, p.statuses.find((x: any) => x.id === b.statusId).name, b.resolution, b.assigneeId, b.labels, b.estimate, b.timeEstimate],
      ['Broken thing', 'bug', 'Shipped', 'Done', bobId, ['api'], 5, 120])
    assert.equal(b.priority, (await call('GET', '/api/v1/priorities')).body.find((x: any) => x.name === 'High').key)
    assert.equal(b.parentId, (await call('GET', '/api/v1/issues/MIG-1')).body.id)                         // Epic Link
    assert.equal((await call('GET', '/api/v1/issues/MIG-5')).body.parentId, b.id)                           // a sub-task's parent
    assert.deepEqual([p.releases.find((r: any) => r.id === b.fixReleaseIds[0]).name, p.components?.find((x: any) => x.id === b.componentIds[0])?.name ?? 'API'], ['1.0', 'API'])
    const sprint = (await pool.query('select name, state, goal from sprints where id = $1', [b.sprintId])).rows[0]
    assert.deepEqual(sprint, { name: 'Sprint 1', state: 'active', goal: 'Ship' })
    const team = Object.values(b.custom)
    assert.deepEqual(team, ['Core'])
    const detail = (await call('GET', `/api/v1/issues/MIG-2?expand=comments,activity,worklogs,watchers,links`)).body
    assert.deepEqual(detail.comments.map((c: any) => [c.body, c.visibility ?? null]), [['**First**', null], ['Secret', { kind: 'role', role: 'admin' }]])   // Jira's markup as Markdown (spec 0805)
    const annName = (await pool.query(`select name from users where email = 'mig.ann@x.com'`)).rows[0].name
    assert.equal(detail.description, `## Steps\n- **Open** the page for @${annName}\n| A | B |\n| --- | --- |\n| 1 | 2 |`)   // [0805.R1]
    assert.deepEqual(detail.worklogs.map((w: any) => [w.minutes, w.note, w.userId]), [[60, 'Fixed', bobId]])
    assert.equal(detail.watcherIds.length, 1)
    const hist = detail.activity.filter((x: any) => x.field === 'statusId').map((x: any) => [x.fromString, x.toString]).reverse()
    assert.deepEqual(hist, [['Backlog', 'Doing it'], ['Doing it', 'Shipped']])
    assert.ok(detail.activity.find((x: any) => x.field === 'statusId' && x.toString === 'Shipped').toValue === b.statusId)   // Strand's own status id: reports read it
    assert.equal((await pool.query('select count(*)::int as n from issue_votes where issue_id = $1', [b.id])).rows[0].n, 1)
    assert.deepEqual((await call('GET', `/api/v1/issues/MIG-2/remote-links`)).body.map((l: any) => l.title), ['Design doc'])
    assert.ok(detail.links.some((l: any) => l.key === 'MIG-5'))
    assert.equal(run.report.waitingLinks, 1)                                                                 // NXT-1 isn't in yet
    // R6: again: nothing twice; the next project brings its link
    const again = await start(['MIG'], false)
    assert.equal(again.report.projects[0].added, 0)
    const nxt = await start(['NXT'], false)
    assert.equal(nxt.report.waitingLinks, 0)
    assert.ok((await call('GET', '/api/v1/issues/MIG-2?expand=links')).body.links.some((l: any) => l.key === 'NXT-1'))
    // a new item continues after Jira's numbers
    assert.equal((await call('POST', '/api/v1/projects/MIG/issues', { title: 'After import' })).body.key, 'MIG-10')
    // the token went to Jira (only GETs) and is never returned
    assert.ok(seen.every(x => x === 'GET Bearer pat-123'))
    assert.ok(!JSON.stringify((await call('GET', '/api/v1/admin/jira-imports')).body).includes('pat-123'))
  } finally { jiraServer.close() }
})

test('[0803.R1] initiatives: a project turns them on; only epics take a Parent Link, to an initiative in any project; history and JQL', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Portfolio', key: 'PFO', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Delivery', key: 'DLV', template: 'kanban' })
  await join('DLV', 'pf.dev@x.com')
  assert.equal((await call('POST', '/api/v1/projects/PFO/issues', { title: 'Too early', type: 'initiative' })).status, 400)   // not on yet
  assert.deepEqual((await call('PUT', '/api/v1/projects/PFO/initiatives', { enabled: true })).body, { enabled: true })
  assert.equal((await call('PUT', '/api/v1/projects/PFO/initiatives', { enabled: true }, 'pf.dev@x.com')).status, 404)       // not a member of it
  const p = (await call('GET', '/api/v1/projects/PFO')).body
  assert.ok(p.initiatives && p.types.some((t: any) => t.key === 'initiative' && t.name === 'Initiative'))
  const ini = (await call('POST', '/api/v1/projects/PFO/issues', { title: 'Grow revenue', type: 'initiative' })).body
  const epic = (await call('POST', '/api/v1/projects/DLV/issues', { title: 'Checkout', type: 'epic', parentLinkId: ini.id })).body
  assert.equal(epic.parentLinkId, ini.id)                                                           // across projects
  const story = (await call('POST', '/api/v1/projects/DLV/issues', { title: 'Pay button', parentId: epic.id })).body
  const why = async (r: Promise<any>) => { const x = await r; return [x.status, Object.keys(x.body.errors ?? {})[0]] }
  assert.deepEqual(await why(call('PATCH', `/api/v1/issues/${story.key}`, { parentLinkId: ini.id })), [400, 'parentLinkId'])           // only epics
  assert.deepEqual(await why(call('PATCH', `/api/v1/issues/${story.key}`, { parentId: ini.id })), [400, 'parentId'])                   // an initiative is no parent
  assert.deepEqual(await why(call('PATCH', `/api/v1/issues/${epic.key}`, { parentLinkId: story.id })), [400, 'parentLinkId'])          // not an initiative
  const bare = (await call('POST', '/api/v1/projects/DLV/issues', { title: 'Bare epic', type: 'epic', parentLinkId: ini.id })).body
  assert.deepEqual(await why(call('PATCH', `/api/v1/issues/${bare.key}`, { type: 'story' })), [400, 'parentLinkId'])                   // an epic in an initiative stays an epic
  assert.deepEqual(await why(call('PATCH', `/api/v1/issues/${ini.key}`, { type: 'task' })), [400, 'type'])                             // an initiative with epics stays one
  assert.deepEqual(await why(call('POST', '/api/v1/projects/PFO/issues', { title: 'x', type: 'initiative', parentId: ini.id })), [400, 'parentId'])
  assert.equal((await call('POST', '/api/v1/projects/DLV/issues', { title: 'Dev epic', type: 'epic', parentLinkId: ini.id }, 'pf.dev@x.com')).status, 400)   // an initiative they can't see
  // history and JQL
  await call('PATCH', `/api/v1/issues/${epic.key}`, { parentLinkId: null })
  await call('PATCH', `/api/v1/issues/${epic.key}`, { parentLinkId: ini.id })
  const hist = (await call('GET', `/api/v1/issues/${epic.key}/activity?limit=20`)).body.items.filter((a: any) => a.field === 'parentLinkId').map((a: any) => [a.fromString, a.toString])
  assert.deepEqual(hist, [[null, ini.key], [ini.key, null]])
  const keys = async (jql: string) => (await call('GET', `/api/v1/search?jql=${encodeURIComponent(jql)}`)).body.items.map((i: any) => i.key).sort()
  assert.deepEqual(await keys(`"Parent Link" = ${ini.key}`), [epic.key, bare.key].sort())
  assert.deepEqual(await keys(`project = DLV AND "Parent Link" is empty`), [story.key])
  assert.deepEqual((await call('GET', '/api/v1/initiatives?query=revenue')).body.map((i: any) => i.key), [ini.key])
  assert.deepEqual((await call('GET', '/api/v1/initiatives', undefined, 'pf.dev@x.com')).body, [])
  // off again only without initiatives
  assert.equal((await call('PUT', '/api/v1/projects/PFO/initiatives', { enabled: false })).status, 409)
})

test('[0803.R2][0803.R3][0803.R4][0803.R6] plans: from projects or a saved view, the timeline as each person sees it, dependencies, releases, sprints, live edits', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Plan goals', key: 'PLG', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Plan work', key: 'PLW', template: 'scrum' })
  await call('POST', '/api/v1/projects', { name: 'Plan secret', key: 'PLS', template: 'kanban' })
  await join('PLW', 'pl.dev@x.com')
  await call('PUT', '/api/v1/projects/PLG/initiatives', { enabled: true })
  const mk = async (key: string, b: object) => (await call('POST', `/api/v1/projects/${key}/issues`, b)).body
  const ini = await mk('PLG', { title: 'Win the market', type: 'initiative' })
  const epic = await mk('PLW', { title: 'Mobile app', type: 'epic', parentLinkId: ini.id, startDate: '2026-12-01', dueDate: '2027-01-31' })
  const a = await mk('PLW', { title: 'Login screen', parentId: epic.id, startDate: '2026-12-01', dueDate: '2026-12-20' })
  const b = await mk('PLW', { title: 'Push messages', parentId: epic.id, startDate: '2026-12-10', dueDate: '2027-01-10' })
  await mk('PLW', { title: 'A sub-item', parentId: a.id })                                         // not on plans
  const [, , done] = (await call('GET', '/api/v1/projects/PLW')).body.statuses.slice(-3)
  const old = await mk('PLW', { title: 'Finished long ago' })
  await call('PATCH', `/api/v1/issues/${old.key}`, { statusId: (await call('GET', '/api/v1/projects/PLW')).body.statuses.find((s: any) => s.category === 'done').id })
  await pool.query(`set session_replication_role = replica; update issues set resolved_at = now() - interval '40 days', updated_at = now() - interval '40 days' where id = '${old.id}'; set session_replication_role = origin`)   // past the resolution trigger
  await call('POST', `/api/v1/issues/${a.key}/links`, { type: 'blocks', targetKey: b.key })
  await call('POST', '/api/v1/projects/PLW/releases', { name: '1.0', releaseDate: '2027-01-15' })
  await call('POST', '/api/v1/projects/PLW/sprints', { name: 'Sprint 9' })
  await mk('PLS', { title: 'Hidden from the dev' })
  void done
  // R2: a plan from projects
  assert.equal((await call('POST', '/api/v1/plans', { name: 'Nothing' })).status, 400)
  const plan = (await call('POST', '/api/v1/plans', { name: 'Mobile 2027', projectKeys: ['PLW', 'PLS'] })).body
  assert.deepEqual(plan.projects.map((p: any) => p.key), ['PLS', 'PLW'])
  assert.equal((await call('POST', '/api/v1/plans', { name: 'mobile 2027', projectKeys: ['PLW'] })).status, 409)
  // R3: the timeline: the items, the initiative its epic belongs to (from another project), no sub-items, no long-finished work
  const tl = (await call('GET', `/api/v1/plans/${plan.id}/timeline`)).body
  const titles = tl.items.map((i: any) => i.title).sort()
  assert.deepEqual(titles, ['Hidden from the dev', 'Login screen', 'Mobile app', 'Push messages', 'Win the market'])
  assert.deepEqual(tl.dependencies, [{ fromId: a.id, toId: b.id }])
  assert.deepEqual([tl.releases.map((r: any) => r.name), tl.sprints.map((s: any) => s.name), tl.truncated], [['1.0'], ['Sprint 9'], false])
  // only what each person sees: the developer doesn't see PLS (nor the initiative's project)
  const dev = (await call('GET', `/api/v1/plans/${plan.id}/timeline`, undefined, 'pl.dev@x.com')).body
  assert.deepEqual(dev.items.map((i: any) => i.title).sort(), ['Login screen', 'Mobile app', 'Push messages'])
  const seenByDev = (await call('GET', '/api/v1/plans', undefined, 'pl.dev@x.com')).body.find((p: any) => p.id === plan.id)
  assert.deepEqual([seenByDev.projects.map((p: any) => p.key), seenByDev.projectIds.length], [['PLW'], 1])     // not the project they can't see
  // R2: only the owner (or a system administrator) changes it
  assert.equal((await call('PATCH', `/api/v1/plans/${plan.id}`, { name: 'Mine now' }, 'pl.dev@x.com')).status, 403)
  assert.equal((await call('DELETE', `/api/v1/plans/${plan.id}`, undefined, 'pl.dev@x.com')).status, 403)
  // R2: from a saved view; R3: the limit
  const view = (await call('POST', '/api/v1/views', { name: 'Epic work', filters: { q: '', resolution: 'open', jql: `project = PLW AND "Epic Link" = ${epic.key}`.replace('"Epic Link"', 'parent') } })).body
  const byView = (await call('POST', '/api/v1/plans', { name: 'By view', viewId: view.id })).body
  assert.equal((await call('GET', `/api/v1/plans/${byView.id}`, undefined, 'pl.dev@x.com')).body.viewName, null)   // a private view's name stays private
  assert.deepEqual((await call('GET', `/api/v1/plans/${byView.id}/timeline`)).body.items.map((i: any) => i.title).sort(), ['Login screen', 'Push messages'])
  await call('PUT', '/api/v1/admin/settings/plans', { maxItems: 100 })
  assert.equal((await call('GET', `/api/v1/plans/${plan.id}/timeline`)).body.maxItems, 100)
  await call('PUT', '/api/v1/admin/settings/plans', { maxItems: 5000 })
  // R6: a drag is an edit: the item's dates change, with history
  await call('PATCH', `/api/v1/issues/${b.key}`, { startDate: '2026-12-21', dueDate: '2027-01-12' })
  const after = (await call('GET', `/api/v1/plans/${plan.id}/timeline`)).body.items.find((i: any) => i.id === b.id)
  assert.deepEqual([after.startDate, after.dueDate], ['2026-12-21', '2027-01-12'])
  assert.equal((await call('PATCH', `/api/v1/plans/${plan.id}`, { doneDays: 60 })).body.doneDays, 60)
  assert.ok((await call('GET', `/api/v1/plans/${plan.id}/timeline`)).body.items.some((i: any) => i.id === old.id))   // within 60 days now
  assert.equal((await call('DELETE', `/api/v1/plans/${plan.id}`)).status, 204)
})

test('[0510.R1][0510.R2] bulk watch and stop watching; bulk transition: each item through its own transition, with fields and a comment, every outcome reported', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Bulk moves', key: 'BKT', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Bulk other', key: 'BKO', template: 'kanban' })
  await join('BKT', 'bk.viewer@x.com', 'viewer'); await join('BKT', 'bk.dev@x.com')
  const mk = async (key: string, title: string) => (await call('POST', `/api/v1/projects/${key}/issues`, { title })).body
  const [a, b, c] = [await mk('BKT', 'One'), await mk('BKT', 'Two'), await mk('BKO', 'Elsewhere')]
  // R1: watch and stop watching, for anyone who can see them (a viewer too)
  assert.deepEqual((await call('POST', '/api/v1/issues/bulk/watch', { issues: [a.key, b.key], watching: true }, 'bk.viewer@x.com')).body, { count: 2 })
  const viewer = (await call('GET', '/api/v1/me', undefined, 'bk.viewer@x.com')).body.id
  const watching = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body.watcherIds.includes(viewer)
  assert.deepEqual([await watching(a.key), await watching(b.key)], [true, true])
  await call('POST', '/api/v1/issues/bulk/watch', { issues: [a.key], watching: false }, 'bk.viewer@x.com')
  assert.deepEqual([await watching(a.key), await watching(b.key)], [false, true])
  assert.equal((await call('POST', '/api/v1/issues/bulk/watch', { issues: [c.key], watching: true }, 'bk.viewer@x.com')).status, 404)   // not their project
  // R2: to Done in both projects, with a resolution and a comment; a viewer can't transition
  const done = (await call('GET', '/api/v1/projects/BKT')).body.statuses.find((x: any) => x.category === 'done')
  await call('PATCH', `/api/v1/issues/${b.key}`, { statusId: done.id })
  const r = (await call('POST', '/api/v1/issues/bulk/transition', { issues: [a.key, b.key, c.key, 'BKT-999'], toStatus: done.name, fields: { resolution: 'Done' }, comment: 'Closing in bulk' })).body
  assert.deepEqual(r.results.map((x: any) => [x.key, x.outcome]), [[a.key, 'done'], [b.key, 'unchanged'], [c.key, 'done'], ['BKT-999', 'failed']])
  assert.equal(r.done, 2)
  const after = (await call('GET', `/api/v1/issues/${a.key}`)).body
  assert.deepEqual([after.statusId, after.resolution, after.comments.at(-1).body], [done.id, 'Done', 'Closing in bulk'])
  // a status no transition reaches is skipped with the reason; a failing item doesn't stop the rest
  const s2 = (await call('POST', '/api/v1/issues/bulk/transition', { issues: [a.key], toStatus: 'Nowhere' })).body
  assert.deepEqual(s2.results.map((x: any) => x.outcome), ['skipped'])
  assert.match(s2.results[0].reason, /no transition from .* to Nowhere/)
  const v = (await call('POST', '/api/v1/issues/bulk/transition', { issues: [a.key], toStatus: 'To do' }, 'bk.viewer@x.com')).body
  assert.deepEqual(v.results.map((x: any) => x.outcome), ['failed'])
})

test('[0705.R2] a webhook never reaches private addresses, whatever its name resolves to', { skip }, async () => {
  const { privateAddress, urlProblem, fillUrl } = await import('../src/webhooks.ts')
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '2002:7f00:1::', '[::1]', 'not-an-ip::zz'])
    assert.equal(privateAddress(a), true, a)
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(privateAddress(a), false, a)
  assert.equal(urlProblem('https://hooks.example.com/{issue.key}'), null)
  for (const u of ['https://[::ffff:7f00:1]/x', 'https://[::ffff:a9fe:a9fe]/latest', 'https://[64:ff9b::7f00:1]/x']) assert.ok(urlProblem(u), u)
  assert.equal(fillUrl('https://h.example/{issue.key}/${project.key}', { issue: { key: 'A B/1', fields: { project: { key: 'AB' } } } }), 'https://h.example/A%20B%2F1/AB')
})

test('[0706.R1][0706.R2][0706.R3] rate limiting counts every request but the web app’s: a script with a developer sign-in, and anonymous requests as one', { skip }, async () => {
  const put = (v: object) => call('PUT', '/api/v1/admin/settings/rateLimiting', v)
  const { clearSettingsCache } = await import('../src/settings.ts')
  const script = async (who = 'rl.script@x.com') => app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-dev-user': who } })      // no Origin: a script (the developer login counts as a sign-in)
  const anon = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'rl.nobody', password: 'x' } })
  await script()
  assert.equal((await put({ enabled: true, mode: 'limit', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [] })).status, 200)
  clearSettingsCache()
  try {
    // R1: a script with a developer sign-in is limited; the web app (its Origin, or same-origin) never is
    assert.deepEqual([(await script()).statusCode, (await script()).statusCode, (await script()).statusCode], [200, 200, 429])
    for (let n = 0; n < 4; n++) assert.equal((await call('GET', '/api/v1/me', undefined, 'rl.script@x.com')).status, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-dev-user': 'rl.script@x.com', 'sec-fetch-site': 'same-origin' } })).statusCode, 200)
    // R2: anonymous requests count together, as Anonymous
    const a = [await anon(), await anon(), await anon()]
    assert.deepEqual(a.map(r => r.statusCode), [401, 401, 429])
    await pool.query('delete from login_failures')
    const list = (await call('GET', '/api/v1/admin/rate-limits/limited')).body
    assert.ok(list.some((x: any) => x.userId === null && x.name === 'Anonymous'))
    assert.ok(list.some((x: any) => x.email === 'rl.script@x.com'))
    // R2: an exemption for Anonymous lifts it
    await put({ enabled: true, mode: 'limit', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [{ userId: 'anonymous', mode: 'unlimited' }] }); clearSettingsCache()
    assert.equal((await anon()).statusCode, 401)
    assert.equal((await put({ enabled: true, mode: 'limit', requests: 1, intervalSeconds: 3600, burst: 2, exemptions: [{ userId: 'someone', mode: 'unlimited' }] })).status, 400)
  } finally {
    await put({ enabled: false, mode: 'limit', requests: 100, intervalSeconds: 60, burst: 100, exemptions: [] }); clearSettingsCache()
    await pool.query('delete from login_failures')
  }
})


test('[0106.R1][0106.R2][0106.R3] deleting a group its comments are restricted to: they move to the group chosen, or the delete is refused; the group leaves notification schemes', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Swapped', key: 'SWP', template: 'kanban' })
  await join('SWP', 'swp.ann@x.com'); await join('SWP', 'swp.bob@x.com')
  const bob = (await call('GET', '/api/v1/me', undefined, 'swp.bob@x.com')).body.id
  const old = (await call('POST', '/api/v1/groups', { name: 'swp-old' }, 'swp.ann@x.com')).body
  const next = (await call('POST', '/api/v1/groups', { name: 'swp-next' })).body
  await call('POST', `/api/v1/groups/${next.id}/members`, { userIds: [bob] })
  const item = (await call('POST', '/api/v1/projects/SWP/issues', { title: 'Hush' })).body
  await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'old group only', visibility: { kind: 'group', id: old.id } }, 'swp.ann@x.com')
  const scheme = (await call('GET', '/api/v1/admin/notification-schemes')).body.find((s: any) => s.isDefault)
  await call('POST', `/api/v1/admin/notification-schemes/${scheme.id}/entries`, { event: 'issue_commented', recipient: 'group', value: old.id })
  // R1: the count, for its owner; others don't get it
  assert.equal((await call('GET', `/api/v1/groups/${old.id}`, undefined, 'swp.ann@x.com')).body.restrictedComments, 1)
  assert.equal((await call('GET', `/api/v1/groups/${old.id}`, undefined, 'swp.bob@x.com')).body.restrictedComments, null)
  const bodies = async (w: string) => (await call('GET', `/api/v1/issues/${item.key}/comments`, undefined, w)).body.items.map((c: any) => c.body)
  assert.deepEqual(await bodies('swp.bob@x.com'), [])
  // without a group to move them to, or to itself, it's refused
  const refused = await call('DELETE', `/api/v1/groups/${old.id}`, undefined, 'swp.ann@x.com')
  assert.deepEqual([refused.status, refused.body.error], [409, '1 comment is restricted to swp-old: choose a group to move it to'])
  assert.equal((await call('DELETE', `/api/v1/groups/${old.id}?swapGroupId=${old.id}`, undefined, 'swp.ann@x.com')).status, 400)
  assert.equal((await call('DELETE', `/api/v1/groups/${old.id}?swapGroupId=${next.id}`, undefined, 'swp.ann@x.com')).status, 403)   // not her group
  await call('POST', `/api/v1/groups/${next.id}/members`, { userIds: [(await call('GET', '/api/v1/me', undefined, 'swp.ann@x.com')).body.id] })
  // moved: swp-next's people read it now
  assert.equal((await call('DELETE', `/api/v1/groups/${old.id}?swapGroupId=${next.id}`, undefined, 'swp.ann@x.com')).status, 204)
  assert.deepEqual(await bodies('swp.bob@x.com'), ['old group only'])
  assert.equal((await call('GET', `/api/v1/groups/${next.id}`)).body.restrictedComments, 1)
  // R2: gone from the notification scheme
  assert.equal((await call('GET', `/api/v1/admin/notification-schemes/${scheme.id}`)).body.entries.some((e: any) => e.value === old.id), false)
  // R3: the audit entry says where they went
  const [entry] = (await call('GET', '/api/v1/audit?action=group.deleted')).body.items.filter((e: any) => e.targetId === old.id)
  assert.deepEqual(entry.after, { commentsMovedTo: 'swp-next', comments: 1 })
  // a group nobody restricted comments to deletes as before
  const empty = (await call('POST', '/api/v1/groups', { name: 'swp-empty' })).body
  assert.equal((await call('DELETE', `/api/v1/groups/${empty.id}`)).status, 204)
})

test('[0609.R1][0609.R2][0609.R3][0609.R4][0609.R5] text search as Jira’s: stemmed words, common words left out, phrases, wildcards, AND OR NOT, fuzzy; comments as each reader may see them; a custom field; quick search; another language re-indexes', { skip }, async () => {
  const { runJobs } = await import('../src/jobs.ts')
  await call('POST', '/api/v1/projects', { name: 'Text search', key: 'TXS', template: 'kanban' })
  await join('TXS', 'txs.dev@x.com')
  const cause = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Root cause', kind: 'text', context: { projectKeys: ['TXS'] } })).body
  const mk = async (title: string, description: string, custom = {}) => (await call('POST', '/api/v1/projects/TXS/issues', { title, description, custom })).body
  const a = await mk('Customized login page', 'The page crashes when VSX will not start')
  await mk('Calculate totals', 'Roaming users see foam')
  const c = await mk('Deploy pipeline', 'Nothing here')
  await mk('Slow search', '', { [cause.id]: 'memory leak in the parser' })
  await call('POST', `/api/v1/issues/${c.key}/comments`, { body: 'Hotfix shipped' })
  await call('POST', `/api/v1/issues/${c.key}/comments`, { body: 'Secret rollout plan', visibility: { kind: 'role', role: 'admin' } })
  const find = async (jql: string, who?: string) => {
    const r = await call('GET', `/api/v1/search?jql=${encodeURIComponent(`project = TXS AND ${jql} ORDER BY key`)}&limit=50`, undefined, who)
    assert.equal(r.status, 200, `${jql}: ${JSON.stringify(r.body)}`)
    return r.body.items.map((x: any) => x.title)
  }
  // R1: any form of a word; common words left out ("will" in "VSX will crash" too); only common words find nothing
  assert.deepEqual(await find('summary ~ "customize"'), ['Customized login page'])
  assert.deepEqual(await find('text ~ "VSX will crash"'), ['Customized login page'])
  assert.deepEqual(await find('text ~ "the"'), [])
  assert.deepEqual(await find('summary ~ "page CRASH"'), [])                      // crash is in the description, not the summary
  // R2: phrases, wildcards anywhere (the words as written), OR, NOT and only-exclusions, fuzzy
  assert.deepEqual(await find('description ~ "\\"page crashes\\""'), ['Customized login page'])
  assert.deepEqual(await find('description ~ "\\"crashes page\\""'), [])
  assert.deepEqual(await find('summary ~ "*cula*"'), ['Calculate totals'])
  assert.deepEqual(await find('summary ~ "customiz*"'), ['Customized login page'])
  assert.deepEqual(await find('summary ~ "calculate OR deploy"'), ['Calculate totals', 'Deploy pipeline'])
  assert.deepEqual(await find('summary ~ "page -login"'), [])
  assert.deepEqual(await find('summary ~ "pipeline NOT login"'), ['Deploy pipeline'])
  assert.deepEqual(await find('summary ~ "-login"'), [])
  assert.deepEqual(await find('description ~ "roam~"'), ['Calculate totals'])
  assert.deepEqual(await find('description ~ "foem~"'), ['Calculate totals'])
  assert.equal((await call('GET', `/api/v1/search?jql=${encodeURIComponent('summary ~ "(login"')}`)).status, 400)
  // R3: comments, each as its reader may see it; text covers them; a custom field; !~
  assert.deepEqual(await find('comment ~ "hotfix"', 'txs.dev@x.com'), ['Deploy pipeline'])
  assert.deepEqual(await find('comment ~ "rollout"'), ['Deploy pipeline'])
  assert.deepEqual(await find('comment ~ "rollout"', 'txs.dev@x.com'), [])
  assert.deepEqual(await find('text ~ "rollout"', 'txs.dev@x.com'), [])
  assert.deepEqual(await find('"Root cause" ~ "leaks"'), ['Slow search'])
  assert.deepEqual(await find('text ~ "parser"'), ['Slow search'])
  assert.deepEqual(await find('summary !~ "customize"'), ['Calculate totals', 'Deploy pipeline', 'Slow search'])
  // R4: quick search, and what isn't Jira's syntax taken as words
  const quick = async (q: string) => (await call('GET', `/api/v1/search?q=${encodeURIComponent(q)}&limit=50`)).body.items.filter((x: any) => x.key.startsWith('TXS-')).map((x: any) => x.title)
  assert.deepEqual(await quick('customizing'), ['Customized login page'])
  assert.deepEqual(await quick('login ('), ['Customized login page'])
  assert.deepEqual(await quick(a.key), ['Customized login page'])
  // R5: Other: exact words; the change re-indexes in the background
  assert.equal((await call('PUT', '/api/v1/admin/settings/search', { indexingLanguage: 'other' })).status, 200)
  await runJobs()
  assert.deepEqual(await find('summary ~ "customize"'), [])
  assert.deepEqual(await find('summary ~ "customized"'), ['Customized login page'])
  assert.deepEqual(await find('comment ~ "shipped"'), ['Deploy pipeline'])
  await call('PUT', '/api/v1/admin/settings/search', { indexingLanguage: 'english' })
  await runJobs()
  assert.deepEqual(await find('comment ~ "ship"'), ['Deploy pipeline'])
})

test('[0310.R1][0310.R2][0310.R3] project templates: Basic software and the business templates bring their workflow, work types and a board; every workspace has their schemes', { skip }, async () => {
  const expect: Record<string, [string, string[], string[]]> = {
    basic:   ['Basic software development', ['To do', 'In progress', 'In review', 'Done'], ['epic', 'task', 'bug', 't-improvement', 't-newfeature']],
    task:    ['Task management', ['To do', 'Done'], ['task']],
    project: ['Project management', ['To do', 'In progress', 'Done'], ['task']],
    process: ['Process management', ['Open', 'In progress', 'Under review', 'Approved', 'Done'], ['task']],
  }
  for (const [template, [scheme, statuses, types]] of Object.entries(expect)) {
    const key = `TP${template.slice(0, 4).toUpperCase()}`
    const made = await call('POST', '/api/v1/projects', { name: `Template ${template}`, key, template })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const p = made.body
    assert.equal(p.template, template)
    assert.deepEqual(p.statuses.map((s: any) => s.name), statuses, template)
    assert.deepEqual(p.types.map((t: any) => t.key), types, template)
    assert.equal(p.boards.map((b: any) => b.type).join(), 'kanban', template)                       // R2: a board, never sprints
    const schemes = (await call('GET', '/api/v1/workflow-schemes')).body
    assert.equal(schemes.find((s: any) => s.id === p.workflowSchemeId)?.name, scheme, template)
    // an item of the template's types, in its first status
    const item = (await call('POST', `/api/v1/projects/${key}/issues`, { title: 'First', type: types.at(-1) })).body
    assert.equal(p.statuses.find((s: any) => s.id === item.statusId)?.name, statuses[0])
  }
  assert.equal((await call('POST', '/api/v1/projects', { name: 'Nope', key: 'TPNO', template: 'service' })).status, 400)
  // R3: a new workspace gets the schemes too
  const { db } = await import('../src/db.ts')
  const [ws] = await db.query<{ id: string }>(`insert into workspaces (name) values ('Templates test') returning id`)
  const names = (await db.query<{ name: string }>('select name from workflow_schemes where workspace_id = $1 order by name', [ws!.id])).map(r => r.name)
  assert.deepEqual(names, ['Basic software development', 'Kanban', 'Process management', 'Project management', 'Scrum', 'Task management'])
  await db.query('delete from workspaces where id = $1', [ws!.id])
})

test('[0412.R1][0412.R2][0412.R3] a number field as the estimation statistic; remaining-estimate tracking; the team’s time zone; a custom field’s change kept in the history', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Valued', key: 'VAL', template: 'scrum' })
  const value = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Business value', kind: 'number', context: { projectKeys: ['VAL'] } })).body
  const note = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Value note', kind: 'text', context: { projectKeys: ['VAL'] } })).body
  const s1 = (await call('POST', '/api/v1/projects/VAL/sprints', { name: 'Valued 1' })).body
  const board = `/api/v1/boards/${s1.boardId}`
  // R1: a number field, not a text one
  assert.equal((await call('PATCH', board, { estimation: 'field', estimationFieldId: note.id })).status, 400)
  assert.equal((await call('PATCH', board, { estimation: 'field' })).status, 400)
  const set = (await call('PATCH', board, { estimation: 'field', estimationFieldId: value.id })).body
  assert.deepEqual([set.estimation, set.estimationFieldId, set.timeTracking], ['field', value.id, 'none'])
  const mk = async (title: string, v?: number) => (await call('POST', '/api/v1/projects/VAL/issues', { title, sprintId: s1.id, ...(v != null ? { custom: { [value.id]: v } } : {}) })).body
  const a = await mk('A', 8); await mk('B', 5); await mk('C')
  const started = (await call('POST', `/api/v1/projects/VAL/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })).body
  assert.deepEqual([started.estimation, started.estimationFieldId, Number(started.committed)], ['field', value.id, 13])
  const panels = (await call('GET', `${board}/panels`)).body
  assert.equal(panels.epicStats.none.estimate, 13)
  // a custom field's change is kept with its value, field by field
  await call('PATCH', `/api/v1/issues/${a.key}`, { custom: { [value.id]: 13 } })
  const history = (await call('GET', `/api/v1/issues/${a.key}/activity`)).body
  const row = (history.items ?? history).find((x: any) => x.field === `custom:${value.id}`)
  assert.deepEqual([row.fromValue, row.toValue], ['8', '13'])
  // R2: remaining-estimate tracking goes with the time statistic
  assert.equal((await call('PATCH', board, { timeTracking: 'remaining' })).status, 400)
  assert.equal((await call('PATCH', board, { estimation: 'time', timeTracking: 'remaining' })).body.timeTracking, 'remaining')
  assert.equal((await call('PATCH', board, { estimation: 'points' })).body.timeTracking, 'none')
  // R3: the team's time zone, or none; a zone that doesn't exist is refused
  const wd = (await call('PATCH', board, { workingDays: { weekdays: [1, 2, 3, 4, 5], nonWorking: [], timeZone: 'Asia/Kolkata' } })).body.workingDays
  assert.equal(wd.timeZone, 'Asia/Kolkata')
  assert.equal((await call('PATCH', board, { workingDays: { weekdays: [1], nonWorking: [], timeZone: 'Mars/Olympus' } })).status, 400)
  // a deleted field leaves the board on story points
  await call('PATCH', board, { estimation: 'field', estimationFieldId: value.id })
  await call('DELETE', `/api/v1/admin/custom-fields/${value.id}`)
  assert.equal((await call('GET', board)).body.estimation, 'points')
})

test('[0414.R1][0414.R2][0414.R3][0414.R4] parallel sprints: off, one active sprint per board; on, two, both on the board and in openSprints(); turning it off waits until one completes', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Two teams', key: 'TWO', template: 'scrum' })
  const ends = new Date(Date.now() + 864e5).toISOString()
  const sprint = async (name: string, title: string) => {
    const s = (await call('POST', '/api/v1/projects/TWO/sprints', { name })).body
    const i = (await call('POST', '/api/v1/projects/TWO/issues', { title, sprintId: s.id })).body
    return { s, i }
  }
  const [a, b] = [await sprint('Team A', 'Alpha work'), await sprint('Team B', 'Beta work')]
  const start = (id: string) => call('POST', `/api/v1/projects/TWO/sprints/${id}/start`, { endsAt: ends })
  // R2: off (the default), a second start is refused, naming the active sprint
  assert.equal((await start(a.s.id)).status, 200)
  const refused = await start(b.s.id)
  assert.equal(refused.status, 409)
  assert.match(refused.body.error, /Team A is active on this board/)
  // R1: on; then both run
  const put = (parallel: boolean) => call('PUT', '/api/v1/admin/settings/sprints', { parallel })
  assert.equal((await put(true)).status, 200)
  assert.equal((await start(b.s.id)).status, 200)
  const board = (await call('GET', `/api/v1/boards/${a.s.boardId}/issues`)).body
  assert.deepEqual((board.items ?? board).map((x: any) => x.title).sort(), ['Alpha work', 'Beta work'])
  const open = (await call('GET', `/api/v1/search?jql=${encodeURIComponent('project = TWO AND sprint in openSprints() ORDER BY key')}`)).body.items.map((x: any) => x.title)
  assert.deepEqual(open, ['Alpha work', 'Beta work'])
  // R1: can't be turned off while the board has two active sprints
  const off = await put(false)
  assert.equal(off.status, 409)
  assert.match(off.body.error, /TWO board \(TWO\)/)
  // R4: reopening follows the rule too
  await call('POST', `/api/v1/projects/TWO/sprints/${b.s.id}/complete`, { moveTo: null })
  assert.equal((await put(false)).status, 200)
  const reopened = await call('POST', `/api/v1/projects/TWO/sprints/${b.s.id}/reopen`)
  assert.equal(reopened.status, 409)
  await put(true)
  assert.equal((await call('POST', `/api/v1/projects/TWO/sprints/${b.s.id}/reopen`)).status, 200)
  for (const s of [a.s, b.s]) await call('POST', `/api/v1/projects/TWO/sprints/${s.id}/complete`, { moveTo: null })
  await put(false)
})

test('[0717.R1][0717.R2][0717.R3][0717.R4] global permissions: granted to groups; without each, its action is refused; a group granted System administrators administers', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Global perms', key: 'GLP', template: 'kanban' })
  await join('GLP', 'gp.ann@x.com')
  await call('GET', '/api/v1/me', undefined, 'gp.zed@x.com')                       // someone in no shared project
  const item = (await call('POST', '/api/v1/projects/GLP/issues', { title: 'Shared item' })).body
  const team = (await call('POST', '/api/v1/groups', { name: 'gp-team' })).body
  const list = async () => (await call('GET', '/api/v1/admin/global-permissions')).body
  const grantOf = async (key: string) => (await list()).find((p: any) => p.key === key).groups.find((g: any) => !g.fixed)
  // R2: by default, the default users group holds the four; the system-administrators group always administers
  const perms = await list()
  assert.deepEqual(perms.map((p: any) => p.key), ['system-admin', 'jira-admin', 'browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change'])
  assert.deepEqual(perms[0].groups.map((g: any) => g.fixed), [true])
  assert.equal(perms[1].groups.length, 0)                                              // Jira administrators: nobody until granted
  for (const p of perms.slice(2)) assert.equal(p.groups.length, 1, p.key)
  const defaultUsers = perms[2].groups[0].groupId
  assert.deepEqual((await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.globalPermissions.sort(), ['browse-users', 'bulk-change', 'group-subscriptions', 'shared-objects'])
  // R1: take each away, and its action is refused
  for (const key of ['browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change']) await call('DELETE', `/api/v1/admin/global-permissions/${(await grantOf(key)).id}`)
  assert.deepEqual((await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.globalPermissions, [])
  const bulk = await call('POST', '/api/v1/issues/bulk/edit', { issues: [item.key], patch: { priority: 'high' } }, 'gp.ann@x.com')
  assert.equal(bulk.status, 403); assert.match(bulk.body.error, /Bulk change/)
  assert.equal((await call('POST', '/api/v1/views', { name: 'Mine', shared: true, filters: {} }, 'gp.ann@x.com')).status, 403)
  const own = await call('POST', '/api/v1/views', { name: 'Private', filters: {} }, 'gp.ann@x.com')
  assert.equal(own.status, 201)
  const names = async (q: string) => (await call('GET', `/api/v1/users/search?query=${encodeURIComponent(q)}`, undefined, 'gp.ann@x.com')).body.items.map((u: any) => u.email)
  assert.deepEqual(await names('gp.zed'), [])
  assert.deepEqual(await names('gp.zed@x.com'), ['gp.zed@x.com'])                  // the exact email still finds them
  assert.ok(!(await call('GET', '/api/v1/users', undefined, 'gp.ann@x.com')).body.some((u: any) => u.email === 'gp.zed@x.com'))
  assert.ok((await call('GET', '/api/v1/users/search?project=GLP&query=gp', undefined, 'gp.ann@x.com')).body.items.length >= 1)   // a project's pickers still work
  assert.ok(!(await call('GET', '/api/v1/groups/search?query=gp-team', undefined, 'gp.ann@x.com')).body.some((g: any) => g.id === team.id))
  assert.equal((await call('POST', `/api/v1/views/${own.body.id}/subscriptions`, { cron: '0 0 8 ? * *', groupId: team.id }, 'gp.ann@x.com')).status, 403)
  // and granting them back allows it again
  for (const key of ['browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change'])
    assert.equal((await call('POST', '/api/v1/admin/global-permissions', { permission: key, groupId: defaultUsers })).status, 201)
  assert.equal((await call('POST', '/api/v1/issues/bulk/edit', { issues: [item.key], patch: { priority: 'high' } }, 'gp.ann@x.com')).status, 200)
  assert.deepEqual(await names('gp.zed'), ['gp.zed@x.com'])
  // R1: a group granted System administrators makes its members admins; the system group can't be added again; members can't grant
  await call('POST', `/api/v1/groups/${team.id}/members`, { userIds: [(await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.id] })
  assert.equal((await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.admin, false)
  const sys = await call('POST', '/api/v1/admin/global-permissions', { permission: 'system-admin', groupId: team.id })
  assert.equal(sys.status, 201)
  assert.equal((await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.admin, true)
  assert.equal((await call('POST', '/api/v1/admin/global-permissions', { permission: 'system-admin', groupId: perms[0].groups[0].groupId })).status, 409)
  await call('DELETE', `/api/v1/admin/global-permissions/${sys.body.id}`)
  assert.equal((await call('GET', '/api/v1/me', undefined, 'gp.ann@x.com')).body.admin, false)
  assert.equal((await call('POST', '/api/v1/admin/global-permissions', { permission: 'bulk-change', groupId: team.id }, 'gp.ann@x.com')).status, 403)
  // R4: audited
  const audited = (await call('GET', '/api/v1/audit?action=global_permission')).body.items.map((e: any) => e.action)
  assert.ok(audited.includes('global_permission.granted') && audited.includes('global_permission.revoked'))
})

test('[0718.R1][0718.R2][0718.R3] workflow triggers: a branch starts an item, a merged pull request finishes it past its conditions and checks, each event once', { skip }, async () => {
  const p = (await call('POST', '/api/v1/projects', { name: 'Triggered', key: 'TRG', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find((s: any) => s.category === 'done')]
  await flow('TRG', [
    { name: 'Start', fromIds: [todo.id], toId: doing.id, rules: { triggers: ['branch_created'] } },
    { name: 'Merge', fromIds: [doing.id], toId: done.id, rules: { triggers: ['pr_merged'], restrict: { op: 'all', items: [{ kind: 'childrenDone' }] },
      validate: [{ kind: 'required', fields: ['dueDate'] }], actions: [{ kind: 'comment', body: 'Shipped by the workflow' }] } },
    { name: 'Back', fromIds: null, toId: todo.id },
  ])
  const a = (await call('POST', '/api/v1/projects/TRG/issues', { title: 'Login' })).body
  const b = (await call('POST', '/api/v1/projects/TRG/issues', { title: 'Other' })).body
  await call('POST', '/api/v1/projects/TRG/issues', { title: 'Open child', parentId: a.id })            // the Merge condition fails for people
  const ws = (await pool.query(`select workspace_id from projects where key = 'TRG'`)).rows[0].workspace_id
  await pool.query(`insert into integrations (workspace_id, provider, installation_id, account_login) values ($1, 'github', 778, 'trg')`, [ws])
  const repo = { id: 4343, full_name: 'acme/trg', default_branch: 'main', html_url: 'https://github.com/acme/trg' }
  const status = async (key: string) => (await call('GET', `/api/v1/issues/${key}`)).body.statusId
  // R2: a new branch naming the item starts it
  assert.equal((await hook('create', { ref: `${a.key}-login`, ref_type: 'branch', repository: repo, installation: { id: 778 } })).status, 200)
  assert.equal(await status(a.key), doing.id)
  // once per event: the same branch again doesn't move it a second time
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: todo.id })
  await hook('create', { ref: `${a.key}-login`, ref_type: 'branch', repository: repo, installation: { id: 778 } })
  assert.equal(await status(a.key), todo.id)
  await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: doing.id })
  // a pull request opened: no transition from In progress has that trigger, so it stays
  const pr = (state: string, merged: boolean, at: string) => ({ action: merged || state === 'closed' ? 'closed' : 'opened', number: 9, repository: repo, installation: { id: 778 },
    pull_request: { number: 9, html_url: 'https://github.com/acme/trg/pull/9', title: `${a.key} Login`, body: '', state, draft: false, merged, merged_at: merged ? at : null,
      updated_at: at, user: { login: 'vicky' }, head: { ref: `${a.key}-login`, sha: 'abc' }, base: { ref: 'main' } } })
  await hook('pull_request', pr('open', false, '2026-11-12T10:00:00Z'))
  assert.equal(await status(a.key), doing.id)
  assert.equal((await call('PATCH', `/api/v1/issues/${a.key}`, { statusId: done.id })).status, 403)   // people can't: a child is open
  // merged: Done, past the condition and the check; its post function runs; Issue Resolved; history says why
  await hook('pull_request', pr('closed', true, '2026-11-12T11:00:00Z'))
  const after = (await call('GET', `/api/v1/issues/${a.key}?expand=comments`)).body
  assert.deepEqual([after.statusId, after.resolution, after.comments.at(-1).body], [done.id, 'Done', 'Shipped by the workflow'])
  const history = (await call('GET', `/api/v1/issues/${a.key}/activity`)).body
  assert.ok((history.items ?? history).some((x: any) => x.text === '“Done” by GitHub: pull request merged' && x.actorId == null))
  // an item whose status has no such transition stays
  await hook('pull_request', { ...pr('closed', true, '2026-11-12T12:00:00Z'), number: 10, pull_request: { ...pr('closed', true, '2026-11-12T12:00:00Z').pull_request, number: 10, title: `${b.key} Other`, head: { ref: 'other', sha: 'def' } } })
  assert.equal(await status(b.key), todo.id)
  // R1: a trigger Strand doesn't know is refused when the workflow is saved
  const wf = (await call('GET', '/api/v1/projects/TRG')).body.workflows[0].workflowId
  const cur = (await call('GET', `/api/v1/workflows/${wf}`)).body
  assert.equal((await call('POST', `/api/v1/admin/workflows/${wf}/publish`, { statuses: cur.statuses, transitions: [{ id: 'x', name: 'x', fromIds: null, toId: cur.statuses[0].id, rules: { triggers: ['deployed'] } }] })).status, 400)
})

test('[0713.R1][0713.R2][0713.R3][0713.R4] incremental directory synchronisation: only what changed, groups again when one did, full runs for deletions, settings, age and failures', { skip }, async () => {
  const { syncDirectory, PRESETS } = await import('../src/directories.ts')
  const saved = { entries: other.entries, passwords: other.passwords }
  process.env.STRAND_SECRET_KEY ??= 'a-secret-key-for-tests-only-0712-xxxxxxxx'
  other.passwords = { ...other.passwords, [SVC]: 'svc-pass' }
  const team = `CN=Incr Team,OU=Groups,${BASE}`, annDn = `CN=Ann Inc,OU=People,${BASE}`, benDn = `CN=Ben Inc,OU=People,${BASE}`
  const at = (e: any, n: number) => ({ ...e, uSNChanged: String(n) })
  other.entries = [at(adUser('Ann Inc', 'ainc', { groups: [team] }), 10), at(adUser('Ben Inc', 'binc'), 11), at(adGroup('Incr Team', [annDn]), 12)]
  const config = { ...PRESETS.ad, host: other.host, port: 389, security: 'none', bindDn: SVC, baseDn: BASE }
  const dir = (await call('POST', '/api/v1/admin/directories', { name: 'Incremental AD', type: 'ad', enabled: true, config, password: 'svc-pass' })).body
  assert.equal(dir.config.incremental, true)
  const sync = async (o: { full?: boolean } = {}) => { const r: any = await syncDirectory(dir.id, undefined, o); assert.ok(r.ok, JSON.stringify(r)); return r }
  const members = async () => (await pool.query(`select u.username from group_members gm join groups g on g.id = gm.group_id join users u on u.id = gm.user_id where g.display_name = 'Incr Team' order by 1`)).rows.map(r => r.username)
  const active = async (sam: string) => (await pool.query('select active from users where username = $1', [sam])).rows[0].active
  const put = (e: any) => { other.entries = [...other.entries.filter(x => x.dn !== e.dn), e] }
  // R2: the first run is full
  const r1 = await sync()
  assert.deepEqual([r1.mode, r1.why, r1.users.created], ['full', 'The first synchronisation', 2])
  assert.deepEqual(await members(), ['ainc'])
  // R1: nothing changed: only changes are asked for, and none come back
  other.log = { binds: [], searches: [] }
  const r2 = await sync()
  assert.deepEqual([r2.mode, r2.users.found, r2.groups.found], ['incremental', 0, 0])
  assert.ok(other.log.searches.some(f => f.includes('(uSNChanged>=13)')), other.log.searches.join(' | '))
  // a person disabled in the directory: read alone, deactivated
  put(at(adUser('Ben Inc', 'binc', { uac: '514' }), 20))
  const r3 = await sync()
  assert.deepEqual([r3.mode, r3.users.found, r3.users.deactivated], ['incremental', 1, 1])
  assert.equal(await active('binc'), false)
  // a group's members changed (the group changes, not the person): groups and memberships read again
  put(at(adUser('Ben Inc', 'binc', { groups: [team] }), 21)); put(at(adGroup('Incr Team', [annDn, benDn]), 22))
  const r4 = await sync()
  assert.deepEqual([r4.mode, r4.groups.found], ['incremental', 1])
  assert.deepEqual(await members(), ['ainc', 'binc'])
  // a person deleted from the directory: an incremental run can't see it; the next full run deactivates them (R2)
  other.entries = other.entries.filter(x => x.dn !== annDn); put(at(adGroup('Incr Team', [benDn]), 23))
  assert.equal((await sync()).mode, 'incremental')
  assert.equal(await active('ainc'), true)
  assert.deepEqual(await members(), ['binc'])
  const full = await sync({ full: true })
  assert.deepEqual([full.mode, full.why, full.users.deactivated], ['full', 'A full synchronisation was asked for', 1])
  assert.equal(await active('ainc'), false)
  // settings changed, or the last full run too old: full
  assert.equal((await call('PUT', `/api/v1/admin/directories/${dir.id}`, { name: dir.name, enabled: true, config: { ...dir.config, fullSyncHours: 12 } })).status, 200)
  assert.deepEqual([(await sync()).why], ['The directory’s settings changed'])
  assert.equal((await sync()).mode, 'incremental')
  await pool.query(`update user_directories set sync_state = jsonb_set(sync_state, '{fullAt}', to_jsonb((now() - interval '13 hours')::text)) where id = $1`, [dir.id])
  assert.match((await sync()).why, /over 12 hours ago/)
  // R3: an incremental run that fails becomes a full one
  other.failSearches = 'uSNChanged'
  const fell = await sync()
  assert.deepEqual([fell.mode, /incremental synchronisation failed/.test(fell.why)], ['full', true])
  other.failSearches = undefined
  // a directory that doesn't report uSNChanged is always fully synchronised
  other.entries = other.entries.map(({ uSNChanged: _, ...e }: any) => e)
  await sync({ full: true })
  assert.equal((await sync()).why, 'The directory doesn’t report uSNChanged')
  // R4: the result is shown; Full synchronisation as a job
  const listed = (await call('GET', '/api/v1/admin/directories')).body.find((d: any) => d.id === dir.id)
  assert.equal(listed.lastSync.mode, 'full')
  const started = await call('POST', `/api/v1/admin/directories/${dir.id}/sync`, { full: true })
  assert.equal(started.status, 202)
  assert.equal((await pool.query('select payload from jobs where id = $1', [started.body.jobId])).rows[0].payload.full, true)
  await call('PUT', `/api/v1/admin/directories/${dir.id}`, { name: dir.name, enabled: false, config: dir.config })
  Object.assign(other, saved)
})

test('[0719.R1][0719.R3] a logo for the collapsed menu: uploaded, served as an image with nosniff, checked, removed, reset, audited', { skip }, async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const pub = async () => (await app.inject({ method: 'GET', url: '/api/v1/look-and-feel' })).json()
  const up = await call('PUT', '/api/v1/admin/look-and-feel/mark', { image: png.toString('base64') })
  assert.equal(up.status, 200)
  const url = (await pub()).mark
  assert.match(url, /^\/look-and-feel\/mark\?v=/)
  const img = await app.inject({ method: 'GET', url: `/api/v1${url}` })
  assert.deepEqual([img.statusCode, img.headers['content-type'], img.headers['x-content-type-options']], [200, 'image/png', 'nosniff'])
  assert.equal((await call('PUT', '/api/v1/admin/look-and-feel/mark', { image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') })).status, 400)
  const big = await call('PUT', '/api/v1/admin/look-and-feel/mark', { image: Buffer.concat([png, Buffer.alloc(70 * 1024)]).toString('base64') })
  assert.equal(big.status, 400)
  assert.equal((await call('DELETE', '/api/v1/admin/look-and-feel/mark')).body.mark, null)
  await call('PUT', '/api/v1/admin/look-and-feel/mark', { image: png.toString('base64') })
  assert.equal((await call('DELETE', '/api/v1/admin/look-and-feel')).body.mark, null)                 // Reset defaults removes it
  const actions = (await pool.query(`select action from audit_log where action like 'look_and_feel.mark%' order by at`)).rows.map(r => r.action)
  assert.deepEqual([...new Set(actions)].sort(), ['look_and_feel.mark_changed', 'look_and_feel.mark_removed'])
})

test('[0709.R6][0709.R7] automation smart values and branches: comments and labels filled in, unknown values empty; For each on sub-items, the parent and linked items, in scope only', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Smart', key: 'SMV', template: 'kanban' })
  await call('POST', '/api/v1/projects', { name: 'Smart elsewhere', key: 'SMVX', template: 'kanban' })
  await join('SMV', 'smv.ann@x.com')
  const ann = (await call('GET', '/api/v1/me', undefined, 'smv.ann@x.com')).body
  const comments = async (key: string) => (await call('GET', `/api/v1/issues/${key}/comments`)).body.items.map((c: any) => c.body)
  // R6: a comment and a label from smart values; the initiator is whoever's change fired it
  assert.equal((await call('POST', '/api/v1/projects/SMV/rules', { name: 'Hello', enabled: true, trigger: { kind: 'created' }, actions: [
    { kind: 'comment', body: 'Thanks {{initiator.displayName}}: {{issue.key}} “{{issue.summary}}” is {{issue.status.name}}, {{issue.priority.name}}; {{issue.nonsense}}{{reporter.x}}|' },
    { kind: 'label', value: 'from-{{issue.project.key}}' }] })).status, 201)
  const a = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Parent work', priority: 'high' }, 'smv.ann@x.com')).body
  assert.deepEqual(await comments(a.key), [`Thanks ${ann.name}: ${a.key} “Parent work” is To do, High; |`])
  assert.deepEqual((await call('GET', `/api/v1/issues/${a.key}`)).body.labels, ['from-SMV'])
  const rules = (await call('GET', '/api/v1/projects/SMV')).body.rules
  for (const r of rules) await call('DELETE', `/api/v1/projects/SMV/rules/${r.id}`)
  // R7: For each sub-item, the parent, and linked items of one type; an item in another project is outside the rule's scope
  const kid1 = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Kid one', parentId: a.id })).body
  const kid2 = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Kid two', parentId: a.id })).body
  const blocked = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Blocked one' })).body
  const related = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Related one' })).body
  const outside = (await call('POST', '/api/v1/projects/SMVX/issues', { title: 'Outside' })).body
  const other = (await call('POST', '/api/v1/admin/link-types', { name: 'Smart related', outward: 'smart-relates to', inward: 'smart-related to' })).body.id
  for (const [t, type] of [[blocked, 'blocks'], [related, other], [outside, 'blocks']] as const)
    assert.equal((await call('POST', `/api/v1/issues/${a.key}/links`, { type, targetKey: t.key })).status, 204)
  const rule = (await call('POST', '/api/v1/projects/SMV/rules', { name: 'Fan out', enabled: true, trigger: { kind: 'assigned' }, actions: [
    { kind: 'branch', target: 'children', actions: [{ kind: 'comment', body: 'Parent {{triggerIssue.key}} was assigned to {{triggerIssue.assignee.displayName}}' }] },
    { kind: 'branch', target: 'linked', linkType: 'blocks', actions: [{ kind: 'label', value: 'waiting-on-{{triggerIssue.key}}' }] }] })).body
  assert.ok(rule.id)
  await call('PATCH', `/api/v1/issues/${a.key}`, { assigneeId: ann.id })
  for (const k of [kid1, kid2]) assert.deepEqual(await comments(k.key), [`Parent ${a.key} was assigned to ${ann.name}`])
  assert.deepEqual((await call('GET', `/api/v1/issues/${blocked.key}`)).body.labels, [`waiting-on-${a.key}`])
  assert.deepEqual((await call('GET', `/api/v1/issues/${related.key}`)).body.labels, [])                 // another link type
  assert.deepEqual((await call('GET', `/api/v1/issues/${outside.key}`)).body.labels, [])                 // another project: out of scope
  const run = (await pool.query(`select steps from rule_runs where rule_id = $1 order by at desc limit 1`, [rule.id])).rows[0].steps
  assert.ok(run.some((s: any) => s.action === `branch ${outside.key}` && s.outcome === 'skipped'))
  // the parent: a sub-item's rule comments on it
  await call('POST', '/api/v1/projects/SMV/rules', { name: 'Up', enabled: true, trigger: { kind: 'created' }, condition: `parent = ${a.key}`,
    actions: [{ kind: 'branch', target: 'parent', actions: [{ kind: 'comment', body: 'New sub-item {{triggerIssue.key}} on {{issue.key}}' }] }] })
  const kid3 = (await call('POST', '/api/v1/projects/SMV/issues', { title: 'Kid three', parentId: a.id })).body
  assert.equal((await comments(a.key)).at(-1), `New sub-item ${kid3.key} on ${a.key}`)
  // a branch inside a branch is refused when saved
  assert.equal((await call('POST', '/api/v1/projects/SMV/rules', { name: 'Nested', enabled: true, trigger: { kind: 'created' },
    actions: [{ kind: 'branch', target: 'children', actions: [{ kind: 'branch', target: 'parent', actions: [{ kind: 'comment', body: 'x' }] }] }] })).status, 400)
})

test('[0601.R6] comment edit history: each edit keeps the text it replaced; its author and the project’s admins read it', { skip }, async () => {
  await call('POST', '/api/v1/projects', { name: 'Edited', key: 'EDH', template: 'kanban' })
  await join('EDH', 'edh.ann@x.com'); await join('EDH', 'edh.bob@x.com'); await join('EDH', 'edh.lead@x.com', 'admin')
  const item = (await call('POST', '/api/v1/projects/EDH/issues', { title: 'Talked about' })).body
  const c = (await call('POST', `/api/v1/issues/${item.key}/comments`, { body: 'First draft' }, 'edh.ann@x.com')).body
  assert.equal((await call('PATCH', `/api/v1/comments/${c.id}`, { body: 'Second draft' }, 'edh.ann@x.com')).status, 200)
  assert.equal((await call('PATCH', `/api/v1/comments/${c.id}`, { body: 'Final' }, 'edh.lead@x.com')).status, 200)
  const ann = (await call('GET', '/api/v1/me', undefined, 'edh.ann@x.com')).body
  const versions = (await call('GET', `/api/v1/comments/${c.id}/versions`, undefined, 'edh.ann@x.com')).body
  assert.deepEqual(versions.map((v: any) => v.body), ['Second draft', 'First draft'])
  assert.equal(versions[1].editedBy, ann.id)
  assert.equal((await call('GET', `/api/v1/comments/${c.id}/versions`, undefined, 'edh.lead@x.com')).status, 200)    // a project admin
  assert.equal((await call('GET', `/api/v1/comments/${c.id}/versions`, undefined, 'edh.bob@x.com')).status, 403)     // a member
  assert.equal((await call('GET', `/api/v1/comments/${c.id}/versions`, undefined, 'edh.nobody@x.com')).status, 404)  // can't see it
  // the same text again isn't a version
  await call('PATCH', `/api/v1/comments/${c.id}`, { body: 'Final' }, 'edh.ann@x.com')
  assert.equal((await call('GET', `/api/v1/comments/${c.id}/versions`)).body.length, 2)
  await call('DELETE', `/api/v1/comments/${c.id}`, undefined, 'edh.ann@x.com')
  assert.equal((await pool.query('select count(*)::int as n from comment_versions where comment_id = $1', [c.id])).rows[0].n, 0)
})

test('[0604.R7] a subscription sent only when the results changed: same results, no email; a changed item, an email', { skip }, async () => {
  process.env.EMAIL_TRANSPORT = 'memory'
  const { sentEmails } = await import('../src/email.ts')
  const { runJobs } = await import('../src/jobs.ts')
  await call('PUT', '/api/v1/admin/settings/email', { enabled: true, from: 'Strand <strand@example.com>', appUrl: 'https://strand.example.com' })
  await call('POST', '/api/v1/projects', { name: 'Changed only', key: 'SBC', template: 'kanban' })
  const item = (await call('POST', '/api/v1/projects/SBC/issues', { title: 'Watched closely' })).body
  const view = (await call('POST', '/api/v1/views', { name: 'Changed only view', filters: { q: '', resolution: 'open', jql: 'project = SBC' } })).body
  const sub = (await call('POST', `/api/v1/views/${view.id}/subscriptions`, { cron: '0 0 7 ? * *', onlyWhenChanged: true })).body
  assert.equal(sub.onlyWhenChanged, true)
  const mails = () => sentEmails.filter(m => m.subject === '[Strand] Subscription: Changed only view').length
  const run = async () => { await call('POST', `/api/v1/subscriptions/${sub.id}/run`); await runJobs(); await runJobs() }
  await run()
  assert.equal(mails(), 1)                                                              // the first run always sends
  await run()
  assert.equal(mails(), 1)                                                              // nothing changed
  await call('PATCH', `/api/v1/issues/${item.key}`, { title: 'Watched closely, renamed' })
  await run()
  assert.equal(mails(), 2)
  await call('POST', '/api/v1/projects/SBC/issues', { title: 'A new one' })
  await run()
  assert.equal(mails(), 3)
  // switched off: every run sends again
  await call('PATCH', `/api/v1/subscriptions/${sub.id}`, { onlyWhenChanged: false })
  await run()
  assert.equal(mails(), 4)
  await call('PUT', '/api/v1/admin/settings/email', { enabled: false, from: '', appUrl: '' })
})

test('[0701.R6] a scheduled announcement: hidden before Show from and after Until, shown between; Until before Show from refused', { skip }, async () => {
  const { clearSettingsCache } = await import('../src/settings.ts')
  const pub = async () => { clearSettingsCache(); return JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/auth/config' })).body).announcement }
  const put = (startsAt: string | null, endsAt: string | null) => call('PUT', '/api/v1/admin/settings/announcement', { text: 'Maintenance window', visibility: 'public', startsAt, endsAt })
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
  assert.equal((await put(at(1), at(2))).status, 200)
  assert.equal(await pub(), null)                                                           // not yet
  await put(at(-2), at(-1))
  assert.equal(await pub(), null)                                                           // over
  await put(at(-1), at(1))
  assert.equal(await pub(), 'Maintenance window')                                           // now
  const s = (await call('GET', '/api/v1/settings/public')).body.announcement
  assert.deepEqual([s.startsAt !== null, s.endsAt !== null], [true, true])                  // the app checks the window too
  const bad = await put(at(2), at(1))
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.endsAt)
  await call('PUT', '/api/v1/admin/settings/announcement', { text: '', visibility: 'private', startsAt: null, endsAt: null }); clearSettingsCache()
})

test('[0717.R5] Jira administrators: most of Administration, but not system settings, global permissions, webhooks, or a system administrator', { skip }, async () => {
  const team = (await call('POST', '/api/v1/groups', { name: 'jira-admins-r5' })).body
  const jim = (await call('GET', '/api/v1/me', undefined, 'r5.jim@x.com')).body
  await call('GET', '/api/v1/me', undefined, 'r5.plain@x.com')
  await call('POST', `/api/v1/groups/${team.id}/members`, { userIds: [jim.id] })
  const as = (method: string, path: string, body?: unknown, who = 'r5.jim@x.com') => call(method, `/api/v1${path}`, body, who)
  // without it: refused
  assert.equal((await as('POST', '/admin/priorities', { name: 'R5 urgent', color: '#dc2626', icon: 'arrow-up' }, 'r5.plain@x.com')).status, 403)
  const grant = (await call('POST', '/api/v1/admin/global-permissions', { permission: 'jira-admin', groupId: team.id })).body
  assert.deepEqual([(await call('GET', '/api/v1/me', undefined, 'r5.jim@x.com')).body.admin, (await call('GET', '/api/v1/me', undefined, 'r5.jim@x.com')).body.globalPermissions.includes('jira-admin')], [false, true])
  // with it: workflows, custom fields, priorities, link types, categories, people, groups
  assert.equal((await as('POST', '/admin/workflows', { name: 'R5 flow' })).status, 201)
  assert.equal((await as('POST', '/admin/custom-fields', { name: 'R5 field', kind: 'text', context: { projectKeys: null } })).status, 201)
  assert.equal((await as('POST', '/admin/priorities', { name: 'R5 urgent', color: '#dc2626', icon: 'arrow-up' })).status, 201)
  assert.equal((await as('POST', '/admin/link-types', { name: 'R5 links', outward: 'r5-links', inward: 'r5-linked by' })).status, 201)
  assert.equal((await as('POST', '/admin/project-categories', { name: 'R5 category' })).status, 201)
  assert.equal((await as('GET', '/admin/users')).status, 200)
  const made = await as('POST', '/admin/users', { email: 'r5.local@x.com', name: 'R5 Local', username: 'r5local', password: 'r5-password-123' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const other = (await call('POST', '/api/v1/groups', { name: 'r5-other' })).body
  assert.equal((await as('PATCH', `/groups/${other.id}`, { description: 'Changed by a Jira admin' })).status, 200)
  // not the system: settings, global permissions, webhooks, the audit log
  assert.equal((await as('PUT', '/admin/settings/voting', { enabled: false })).status, 403)
  assert.equal((await as('POST', '/admin/global-permissions', { permission: 'bulk-change', groupId: other.id })).status, 403)
  assert.equal((await as('GET', '/admin/webhooks')).status, 403)
  // not a system administrator, nor the groups that make them
  const owner = (await call('GET', '/api/v1/me')).body
  const bulk = await as('POST', '/admin/users/bulk', { userIds: [owner.id], action: 'deactivate' })
  assert.equal(bulk.status, 403); assert.match(bulk.body.error, /system administrator/)
  const sys = (await call('GET', '/api/v1/admin/global-permissions')).body[0].groups[0].groupId
  assert.equal((await as('POST', '/admin/users/bulk', { userIds: [jim.id], action: 'add-to-group', groupId: sys })).status, 403)
  assert.equal((await as('POST', `/groups/${sys}/members`, { userIds: [jim.id] })).status, 403)
  await call('DELETE', `/api/v1/admin/global-permissions/${grant.id}`)
  assert.equal((await as('POST', '/admin/workflows', { name: 'R5 flow 2' })).status, 403)
})

test('[0310.R4] create with shared configuration: the other project’s schemes shared, its work types, template and field contexts copied; members and versions not', { skip }, async () => {
  const src = (await call('POST', '/api/v1/projects', { name: 'Shared source', key: 'SHSRC', template: 'scrum' })).body
  await call('POST', '/api/v1/projects/SHSRC/types', { name: 'Incident', color: '#dc2626', icon: 'zap' })
  const field = (await call('POST', '/api/v1/admin/custom-fields', { name: 'Shared field', kind: 'text', context: { projectKeys: ['SHSRC'] } })).body
  await call('POST', '/api/v1/projects/SHSRC/releases', { name: '1.0' })
  await join('SHSRC', 'sh.member@x.com')
  const made = await call('POST', '/api/v1/projects', { name: 'Shared copy', key: 'SHCPY', template: 'kanban', sharedWith: 'shsrc' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const p = made.body, s = (await call('GET', '/api/v1/projects/SHSRC')).body
  assert.equal(p.template, 'scrum')                                                    // the other project's template
  assert.equal(p.workflowSchemeId, s.workflowSchemeId)
  assert.deepEqual(p.types.map((t: any) => t.name).sort(), s.types.map((t: any) => t.name).sort())
  assert.ok(p.types.some((t: any) => t.name === 'Incident'))
  assert.ok(p.fields.some((f: any) => f.id === field.id))
  const cols = (r: any) => [r.fieldConfigSchemeId ?? null, r.issueTypeScreenSchemeId ?? null]
  assert.deepEqual(cols(p), cols(s))
  assert.equal(p.releases.length, 0)
  const members = (await pool.query(`select u.email from project_members m join users u on u.id = m.user_id join projects pr on pr.id = m.project_id where pr.key = 'SHCPY'`)).rows.map(r => r.email)
  assert.ok(!members.includes('sh.member@x.com'))
  assert.equal((await pool.query(`select notification_scheme_id from projects where key = 'SHCPY'`)).rows[0].notification_scheme_id,
    (await pool.query(`select notification_scheme_id from projects where key = 'SHSRC'`)).rows[0].notification_scheme_id)
  // only its administrators (or a Jira administrator) share it
  const refused = await call('POST', '/api/v1/projects', { name: 'Not mine', key: 'SHNOT', template: 'kanban', sharedWith: 'SHSRC' }, 'sh.member@x.com')
  assert.equal(refused.status, 403)
  assert.ok((await pool.query(`select 1 from audit_log where action = 'project.shared_configuration' and target = 'SHCPY'`)).rows.length)
})
