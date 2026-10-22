import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

// First sign-ins race: a new person's browser sends several requests at once, and on an empty system the very first people
// may arrive together. Runs on its own scratch database. Needs DATABASE_URL (a user that may create databases); skipped otherwise.
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'

let admin: pg.Client, scratch: pg.Pool, app: Awaited<ReturnType<typeof import('../src/app.ts').build>>
const dbName = `first_login_${process.pid}`
const me = async (email: string) => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-dev-user': email } })
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }
}

before(async () => {
  if (skip) return
  admin = new pg.Client({ connectionString: url }); await admin.connect()
  await admin.query(`create database ${dbName}`)
  const target = new URL(url!); target.pathname = '/' + dbName
  scratch = new pg.Pool({ connectionString: target.href })
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await scratch.query(readFileSync(new URL(f, dir), 'utf8'))
  Object.assign(process.env, { DATABASE_URL: target.href, NODE_ENV: 'test', AUTH_DEV: '1' })
  app = await (await import('../src/app.ts')).build()
})
after(async () => {
  if (skip) return
  await app.close(); await scratch.end()
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
  // The overlap is a matter of timing, so many rounds make it a certainty
  const statuses: number[] = []
  for (let round = 0; round < 25; round++) {
    const results = await Promise.all(Array.from({ length: 13 }, () => me(`burst${round}@x.com`)))
    statuses.push(...results.map(r => r.status))
    assert.equal(new Set(results.map(r => r.body.id)).size, 1, `round ${round}: one person, one user`)
  }
  assert.deepEqual([...new Set(statuses)], [200])
  assert.equal((await scratch.query(`select count(*)::int as n from users where email like 'burst%'`)).rows[0].n, 25)
})
