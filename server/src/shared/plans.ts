// A plan's timeline worked out from its items (spec 0803 R3–R5): bars, the initiative › epic › item tree, broken
// dependencies, progress and health. Pure (no database, no React): the web app draws with it, the tests check it.

export interface PlanItem {
  id: string; key: string; type: string; title: string; category: string; startDate: string | null; dueDate: string | null
  sprintId: string | null; parentId: string | null; parentLinkId: string | null; projectKey: string; statusName: string
}
export interface PlanSprint { id: string; startedAt: string | null; endsAt: string | null; completedAt: string | null }
export type Health = 'on-track' | 'at-risk' | 'off-track' | null
const DAY = 86_400_000
export const day = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`)

/** R3: the tree: initiatives, their epics, the epics' items; what has no parent in the plan is a root at its own level. */
export function tree(items: PlanItem[]) {
  const ids = new Set(items.map(i => i.id))
  const children = new Map<string, PlanItem[]>()
  const roots: PlanItem[] = []
  for (const i of items) {
    const up = i.type === 'epic' ? i.parentLinkId : i.type === 'initiative' ? null : i.parentId
    if (up && ids.has(up)) children.set(up, [...(children.get(up) ?? []), i])
    else roots.push(i)
  }
  const level = (i: PlanItem) => (i.type === 'initiative' ? 0 : i.type === 'epic' ? 1 : 2)
  roots.sort((a, b) => level(a) - level(b))
  return { roots, children: (id: string) => children.get(id) ?? [] }
}

/** R3: a bar: its own dates; else an initiative or epic spans its children's; else an item in a sprint spans the sprint. */
export function spans(items: PlanItem[], sprints: PlanSprint[]) {
  const t = tree(items)
  const out = new Map<string, { start: number; end: number; derived: boolean } | null>()
  const sprint = new Map(sprints.map(s => [s.id, s]))
  const of = (i: PlanItem): { start: number; end: number; derived: boolean } | null => {
    if (out.has(i.id)) return out.get(i.id)!
    out.set(i.id, null)                                                            // a cycle can't loop
    let r: { start: number; end: number; derived: boolean } | null = null
    if (i.startDate || i.dueDate) {
      const s = day(i.startDate ?? i.dueDate!), e = day(i.dueDate ?? i.startDate!)
      r = { start: Math.min(s, e), end: Math.max(s, e), derived: false }
    } else if (i.type === 'initiative' || i.type === 'epic') {
      const kids = t.children(i.id).map(of).filter((x): x is NonNullable<typeof x> => !!x)
      if (kids.length) r = { start: Math.min(...kids.map(k => k.start)), end: Math.max(...kids.map(k => k.end)), derived: true }
    } else if (i.sprintId) {
      const s = sprint.get(i.sprintId)
      const end = s?.completedAt ?? s?.endsAt
      if (s?.startedAt && end) r = { start: day(s.startedAt), end: day(end), derived: true }
    }
    out.set(i.id, r)
    return r
  }
  for (const i of items) of(i)
  return out
}

/** R4: a dependency is broken when the blocker ends after the blocked item starts. */
export function broken(dep: { fromId: string; toId: string }, bars: Map<string, { start: number; end: number } | null>) {
  const a = bars.get(dep.fromId), b = bars.get(dep.toId)
  return !!a && !!b && a.end > b.start
}

/** R5: an initiative's or epic's work items (an initiative's: its epics' items), done out of all. */
export function progress(id: string, items: PlanItem[]) {
  const t = tree(items)
  const self = items.find(i => i.id === id)
  const work = self?.type === 'initiative' ? t.children(id).flatMap(e => t.children(e.id)) : t.children(id)
  return { done: work.filter(i => i.category === 'done').length, total: work.length }
}

/** R5: Off track when its due date has passed unfinished; At risk when one of its work items ends after it or a dependency
 *  inside it is broken; On track otherwise; no health without dates. `today` is a day's start (UTC). */
export function health(id: string, items: PlanItem[], bars: Map<string, { start: number; end: number } | null>, deps: { fromId: string; toId: string }[], today: number): Health {
  const self = items.find(i => i.id === id)
  const bar = bars.get(id)
  if (!self || !bar) return null
  const t = tree(items)
  const under = self.type === 'initiative' ? t.children(id).flatMap(e => [e, ...t.children(e.id)]) : t.children(id)
  if (self.category !== 'done' && self.dueDate && day(self.dueDate) < today) return 'off-track'
  const inside = new Set([id, ...under.map(i => i.id)])
  if (under.some(i => (bars.get(i.id)?.end ?? -Infinity) > bar.end) || deps.some(d => inside.has(d.fromId) && inside.has(d.toId) && broken(d, bars))) return 'at-risk'
  return 'on-track'
}

/** The timeline's first and last days, a little wider than its bars and dated lanes. */
export function range(bars: Iterable<{ start: number; end: number } | null>, extra: number[] = [], today = Date.now()) {
  const ts = [...[...bars].flatMap(b => (b ? [b.start, b.end] : [])), ...extra, today]
  return { from: Math.min(...ts) - 7 * DAY, to: Math.max(...ts) + 14 * DAY }
}
