// Jira's agile reports for epics, versions and sprints (spec 0411): burnup, epic and version reports, epic and release
// burndowns. Worked out from the project's items and history, in the board's estimation statistic.
import { categoryOf, statOf, type Activity, type Estimation, type Issue, type Project, type Sprint, type State } from './reducer.ts'
import { DAY, dayLabel, guideline, resolvedAt, sprintMembers, statusHistory, type WorkingDays } from './analytics.ts'

const endOfDay = (t: number) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime() }
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const daysFrom = (from: number, to: number) => { const out: number[] = []; for (let t = startOfDay(from); t <= to; t += DAY) out.push(t); return out }

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
  const stat = (i: Issue) => statOf(i, sprint.estimation)
  const done = doneTimes(state, project, members)
  const scope = members.reduce((n, i) => n + stat(i), 0)
  const timeline = daysFrom(sprint.startedAt, end)
  const last = Math.min(now, end)
  const completed = timeline.map(d => d > last ? NaN : members.reduce((n, i) => { const t = done.get(i.id); return n + (t !== undefined && t <= Math.min(endOfDay(d), last) ? stat(i) : 0) }, 0))
  const ideal = guideline(timeline, scope, working).map(v => scope - v)
  return { labels: timeline.map(dayLabel), scope: timeline.map(d => (d > last ? NaN : scope)), completed, ideal }
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
export function progressReport(state: State, project: Project, of: { epic?: string; version?: string }, o: { from?: number; to?: number; estimation?: Estimation; now?: number } = {}) {
  const now = o.now ?? Date.now()
  const items = itemsOf(state, project, of)
  const stat = (i: Issue) => statOf(i, o.estimation)
  const done = doneTimes(state, project, items)
  const field = of.epic ? 'parentId' as const : 'fixReleaseIds' as const
  const joined = new Map(items.map(i => [i.id, joinedAt(i, state.activity, field, (of.epic ?? of.version)!)]))
  const start = o.from ?? Math.min(now, ...items.map(i => joined.get(i.id)!))
  const end = Math.min(o.to ?? now, now)
  const timeline = daysFrom(start, Math.max(start, end))
  const total = timeline.map(d => items.reduce((n, i) => n + (joined.get(i.id)! <= endOfDay(d) ? stat(i) : 0), 0))
  const completed = timeline.map(d => items.reduce((n, i) => { const t = done.get(i.id); return n + (t !== undefined && t <= endOfDay(d) ? stat(i) : 0) }, 0))
  const isDone = (i: Issue) => categoryOf(project, i.status) === 'done'
  const unestimated = (i: Issue) => !isDone(i) && (o.estimation === 'time' ? i.timeEstimate == null : o.estimation === 'count' ? false : i.estimate == null)
  return {
    labels: timeline.map(dayLabel), timeline, total, completed,
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
  const stat = (i: Issue) => statOf(i, estimation)
  const done = doneTimes(state, project, items)
  const field = of.epic ? 'parentId' as const : 'fixReleaseIds' as const
  const joined = new Map(items.map(i => [i.id, joinedAt(i, state.activity, field, (of.epic ?? of.version)!)]))
  const runs = sprints.filter(s => s.startedAt && (s.state === 'closed' || s.state === 'active')).sort((a, b) => a.startedAt! - b.startedAt!)
  const rows = runs.map((s, k) => {
    const from = s.startedAt!, to = s.state === 'closed' ? (s.completedAt ?? now) : now
    const sum = (f: (i: Issue) => boolean) => items.filter(f).reduce((n, i) => n + stat(i), 0)
    const isDoneBy = (i: Issue, t: number) => { const d = done.get(i.id); return d !== undefined && d <= t }
    return {
      name: s.name, active: s.state === 'active',
      completed: sum(i => { const d = done.get(i.id); return d !== undefined && d > from && d <= to }),
      remaining: sum(i => joined.get(i.id)! <= to && !isDoneBy(i, to)),
      added: k === 0 ? 0 : sum(i => joined.get(i.id)! > from && joined.get(i.id)! <= to),
    }
  })
  const closed = rows.filter(r => !r.active).slice(-3)
  const pace = closed.length ? closed.reduce((n, r) => n + r.completed, 0) / closed.length : 0
  const remaining = items.filter(i => done.get(i.id) === undefined).reduce((n, i) => n + stat(i), 0)
  return { rows, remaining, forecast: remaining <= 0 ? 0 : pace > 0 ? Math.ceil(remaining / pace) : null }
}
