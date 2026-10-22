import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import pg from 'pg'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'

// First sign-ins race: a new person's browser sends several requests at once, and on an empty system the very first people
// may arrive together. Runs on its own scratch database. Needs DATABASE_URL (a user that may create databases); skipped otherwise.
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'
const TENANT = '11111111-1111-4111-8111-111111111111', CLIENT = '22222222-2222-4222-8222-222222222222'

let admin: pg.Client, scratch: pg.Pool, jwks: Server, key: CryptoKey, authority: string, app: Awaited<ReturnType<typeof import('../src/app.ts').build>>
const dbName = `first_login_${process.pid}`
const oidOf = (email: string) => { let h = 0; for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `00000000-0000-4000-8000-${h.toString(16).padStart(12, '0')}` }
const me = async (email: string) => {
  const token = await new SignJWT({ oid: oidOf(email), preferred_username: email, name: email.split('@')[0], roles: [] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(`${authority}/${TENANT}/v2.0`).setAudience(CLIENT).setIssuedAt().setExpirationTime('1h').sign(key)
  const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}

before(async () => {
  if (skip) return
  admin = new pg.Client({ connectionString: url }); await admin.connect()
  await admin.query(`create database ${dbName}`)
  const target = new URL(url!); target.pathname = '/' + dbName
  execFileSync('node', ['scripts/migrate.ts'], { env: { ...process.env, DATABASE_URL: target.href }, stdio: 'ignore' })
  scratch = new pg.Pool({ connectionString: target.href })
  const pair = await generateKeyPair('RS256'); key = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }
  jwks = createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>(r => jwks.listen(0, '127.0.0.1', r))
  authority = `http://127.0.0.1:${(jwks.address() as { port: number }).port}`
  Object.assign(process.env, { DATABASE_URL: target.href, NODE_ENV: 'test', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_AUTHORITY: authority })
  app = await (await import('../src/app.ts')).build()
})
after(async () => {
  if (skip) return
  await app.close(); await scratch.end(); jwks.close()
  await admin.query(`drop database ${dbName} with (force)`); await admin.end()
})

test('people arriving together on an empty system share one workspace, and exactly one becomes its owner', { skip }, async () => {
  const people = Array.from({ length: 8 }, (_, i) => `first${i}@x.com`)
  const results = await Promise.all(people.map(me))
  assert.deepEqual(results.map(r => r.status), Array(8).fill(200))
  assert.equal((await scratch.query('select count(*)::int as n from workspaces')).rows[0].n, 1)
  assert.deepEqual((await scratch.query(`select role, count(*)::int as n from memberships group by role order by role`)).rows, [{ role: 'member', n: 7 }, { role: 'owner', n: 1 }])
  assert.equal(new Set(results.map(r => r.body.workspaceId)).size, 1)
})

test('new people making many requests at once are each created once, and no request fails', { skip }, async () => {
  // The overlap is a matter of timing (about 3 in 100 requests failed before the fix), so many rounds make it a certainty
  const statuses: number[] = []
  for (let round = 0; round < 25; round++) {
    const results = await Promise.all(Array.from({ length: 13 }, () => me(`burst${round}@x.com`)))
    statuses.push(...results.map(r => r.status))
    assert.equal(new Set(results.map(r => r.body.id)).size, 1, `round ${round}: one person, one user`)
  }
  assert.deepEqual([...new Set(statuses)], [200])
  assert.equal((await scratch.query(`select count(*)::int as n from users where email like 'burst%'`)).rows[0].n, 25)
})
