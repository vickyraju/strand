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

test('[0105.R8] field options get ids, keep their order, and a value no longer an option becomes a disabled option (nothing lost)', { skip }, async () => {
  // the migration itself, run on the old shape of the two tables it reads, in a scratch schema
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../migrations/20261123090000_field_options.sql', import.meta.url), 'utf8')
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const schema = `fo_${process.pid}`
  try {
    await c.query(`create schema ${schema}; set search_path = ${schema}, public`)
    await c.query(`create table field_defs (id uuid primary key, project_id uuid, kind text, options text[]);
                   create table issues (project_id uuid, custom jsonb)`)
    const [p, team, note] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3']
    await c.query(`insert into field_defs values ($1, $2, 'select', '{Web,Mobile}'), ($3, $2, 'text', null)`, [team, p, note])
    await c.query(`insert into issues values ($1, $2), ($1, $3), ($1, $4)`, [p, { [team]: 'Web' }, { [team]: 'iOS' }, { [note]: 'free text' }])
    await c.query(sql)
    const { rows } = await c.query(`select id, options from field_defs order by kind`)
    const sel = rows.find((r: any) => r.id === team).options
    assert.deepEqual(sel.map((o: any) => [o.name, o.disabled]), [['Web', false], ['Mobile', false], ['iOS', true]])
    assert.ok(sel.every((o: any) => typeof o.id === 'string' && o.id.length > 0))
    assert.equal(rows.find((r: any) => r.id === note).options, null)                     // a text field has no options
    assert.equal((await c.query(`select count(*)::int as n from issues where custom ->> $1 = 'iOS'`, [team])).rows[0].n, 1)   // items keep their value
  } finally {
    await c.query(`drop schema ${schema} cascade`)
    await c.end()
  }
})

test('[0301.R2][0301.R7] fix versions become a list (one version or none) and workflow rules name the new field', { skip }, async () => {
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../migrations/20261125090000_fix_versions.sql', import.meta.url), 'utf8')
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const schema = `fv_${process.pid}`
  try {
    await c.query(`create schema ${schema}; set search_path = ${schema}, public`)
    await c.query(`create table issues (id int primary key, release_id uuid);
                   create table transitions (id int, rules jsonb); create table workflows (id int, transitions jsonb); create table workflow_versions (id int, transitions jsonb)`)
    const r = '00000000-0000-4000-8000-0000000000b1'
    await c.query(`insert into issues values (1, $1), (2, null)`, [r])
    await c.query(`insert into transitions values (1, $1)`, [{ actions: [{ kind: 'set', field: 'releaseId', value: r }] }])
    await c.query(`insert into workflows values (1, $1)`, [JSON.stringify([{ rules: { validate: [{ kind: 'required', fields: ['releaseId'] }] } }])])
    await c.query(sql)
    assert.deepEqual((await c.query(`select fix_release_ids from issues order by id`)).rows.map((x: any) => x.fix_release_ids), [[r], []])
    assert.equal((await c.query(`select rules->'actions'->0->>'field' as f from transitions`)).rows[0].f, 'fixReleaseIds')
    assert.equal((await c.query(`select transitions->0->'rules'->'validate'->0->'fields'->>0 as f from workflows`)).rows[0].f, 'fixReleaseIds')
  } finally {
    await c.query(`drop schema ${schema} cascade`)
    await c.end()
  }
})

test('[0302.R5] ranks are renumbered once per workspace, in their order, ties broken by id', { skip }, async () => {
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../migrations/20261126090000_global_rank.sql', import.meta.url), 'utf8')
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const schema = `gr_${process.pid}`
  try {
    await c.query(`create schema ${schema}; set search_path = ${schema}, public`)
    await c.query(`create table issues (id uuid primary key, workspace_id uuid, rank double precision, deleted_at timestamptz)`)
    const [w1, w2] = ['00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2']
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    // workspace 1: two projects both started at 1000, so their items tie; workspace 2 on its own
    await c.query(`insert into issues values ($1, $5, 1000, null), ($2, $5, 1000, null), ($3, $5, 2000, null), ($4, $6, 1000, null)`, [id(2), id(1), id(3), id(4), w1, w2])
    await c.query(sql)
    const { rows } = await c.query(`select id, workspace_id, rank from issues order by workspace_id, rank`)
    assert.deepEqual(rows.map((r: any) => [r.id, r.rank]), [[id(1), 1024], [id(2), 2048], [id(3), 3072], [id(4), 1024]])
  } finally {
    await c.query(`drop schema ${schema} cascade`)
    await c.end()
  }
})
