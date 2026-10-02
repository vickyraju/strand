import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, MoreHorizontal, ArrowRightLeft } from 'lucide-react'
import { useStore, isDone, type Project, type Sprint, type Issue } from '../data/store'
import { useApp } from '../appContext'
import { useIssueFilter } from './BoardView'
import IssueRow from './IssueRow'
import { Picker } from './ui'

const BACKLOG = 'backlog'
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export default function BacklogView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { createIssue } = useApp()
  const { apply, toolbar } = useIssueFilter()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [over, setOver]             = useState<string | null>(null)
  const [completing, setCompleting] = useState<Sprint | null>(null)

  const sprints = state.sprints
    .filter(s => s.projectId === project.id && s.state !== 'closed')
    .sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : 0))
  const hasActive = sprints.some(s => s.state === 'active')
  const issues = apply(state.issues.filter(i => i.projectId === project.id))
    .sort((a, b) => a.createdAt - b.createdAt)

  const moveTargets = [
    ...sprints.map(s => ({ value: s.id as string, label: s.name })),
    { value: BACKLOG, label: 'Backlog' },
  ]
  const moveTo = (issueId: string, target: string) =>
    dispatch({ type: 'updateIssue', id: issueId, patch: { sprintId: target === BACKLOG ? undefined : target } })

  const dropZone = (target: string) => ({
    onDragOver:  (e: React.DragEvent) => { e.preventDefault(); setOver(target) },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) },
    onDrop:      (e: React.DragEvent) => { e.preventDefault(); if (draggingId) moveTo(draggingId, target); setDraggingId(null); setOver(null) },
  })

  const rows = (list: Issue[]) => list.map(i => (
    <IssueRow
      key={i.id}
      issue={i}
      project={project}
      draggable
      onDragStart={() => setDraggingId(i.id)}
      trailing={
        <Picker value={i.sprintId ?? BACKLOG} options={moveTargets} onChange={t => moveTo(i.id, t)}
          className="ir-icon-btn" align="right" title="Move to sprint"
          trigger={<ArrowRightLeft size={13} strokeWidth={1.5} color="#A8A29E" />} />
      }
    />
  ))

  const backlogItems = issues.filter(i => !i.sprintId || !sprints.some(s => s.id === i.sprintId))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="bv-toolbar">
        {toolbar}
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={() => dispatch({ type: 'createSprint', projectId: project.id })}>
          <Plus size={13} strokeWidth={2} />Create sprint
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 32px' }}>
        {sprints.map(sprint => {
          const items = issues.filter(i => i.sprintId === sprint.id)
          return (
            <SprintBox
              key={sprint.id}
              sprint={sprint}
              project={project}
              items={items}
              canStart={!hasActive}
              highlight={over === sprint.id}
              dropProps={dropZone(sprint.id)}
              onComplete={() => setCompleting(sprint)}
              onCreate={() => createIssue({ projectId: project.id, sprintId: sprint.id })}
            >
              {items.length === 0
                ? <div className="bl-drop-hint">Plan a sprint by dragging work items here, or use the move menu on a row.</div>
                : rows(items)}
            </SprintBox>
          )
        })}

        <div className={`bl-box${over === BACKLOG ? ' drop-target' : ''}`} {...dropZone(BACKLOG)}>
          <div className="bl-box-hdr">
            <span className="bl-box-title">Backlog</span>
            <span className="ir-group-count">{plural(backlogItems.length, 'item')}</span>
          </div>
          {backlogItems.length === 0
            ? <div className="bl-drop-hint">Your backlog is empty.</div>
            : rows(backlogItems)}
          <button className="col-create" style={{ margin: 4 }} onClick={() => createIssue({ projectId: project.id })}>
            <Plus size={13} strokeWidth={1.75} />Create
          </button>
        </div>
      </div>

      {completing && (
        <CompleteSprintModal
          sprint={completing}
          project={project}
          others={sprints.filter(s => s.id !== completing.id)}
          onClose={() => setCompleting(null)}
        />
      )}
    </div>
  )
}

// ── One sprint container ───────────────────────────────────

function SprintBox({ sprint, project, items, canStart, highlight, dropProps, onComplete, onCreate, children }: {
  sprint:     Sprint
  project:    Project
  items:      Issue[]
  canStart:   boolean
  highlight:  boolean
  dropProps:  Record<string, (e: React.DragEvent) => void>
  onComplete: () => void
  onCreate:   () => void
  children:   React.ReactNode
}) {
  const { dispatch } = useStore()
  const [open, setOpen]       = useState(true)
  const [editing, setEditing] = useState(false)
  const [name, setName]       = useState(sprint.name)
  const [goal, setGoal]       = useState(sprint.goal)
  const points = items.reduce((n, i) => n + (i.estimate ?? 0), 0)
  const doneCount = items.filter(i => isDone(project, i)).length

  return (
    <div className={`bl-box${highlight ? ' drop-target' : ''}`} {...dropProps}>
      <div className="bl-box-hdr">
        <button className="ir-group-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={13} strokeWidth={1.75} /> : <ChevronRight size={13} strokeWidth={1.75} />}
          <span className="bl-box-title">{sprint.name}</span>
        </button>
        {sprint.state === 'active' && <span className="bl-active">Active</span>}
        <span className="ir-group-count">
          {plural(items.length, 'item')}{points ? ` · ${points} pts` : ''}{sprint.state === 'active' ? ` · ${doneCount} done` : ''}
        </span>
        {sprint.goal && !editing && <span className="bl-goal">{sprint.goal}</span>}
        <div style={{ flex: 1 }} />
        {sprint.state === 'planned' && (
          <button className="btn-secondary" disabled={!canStart || items.length === 0}
            title={!canStart ? 'Complete the active sprint first' : items.length === 0 ? 'Add work items to start this sprint' : undefined}
            onClick={() => dispatch({ type: 'startSprint', id: sprint.id })}>
            Start sprint
          </button>
        )}
        {sprint.state === 'active' && <button className="btn-secondary" onClick={onComplete}>Complete sprint</button>}
        <Picker
          value=""
          options={[
            { value: 'edit',   label: 'Edit sprint' },
            ...(sprint.state === 'planned' ? [{ value: 'delete', label: 'Delete sprint' }] : []),
          ]}
          onChange={v => v === 'edit' ? setEditing(true) : dispatch({ type: 'deleteSprint', id: sprint.id })}
          className="col-hdr-btn" align="right" title="Sprint actions"
          trigger={<MoreHorizontal size={14} strokeWidth={1.5} />}
        />
      </div>

      {editing && (
        <form className="bl-edit" onSubmit={e => {
          e.preventDefault()
          dispatch({ type: 'updateSprint', id: sprint.id, patch: { name: name.trim() || sprint.name, goal: goal.trim() } })
          setEditing(false)
        }}>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} aria-label="Sprint name" autoFocus />
          <input className="form-input" value={goal} onChange={e => setGoal(e.target.value)} placeholder="Sprint goal (optional)" aria-label="Sprint goal" />
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" className="btn-primary">Save</button>
        </form>
      )}

      {open && children}
      {open && (
        <button className="col-create" style={{ margin: 4 }} onClick={onCreate}>
          <Plus size={13} strokeWidth={1.75} />Create
        </button>
      )}
    </div>
  )
}

// ── Complete sprint ────────────────────────────────────────

function CompleteSprintModal({ sprint, project, others, onClose }: {
  sprint: Sprint; project: Project; others: Sprint[]; onClose: () => void
}) {
  const { state, dispatch } = useStore()
  const items = state.issues.filter(i => i.sprintId === sprint.id)
  const open = items.filter(i => !isDone(project, i)).length
  const [target, setTarget] = useState<string>(BACKLOG)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-modal" onClick={e => e.stopPropagation()} onKeyDown={e => e.key === 'Escape' && onClose()} role="dialog" aria-label="Complete sprint">
        <div className="modal-hdr"><div className="modal-title">Complete {sprint.name}</div></div>
        <div className="modal-body">
          <p style={{ color: '#57534E', marginBottom: 12 }}>
            {items.length - open} of {items.length} work items are done.
            {open > 0 ? ` Where should the ${open} open item${open === 1 ? '' : 's'} go?` : ' Nice work.'}
          </p>
          {open > 0 && (
            <select className="form-input" value={target} onChange={e => setTarget(e.target.value)} aria-label="Move open items to">
              <option value={BACKLOG}>Backlog</option>
              {others.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
        <div className="modal-ftr">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" autoFocus onClick={() => {
            dispatch({ type: 'completeSprint', id: sprint.id, moveTo: target === BACKLOG ? undefined : target })
            onClose()
          }}>Complete sprint</button>
        </div>
      </div>
    </div>
  )
}
