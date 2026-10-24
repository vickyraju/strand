import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type Announcements, type DragEndEvent, type Modifier,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { Category, Status } from '../../data/store'
import type { Workflow } from '../../data/workflow'
import { plural } from '../ui'
import type { Selection } from './types'
import { rulesSummary } from './RulesEditor'

const CATEGORY_LABEL: Record<Category, string> = { todo: 'To do', 'in-progress': 'In progress', done: 'Done' }

/** Rows only move up and down. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

const INSTRUCTIONS = 'To move a status, press Space or Enter on its handle, use the up and down arrow keys to move it, then press Space or Enter to drop it. Press Escape to cancel.'

/** Pressing Enter or Space on a row (not on a button inside it) selects it. */
const selectOnKey = (select: () => void) => (e: React.KeyboardEvent) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); select() }
}

function StatusRow({ status, index, count, incoming, selected, onSelect }: {
  status: Status; index: number; count: number; incoming: string; selected: boolean; onSelect: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: status.id })
  return (
    <tr ref={setNodeRef} tabIndex={0} onClick={onSelect} onKeyDown={selectOnKey(onSelect)} aria-selected={selected}
      className={`${selected ? 'selected ' : ''}${isDragging ? 'wf-row-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}>
      <td className="wf-handle-cell">
        <button type="button" ref={setActivatorNodeRef} className="icon-btn wf-handle" aria-label={`Reorder ${status.name}`}
          onClick={e => e.stopPropagation()} {...attributes} {...listeners}><GripVertical size={15} /></button>
      </td>
      <td>
        <span className="cell-flex"><span className="status-dot" style={{ background: status.color }} />{status.name}
          {index === 0 && <span className="lozenge lozenge-todo" title="New work items start in this status">Start</span>}
        </span>
      </td>
      <td><span className={`lozenge lozenge-${status.category}`}>{CATEGORY_LABEL[status.category]}</span></td>
      <td className="wf-desc" title={status.description || undefined}>{status.description || <span className="muted">No description</span>}</td>
      <td className="col-num">{count}</td>
      <td className="muted">{incoming}</td>
    </tr>
  )
}

/** The workflow as two tables, like Jira's text view: statuses (drag a row's handle to reorder) and transitions. */
export default function TextView({ workflow, counts, selection, onSelect, onMoveStatus, typeName = k => k }: {
  workflow: Workflow; counts: Record<string, number>; selection: Selection; typeName?: (key: string) => string
  onSelect: (s: Selection) => void; onMoveStatus: (id: string, toIndex: number) => void
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),              // a click is a click, not a tiny drag. (Not PointerSensor: it would also take touch, skipping the hold below.)
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),  // press and hold, so scrolling still works
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = workflow.statuses.map(s => s.id)
  const nameOf = (id: unknown) => workflow.statuses.find(s => s.id === id)?.name ?? ''
  const where = (id: unknown) => `position ${ids.indexOf(String(id)) + 1} of ${ids.length}`
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}. It is in ${where(active.id)}.`,
    onDragOver: ({ active, over }) => (over && over.id !== active.id ? `${nameOf(active.id)} moved to ${where(over.id)}.` : undefined),   // lifting reports "over itself"; that would hide "Picked up"
    onDragEnd: ({ active, over }) => `${nameOf(active.id)} was dropped at ${where(over?.id ?? active.id)}.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled. It is still in ${where(active.id)}.`,
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMoveStatus(String(active.id), ids.indexOf(String(over.id)))
  }
  const anyInto = (id: string) => workflow.transitions.some(t => t.to === id && t.from === 'any')

  return (
    <div className="wf-list">
      <h3 className="section-label">Statuses</h3>
      <p className="muted wf-list-note">Drag a row by its handle to reorder. This order is the column order on the board, and new work items start in the first status.</p>
      <div className="card-table">
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: { draggable: INSTRUCTIONS } }}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <table className="table">
              <thead><tr><th className="wf-handle-cell"><span className="sr-only">Reorder</span></th><th>Status</th><th>Category</th><th>Description</th><th className="col-num">Items</th><th>Incoming</th></tr></thead>
              <tbody>
                {workflow.statuses.map((s, i) => (
                  <StatusRow key={s.id} status={s} index={i} count={counts[s.id] ?? 0} selected={selection?.kind === 'status' && selection.id === s.id}
                    incoming={anyInto(s.id) ? 'From any status' : plural(workflow.transitions.filter(t => t.to === s.id).length, 'transition')}
                    onSelect={() => onSelect({ kind: 'status', id: s.id })} />
                ))}
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      </div>

      <h3 className="section-label" style={{ marginTop: 20 }}>Transitions</h3>
      <div className="card-table">
        <table className="table">
          <thead><tr><th>Name</th><th>From</th><th>To</th><th>Work types</th><th>Rules</th></tr></thead>
          <tbody>
            {workflow.transitions.map(t => {
              const select = () => onSelect({ kind: 'transition', id: t.id })
              return (
                <tr key={t.id} tabIndex={0} onClick={select} onKeyDown={selectOnKey(select)} aria-selected={selection?.kind === 'transition' && selection.id === t.id}
                  className={selection?.kind === 'transition' && selection.id === t.id ? 'selected' : ''}>
                  <td>{t.name}</td>
                  <td>{t.from === 'any' ? <span className="muted">Any status</span> : t.from.map(nameOf).join(', ')}</td>
                  <td>{t.to === null ? <span className="muted">Stays (an action)</span> : nameOf(t.to)}</td>
                  <td className="muted sm">{t.types?.length ? t.types.map(k => typeName(k)).join(', ') : 'Every type'}</td>
                  <td className="muted sm">{rulesSummary(t.rules) || 'None'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
