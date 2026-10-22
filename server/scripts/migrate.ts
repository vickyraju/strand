// Applies migrations/*.sql in name order, each once:  node scripts/migrate.ts
// Runs as the pre-deploy Job. Safe to run on every deploy and from several pods at once (an advisory lock serializes them).
// Connects to DATABASE_DIRECT_URL (the Aurora writer endpoint) when set, otherwise DATABASE_URL: the lock is a session setting, so avoid RDS Proxy.
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL
if (!url) { console.error('Set DATABASE_URL (or DATABASE_DIRECT_URL)'); process.exit(2) }
const dir = new URL('../migrations/', import.meta.url)
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

const c = new pg.Client({ connectionString: url })
await c.connect()
try {
  await c.query('select pg_advisory_lock(727274)')
  await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())')
  const done = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map(r => r.name))
  let applied = 0
  for (const f of files) {
    if (done.has(f)) continue
    try {
      await c.query('begin')
      await c.query(readFileSync(new URL(f, dir), 'utf8'))
      await c.query('insert into schema_migrations (name) values ($1)', [f])
      await c.query('commit')
    } catch (e) {
      await c.query('rollback')
      throw new Error(`${f}: ${(e as Error).message}`)
    }
    console.log(`applied ${f}`); applied++
  }
  console.log(applied ? `${applied} migration(s) applied` : 'up to date')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await c.end()
}
