// Drag and drop for the backlog and sprint lists (rows reordered within a list, moved between sprints and the backlog).
// The rules are plain functions so they are unit-tested; BacklogView wires them to dnd-kit.
import { closestCenter, pointerWithin, type Announcements, type CollisionDetection, type KeyboardCoordinateGetter } from '@dnd-kit/core'

/** The backlog is a list like any sprint; this is its id in drop targets. */
export const BACKLOG = 'backlog'

// A drop target is one of: the gap before a row, the end of a list, or the whole box around a list (for dropping into empty space).
export const rowTarget = (issueId: string) => `row:${issueId}`
export const endTarget = (list: string) => `end:${list}`
export const boxTarget = (list: string) => `box:${list}`
const parts = (id: unknown): [string, string] => { const s = String(id), i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)] }

export interface Move { id: string; container: string | null; beforeId?: string }

/** What a drop does: each dragged item (in the order given) goes before the row it was dropped on, in that row's list, or
 *  to the end of the list it was dropped on. `container` is a sprint id, or null for the backlog (what `moveIssue` expects). */
export function planBacklogDrop(o: { dragged: string[]; overId: string; containerOf: (issueId: string) => string | null }): Move[] {
  const [kind, rest] = parts(o.overId)
  if (kind === 'row') return o.dragged.filter(id => id !== rest).map(id => ({ id, beforeId: rest, container: o.containerOf(rest) }))
  return o.dragged.map(id => ({ id, container: rest === BACKLOG ? null : rest }))
}

// ── Collisions and the keyboard ──────────────────────────

/** Under the pointer, the most specific target wins: a row, then the end of a list, then the box. With the keyboard (no pointer) the
 *  closest row or list end to the carried row. Dropping on nothing is a cancel. */
export const backlogCollision: CollisionDetection = args => {
  if (args.pointerCoordinates) {
    const hits = pointerWithin(args)
    for (const kind of ['row', 'end', 'box']) {
      const of = hits.filter(h => parts(h.id)[0] === kind)
      if (of.length) return of
    }
    return []
  }
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(c => parts(c.id)[0] !== 'box') })
}

/** Up and down jump the carried row to the next gap in that direction (a gap before a row, or the end of a list), skipping the
 *  gap right after where it started, since dropping there changes nothing. */
export const backlogKeyboard: KeyboardCoordinateGetter = (event, { context: { active, collisionRect, droppableRects, droppableContainers } }) => {
  const down = event.code === 'ArrowDown'
  if (!down && event.code !== 'ArrowUp') return
  if (!active || !collisionRect) return
  event.preventDefault()
  const start = active.rect.current.initial
  let best: { left: number; top: number } | undefined, bestGap = Infinity
  for (const c of droppableContainers.getEnabled()) {
    if (parts(c.id)[0] === 'box') continue
    const r = droppableRects.get(c.id)
    if (!r) continue
    const gap = down ? r.top - collisionRect.top : collisionRect.top - r.top
    if (gap <= 2) continue
    if (start && Math.abs(r.top - start.top - start.height) < 8) continue         // the slot right after its original place: no change
    if (gap < bestGap) { bestGap = gap; best = r }
  }
  return best ? { x: best.left, y: best.top } : undefined
}

// ── What a screen reader hears ───────────────────────────

export interface DescribeBacklog {
  key: (issueId: unknown) => string
  /** How many items are being carried (a selected row carries the whole selection). */
  count: () => number
  /** Which list the item is in now. */
  listOf: (issueId: unknown) => string
  /** "before PAY-3 in Sprint 2" or "the end of Backlog". */
  place: (overId: unknown) => string
}

// Lifting a row reports "over the box it is in" straight away, which would replace "Picked up" before it is heard, so that first
// report is skipped. One row is carried at a time, so a single flag is enough.
let first = true

export function backlogAnnouncements(d: DescribeBacklog): Announcements {
  const what = (id: unknown) => { const n = d.count(); return n > 1 ? `${d.key(id)} and ${n - 1} other selected item${n === 2 ? '' : 's'}` : d.key(id) }
  return {
    onDragStart: ({ active }) => { first = true; return `Picked up ${what(active.id)}. It is in ${d.listOf(active.id)}.` },
    onDragOver: ({ over }) => { if (first) { first = false; return undefined } return over ? `Over ${d.place(over.id)}.` : 'Not over a list.' },
    onDragEnd: ({ active, over }) => (over ? `${what(active.id)} moved to ${d.place(over.id)}.` : `${what(active.id)} was dropped outside the lists and did not move.`),
    onDragCancel: ({ active }) => `Cancelled. ${what(active.id)} did not move.`,
  }
}
