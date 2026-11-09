import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

// Migrations run on Supabase (supabase/migrations); this checks one migration's SQL on a scratch schema.
// Needs a throwaway Postgres: DATABASE_URL=postgres://… npm test  (skipped otherwise)
const url = process.env.DATABASE_URL
const skip = !url && 'DATABASE_URL not set'

test('[0105.R8] field options get ids, keep their order, and a value no longer an option becomes a disabled option (nothing lost)', { skip }, async () => {
  // the migration itself, run on the old shape of the two tables it reads, in a scratch schema
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../../supabase/migrations/20261123090000_field_options.sql', import.meta.url), 'utf8')
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
  const sql = readFileSync(new URL('../../supabase/migrations/20261125090000_fix_versions.sql', import.meta.url), 'utf8')
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
