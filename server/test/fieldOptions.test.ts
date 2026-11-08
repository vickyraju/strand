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
