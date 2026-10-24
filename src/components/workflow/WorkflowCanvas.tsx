import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background, BackgroundVariant, ConnectionMode, Controls, MarkerType, MiniMap, Panel, ReactFlow, useEdgesState, useNodesState,
  type OnConnect, type OnSelectionChangeFunc, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CATEGORY_COLOR } from '../../data/store'
import { NODE_H, NODE_W, edgeOffsets, edgesOf, hasGlobal, positionsOf, type Pos, type Workflow } from '../../data/workflow'
import { placeLabels } from './geometry'
import { useThemePref } from '../../theme'
import StatusNode from './StatusNode'
import TransitionEdge from './TransitionEdge'
import type { Selection, StatusNode as StatusNodeType, TransitionEdge as TransitionEdgeType } from './types'

// Defined once: React Flow warns when these change between renders.
const nodeTypes = { status: StatusNode }
const edgeTypes = { transition: TransitionEdge }
const ARIA = {
  'node.a11yDescription.default': 'Press Enter to select this status. Press Escape to deselect.',
  'node.a11yDescription.keyboardDisabled': 'Press Enter to select this status. Press Escape to deselect.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => `Status moved ${direction}. New position, x ${x}, y ${y}.`,
  'edge.a11yDescription.default': 'Press Enter to select this transition. Press Escape to deselect.',
  'controls.ariaLabel': 'Zoom controls',
  'minimap.ariaLabel': 'Overview of the workflow',
} as const

interface Props {
  workflow: Workflow
  /** Work items in each status, by status id. */
  usage: Record<string, number>
  selection: Selection
  showLabels: boolean
  onSelect: (s: Selection) => void
  /** Called when a drag ends, with the position of every status (so statuses that were never placed by hand stay put). */
  onMoveNodes: (positions: Record<string, Pos>) => void
  /** A line was dragged from one status to another. */
  onConnectStatuses: (from: string, to: string) => void
  /** An arrow end was dragged to another status. */
  onReconnect: (transitionId: string, end: 'source' | 'target', from: string, newId: string) => void
  /** Delete or Backspace was pressed with the canvas focused. */
  onDelete: () => void
  /** Bring one status (or everything, with no id) into view. Each new `tick` asks again, even for the same status. */
  focus?: { id?: string; tick: number }
}

/** The workflow drawn as a diagram: pan and zoom, a minimap, draggable statuses and arrows that follow them. */
export default function WorkflowCanvas({ workflow, usage, selection, showLabels, onSelect, onMoveNodes, onConnectStatuses, onReconnect, onDelete, focus }: Props) {
  const theme = useThemePref()
  const flow = useRef<ReactFlowInstance<StatusNodeType, TransitionEdgeType>>(null)
  const positions = useMemo(() => positionsOf(workflow), [workflow])

  const derivedNodes = useMemo<StatusNodeType[]>(() => workflow.statuses.map((s, i) => ({
    id: s.id, type: 'status', position: positions[s.id]!, ariaLabel: `Status ${s.name}`,
    selected: selection?.kind === 'status' && selection.id === s.id,
    data: {
      name: s.name, description: s.description, color: s.color, category: s.category, wipLimit: s.wipLimit, count: usage[s.id] ?? 0, start: i === 0,
      anyId: hasGlobal(workflow, s.id) ? workflow.transitions.find(t => t.to === s.id && t.from === 'any')!.id : undefined,
      onSelectAny: id => onSelect({ kind: 'transition', id }),
    },
  })), [workflow, positions, usage, selection, onSelect])

  const derivedEdges = useMemo<TransitionEdgeType[]>(() => {
    const list = edgesOf(workflow)
    const offsets = edgeOffsets(list)
    const name = (id: string) => workflow.statuses.find(s => s.id === id)?.name ?? ''
    const rect = (id: string) => ({ x: positions[id]!.x, y: positions[id]!.y, w: NODE_W, h: NODE_H })
    const labelled = list.filter(e => showLabels && e.name !== name(e.to))
    const labelT = placeLabels(labelled.map(e => ({ id: e.id, name: e.name, from: rect(e.from), to: rect(e.to), offset: offsets.get(e.id) ?? 0 })), workflow.statuses.map(s => rect(s.id)))
    return list.map(e => {
      const on = selection?.kind === 'transition' && selection.id === e.transitionId
      return {
        id: e.id, source: e.from, target: e.to, type: 'transition', selected: on,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: on ? 'var(--brand)' : 'var(--text-3)' },
        ariaLabel: `Transition ${e.name}, from ${name(e.from)} to ${name(e.to)}`,
        data: { transitionId: e.transitionId, name: e.name, offset: offsets.get(e.id) ?? 0, showLabel: showLabels && e.name !== name(e.to), labelT: labelT[e.id] ?? 0.5, from: e.from, onSelect: id => onSelect({ kind: 'transition', id }), onReconnect },
      }
    })
  }, [workflow, positions, selection, showLabels, onSelect, onReconnect])

  // Local copies let React Flow move a box while it is dragged; they are re-derived whenever the workflow or selection changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<StatusNodeType>(derivedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<TransitionEdgeType>(derivedEdges)
  // Keep each box's measured size: replacing it with an unmeasured copy would hide every arrow for a frame.
  useEffect(() => setNodes(prev => {
    const old = new Map(prev.map(n => [n.id, n]))
    return derivedNodes.map(d => (old.get(d.id)?.measured ? { ...d, measured: old.get(d.id)!.measured } : d))
  }), [derivedNodes, setNodes])
  useEffect(() => setEdges(derivedEdges), [derivedEdges, setEdges])

  // Move the view to a status or to everything. Waits a moment so a status that was just added has been measured.
  useEffect(() => {
    if (!focus) return
    const t = setTimeout(() => flow.current?.fitView({ nodes: focus.id ? [{ id: focus.id }] : undefined, duration: 250, padding: 0.4, maxZoom: 1.1 }), 80)
    return () => clearTimeout(t)
  }, [focus])

  const onConnect = useCallback<OnConnect>(c => { if (c.source && c.target && c.source !== c.target) onConnectStatuses(c.source, c.target) }, [onConnectStatuses])

  // Clicking, or pressing Enter on a focused box or arrow, selects it. An empty selection is deliberately ignored: a "from any
  // status" transition has no arrow, so selecting one leaves React Flow with nothing selected. Clearing is explicit instead
  // (click on the background, or Escape).
  const onSelectionChange = useCallback<OnSelectionChangeFunc>(({ nodes: n, edges: e }) => {
    if (n.length) onSelect({ kind: 'status', id: n[0]!.id })
    else if (e.length) onSelect({ kind: 'transition', id: (e[0] as TransitionEdgeType).data!.transitionId })
  }, [onSelect])

  const loops = workflow.transitions.filter(t => t.to === null)   // no arrow to draw: listed over the diagram instead
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
      onPaneClick={() => onSelect(null)} onInit={i => { flow.current = i }}
      onKeyDown={e => {
        if (e.key === 'Escape') onSelect(null)
        else if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('input, textarea, select')) { e.preventDefault(); onDelete() }
      }}
      onConnect={onConnect} connectionRadius={70} connectionLineStyle={{ stroke: 'var(--brand)', strokeWidth: 2 }}
      multiSelectionKeyCode={null} selectionKeyCode={null}
      onNodeDragStop={(_, node, dragged) => onMoveNodes({ ...positions, ...Object.fromEntries([node, ...dragged].map(n => [n.id, n.position])) })}
      connectionMode={ConnectionMode.Loose} deleteKeyCode={null} elevateEdgesOnSelect
      snapToGrid snapGrid={[10, 10]} minZoom={0.25} maxZoom={2}
      fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      colorMode={theme} attributionPosition="bottom-left" ariaLabelConfig={ARIA}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <MiniMap pannable zoomable nodeColor={n => CATEGORY_COLOR[(n as StatusNodeType).data.category]} nodeStrokeWidth={0} />
      <Controls showInteractive={false} />
      {loops.length > 0 && (
        <Panel position="top-left" className="wf-loops" aria-label="Loops">
          <span className="muted sm">Stay in status:</span>
          {loops.map(t => (
            <button key={t.id} type="button" className={`wf-loop${selection?.kind === 'transition' && selection.id === t.id ? ' on' : ''}`} onClick={() => onSelect({ kind: 'transition', id: t.id })}
              title={t.from === 'any' ? 'From any status' : `From ${t.from.map(f => workflow.statuses.find(s => s.id === f)?.name).join(', ')}`}>↻ {t.name}</button>
          ))}
        </Panel>
      )}
    </ReactFlow>
  )
}
