import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseSchema } from './schema.mjs'

const root = new URL('../../', import.meta.url)
const read = f => readFileSync(new URL(`docs/architecture/${f}`, root), 'utf8')
const gen = f => execFileSync('node', [`scripts/diagrams/${f}`], { cwd: root, stdio: 'pipe' })

/** ids, parents and edge ends of every page in a .drawio file (regex-level: the files are generated, so their shape is fixed) */
function cells(xml) {
  return {
    ids: [...xml.matchAll(/<mxCell id="([^"]+)"/g)].map(m => m[1]),
    edges: [...xml.matchAll(/<mxCell id="([^"]+)"[^>]*edge="1"[^>]*source="([^"]+)" target="([^"]+)"/g)].map(m => ({ id: m[1], source: m[2], target: m[3] })),
    pages: [...xml.matchAll(/<diagram [^>]*name="([^"]+)"/g)].map(m => m[1]),
  }
}

for (const [file, generator] of [['jira-build-data-model.drawio', 'gen-data-model.mjs'], ['jira-build-aws-architecture.drawio', 'gen-aws.mjs']]) {
  test(`${file}: up to date, well-formed, every edge ends on a real cell`, () => {
    const before = read(file)
    gen(generator)
    assert.equal(read(file), before, `${file} is stale: run \`node scripts/diagrams/${generator}\` and commit`)
    const xml = read(file)
    assert.match(xml, /^<mxfile [^>]*compressed="false"/)
    // every page's cell ids are unique within the page
    for (const page of xml.split('<diagram ').slice(1)) {
      const { ids } = cells(page)
      assert.equal(new Set(ids).size, ids.length, 'duplicate cell ids on a page')
      for (const e of cells(page).edges) { assert.ok(ids.includes(e.source), `edge ${e.id}: missing source ${e.source}`); assert.ok(ids.includes(e.target), `edge ${e.id}: missing target ${e.target}`) }
    }
    assert.ok(!/<mxCell[^>]*value="[^"]*&amp;lt;br/.test(xml), 'labels must not be double-escaped')
  })
}

test('data model: every table, column and foreign key in the migrations is in the diagram', () => {
  const xml = read('jira-build-data-model.drawio')
  const OMIT = ['integrations', 'repositories', 'dev_entities', 'dev_links', 'webhook_deliveries', 'user_identities']   // paused GitHub feature, left out on purpose
  const { tables: all } = parseSchema()
  const tables = all.filter(t => !OMIT.includes(t.name))
  const ids = new Set(cells(xml).ids)
  assert.equal(all.length, 29)
  assert.equal(tables.length, 23)
  for (const o of OMIT) assert.ok(!ids.has(`t_${o}`), `${o} should not be in the diagram`)
  let fks = 0
  for (const t of tables) {
    assert.ok(ids.has(`t_${t.name}`), `table ${t.name} missing`)
    for (const c of t.columns) {
      assert.ok(ids.has(`r_${t.name}_${c.name}`), `column ${t.name}.${c.name} missing`)
      if (c.ref) fks++
    }
  }
  assert.match(xml, new RegExp(`${tables.length} tables · ${fks} foreign keys`))
  // every foreign key that is drawn (not text-only) has an edge from its column row
  const edges = cells(xml).edges
  const drawn = tables.flatMap(t => t.columns.filter(c => c.ref).map(c => ({ t: t.name, c: c.name, ref: c.ref })))
    .filter(f => !(['workspaces', 'users'].includes(f.ref)))
  for (const f of drawn) assert.ok(edges.some(e => e.source === `r_${f.t}_${f.c}`), `no line for ${f.t}.${f.c} → ${f.ref}`)
})

test('AWS diagram: uses only icons draw.io knows and names every planned component', () => {
  const xml = read('jira-build-aws-architecture.drawio')
  const names = new Set(readFileSync(new URL('scripts/diagrams/aws4-names.txt', root), 'utf8').split('\n').filter(Boolean).map(l => l.split(':')[1]))
  for (const m of xml.matchAll(/(?:resIcon|grIcon)=mxgraph\.aws4\.([a-z0-9_]+)/g)) assert.ok(names.has(m[1]), `unknown icon ${m[1]}`)
  for (const m of xml.matchAll(/shape=mxgraph\.aws4\.([a-z0-9_]+)/g)) if (m[1] !== 'resourceIcon' && m[1] !== 'group') assert.ok(names.has(m[1]), `unknown shape ${m[1]}`)
  assert.equal(cells(xml).pages.length, 2)
  for (const must of ['jira-build', 'EKS', 'Aurora', 'CloudFront', 'AWS WAF', 'RDS Proxy', 'SQS', 'ElastiCache', 'Global Database']) assert.ok(xml.includes(must), `diagram lacks ${must}`)
  // production design only: no integrations, no identity-provider or SCIM detail, no 'planned' markers, no old product name
  for (const banned of ['GitHub', 'Entra', 'SCIM', 'PLANNED', 'Strand', 'Vercel', 'Render', 'Neon']) assert.ok(!xml.includes(banned), `diagram must not mention ${banned}`)
})
