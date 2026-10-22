// Drag and drop for the board and its swimlanes. The rules (what a drop does) are plain functions so they are unit-tested;
// the rest wires dnd-kit so cards move with a mouse, a finger (press and hold) or the keyboard (Space, arrows, Space).
import {
  KeyboardSensor, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useSensor, useSensors,
  type Announcements, type CollisionDetection, type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { canTransition, statusOf, type Issue, type IssuePatch, type Project } from '../data/reducer.ts'

// ── The rules ────────────────────────────────────────────

export type DropPlan = { patch: IssuePatch } | { blocked: string }

/** What dropping a card into a cell does: change its status when the workflow allows that move, and, when the cell is in
 *  another swimlane, also change the field the board is grouped by. A move the workflow forbids does nothing at all. */
export function planDrop(o: { project: Project; issue: Issue; statusId: string; lanePatch?: IssuePatch; moveLane: boolean }): DropPlan {
  const patch: IssuePatch = {}
  if (o.issue.status !== o.statusId) {
    if (!canTransition(o.project, o.issue.status, o.statusId)) {
      return { blocked: `The ${o.project.name} workflow doesn’t allow ${statusOf(o.project, o.issue.status)?.name} → ${statusOf(o.project, o.statusId)?.name}` }
    }
    patch.status = o.statusId
  }
  if (o.moveLane && o.lanePatch) Object.assign(patch, o.lanePatch)
  return { patch }
}

// ── Collisions and the keyboard ──────────────────────────

/** Under the pointer when there is one (mouse, finger); otherwise whichever cell the card overlaps most (keyboard). */
export const boardCollision: CollisionDetection = args => {
  const under = pointerWithin(args)
  return under.length ? under : rectIntersection(args)
}

const ARROWS: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }

/** Arrow keys jump the card to the next cell in that direction, staying in the same swimlane for left and right.
 *  (dnd-kit's own getter assumes sortable lists, where the dragged item is itself a drop target; a kanban card is not.) */
export const boardKeyboard: KeyboardCoordinateGetter = (event, { context: { active, collisionRect, droppableRects, droppableContainers, over } }) => {
  const dir = ARROWS[event.code]
  if (!dir || !active || !collisionRect || !over) return
  event.preventDefault()
  const here = droppableRects.get(over.id)
  if (!here) return
  const hx = here.left + here.width / 2, hy = here.top + here.height / 2
  let best: { left: number; top: number } | undefined, bestScore = Infinity
  for (const cell of droppableContainers.getEnabled()) {
    const r = droppableRects.get(cell.id)
    if (!r || cell.id === over.id) continue
    const dx = r.left + r.width / 2 - hx, dy = r.top + r.height / 2 - hy
    const ahead = dx * dir[0] + dy * dir[1]
    if (ahead <= 1) continue                                    // behind, or the same place
    const aside = dir[0] ? Math.abs(dy) : Math.abs(dx)          // prefer the same row (or column)
    const score = ahead + aside * 3
    if (score < bestScore) { bestScore = score; best = r }
  }
  return best ? { x: best.left + 12, y: best.top + 12 } : undefined
}

/** Mouse after a 6 px move (so a click still opens the card), finger after a short hold (so the page still scrolls),
 *  keyboard with Space. Enter is left alone: it opens the card. The backlog passes its own arrow-key getter. */
export function useBoardSensors(coordinateGetter: KeyboardCoordinateGetter = boardKeyboard) {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] } }),
  )
}

// ── What a screen reader hears ───────────────────────────

export const BOARD_INSTRUCTIONS = 'To move a work item, press Space on it, use the arrow keys to choose a column or swimlane, then press Space to drop it. Press Escape to cancel.'

export interface Describe {
  key: (cardId: unknown) => string
  status: (cardId: unknown) => string
  column: (cellId: unknown) => string
  /** What dropping this card in that cell would do. */
  verdict: (cardId: unknown, cellId: unknown) => 'moves' | 'stays' | 'blocked'
}

// Lifting a card reports "over its own column" straight away, which would replace "Picked up" before it is heard. So that
// first report is skipped; only one card is ever carried at a time, so a single flag is enough.
let wandered = false

export function boardAnnouncements(d: Describe): Announcements {
  return {
    onDragStart: ({ active }) => { wandered = false; return `Picked up ${d.key(active.id)}. It is in ${d.status(active.id)}.` },
    onDragOver: ({ active, over }) => {
      if (!over) return `${d.key(active.id)} is not over a column.`
      const v = d.verdict(active.id, over.id)
      if (v === 'stays' && !wandered) return undefined
      wandered = true
      if (v === 'blocked') return `${d.key(active.id)} is over ${d.column(over.id)}. The workflow does not allow that move.`
      return v === 'stays' ? `${d.key(active.id)} is back over ${d.column(over.id)}, where it started.` : `${d.key(active.id)} is over ${d.column(over.id)}.`
    },
    onDragEnd: ({ active, over }) => {
      if (!over) return `${d.key(active.id)} was dropped outside the board and did not move.`
      const v = d.verdict(active.id, over.id)
      if (v === 'blocked') return `${d.key(active.id)} did not move: the workflow does not allow that move.`
      return v === 'stays' ? `${d.key(active.id)} stays in ${d.status(active.id)}.` : `${d.key(active.id)} was moved to ${d.column(over.id)}.`
    },
    onDragCancel: ({ active }) => `Cancelled. ${d.key(active.id)} did not move.`,
  }
}
