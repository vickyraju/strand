// Report maths. Everything is reconstructed from the activity log, so reports reflect real history.
import { categoryOf, statOf, type Activity, type Category, type Issue, type Project, type Sprint, type State } from './reducer.ts'

export const DAY = 86_400_000

// Days in a time zone: the team's (spec 0412), or the viewer's own when none is set
const clocks = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** The wall clock at `t` in a time zone. */
function wall(t: number, tz?: string) {
  let f = clocks.get(tz ?? '')
  if (!f) clocks.set(tz ?? '', f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }))
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second!, wd: WEEKDAYS.indexOf(p.weekday!) }
}
/** The zone's offset from UTC at `t`, in milliseconds. */
const offsetAt = (t: number, tz?: string) => { const w = wall(t, tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000 }
/** Midnight starting `t`'s day in the zone. */
export function startOfDay(t: number, tz?: string) {
  const w = wall(t, tz), midnight = Date.UTC(w.y, w.m - 1, w.d)
  return midnight - offsetAt(midnight - offsetAt(t, tz), tz)              // the offset at midnight itself (a daylight-saving change)
}
/** The last moment of `t`'s day in the zone (a day can be 23 or 25 hours long). */
export const endOfDay = (t: number, tz?: string) => startOfDay(startOfDay(t, tz) + 26 * 3_600_000, tz) - 1
/** `t`'s date in the zone, YYYY-MM-DD. */
export const isoDay = (t: number, tz?: string) => { const w = wall(t, tz); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}` }
export const dayLabel = (t: number, tz?: string) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: tz })

/** Status changes per issue, oldest first. */
export function statusHistory(state: State) {
  const map = new Map<string, Activity[]>()
  for (const a of state.activity) {
    if (a.field !== 'status') continue
    const list = map.get(a.issueId)
    if (list) list.push(a); else map.set(a.issueId, [a])
  }
  for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt)
  return map
}

/** The status an issue had at time `t` (undefined if it didn't exist yet). */
export function statusAt(issue: Issue, history: Activity[] | undefined, t: number): string | undefined {
  if (issue.createdAt > t) return undefined
  let status = history?.[0]?.to ?? issue.status
  for (const a of history ?? []) {
    if (a.createdAt > t) break
    if (a.to) status = a.to
  }
  return status
}

/** When the issue last entered a done status (undefined if not done now). */
export function resolvedAt(project: Project, issue: Issue, history: Activity[] | undefined) {
  if (categoryOf(project, issue.status) !== 'done') return undefined
  const entered = (history ?? []).filter(a => a.to && categoryOf(project, a.to) === 'done' && (!a.from || categoryOf(project, a.from) !== 'done'))
  return entered.at(-1)?.createdAt ?? issue.updatedAt
}

export function days(from: number, to: number, tz?: string) {
  const out: number[] = []
  for (let t = startOfDay(from, tz); t <= to; t = startOfDay(t + 26 * 3_600_000, tz)) out.push(t)
  return out
}

// ── Sprint reports ─────────────────────────────────────────

export function sprintMembers(state: State, sprint: Sprint) {
  return sprint.state === 'closed' && sprint.issueIds
    ? state.issues.filter(i => sprint.issueIds!.includes(i.id))
    : state.issues.filter(i => i.sprintId === sprint.id)
}

/** A board's working days (spec 0405): weekdays (0 is Sunday), non-working dates (YYYY-MM-DD), and the team's time zone (spec 0412). */
export interface WorkingDays { weekdays: number[]; nonWorking: string[]; timeZone?: string }
export const isWorkingDay = (t: number, w?: WorkingDays) => !w || (w.weekdays.includes(wall(t, w.timeZone).wd) && !w.nonWorking.includes(isoDay(t, w.timeZone)))

/** The guideline (Jira's grey line): from `total` to zero, falling only across working days, flat on the others. */
export function guideline(timeline: number[], total: number, w?: WorkingDays) {
  // each working day after the first takes an equal share; a day off keeps the previous value
  const steps = timeline.map((t, k): number => (k > 0 && isWorkingDay(t, w) ? 1 : 0))
  const all = steps.reduce((n, x) => n + x, 0)
  let done = 0
  return timeline.map((_, k) => { done += steps[k]!; return all ? Math.max(0, total - (total * done) / all) : total })
}

/** An item's remaining estimate at a moment, from its history (spec 0412 R2); without one, its original estimate then. */
export function remainingAt(state: State) {
  const by = (f: string) => {
    const m = new Map<string, Activity[]>()
    for (const a of state.activity) if (a.field === f) (m.get(a.issueId) ?? m.set(a.issueId, []).get(a.issueId)!).push(a)
    for (const l of m.values()) l.sort((x, y) => x.createdAt - y.createdAt)
    return m
  }
  const rem = by('timeRemaining'), est = by('timeEstimate')
  const at = (list: Activity[] | undefined, now: number | undefined, t: number): number | null => {
    if (!list?.length) return now ?? null
    const before = list.filter(a => a.createdAt <= t)
    const v = before.length ? before.at(-1)!.to : list[0]!.from
    return v == null || v === '' ? null : Number(v)
  }
  return (i: Issue, t: number) => at(rem.get(i.id), i.timeRemaining, t) ?? at(est.get(i.id), i.timeEstimate, t) ?? 0
}

/** A sprint's burndown in its statistic, or with remaining-estimate tracking (spec 0412 R2) its remaining estimate, which
 *  falls as work is logged. Days are the team's (`working.timeZone`). */
export function burndown(state: State, project: Project, sprint: Sprint, now = Date.now(), working?: WorkingDays, tracking: 'none' | 'remaining' = 'none') {
  if (!sprint.startedAt) return null
  const end = sprint.completedAt ?? sprint.endsAt ?? now
  const members = sprintMembers(state, sprint)
  const history = statusHistory(state)
  const remainingEstimate = tracking === 'remaining' ? remainingAt(state) : null
  const stat = (i: Issue, t: number) => remainingEstimate ? remainingEstimate(i, t) : statOf(i, sprint.estimation)   // the sprint's statistic (spec 0404)
  const total = remainingEstimate ? members.reduce((n, i) => n + stat(i, sprint.startedAt!), 0) : sprint.committed ?? members.reduce((n, i) => n + stat(i, now), 0)
  const tz = working?.timeZone
  const timeline = days(sprint.startedAt, end, tz)
  const last = Math.min(now, end)
  const remaining = timeline.map(d => {
    if (d > last) return NaN
    const t = Math.min(endOfDay(d, tz), last)
    return members.reduce((n, i) => {
      const st = statusAt(i, history.get(i.id), t)
      return n + (st && categoryOf(project, st) === 'done' ? 0 : stat(i, t))
    }, 0)
  })
  const ideal = guideline(timeline, total, working)                      // flat on the board's days off (spec 0405)
  return { labels: timeline.map(d => dayLabel(d, tz)), remaining, ideal, total, members }
}

export function velocity(state: State, project: Project) {
  const closed = state.sprints
    .filter(s => s.projectId === project.id && s.state === 'closed')
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    .slice(-8)
  return {
    labels:    closed.map(s => s.name.replace(`${project.key} `, '')),
    committed: closed.map(s => s.committed ?? 0),
    completed: closed.map(s => s.completed ?? 0),
    average:   closed.length ? closed.reduce((n, s) => n + (s.completed ?? 0), 0) / closed.length : 0,
  }
}

// ── Flow reports ───────────────────────────────────────────

export function cumulativeFlow(state: State, project: Project, span: number, now = Date.now()) {
  const items = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic')
  const history = statusHistory(state)
  const timeline = days(now - (span - 1) * DAY, now)
  const counts: Record<Category, number[]> = { todo: [], 'in-progress': [], done: [] }
  for (const d of timeline) {
    const t = Math.min(endOfDay(d), now)
    const c: Record<Category, number> = { todo: 0, 'in-progress': 0, done: 0 }
    for (const i of items) {
      const st = statusAt(i, history.get(i.id), t)
      if (st) c[categoryOf(project, st)]++
    }
    for (const k of Object.keys(c) as Category[]) counts[k].push(c[k])
  }
  return { labels: timeline.map(d => dayLabel(d)), counts }
}

export function createdVsResolved(state: State, project: Project, span: number, now = Date.now()) {
  const items = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic')
  const history = statusHistory(state)
  // Weekly buckets for long ranges keep the chart readable
  const bucket = span > 45 ? 7 * DAY : DAY
  const start = startOfDay(now - (span - 1) * DAY)
  const buckets: number[] = []
  for (let t = start; t <= now; t += bucket) buckets.push(t)
  const idx = (t: number) => Math.floor((t - start) / bucket)
  const created = buckets.map(() => 0)
  const resolved = buckets.map(() => 0)
  for (const i of items) {
    if (i.createdAt >= start) created[idx(i.createdAt)]++
    const r = resolvedAt(project, i, history.get(i.id))
    if (r && r >= start && r <= now) resolved[idx(r)]++
  }
  return { labels: buckets.map(d => dayLabel(d)), created, resolved, bucket }
}

// ── Summary ────────────────────────────────────────────────

export function lastWeek(state: State, project: Project, now = Date.now()) {
  const items = state.issues.filter(i => i.projectId === project.id)
  const history = statusHistory(state)
  const since = now - 7 * DAY
  const inWeek = (t?: number) => !!t && t >= since
  return {
    completed: items.filter(i => inWeek(resolvedAt(project, i, history.get(i.id)))).length,
    updated:   items.filter(i => inWeek(i.updatedAt)).length,
    created:   items.filter(i => inWeek(i.createdAt)).length,
    dueSoon:   items.filter(i => {
      if (!i.dueDate || categoryOf(project, i.status) === 'done') return false
      const due = new Date(i.dueDate + 'T23:59').getTime()
      return due >= now - DAY && due <= now + 7 * DAY
    }).length,
  }
}
