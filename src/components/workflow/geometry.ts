// Where arrows run and where their labels sit. Pure, so the same maths serves the live drawing and the unit tests.
import { Position, getBezierPath } from '@xyflow/react'

export interface Rect { x: number; y: number; w: number; h: number }

// Px between arrows that run side by side. Labels sit beside each other when an arrow runs up or down, so those lanes are wider.
const LANE_ACROSS = 26, LANE_DOWN = 50

/** Where an arrow meets a status: the middle of the side facing the other status, shifted along that side by its lane. */
export function anchor(from: Rect, to: Rect, laneIndex: number) {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2), dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) {
    const right = dx >= 0
    return { x: from.x + (right ? from.w : 0), y: from.y + from.h / 2 + laneIndex * LANE_ACROSS, position: right ? Position.Right : Position.Left }
  }
  const down = dy >= 0
  return { x: from.x + from.w / 2 + laneIndex * LANE_DOWN, y: from.y + (down ? from.h : 0), position: down ? Position.Bottom : Position.Top }
}

export function edgePath(a: Rect, b: Rect, offset: number) {
  const s = anchor(a, b, offset), t = anchor(b, a, offset)
  const [path] = getBezierPath({ sourceX: s.x, sourceY: s.y, sourcePosition: s.position, targetX: t.x, targetY: t.y, targetPosition: t.position, curvature: 0.3 })
  return { path, start: s, end: t }
}

/** The point a fraction `t` (0 to 1) of the way along a bezier path as React Flow writes it: "M x,y C x,y x,y x,y". */
export function pointAt(path: string, t: number): { x: number; y: number } {
  const n = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  const [x0, y0, x1, y1, x2, y2, x3, y3] = n as [number, number, number, number, number, number, number, number]
  const u = 1 - t
  const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  return { x: at(x0, x1, x2, x3), y: at(y0, y1, y2, y3) }
}

const LABEL_H = 22
export const labelSize = (name: string) => ({ w: name.length * 6.4 + 20, h: LABEL_H })
const CANDIDATES = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]
const hit = (a: Rect, b: Rect, pad = 4) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad

/** Pick, for each arrow, how far along it (0 to 1) its label sits so labels avoid each other and the status boxes.
 *  Takes the middle where it is free and slides along the arrow otherwise; keeps the middle if nothing is free. */
export function placeLabels(edges: { id: string; name: string; from: Rect; to: Rect; offset: number }[], boxes: Rect[]): Record<string, number> {
  const placed: Rect[] = []
  const out: Record<string, number> = {}
  for (const e of edges) {
    const { path } = edgePath(e.from, e.to, e.offset)
    const { w, h } = labelSize(e.name)
    const at = (t: number): Rect => { const p = pointAt(path, t); return { x: p.x - w / 2, y: p.y - h / 2, w, h } }
    const free = CANDIDATES.find(t => { const r = at(t); return !placed.some(o => hit(r, o)) && !boxes.some(b => hit(r, b, 2)) })
    const t = free ?? CANDIDATES.find(c => !placed.some(o => hit(at(c), o))) ?? 0.5
    out[e.id] = t
    placed.push(at(t))
  }
  return out
}
