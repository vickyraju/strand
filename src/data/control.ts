// The control chart's maths (spec 0410), as Jira's: default columns, statistics, the rolling average and its standard
// deviation over a window of items, clusters, and the vertical scale.

/** Jira's first choice of columns: all but the first and the last; with one or two columns, all but the last (R3). */
export function defaultColumns<C>(columns: C[]): C[] {
  if (columns.length <= 1) return columns
  return columns.length === 2 ? columns.slice(0, 1) : columns.slice(1, -1)
}

/** The rolling window: 20% of the items, an odd number, at least 5, and at most all of them (odd) (R5). */
export function windowSize(n: number) {
  let w = Math.max(5, Math.round(n * 0.2))
  if (w % 2 === 0) w++
  if (w > n) w = n % 2 ? n : n - 1
  return Math.max(1, w)
}

export interface Point { t: number; v: number }

/** Average, median, minimum, maximum and count of the values; then, in time order, each point's rolling average and the
 *  standard deviation over its window (R5). */
export function controlStats(points: Point[]) {
  const vs = points.map(p => p.v).sort((a, b) => a - b), n = vs.length
  const avg = n ? vs.reduce((s, v) => s + v, 0) / n : 0
  const median = !n ? 0 : n % 2 ? vs[(n - 1) / 2]! : (vs[n / 2 - 1]! + vs[n / 2]!) / 2
  const ordered = [...points].sort((a, b) => a.t - b.t)
  const half = Math.floor(windowSize(n) / 2)
  const rolling = ordered.map((p, i) => {
    const from = Math.max(0, Math.min(i - half, n - 2 * half - 1)), win = ordered.slice(from, from + 2 * half + 1)
    const mean = win.reduce((s, x) => s + x.v, 0) / win.length
    const sd = Math.sqrt(win.reduce((s, x) => s + (x.v - mean) ** 2, 0) / win.length)
    return { t: p.t, mean, sd }
  })
  return { count: n, average: avg, median, min: n ? vs[0]! : 0, max: n ? vs[n - 1]! : 0, rolling }
}

/** Points that would land on the same spot (within `dx` and `dy` of a cluster's first point) become one, at their
 *  average, with their count (R6). */
export function clusters<P extends Point>(points: P[], dx: number, dy: number) {
  const out: { t: number; v: number; items: P[] }[] = []
  for (const p of [...points].sort((a, b) => a.t - b.t || a.v - b.v)) {
    const c = out.find(c => Math.abs(c.items[0]!.t - p.t) <= dx && Math.abs(c.items[0]!.v - p.v) <= dy)
    if (c) { c.items.push(p); c.t = c.items.reduce((s, x) => s + x.t, 0) / c.items.length; c.v = c.items.reduce((s, x) => s + x.v, 0) / c.items.length }
    else out.push({ t: p.t, v: p.v, items: [p] })
  }
  return out
}

/** The vertical scale: linear below 30 days, else cube-root, as Jira's (R7). Values are days; the result runs 0…1. */
export function yScale(maxDays: number) {
  const top = Math.max(maxDays, 1)
  return top < 30 ? { kind: 'linear' as const, at: (v: number) => v / top } : { kind: 'cube-root' as const, at: (v: number) => Math.cbrt(v) / Math.cbrt(top) }
}
