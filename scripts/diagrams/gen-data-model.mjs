// Builds docs/architecture/strand-data-model.drawio from the migrations.   node scripts/diagrams/gen-data-model.mjs
import { writeFileSync } from 'node:fs'
import { Page, drawioFile, esc, style } from './drawio.mjs'
import { parseSchema } from './schema.mjs'

const APP = 'jira-build'
// Integration tables (GitHub) are left out: they belong to a feature that is paused, and this diagram is the core product.
const OMIT = new Set(['integrations', 'repositories', 'dev_entities', 'dev_links', 'webhook_deliveries', 'user_identities'])
const parsed = parseSchema()
const tables = parsed.tables.filter(t => !OMIT.has(t.name))
const files = [...new Set(tables.map(t => t.file))]
const byName = new Map(tables.map(t => [t.name, t]))

// ── Layout: domains in two rows; each domain lists its tables per column ──
const DOMAINS = [
  { key: 'people', title: 'Workspace & people', c: '#6C8EBF', f: '#EAF1FB', cols: [['workspaces', 'users', 'memberships', 'personal_access_tokens', 'audit_log', 'jobs', 'system_settings', 'rate_limited_accounts', 'project_backups'], ['groups', 'group_members', 'link_types']] },
  { key: 'projects', title: 'Projects & workflow', c: '#82B366', f: '#EFF7EA', cols: [['statuses', 'transitions', 'field_defs', 'stars', 'work_types', 'workflow_versions'], ['projects', 'project_members', 'project_group_roles', 'rules', 'item_templates', 'components']] },
  { key: 'planning', title: 'Planning', c: '#9673A6', f: '#F4EDF7', cols: [['sprints', 'releases']] },
  { key: 'work', title: 'Work items', c: '#D79B00', f: '#FFF6E5', cols: [['issues'], ['issue_links', 'issue_watchers', 'issue_editors', 'attachments', 'file_deletions', 'worklogs', 'labels']] },
  { key: 'collab', title: 'Collaboration', c: '#B85450', f: '#FBEDEC', cols: [['comments', 'activity', 'notifications']] },
  { key: 'personal', title: 'Views & personal', c: '#0E8088', f: '#E6F4F5', cols: [['saved_views', 'issue_views']] },
]
const rows1 = ['people', 'projects', 'planning', 'work']

const TW = 280, HEAD = 30, ROW = 22, GAP = 28, PAD = 20, TITLE = 36
const tableHeight = t => HEAD + (t.columns.length + (t.uniques.length ? 1 : 0)) * ROW
const colWidth = TW
const domainSize = d => {
  const colsH = d.cols.map(col => col.reduce((h, n) => h + tableHeight(byName.get(n)) + GAP, 0) - GAP)
  return { w: PAD * 2 + d.cols.length * colWidth + (d.cols.length - 1) * GAP, h: TITLE + PAD + Math.max(...colsH) + PAD }
}

const page = new Page('Data model', { width: 2400, height: 1800 })
page.edgesBehind = true   // relationship lines run behind the tables and show only in the gaps
const COLOR = new Map()          // table → domain colours
const rowId = (t, c) => `r_${t}_${c}`

const places = []
let x = 40
const row1H = Math.max(...rows1.map(k => domainSize(DOMAINS.find(d => d.key === k)).h))
for (const k of rows1) { const d = DOMAINS.find(d => d.key === k); places.push({ d, x, y: 150 }); x += domainSize(d).w + 50 }
const row2Y = 150 + row1H + 60
// Row 2 sits under the domains it talks to: Views & personal under people, the notes panel under projects/planning,
// Collaboration (references issues) under Work items.
const at = k => places.find(p => p.d.key === k)
const dom = k => DOMAINS.find(d => d.key === k)
places.push({ d: dom('personal'), x: at('people').x, y: row2Y })
const panelX = at('projects').x
places.push({ d: dom('collab'), x: at('work').x, y: row2Y })

page.text('1', 40, 24, 1400, 50, `<b style="font-size:24px">${APP} data model</b><br><span style="font-size:12px;color:#545B64">PostgreSQL schema, ${tables.length} tables, generated from ${files.map(f => f.replace(/^\d+_/, '')).join(', ')}</span>`, { size: 12, noOverlap: true })

for (const { d, x: dx, y: dy } of places) {
  const sz = domainSize(d)
  page.box({ id: `bg_${d.key}`, x: dx, y: dy, w: sz.w, h: sz.h, back: true, noOverlap: true, st: { rounded: 1, arcSize: 3, fillColor: d.f, strokeColor: d.c, dashed: d.dashed ? 1 : 0, dashPattern: d.dashed ? '6 4' : undefined, strokeWidth: d.dashed ? 1.5 : 1, pointerEvents: 0 } })
  const cid = page.panel('1', dx, dy, sz.w, sz.h, d.title, { fill: 'none', stroke: 'none', size: 14, id: `d_${d.key}`, font: d.c })
  d.cols.forEach((col, ci) => {
    let ty = TITLE + PAD
    for (const name of col) {
      const t = byName.get(name), tx = PAD + ci * (colWidth + GAP), th = tableHeight(t)
      COLOR.set(name, d.c)
      const tid = page.box({ id: `t_${name}`, parent: cid, x: tx, y: ty, w: TW, h: th, value: esc(name),
        st: { swimlane: '', fontStyle: 1, startSize: HEAD, horizontal: 1, collapsible: 0, html: 1, fontSize: 13, fontColor: '#ffffff', fillColor: d.c, swimlaneFillColor: '#ffffff', strokeColor: d.c, rounded: 1, arcSize: 6, container: 1, childLayout: undefined } })
      t.columns.forEach((c, i) => {
        const ry = HEAD + i * ROW
        const optional = !c.notNull
        page.box({ id: rowId(name, c.name), parent: tid, x: 0, y: ry, w: TW, h: ROW, value: esc(c.name),
          st: { text: '', html: 1, align: 'left', verticalAlign: 'middle', spacingLeft: 40, fontSize: 11, fontStyle: c.pk ? 1 : 0, fontColor: '#232F3E', whiteSpace: 'nowrap', overflow: 'hidden', strokeColor: 'none', fillColor: i % 2 ? '#FAFAFA' : '#ffffff' } })
        const tag = c.pk && c.ref ? 'PK,FK' : c.pk ? 'PK' : c.ref ? 'FK' : c.unique ? 'UQ' : ''
        if (tag) page.box({ parent: tid, x: 2, y: ry, w: 38, h: ROW, value: `<b>${tag}</b>`, noOverlap: true, st: { text: '', html: 1, align: 'center', verticalAlign: 'middle', fontSize: 9, fontColor: tag.includes('PK') ? '#9A6700' : tag === 'FK' ? '#1F5FA8' : '#6B6B6B', pointerEvents: 0 } })
        page.box({ parent: tid, x: TW - 152, y: ry, w: 146, h: ROW, value: esc(c.type + (optional ? '?' : '') + (c.ref ? ` → ${c.ref}` : '')), noOverlap: true, st: { text: '', html: 1, align: 'right', verticalAlign: 'middle', fontSize: 10, fontColor: '#6B7280', pointerEvents: 0 } })
      })
      if (t.uniques.length) page.box({ parent: tid, x: 0, y: HEAD + t.columns.length * ROW, w: TW, h: ROW, value: esc('unique ' + t.uniques.map(u => `(${u.join(', ')})`).join(' · ')), noOverlap: true,
        st: { text: '', html: 1, align: 'left', verticalAlign: 'middle', spacingLeft: 8, fontSize: 9, fontStyle: 2, fontColor: '#6B7280', strokeColor: 'none', fillColor: '#F3F4F6' } })
      ty += th + GAP
    }
  })
}

/** Which side a line leaves the source table and enters the target: facing each other, or both on the right for the same column. */
function sides(from, to) {
  const a = page.abs(page.cells.get(`t_${from}`)), b = page.abs(page.cells.get(`t_${to}`))
  if (Math.abs(a.x - b.x) < 20) return { exitX: 1, entryX: 1 }
  return b.x > a.x ? { exitX: 1, entryX: 0 } : { exitX: 0, entryX: 1 }
}

// ── Relationships: one line per foreign key, from the FK column row to the parent's id row ──
// References to the two hub tables (workspaces, users) from another domain would cross the whole page, so they are shown as
// text in the column (`uuid → users`) and counted, not drawn.
const domainOf = new Map(DOMAINS.flatMap(d => d.cols.flat().map(n => [n, d.key])))
const HUBS = new Set(['workspaces', 'users'])
// One long reference would run behind the Work items tables and look like it joins them, so it is text-only too
const TEXT_ONLY = new Set()
let fkCount = 0, drawn = 0, hubText = 0
for (const t of tables) for (const c of t.columns) {
  if (!c.ref) continue
  fkCount++
  if ((HUBS.has(c.ref) && domainOf.get(t.name) !== domainOf.get(c.ref)) || TEXT_ONLY.has(`${t.name}.${c.name}`)) { hubText++; continue }
  drawn++
  const parentPk = byName.get(c.ref).pk[0] ?? 'id'
  const color = COLOR.get(t.name)
  const base = { html: 1, strokeColor: color, strokeWidth: 1.5, fontSize: 9, startFill: 0, endFill: 0, startArrow: 'ERmany', endArrow: c.notNull ? 'ERmandOne' : 'ERzeroToOne' }
  const side = sides(t.name, c.ref)
  if (t.name === c.ref) {            // self reference (issues.parent_id): loop on the right-hand side
    const tb = page.abs(page.cells.get(`t_${t.name}`)), rb = page.abs(page.cells.get(rowId(t.name, c.name))), pb = page.abs(page.cells.get(rowId(t.name, parentPk)))
    page.edge({ source: rowId(t.name, c.name), target: rowId(t.name, parentPk), st: { ...base, edgeStyle: 'orthogonalEdgeStyle', rounded: 1, exitX: 1, exitY: 0.5, entryX: 1, entryY: 0.5 }, points: [[tb.x + tb.w + 24, rb.y + ROW / 2], [tb.x + tb.w + 24, pb.y + ROW / 2]] })
  } else page.edge({ source: rowId(t.name, c.name), target: rowId(c.ref, parentPk), st: { ...base, edgeStyle: 'orthogonalEdgeStyle', rounded: 1, jettySize: 'auto', exitY: 0.5, entryY: 0.5, exitPerimeter: 0, entryPerimeter: 0, ...side } })
}
// References that have no foreign key (ids stored inside an array or jsonb column): dashed, labelled
const LOGICAL = [
  ['sprints', 'issue_ids', 'issues', 'id', 'issue_ids[] (snapshot)'],
  ['transitions', 'from_ids', 'statuses', 'id', 'from_ids[]'],
  ['issues', 'custom', 'field_defs', 'id', 'custom{field id → value}'],
]
for (const [st, sc, tt, tc, label] of LOGICAL) {
  if (!page.cells.has(rowId(st, sc)) || !page.cells.has(rowId(tt, tc))) throw new Error(`logical link ${st}.${sc} → ${tt}.${tc} not found`)
  page.edge({ source: rowId(st, sc), target: rowId(tt, tc), value: label, st: { edgeStyle: 'orthogonalEdgeStyle', rounded: 1, exitY: 0.5, entryY: 0.5, exitPerimeter: 0, entryPerimeter: 0, ...sides(st, tt), html: 1, dashed: 1, dashPattern: '5 4', strokeColor: '#6B7280', strokeWidth: 1.2, endArrow: 'open', endFill: 0, fontSize: 9, fontColor: '#6B7280', labelBackgroundColor: '#ffffff' } })
}

// ── Notes and legend panel (bottom right) ──
const pw = 560
const notes = [
  ['Keys', 'uuid v7 primary keys (time-ordered). Every tenant table carries <b>workspace_id</b> or hangs off a table that does. References to <b>workspaces</b> and <b>users</b> from other domains are written in the column (<i>uuid → users</i>) instead of drawn, to keep the lines readable.'],
  ['Access', 'Row-level security is <b>on, with no policies</b>: only the API (a privileged role) reads or writes. Authorisation is in the API.'],
  ['Deletes', 'Issues are soft-deleted (<b>deleted_at</b>) so Undo can restore them. Everything else cascades from its parent.'],
  ['Concurrency', '<b>issues.version</b> is sent as If-Match on edits; a stale edit gets 409. <b>rank</b> is fractional, so a move rewrites one row.'],
  ['Flexible data', 'jsonb for shapes that vary: custom field values, board prefs, layout, rule triggers/actions, view filters, integration payloads.'],
  ['Search', 'issues.<b>search</b> is a generated tsvector (GIN); titles also have a trigram index. Partial indexes skip deleted rows.'],
]
const legendH = 40 + notes.length * 44 + 150
page.box({ id: 'bg_legend', x: panelX, y: row2Y, w: pw, h: Math.max(legendH, 520), back: true, noOverlap: true, st: { rounded: 1, arcSize: 3, fillColor: '#FFFFFF', strokeColor: '#879196', pointerEvents: 0 } })
const panel = page.panel('1', panelX, row2Y, pw, Math.max(legendH, 520), 'Conventions & legend', { fill: 'none', stroke: 'none', size: 14 })
notes.forEach(([h, body], i) => page.text(panel, 16, 40 + i * 44, pw - 32, 42, `<b>${h}.</b> ${body}`, { size: 10 }))
const ly = 40 + notes.length * 44 + 12
page.text(panel, 16, ly, 120, 18, '<b>Legend</b>', { size: 11, noOverlap: true })
const leg = (i, xx, yy, tag, color, desc) => { page.text(panel, xx, yy, 36, 18, `<b style="color:${color}">${tag}</b>`, { size: 10, align: 'center', noOverlap: true }); page.text(panel, xx + 40, yy, 200, 18, desc, { size: 10, noOverlap: true }) }
leg(0, 16, ly + 24, 'PK', '#9A6700', 'primary key'); leg(1, 16, ly + 46, 'FK', '#1F5FA8', 'foreign key'); leg(2, 16, ly + 68, 'UQ', '#6B6B6B', 'unique'); page.text(panel, 16, ly + 90, 260, 18, 'type<b>?</b> = nullable', { size: 10, noOverlap: true })
const sample = (yy, st) => { const a = page.box({ parent: panel, x: 290, y: yy + 8, w: 2, h: 2, noOverlap: true, st: { fillColor: 'none', strokeColor: 'none', pointerEvents: 0 } }); const b = page.box({ parent: panel, x: 350, y: yy + 8, w: 2, h: 2, noOverlap: true, st: { fillColor: 'none', strokeColor: 'none', pointerEvents: 0 } }); page.edge({ source: a, target: b, st }) }
sample(ly + 24, { html: 1, strokeColor: '#232F3E', strokeWidth: 1.5, startArrow: 'ERmany', endArrow: 'ERmandOne', startFill: 0, endFill: 0 }); page.text(panel, 365, ly + 24, 180, 18, 'one-to-many (required parent)', { size: 10, noOverlap: true })
sample(ly + 46, { html: 1, strokeColor: '#232F3E', strokeWidth: 1.5, startArrow: 'ERmany', endArrow: 'ERzeroToOne', startFill: 0, endFill: 0 }); page.text(panel, 365, ly + 46, 180, 18, 'one-to-many (optional parent)', { size: 10, noOverlap: true })
sample(ly + 68, { html: 1, strokeColor: '#6B7280', dashed: 1, dashPattern: '5 4', strokeWidth: 1.2, endArrow: 'open', endFill: 0 }); page.text(panel, 365, ly + 68, 190, 18, 'logical link (ids in array/jsonb, no FK)', { size: 10, noOverlap: true })
page.text(panel, 290, ly + 90, 260, 30, `${tables.length} tables · ${fkCount} foreign keys (${drawn} drawn, ${hubText} to workspaces/users shown as text) · ${LOGICAL.length} logical links`, { size: 10, noOverlap: true })

const bottom = Math.max(...places.map(p => p.y + domainSize(p.d).h), row2Y + 560)
page.width = Math.max(panelX + pw + 60, 2400); page.height = bottom + 60
const problems = page.problems()
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
const out = new URL('../../docs/architecture/jira-build-data-model.drawio', import.meta.url)
writeFileSync(out, drawioFile([page], { name: `${APP} data model` }))
console.log(`wrote jira-build-data-model.drawio: ${tables.length} tables, ${fkCount} foreign keys, ${LOGICAL.length} logical links, page ${page.width}x${page.height}`)
