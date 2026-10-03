// CSV import: parse (RFC 4180: quoted fields, escaped quotes, newlines inside quotes) and map rows to work items.
import type { IssueType, NewIssue, Priority, Project, User } from './reducer.ts'

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim())) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim())) rows.push(row)
  return rows
}

export type ImportField = 'title' | 'description' | 'type' | 'status' | 'priority' | 'assignee' | 'labels' | 'estimate' | 'dueDate'
export const IMPORT_FIELDS: { id: ImportField; label: string; aliases: string[] }[] = [
  { id: 'title',       label: 'Title',        aliases: ['title', 'summary', 'name', 'task', 'subject'] },
  { id: 'description', label: 'Description',  aliases: ['description', 'details', 'body', 'notes'] },
  { id: 'type',        label: 'Type',         aliases: ['type', 'issue type', 'work type', 'issuetype'] },
  { id: 'status',      label: 'Status',       aliases: ['status', 'state'] },
  { id: 'priority',    label: 'Priority',     aliases: ['priority'] },
  { id: 'assignee',    label: 'Assignee',     aliases: ['assignee', 'owner', 'assigned to'] },
  { id: 'labels',      label: 'Labels',       aliases: ['labels', 'label', 'tags'] },
  { id: 'estimate',    label: 'Story points', aliases: ['story points', 'points', 'estimate', 'story point estimate'] },
  { id: 'dueDate',     label: 'Due date',     aliases: ['due date', 'due', 'deadline'] },
]

/** Guess which CSV column feeds each field, from the header names. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const map: Partial<Record<ImportField, number>> = {}
  headers.forEach((h, idx) => {
    const name = h.trim().toLowerCase()
    const f = IMPORT_FIELDS.find(x => x.aliases.includes(name))
    if (f && map[f.id] === undefined) map[f.id] = idx
  })
  return map
}

const PRIORITY: Record<string, Priority> = {
  highest: 'urgent', urgent: 'urgent', critical: 'urgent', blocker: 'urgent',
  high: 'high', major: 'high', medium: 'medium', normal: 'medium', low: 'low', minor: 'low', lowest: 'low', trivial: 'low', none: 'none',
}
const TYPE: Record<string, IssueType> = { bug: 'bug', defect: 'bug', story: 'story', 'user story': 'story', epic: 'epic', task: 'task', 'sub-task': 'task', subtask: 'task', feature: 'story', improvement: 'task' }

/** YYYY-MM-DD from common date formats, or undefined. */
function toDate(v: string) {
  const s = v.trim()
  if (!s) return undefined
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface ImportRow { issue: NewIssue; warnings: string[] }

export function mapRows(rows: string[][], mapping: Partial<Record<ImportField, number>>, project: Project, users: User[]): ImportRow[] {
  const get = (r: string[], f: ImportField) => mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim()
  return rows.map(r => {
    const warnings: string[] = []
    const statusName = get(r, 'status')
    const status = project.statuses.find(s => s.name.toLowerCase() === statusName.toLowerCase())
    if (statusName && !status) warnings.push(`status “${statusName}” → ${project.statuses[0].name}`)
    const who = get(r, 'assignee')
    const assignee = users.find(u => u.name.toLowerCase() === who.toLowerCase() || u.name.split(' ')[0].toLowerCase() === who.toLowerCase())
    if (who && !assignee) warnings.push(`no person called “${who}”`)
    const points = Number(get(r, 'estimate'))
    return {
      warnings,
      issue: {
        projectId: project.id,
        title: get(r, 'title'),
        description: get(r, 'description'),
        type: TYPE[get(r, 'type').toLowerCase()] ?? 'task',
        status: status?.id ?? project.statuses[0].id,
        priority: PRIORITY[get(r, 'priority').toLowerCase()] ?? 'medium',
        assigneeId: assignee?.id,
        labels: get(r, 'labels').split(/[,;]|\s+/).map(l => l.trim()).filter(Boolean),
        estimate: get(r, 'estimate') && Number.isFinite(points) ? points : undefined,
        dueDate: toDate(get(r, 'dueDate')),
      },
    }
  })
}
