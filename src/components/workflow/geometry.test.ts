import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgePath, labelSize, placeLabels, pointAt, type Rect } from './geometry.ts'

const box = (x: number, y: number): Rect => ({ x, y, w: 156, h: 40 })
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('a point a fraction along a path: the ends are the ends, the middle is between them', () => {
  const path = 'M0,0 C30,0 70,0 100,0'
  assert.deepEqual(pointAt(path, 0), { x: 0, y: 0 })
  assert.deepEqual(pointAt(path, 1), { x: 100, y: 0 })
  assert.ok(Math.abs(pointAt(path, 0.5).x - 50) < 1e-9)
  const curved = pointAt('M0,0 C0,100 100,100 100,0', 0.5)
  assert.deepEqual([curved.x, curved.y], [50, 75])
})

test('an arrow leaves the side that faces the other status, and parallel arrows are spread apart', () => {
  const right = edgePath(box(0, 0), box(400, 0), 0)
  assert.deepEqual([right.start.x, right.end.x], [156, 400])                                      // right side of the first, left side of the second
  const down = edgePath(box(0, 0), box(0, 200), 0)
  assert.deepEqual([down.start.y, down.end.y], [40, 200])                                         // bottom, then top
  const a = edgePath(box(0, 0), box(400, 0), 1), b = edgePath(box(0, 0), box(400, 0), -1)
  assert.equal(a.start.y - b.start.y, 52)                                                         // 26 px each way across
  const va = edgePath(box(0, 0), box(0, 200), 1), vb = edgePath(box(0, 0), box(0, 200), -1)
  assert.equal(va.start.x - vb.start.x, 100)                                                      // wider when running down, for the labels
})

test('labels that would land on each other slide apart, and stay off the status boxes', () => {
  // a runs left to right; c runs top to bottom through the same middle point, so their labels coincide
  const boxes = [box(0, 0), box(400, 0), box(200, -160), box(200, 160)]
  const edges = [
    { id: 'a', name: 'Stop work', from: boxes[1]!, to: boxes[0]!, offset: 0 },
    { id: 'c', name: 'Send to review', from: boxes[2]!, to: boxes[3]!, offset: 0 },
  ]
  const centre = (e: (typeof edges)[number]) => pointAt(edgePath(e.from, e.to, e.offset).path, 0.5)
  assert.ok(Math.abs(centre(edges[0]!).x - centre(edges[1]!).x) < 1 && Math.abs(centre(edges[0]!).y - centre(edges[1]!).y) < 1)   // they really do meet at the middle
  const t = placeLabels(edges, boxes)
  const rects = edges.map(e => {
    const p = pointAt(edgePath(e.from, e.to, e.offset).path, t[e.id]!), s = labelSize(e.name)
    return { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h }
  })
  assert.equal(t.a, 0.5)                                                                           // the first keeps the middle
  assert.notEqual(t.c, 0.5)                                                                        // the second slides along its arrow
  assert.ok(!overlap(rects[0]!, rects[1]!))
  for (const r of rects) for (const b of boxes) assert.ok(!overlap(r, b), 'a label sits on a status')
})

test('when nothing is free the label keeps the middle, and an empty list is fine', () => {
  assert.deepEqual(placeLabels([], []), {})
  const wall = Array.from({ length: 30 }, (_, i) => ({ x: 150 + i * 10, y: -50, w: 10, h: 120 }))   // a solid wall across the whole arrow
  const t = placeLabels([{ id: 'x', name: 'Blocked', from: box(0, 0), to: box(400, 0), offset: 0 }], wall)
  assert.equal(t.x, 0.5)
})
