// Reads server/migrations/*.sql into { tables: [{ name, columns, pk, uniques }] }. Plain regex parsing, enough for this
// project's migrations (create table, add column, add foreign key); anything it cannot read throws, it never guesses.
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../../server/migrations/', import.meta.url)

/** Split on commas that are not inside parentheses or quotes */
function splitTop(body) {
  const out = []; let depth = 0, cur = '', q = false
  for (const ch of body) {
    if (ch === "'") q = !q
    if (!q && ch === '(') depth++
    if (!q && ch === ')') depth--
    if (!q && depth === 0 && ch === ',') { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

const list = s => s.split(',').map(x => x.trim())

export function parseSchema() {
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const tables = new Map()

  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), 'utf8')

    for (const m of sql.matchAll(/^create table (\w+) \(\n([\s\S]*?)\n\);/gm)) {
      const [, name, rawBody] = m
      const comments = new Map()
      for (const line of rawBody.split('\n')) {
        const c = /^\s*(\w+)\s+.*--\s*(.+)$/.exec(line)
        if (c) comments.set(c[1], c[2].trim())
      }
      const body = rawBody.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
      const t = { name, file: f, columns: [], pk: [], uniques: [] }
      for (const item of splitTop(body)) {
        let x
        if ((x = /^primary key\s*\(([^)]*)\)/i.exec(item))) { t.pk = list(x[1]); continue }
        if ((x = /^unique\s*\(([^)]*)\)/i.exec(item))) { t.uniques.push(list(x[1])); continue }
        if (/^(check\s*\(|constraint\s|foreign key\s*\()/i.test(item)) throw new Error(`${name}: unsupported table constraint: ${item}`)
        x = /^(\w+)\s+([\s\S]+)$/.exec(item)
        if (!x) throw new Error(`${name}: cannot read column: ${item}`)
        const [, col, rest] = x
        const type = /^(double precision|[a-z0-9]+(?:\[\])?)/i.exec(rest)?.[1]
        if (!type) throw new Error(`${name}.${col}: no type in "${rest}"`)
        const ref = /references\s+(\w+)/i.exec(rest)
        t.columns.push({
          name: col, type, notNull: /not null/i.test(rest) || /primary key/i.test(rest),
          pk: /primary key/i.test(rest), unique: /\bunique\b/i.test(rest),
          ref: ref?.[1] ?? null, onDelete: /on delete (cascade|set null)/i.exec(rest)?.[1].toLowerCase() ?? null,
          note: comments.get(col) ?? null,
        })
      }
      for (const c of t.pk) { const col = t.columns.find(k => k.name === c); if (col) col.pk = true }
      tables.set(name, t)
    }

    let handled = 0
    for (const m of sql.matchAll(/^alter table (\w+) add column (\w+)\s+([a-z0-9]+)([^;]*);/gim)) {
      handled++
      const [, table, col, type, rest] = m
      const t = tables.get(table); if (!t) throw new Error(`alter on unknown table ${table}`)
      t.columns.push({ name: col, type, notNull: /not null/i.test(rest), pk: false, unique: false, ref: null, onDelete: null, note: /generated/i.test(rest) ? 'generated (full-text search)' : null })
    }
    for (const m of sql.matchAll(/^alter table (\w+)\s+add foreign key\s*\((\w+)\)\s+references\s+(\w+)(?:\s+on delete (cascade|set null))?\s*;/gim)) {
      handled++
      const [, table, col, ref, onDelete] = m
      const c = tables.get(table)?.columns.find(k => k.name === col); if (!c) throw new Error(`alter FK on unknown column ${table}.${col}`)
      c.ref = ref; c.onDelete = onDelete ?? null
    }
    const all = [...sql.matchAll(/^alter table \w+\s+add (?:column|foreign key)/gim)].length
    if (all !== handled) throw new Error(`${f}: ${all - handled} alter table statement(s) the diagram parser cannot read`)
  }
  for (const t of tables.values()) for (const c of t.columns) if (c.ref && !tables.has(c.ref)) throw new Error(`${t.name}.${c.name} references unknown table ${c.ref}`)
  return { tables: [...tables.values()], files }
}
