// Report maths. Everything is reconstructed from the activity log, so reports reflect real history.
import { categoryOf, type Activity, type Category, type Issue, type Project, type Sprint, type State } from './reducer.ts'

export const DAY = 86_400_000
const endOfDay = (t: number) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime() }
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
export const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

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

/** When work first started (first move into an in-progress status). */
export function startedAt(project: Project, history: Activity[] | undefined) {
  return history?.find(a => a.to && categoryOf(project, a.to) === 'in-progress')?.createdAt
}

function days(from: number, to: number) {
  const out: number[] = []
  for (let t = startOfDay(from); t <= to; t += DAY) out.push(t)
  return out
}

// ── Sprint reports ─────────────────────────────────────────

export function sprintMembers(state: State, sprint: Sprint) {
  return sprint.state === 'closed' && sprint.issueIds
    ? state.issues.filter(i => sprint.issueIds!.includes(i.id))
    : state.issues.filter(i => i.sprintId === sprint.id)
}

export function burndown(state: State, project: Project, sprint: Sprint, now = Date.now()) {
  if (!sprint.startedAt) return null
  const end = sprint.completedAt ?? sprint.endsAt ?? now
  const members = sprintMembers(state, sprint)
  const history = statusHistory(state)
  const total = sprint.committed ?? members.reduce((n, i) => n + (i.estimate ?? 0), 0)
  const timeline = days(sprint.startedAt, end)
  const last = Math.min(now, end)
  const remaining = timeline.map(d => {
    if (d > last) return NaN
    const t = Math.min(endOfDay(d), last)
    return members.reduce((n, i) => {
      const st = statusAt(i, history.get(i.id), t)
      return n + (st && categoryOf(project, st) === 'done' ? 0 : (i.estimate ?? 0))
    }, 0)
  })
  const ideal = timeline.map((_, k) => Math.max(0, total - (total * k) / Math.max(1, timeline.length - 1)))
  return { labels: timeline.map(dayLabel), remaining, ideal, total, members }
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
  return { labels: timeline.map(dayLabel), counts }
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
  return { labels: buckets.map(dayLabel), created, resolved, bucket }
}

export function cycleTimes(state: State, project: Project) {
  const history = statusHistory(state)
  const points = state.issues
    .filter(i => i.projectId === project.id && i.type !== 'epic')
    .map(i => {
      const h = history.get(i.id)
      const done = resolvedAt(project, i, h)
      const start = startedAt(project, h)
      return done && start && done > start ? { issue: i, done, days: (done - start) / DAY } : null
    })
    .filter((x): x is { issue: Issue; done: number; days: number } => !!x)
  const sorted = points.map(p => p.days).sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const p85 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85))] : 0
  return { points, median, p85 }
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
