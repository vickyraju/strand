import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import pg from 'pg'

// Needs a throwaway Postgres whose user may create databases: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'

test('migrate: applies every migration once, and a second run changes nothing', { skip }, async () => {
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  const name = `migrate_test_${process.pid}`
  await admin.query(`create database ${name}`)
  try {
    const target = new URL(url!); target.pathname = '/' + name
    const run = () => execFileSync('node', ['scripts/migrate.ts'], { env: { ...process.env, DATABASE_URL: target.href }, encoding: 'utf8' })
    assert.match(run(), /migration\(s\) applied/)
    assert.match(run(), /up to date/)
    const c = new pg.Client({ connectionString: target.href })
    await c.connect()
    const { rows } = await c.query(`select count(*)::int as n from schema_migrations`)
    const tables = await c.query(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'issue_editors'`)
    await c.end()
    assert.equal(rows[0].n, readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).length)
    assert.equal(tables.rows[0].n, 1)
  } finally {
    await admin.query(`drop database ${name} with (force)`)
    await admin.end()
  }
})
