import type { Estimation, Issue } from './reducer.ts'

/** Jira's time tracking settings (System settings › Time tracking, spec 0306): how long a day and a week are, how time is
 *  shown, and the unit of a number typed alone. Times themselves are always minutes. */
export interface TimeSettings { hoursPerDay: number; daysPerWeek: number; format: 'pretty' | 'days' | 'hours'; defaultUnit: 'm' | 'h' | 'd' | 'w' }
export const DEFAULT_TIME: TimeSettings = { hoursPerDay: 8, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' }

const unitMinutes = (t: TimeSettings) => ({ m: 1, h: 60, d: t.hoursPerDay * 60, w: t.daysPerWeek * t.hoursPerDay * 60 })

/** "1w 2d 4h 30m", "45m", "2d" → minutes; a bare number is in the default unit. Returns null when it can't be read. */
export function parseDuration(text: string, t: TimeSettings = DEFAULT_TIME): number | null {
  const s = text.trim().toLowerCase()
  if (!s) return null
  const unit = unitMinutes(t)
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * unit[t.defaultUnit]) || null
  let total = 0
  let matched = ''
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m)/g)) {
    total += Number(m[1]) * unit[m[2] as keyof typeof unit]
    matched += m[0]
  }
  return matched.replace(/\s/g, '') === s.replace(/\s/g, '') && total > 0 ? Math.round(total) : null
}

/** Minutes as the settings show them: pretty (1w 2d 3h 30m), days (1.5d) or hours (12.5h). */
export function formatDuration(minutes: number, t: TimeSettings = DEFAULT_TIME) {
  if (minutes <= 0) return '0m'
  const unit = unitMinutes(t)
  const round = (n: number) => String(Math.round(n * 100) / 100)
  if (t.format === 'days') return `${round(minutes / unit.d)}d`
  if (t.format === 'hours') return `${round(minutes / unit.h)}h`
  let left = minutes
  const parts: string[] = []
  for (const u of ['w', 'd', 'h'] as const) {
    const n = Math.floor(left / unit[u])
    if (n) { parts.push(`${n}${u}`); left -= n * unit[u] }
  }
  if (left) parts.push(`${Math.round(left)}m`)
  return parts.join(' ')
}

export const loggedMinutes = (i: Issue) => i.worklogs.reduce((n, w) => n + w.minutes, 0)

/** A total in a board's estimation statistic, with its unit (spec 0404): "8 points", "1d 2h" (time format), "3 issues";
 *  a number field's total is the number (spec 0412). */
export function statLabel(total: number, e: Estimation = 'points', t: TimeSettings = DEFAULT_TIME) {
  if (e === 'time') return formatDuration(total, t)
  const n = Math.round(total * 10) / 10
  if (e.startsWith('field:')) return String(n)
  return `${n} ${e === 'count' ? (n === 1 ? 'issue' : 'issues') : n === 1 ? 'point' : 'points'}`
}
