// CSV import, as Jira's importer works: map columns to fields, check every row first (a dry run, the default), then
// import in the background. Rows with problems are reported, not guessed at: a row without a title is left out; a value
// that matches nothing (an unknown status, person, component…) is left empty with a warning. Each row's work item has an
// id made from the import and the row number, so running the same import again (a retry, a restart) adds nothing twice.
import { createHash } from 'node:crypto'
import { tx, type Db } from './db.ts'
import type { Me } from './auth.ts'
import { parseCsv } from './shared/csv.ts'
import { registerJob } from './jobs.ts'
import { canJoinWork } from './access.ts'

export const IMPORT_FIELDS = ['title', 'description', 'type', 'status', 'priority', 'assignee', 'labels', 'estimate', 'dueDate', 'startDate', 'components', 'fixVersion'] as const
export type ImportField = typeof IMPORT_FIELDS[number] | `custom.${string}`
export interface RowReport { row: number; title: string; ok: boolean; errors: string[]; warnings: string[] }

const PRIORITY: Record<string, string> = {
  highest: 'urgent', urgent: 'urgent', critical: 'urgent', blocker: 'urgent', high: 'high', major: 'high',
  medium: 'medium', normal: 'medium', low: 'low', minor: 'low', lowest: 'low', trivial: 'low', none: 'none', '': 'none',
}
/** YYYY-MM-DD from common date forms (ISO, 1/Oct/26, Oct 1 2026), or null. */
function toDate(v: string) {
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4})/.exec(s)                       // Jira's export: 01/Oct/26
  const d = new Date(jira ? `${jira[2]} ${jira[1]} ${jira[3]!.length === 2 ? '20' + jira[3] : jira[3]}` : s)
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** A stable uuid for one row of one import. */
export const rowId = (importId: string, row: number) => {
  const h = createHash('sha1').update(`${importId}:${row}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Read the file and check every row against the project. Returns the work items it would create and a report per row. */
export async function checkImport(d: Db, projectId: string, csv: string, mapping: Partial<Record<string, number>>) {
  const rows = parseCsv(csv)
  const [header, ...data] = rows
  if (!header) return { header: [], items: [], report: [] as RowReport[] }
  const named = async <T,>(sql: string) => new Map((await d.query<{ k: string } & T>(sql, [projectId])).map(r => [r.k.toLowerCase(), r]))
  const [statuses, types, users, components, releases, fields] = await Promise.all([
    named<{ id: string }>('select lower(name) as k, id from statuses where project_id = $1'),
    named<{ key: string }>('select lower(name) as k, key from work_types where project_id = $1 union select key, key from work_types where project_id = $1'),
    named<{ id: string }>(`select lower(u.email) as k, u.id from users u join memberships m on m.user_id = u.id join projects p on p.workspace_id = m.workspace_id where p.id = $1 and u.active
                           union select lower(u.name), u.id from users u join memberships m on m.user_id = u.id join projects p on p.workspace_id = m.workspace_id where p.id = $1 and u.active`),
    named<{ id: string }>('select lower(name) as k, id from components where project_id = $1'),
    named<{ id: string }>('select lower(name) as k, id from releases where project_id = $1'),
    named<{ id: string; kind: string; options: string[] | null; name: string }>('select id::text as k, id, kind, options, name from field_defs where project_id = $1'),
  ])
  const items: Record<string, unknown>[] = []
  const report: RowReport[] = []
  for (const [n, r] of data.entries()) {
    const row = n + 2                                                                   // as a spreadsheet numbers it (1 is the header)
    const get = (f: string) => (mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim())
    const errors: string[] = [], warnings: string[] = []
    const item: Record<string, unknown> = { title: get('title'), description: get('description') }
    if (!item.title) errors.push('No title')
    else if ((item.title as string).length > 500) errors.push('The title is longer than 500 characters')
    const pick = <T,>(f: string, map: Map<string, T>, what: string): T | undefined => {
      const v = get(f)
      if (!v) return undefined
      const hit = map.get(v.toLowerCase())
      if (!hit) warnings.push(`${what} “${v}” isn’t in this project: left empty`)
      return hit
    }
    const st = pick('status', statuses, 'Status'); if (st) item.statusId = (st as any).id
    const ty = pick('type', types, 'Type'); item.type = ty ? (ty as any).key : 'task'
    const who = pick('assignee', users, 'Person')
    if (who) { if (await canJoinWork(d, projectId, (who as any).id)) item.assigneeId = (who as any).id; else warnings.push(`${get('assignee')} isn’t in this project: left unassigned`) }
    const pr = get('priority')
    item.priority = PRIORITY[pr.toLowerCase()] ?? (warnings.push(`Priority “${pr}” isn’t known: none`), 'none')
    const labels = get('labels'); if (labels) item.labels = [...new Set(labels.split(/[,;]|\s+/).map(l => l.trim()).filter(Boolean))].slice(0, 50)
    const est = get('estimate')
    if (est) { if (Number.isFinite(Number(est)) && Number(est) >= 0) item.estimate = Number(est); else warnings.push(`Story points “${est}” isn’t a number: left empty`) }
    for (const f of ['dueDate', 'startDate'] as const) {
      const v = get(f)
      if (v) { const dd = toDate(v); if (dd) item[f] = dd; else warnings.push(`${f === 'dueDate' ? 'Due' : 'Start'} date “${v}” isn’t a date: left empty`) }
    }
    const comps = get('components')
    if (comps) item.componentIds = comps.split(/[,;]/).map(c => c.trim()).filter(Boolean).flatMap(c => {
      const hit = components.get(c.toLowerCase()); if (!hit) warnings.push(`Component “${c}” isn’t in this project: left out`); return hit ? [hit.id] : []
    })
    const fix = pick('fixVersion', releases, 'Release'); if (fix) item.releaseId = (fix as any).id
    const custom: Record<string, string | number> = {}
    for (const k of Object.keys(mapping).filter(k => k.startsWith('custom.'))) {
      const v = get(k), f = fields.get(k.slice(7))
      if (!v || !f) continue
      if (f.kind === 'number') { if (Number.isFinite(Number(v))) custom[f.id] = Number(v); else warnings.push(`${f.name} “${v}” isn’t a number: left empty`) }
      else if (f.kind === 'select') { const o = (f.options ?? []).find(x => x.toLowerCase() === v.toLowerCase()); if (o) custom[f.id] = o; else warnings.push(`${f.name} “${v}” isn’t one of its options: left empty`) }
      else if (f.kind === 'date') { const dd = toDate(v); if (dd) custom[f.id] = dd; else warnings.push(`${f.name} “${v}” isn’t a date: left empty`) }
      else custom[f.id] = v.slice(0, 5000)
    }
    if (Object.keys(custom).length) item.custom = custom
    report.push({ row, title: String(item.title ?? ''), ok: !errors.length, errors, warnings })
    if (!errors.length) items.push({ ...item, row })
  }
  return { header, items, report }
}

/** The import itself, as a background job: every checked row becomes a work item, in one transaction. Rows already
 *  imported by an earlier run of the same import are skipped. */
registerJob('csv.import', async (p: { importId: string; projectId: string; me: Me; csv: string; mapping: Record<string, number> }) => {
  const { insertIssue } = await import('./routes/issues.ts')
  return tx(async d => {
    const { items, report } = await checkImport(d, p.projectId, p.csv, p.mapping)
    let created = 0, already = 0
    for (const { row, ...item } of items as ({ row: number } & Record<string, unknown>)[]) {
      const id = rowId(p.importId, row)
      if ((await d.query('select 1 from issues where id = $1', [id])).length) { already++; continue }
      await insertIssue(d, p.me, p.projectId, { ...item, id }, `Imported from CSV (row ${row})`)
      created++
    }
    return { created, already, skipped: report.filter(r => !r.ok).length, warnings: report.reduce((n, r) => n + r.warnings.length, 0) }
  })
})
