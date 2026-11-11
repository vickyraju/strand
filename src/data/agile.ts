// Jira's agile reports for epics, versions and sprints (spec 0411): burnup, epic and version reports, epic and release
// burndowns. Worked out from the project's items and history, in the board's estimation statistic, with estimates as they
// stood at each moment (as Jira's reports count them).
import { categoryOf, statField, statOf, type Activity, type Estimation, type Issue, type Project, type Sprint, type State } from './reducer.ts'
import { DAY, dayLabel, days as daysFrom, endOfDay, guideline, resolvedAt, sprintMembers, statusHistory, type WorkingDays } from './analytics.ts'

/** R5: an item's statistic as it stood at a moment, as Jira's reports count it: its estimate history replayed (the last
 *  change by then, else the value before its first change, else what it is now). Count is always 1. */
export function estimatesAt(state: State, estimation?: Estimation) {
  const f = statField(estimation)
  const field = estimation === 'time' ? 'timeEstimate' : f ? `custom:${f}` : 'estimate'
  const changes = new Map<string, Activity[]>()
  for (const a of state.activity) if (a.field === field) (changes.get(a.issueId) ?? changes.set(a.issueId, []).get(a.issueId)!).push(a)
  for (const list of changes.values()) list.sort((x, y) => x.createdAt - y.createdAt)
  const num = (v?: string) => (v == null || v === '' ? 0 : Number(v) || 0)
  return (i: Issue, t: number) => {
    if (estimation === 'count') return 1
    const list = changes.get(i.id)
    if (!list?.length) return statOf(i, estimation)
    const before = list.filter(a => a.createdAt <= t)
    return before.length ? num(before[before.length - 1]!.to) : num(list[0]!.from)
  }
}

/** When each item was done (undefined: not done), from its status history. */
function doneTimes(state: State, project: Project, items: Issue[]) {
  const history = statusHistory(state)
  return new Map(items.map(i => [i.id, resolvedAt(project, i, history.get(i.id))]))
}

/** R1: a sprint's burnup: its scope and the work completed per day, and a guideline rising on working days. */
export function burnup(state: State, project: Project, sprint: Sprint, now = Date.now(), working?: WorkingDays) {
  if (!sprint.startedAt) return null
  const end = sprint.completedAt ?? sprint.endsAt ?? now
  const members = sprintMembers(state, sprint)
  const at = estimatesAt(state, sprint.estimation)
  const done = doneTimes(state, project, members)
  const tz = working?.timeZone                                         // the team's days (spec 0412)
  const timeline = daysFrom(sprint.startedAt, end, tz)
  const last = Math.min(now, end)
  // the scope moves when estimates change; work completed counts at its estimate when it was done
  const scopeOn = (d: number) => members.reduce((n, i) => n + at(i, Math.min(endOfDay(d, tz), last)), 0)
  const startScope = members.reduce((n, i) => n + at(i, sprint.startedAt!), 0)
  const completed = timeline.map(d => d > last ? NaN : members.reduce((n, i) => { const t = done.get(i.id); return n + (t !== undefined && t <= Math.min(endOfDay(d, tz), last) ? at(i, t) : 0) }, 0))
  const ideal = guideline(timeline, startScope, working).map(v => startScope - v)
  return { labels: timeline.map(d => dayLabel(d, tz)), scope: timeline.map(d => (d > last ? NaN : scopeOn(d))), completed, ideal }
}

/** R6: when an item joined an epic (parentId) or a version (fixReleaseIds): the last time its history put it there, else its creation. */
export function joinedAt(i: Issue, activity: Activity[], field: 'parentId' | 'fixReleaseIds', id: string) {
  const put = activity.filter(a => a.issueId === i.id && a.field === field && (a.to ?? '').split(',').includes(id))
  return put.length ? Math.max(...put.map(a => a.createdAt)) : i.createdAt
}

/** The items of an epic (its children) or of a version (fix versions). */
export const itemsOf = (state: State, project: Project, of: { epic?: string; version?: string }) =>
  state.issues.filter(i => i.projectId === project.id && i.type !== 'epic' && (of.epic ? i.parentId === of.epic : !!of.version && !!i.fixReleaseIds?.includes(of.version)))

/** R2, R3: total and completed work per day from `from` to `to`, and the three lists. */
export function progressReport(state: State, project: Project, of: { epic?: string; version?: string }, o: { from?: number; to?: number; estimation?: Estimation; now?: number; timeZone?: string } = {}) {
  const now = o.now ?? Date.now()
  const items = itemsOf(state, project, of)
  const at = estimatesAt(state, o.estimation)
  const done = doneTimes(state, project, items)
  const field = of.epic ? 'parentId' as const : 'fixReleaseIds' as const
  const joined = new Map(items.map(i => [i.id, joinedAt(i, state.activity, field, (of.epic ?? of.version)!)]))
  const start = o.from ?? Math.min(now, ...items.map(i => joined.get(i.id)!))
  const end = Math.min(o.to ?? now, now)
  const tz = o.timeZone
  const timeline = daysFrom(start, Math.max(start, end), tz)
  const total = timeline.map(d => items.reduce((n, i) => n + (joined.get(i.id)! <= endOfDay(d, tz) ? at(i, Math.min(endOfDay(d, tz), now)) : 0), 0))
  const completed = timeline.map(d => items.reduce((n, i) => { const t = done.get(i.id); return n + (t !== undefined && t <= endOfDay(d, tz) ? at(i, t) : 0) }, 0))
  const isDone = (i: Issue) => categoryOf(project, i.status) === 'done'
  const f = statField(o.estimation)
  const unestimated = (i: Issue) => !isDone(i) && (o.estimation === 'time' ? i.timeEstimate == null : o.estimation === 'count' ? false : f ? typeof i.custom?.[f] !== 'number' : i.estimate == null)
  return {
    labels: timeline.map(d => dayLabel(d, tz)), timeline, total, completed,
    lists: { completed: items.filter(isDone), incomplete: items.filter(i => !isDone(i) && !unestimated(i)), unestimated: items.filter(unestimated) },
  }
}

/** R3: the predicted release date at the pace so far (work done per day since `start`), 10% faster and 10% slower. */
export function predictRelease(o: { start: number; now: number; total: number; completed: number }) {
  const elapsed = Math.max(1, (o.now - o.start) / DAY), pace = o.completed / elapsed, remaining = o.total - o.completed
  if (remaining <= 0) return { predicted: o.now, optimistic: o.now, pessimistic: o.now }
  if (pace <= 0) return null
  const at = (p: number) => o.now + Math.ceil(remaining / p) * DAY
  return { predicted: at(pace), optimistic: at(pace * 1.1), pessimistic: at(pace * 0.9) }
}

/** R4: an epic's or a version's burndown across sprints: per sprint, completed in it, remaining after it, added during it;
 *  and the forecast in sprints at the average of the last three sprints' completed work. */
export function scopeBurndown(state: State, project: Project, of: { epic?: string; version?: string }, sprints: Sprint[], estimation?: Estimation, now = Date.now()) {
  const items = itemsOf(state, project, of)
  const at = estimatesAt(state, estimation)
  const done = doneTimes(state, project, items)
  const field = of.epic ? 'parentId' as const : 'fixReleaseIds' as const
  const joined = new Map(items.map(i => [i.id, joinedAt(i, state.activity, field, (of.epic ?? of.version)!)]))
  const runs = sprints.filter(s => s.startedAt && (s.state === 'closed' || s.state === 'active')).sort((a, b) => a.startedAt! - b.startedAt!)
  const rows = runs.map((s, k) => {
    const from = s.startedAt!, to = s.state === 'closed' ? (s.completedAt ?? now) : now
    const isDoneBy = (i: Issue, t: number) => { const d = done.get(i.id); return d !== undefined && d <= t }
    const sum = (f: (i: Issue) => boolean, v: (i: Issue) => number) => items.filter(f).reduce((n, i) => n + v(i), 0)
    return {
      name: s.name, active: s.state === 'active',
      // completed at its estimate when done; remaining at its estimate at the sprint's end
      completed: sum(i => { const d = done.get(i.id); return d !== undefined && d > from && d <= to }, i => at(i, done.get(i.id)!)),
      remaining: sum(i => joined.get(i.id)! <= to && !isDoneBy(i, to), i => at(i, to)),
      // Jira's scope change: work that joined during the sprint, and estimates raised during it on work already there
      added: k === 0 ? 0 : sum(i => joined.get(i.id)! > from && joined.get(i.id)! <= to, i => at(i, to))
        + sum(i => joined.get(i.id)! <= from && !isDoneBy(i, from), i => Math.max(0, at(i, Math.min(to, done.get(i.id) ?? to)) - at(i, from))),
    }
  })
  const closed = rows.filter(r => !r.active).slice(-3)
  const pace = closed.length ? closed.reduce((n, r) => n + r.completed, 0) / closed.length : 0
  const remaining = items.filter(i => done.get(i.id) === undefined).reduce((n, i) => n + at(i, now), 0)
  return { rows, remaining, forecast: remaining <= 0 ? 0 : pace > 0 ? Math.ceil(remaining / pace) : null }
}
