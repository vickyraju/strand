import { memo, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps, type InternalNode } from '@xyflow/react'
import { NODE_H, NODE_W } from '../../data/workflow'
import { edgePath, pointAt } from './geometry'
import type { TransitionEdge as TransitionEdgeType } from './types'

const GRAB = 8    // slack, in px, around a box when an arrow end is dropped near it

const box = (n: InternalNode) => ({
  x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y,
  w: n.measured.width ?? NODE_W, h: n.measured.height ?? NODE_H,
})


function TransitionEdge({ id, source, target, markerEnd, selected, data }: EdgeProps<TransitionEdgeType>) {
  const rf = useReactFlow()
  const [drag, setDrag] = useState<{ end: 'source' | 'target'; x: number; y: number } | null>(null)
  const a = useInternalNode(source), b = useInternalNode(target)
  if (!a || !b || !data) return null
  // Worked out from the live positions, so the arrow follows a box while it is being dragged.
  const { path, start: s, end: t } = edgePath(box(a), box(b), data.offset)
  const label = pointAt(path, data.labelT)

  // Dragging an arrow end: a dashed line follows the pointer, and dropping on a status moves that end there.
  const startDrag = (end: 'source' | 'target') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    const at = (ev: { clientX: number; clientY: number }) => rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
    const move = (ev: PointerEvent) => setDrag({ end, ...at(ev) })
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      setDrag(null)
      const p = at(ev)
      const hit = rf.getNodes().find(n => {
        const w = n.measured?.width ?? NODE_W, h = n.measured?.height ?? NODE_H
        return p.x >= n.position.x - GRAB && p.x <= n.position.x + w + GRAB && p.y >= n.position.y - GRAB && p.y <= n.position.y + h + GRAB
      })
      if (hit && hit.id !== (end === 'source' ? source : target)) data.onReconnect(data.transitionId, end, data.from, hit.id)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    setDrag({ end, ...at(e) })
  }
  const fixed = drag ? (drag.end === 'source' ? t : s) : null

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18}
        style={{ stroke: selected ? 'var(--brand)' : 'var(--text-3)', strokeWidth: selected ? 2.25 : 1.5, opacity: drag ? 0.35 : 1 }} />
      {drag && fixed && <path d={`M${fixed.x},${fixed.y} L${drag.x},${drag.y}`} className="wf2-ghost" />}
      {selected && !drag && (
        <>
          <circle cx={s.x} cy={s.y} r={6} className="wf2-anchor" onPointerDown={startDrag('source')}><title>Drag to another status to change where this move starts</title></circle>
          <circle cx={t.x} cy={t.y} r={6} className="wf2-anchor" onPointerDown={startDrag('target')}><title>Drag to another status to change where this move ends</title></circle>
        </>
      )}
      {data.showLabel && (
        <EdgeLabelRenderer>
          <button type="button" className={`wf2-label nodrag nopan${selected ? ' on' : ''}`} tabIndex={-1}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
            onClick={() => data.onSelect(data.transitionId)}>{data.name}</button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default memo(TransitionEdge)
