import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, MoreHorizontal, ArrowRightLeft, Pencil, Trash2, Play, ArrowUpToLine, ArrowDownToLine } from 'lucide-react'
import { useStore, isDone, userOf, type Project, type Sprint, type Issue } from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import IssueRow from './IssueRow'
import BulkBar from './BulkBar'
import { Menu, Modal, plural } from './ui'

const BACKLOG = 'backlog'
const DAY = 86_400_000

const fmt = (ts?: number) => ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''

export default function BacklogView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { createIssue } = useApp()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver]         = useState<string | null>(null)
  const [overRow, setOverRow]   = useState<string | null>(null)
  const [completing, setCompleting] = useState<Sprint | null>(null)
  const [starting, setStarting]     = useState<Sprint | null>(null)
  const [editing, setEditing]       = useState<Sprint | null>(null)
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [anchor, setAnchor]         = useState<string | null>(null)

  const items = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic')
  const people = [...new Set(items.map(i => i.assigneeId).filter((x): x is string => !!x))].map(id => userOf(state, id)!).filter(Boolean)
  const filters = useFilters(people)

  const sprints = state.sprints
    .filter(s => s.projectId === project.id && s.state !== 'closed')
    .sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : 0))
  const hasActive = sprints.some(s => s.state === 'active')
  const issues = filters.apply(items).sort((a, b) => a.rank - b.rank)
  const inSprint = (s: Sprint) => issues.filter(i => i.sprintId === s.id)
  // Items still in a closed sprint were completed there; they live in the sprint report, not the backlog
  const closedIds = new Set(state.sprints.filter(s => s.projectId === project.id && s.state === 'closed').map(s => s.id))
  const backlogItems = issues.filter(i => (!i.sprintId || !sprints.some(s => s.id === i.sprintId)) && !(i.sprintId && closedIds.has(i.sprintId)))
  const ordered = [...sprints.flatMap(inSprint), ...backlogItems]
  useNavList(ordered.map(i => i.id))

  const moveTargets = [...sprints.map(s => ({ value: s.id as string, label: s.name })), { value: BACKLOG, label: 'Backlog' }]

  const select = (id: string, on: boolean, shift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && anchor) {
        const ids = ordered.map(i => i.id)
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
        ids.slice(a, b + 1).forEach(x => on ? next.add(x) : next.delete(x))
      } else if (on) next.add(id); else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  // Dragging a selected row moves the whole selection, keeping its order
  const draggedIds = () => !dragging ? [] : selected.has(dragging) ? ordered.filter(i => selected.has(i.id)).map(i => i.id) : [dragging]
  const container = (target: string) => target === BACKLOG ? null : target

  const dropZone = (target: string) => ({
    onDragOver:  (e: React.DragEvent) => { e.preventDefault(); setOver(target) },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) },
    onDrop:      (e: React.DragEvent) => {
      e.preventDefault()
      for (const id of draggedIds()) dispatch({ type: 'moveIssue', id, container: container(target) })
      setDragging(null); setOver(null); setOverRow(null)
    },
  })

  const refocus = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus())

  // Ordering inside one list (a sprint or the backlog)
  const reorder = (i: Issue, list: Issue[], where: 'up' | 'down' | 'top' | 'bottom') => {
    const at = list.findIndex(x => x.id === i.id)
    const target = list.filter(x => x.id !== i.id)
    const beforeId = where === 'top' ? target[0]?.id
      : where === 'up' ? (at > 0 ? list[at - 1].id : undefined)
      : where === 'down' ? list[at + 2]?.id
      : undefined
    if (where === 'up' && at === 0) return
    if (where === 'down' && at === list.length - 1) return
    dispatch({ type: 'moveIssue', id: i.id, beforeId, container: i.sprintId ?? null })
    refocus(i.id)
  }

  const rows = (list: Issue[]) => list.map(i => (
    <div key={i.id} className={`rank-slot${overRow === i.id ? ' drop-before' : ''}`}
      onDragOver={e => { if (dragging && dragging !== i.id) { e.preventDefault(); e.stopPropagation(); setOverRow(i.id); setOver(null) } }}
      onDragLeave={() => setOverRow(r => r === i.id ? null : r)}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation()
        for (const id of draggedIds()) if (id !== i.id) dispatch({ type: 'moveIssue', id, beforeId: i.id, container: i.sprintId ?? null })
        setDragging(null); setOver(null); setOverRow(null)
      }}
      onKeyDown={e => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        reorder(i, list, e.key === 'ArrowUp' ? 'up' : 'down')
      }}>
      <IssueRow issue={i} project={project}
        selected={selected.has(i.id)} onSelect={(on, shift) => select(i.id, on, shift)}
        draggable onDragStart={() => setDragging(i.id)} onDragEnd={() => { setDragging(null); setOver(null); setOverRow(null) }}
        trailing={
          <Menu title={`Move ${i.key}`} className="icon-btn sm" trigger={<ArrowRightLeft size={14} />} items={[
            { label: 'Move to top', icon: <ArrowUpToLine size={14} />, hint: '⌥↑', onClick: () => reorder(i, list, 'top') },
            { label: 'Move to bottom', icon: <ArrowDownToLine size={14} />, hint: '⌥↓', onClick: () => reorder(i, list, 'bottom') },
            ...moveTargets.filter(t => t.value !== (i.sprintId ?? BACKLOG)).map((t, k) => ({
              label: `Move to ${t.label}`, icon: <ArrowRightLeft size={14} />, divider: k === 0,
              onClick: () => dispatch({ type: 'moveIssue', id: i.id, container: container(t.value) }),
            })),
          ]} />
        }
      />
    </div>
  ))

  const summary = (list: Issue[]) => {
    const pts = list.reduce((n, i) => n + (i.estimate ?? 0), 0)
    const byCat = (c: string) => list.filter(i => project.statuses.find(s => s.id === i.status)?.category === c).reduce((n, i) => n + (i.estimate ?? 0), 0)
    return (
      <span className="pts-summary" title="Story points: to do · in progress · done">
        <span className="muted">{plural(list.length, 'item')}</span>
        {pts > 0 && <>
          <span className="pt pt-todo">{byCat('todo')}</span>
          <span className="pt pt-progress">{byCat('in-progress')}</span>
          <span className="pt pt-done">{byCat('done')}</span>
        </>}
      </span>
    )
  }

  return (
    <div className="page-col">
      <div className="toolbar">
        {filters.toolbar}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={() => dispatch({ type: 'createSprint', projectId: project.id })}>
          <Plus size={15} />Create sprint
        </button>
      </div>

      <div className="backlog-scroll">
        {sprints.map(sprint => {
          const list = inSprint(sprint)
          return (
            <SprintBox key={sprint.id} sprint={sprint} highlight={over === sprint.id} dropProps={dropZone(sprint.id)}
              summary={summary(list)}
              actions={<>
                {sprint.state === 'planned' && (
                  <button className="btn btn-secondary btn-sm" disabled={hasActive || list.length === 0}
                    title={hasActive ? 'Complete the active sprint first' : list.length === 0 ? 'Add work items to start this sprint' : undefined}
                    onClick={() => setStarting(sprint)}><Play size={13} />Start sprint</button>
                )}
                {sprint.state === 'active' && <button className="btn btn-secondary btn-sm" onClick={() => setCompleting(sprint)}>Complete sprint</button>}
                <Menu title="Sprint actions" className="icon-btn sm" trigger={<MoreHorizontal size={15} />} items={[
                  { label: 'Edit sprint', icon: <Pencil size={14} />, onClick: () => setEditing(sprint) },
                  ...(sprint.state === 'planned' ? [{ label: 'Delete sprint', icon: <Trash2 size={14} />, danger: true, onClick: () => dispatch({ type: 'deleteSprint', id: sprint.id }) }] : []),
                ]} />
              </>}
              onCreate={() => createIssue({ projectId: project.id, sprintId: sprint.id })}
            >
              {list.length === 0
                ? <div className="drop-hint">Plan this sprint by dragging work items here, or select items and use “Sprint” in the action bar.</div>
                : rows(list)}
            </SprintBox>
          )
        })}

        <div className={`sprint-box${over === BACKLOG ? ' drop-over' : ''}`} {...dropZone(BACKLOG)}>
          <div className="sprint-hdr">
            <span className="sprint-name">Backlog</span>
            {summary(backlogItems)}
            <div style={{ flex: 1 }} />
            {sprints.length === 0 && <button className="btn btn-secondary btn-sm" onClick={() => dispatch({ type: 'createSprint', projectId: project.id })}>Create sprint</button>}
          </div>
          {backlogItems.length === 0
            ? <div className="drop-hint">{filters.active ? 'No backlog items match the filters.' : 'Your backlog is empty. Create work items to plan them into sprints.'}</div>
            : rows(backlogItems)}
          <button className="cell-create" onClick={() => createIssue({ projectId: project.id })}><Plus size={14} />Create</button>
        </div>
      </div>

      <BulkBar ids={[...selected].filter(id => ordered.some(i => i.id === id))} onClear={() => setSelected(new Set())} />

      {completing && <CompleteSprintModal sprint={completing} project={project} others={sprints.filter(s => s.id !== completing.id)} onClose={() => setCompleting(null)} />}
      {starting && <SprintDialog sprint={starting} mode="start" onClose={() => setStarting(null)} />}
      {editing && <SprintDialog sprint={editing} mode="edit" onClose={() => setEditing(null)} />}
    </div>
  )
}

function SprintBox({ sprint, highlight, dropProps, summary, actions, onCreate, children }: {
  sprint: Sprint; highlight: boolean; dropProps: Record<string, (e: React.DragEvent) => void>
  summary: React.ReactNode; actions: React.ReactNode; onCreate: () => void; children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className={`sprint-box${highlight ? ' drop-over' : ''}`} {...dropProps}>
      <div className="sprint-hdr">
        <button className="sprint-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="sprint-name">{sprint.name}</span>
        </button>
        {sprint.state === 'active' && <span className="lozenge lozenge-in-progress">Active</span>}
        {sprint.startedAt && <span className="muted sm">{fmt(sprint.startedAt)} – {fmt(sprint.endsAt)}</span>}
        {summary}
        {sprint.goal && <span className="sprint-goal" title={sprint.goal}>{sprint.goal}</span>}
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {open && children}
      {open && <button className="cell-create" onClick={onCreate}><Plus size={14} />Create</button>}
    </div>
  )
}

function SprintDialog({ sprint, mode, onClose }: { sprint: Sprint; mode: 'start' | 'edit'; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const [name, setName] = useState(sprint.name)
  const [goal, setGoal] = useState(sprint.goal)
  const [weeks, setWeeks] = useState(() => sprint.startedAt && sprint.endsAt ? Math.max(1, Math.round((sprint.endsAt - sprint.startedAt) / (7 * DAY))) : 2)
  const count = state.issues.filter(i => i.sprintId === sprint.id).length
  const start = sprint.startedAt ?? Date.now()

  const save = () => {
    const endsAt = start + weeks * 7 * DAY
    dispatch({ type: 'updateSprint', id: sprint.id, patch: { name: name.trim() || sprint.name, goal: goal.trim(), ...(mode === 'edit' && sprint.startedAt ? { endsAt } : {}) } })
    if (mode === 'start') dispatch({ type: 'startSprint', id: sprint.id, endsAt })
    onClose()
  }

  return (
    <Modal title={mode === 'start' ? `Start ${sprint.name}` : 'Edit sprint'} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>{mode === 'start' ? 'Start sprint' : 'Save'}</button>
      </>}>
      {mode === 'start' && <p className="muted" style={{ marginBottom: 14 }}>{plural(count, 'work item')} will be included in this sprint.</p>}
      <label className="label" htmlFor="sp-name">Sprint name</label>
      <input id="sp-name" className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
      {(mode === 'start' || sprint.startedAt) && (
        <div className="form-row" style={{ marginTop: 14 }}>
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="sp-dur">Duration</label>
            <select id="sp-dur" className="input" value={weeks} onChange={e => setWeeks(Number(e.target.value))}>
              {[1, 2, 3, 4].map(w => <option key={w} value={w}>{plural(w, 'week')}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <span className="label">Dates</span>
            <div className="static-field">{fmt(start)} – {fmt(start + weeks * 7 * DAY)}</div>
          </div>
        </div>
      )}
      <label className="label" htmlFor="sp-goal" style={{ marginTop: 14 }}>Sprint goal</label>
      <textarea id="sp-goal" className="input" rows={3} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What does the team want to achieve?" />
    </Modal>
  )
}

export function CompleteSprintModal({ sprint, project, others, onClose }: {
  sprint: Sprint; project: Project; others: Sprint[]; onClose: () => void
}) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const items = state.issues.filter(i => i.sprintId === sprint.id)
  const open = items.filter(i => !isDone(project, i))
  const [target, setTarget] = useState<string>(others.find(s => s.state === 'planned')?.id ?? BACKLOG)
  const donePts = items.filter(i => isDone(project, i)).reduce((n, i) => n + (i.estimate ?? 0), 0)

  return (
    <Modal title={`Complete ${sprint.name}`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" autoFocus onClick={() => {
          dispatch({ type: 'completeSprint', id: sprint.id, moveTo: target === BACKLOG ? undefined : target })
          toast(`${sprint.name} completed`, { undo: 'completeSprint' })
          onClose()
        }}>Complete sprint</button>
      </>}>
      <div className="stat-pair">
        <div><b>{items.length - open.length}</b><span>completed items</span></div>
        <div><b>{open.length}</b><span>open items</span></div>
        <div><b>{donePts}</b><span>points done</span></div>
      </div>
      {open.length > 0 && (
        <>
          <label className="label" htmlFor="cs-target" style={{ marginTop: 16 }}>Move open items to</label>
          <select id="cs-target" className="input" value={target} onChange={e => setTarget(e.target.value)}>
            {others.filter(s => s.state === 'planned').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value={BACKLOG}>Backlog</option>
          </select>
        </>
      )}
    </Modal>
  )
}
