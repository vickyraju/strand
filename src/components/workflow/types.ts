import type { Edge, Node } from '@xyflow/react'
import type { Category } from '../../data/store'

/** What is selected in the editor: one status or one transition. */
export type Selection = { kind: 'status' | 'transition'; id: string } | null
export const sameSelection = (a: Selection, b: Selection) => a?.kind === b?.kind && a?.id === b?.id

export interface StatusNodeData extends Record<string, unknown> {
  name: string
  description?: string
  color: string
  category: Category
  wipLimit?: number
  /** Work items currently in this status. */
  count: number
  /** The first status: where new work items start. */
  start: boolean
  /** The "from any status" transition into this status, if there is one. */
  anyId?: string
  onSelectAny: (transitionId: string) => void
}
export type StatusNode = Node<StatusNodeData, 'status'>

export interface TransitionEdgeData extends Record<string, unknown> {
  transitionId: string
  name: string
  /** Sideways bend, in lanes, so arrows between the same two statuses do not overlap. */
  offset: number
  showLabel: boolean
  /** How far along the arrow (0 to 1) its label sits, chosen so labels do not cover each other. */
  labelT: number
  /** This arrow's own From status. */
  from: string
  onSelect: (transitionId: string) => void
  /** An arrow end was dropped on another status: `end` says which end moved. */
  onReconnect: (transitionId: string, end: 'source' | 'target', from: string, newId: string) => void
}
export type TransitionEdge = Edge<TransitionEdgeData, 'transition'>
