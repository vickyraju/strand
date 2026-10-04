import { useState } from 'react'
import {
  Plus, Columns2, ListChecks, ChevronDown, ChevronRight, ChevronsLeftRight, Settings2, Check, GitBranch, Timer,
} from 'lucide-react'
import {
  useStore, userOf, canTransition, statusOf, indexOf, DEFAULT_FIELDS,
  type Project, type Issue, type BoardPrefs, type CardField, type GroupBy, type IssuePatch,
} from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import BoardCard from './BoardCard'
import { CompleteSprintModal } from './BacklogView'
import { Avatar, Empty, Picker, Popover, Toggle, PriorityIcon, PRIORITY_META, PRIORITIES, TypeIcon, StatusLozenge, plural } from './ui'

const FIELD_LABELS: [CardField, string][] = [
  ['type', 'Work type'], ['key', 'Key'], ['epic', 'Epic'], ['labels', 'Labels'], ['due', 'Due date'],
  ['estimate', 'Story points'], ['priority', 'Priority'], ['assignee', 'Assignee'], ['subitems', 'Sub-item progress'],
]

interface Lane {
  key:    string
  label:  React.ReactNode
  match:  (i: Issue) => boolean
  /** Fields to change when a card is dropped into this lane. */
  patch?: IssuePatch
}

export default function BoardView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { createIssue, openProject, toast } = useApp()
  const prefs: BoardPrefs = { ...project.boardPrefs, fields: { ...DEFAULT_FIELDS, ...project.boardPrefs.fields } }
  const setPrefs = (p: Partial<BoardPrefs>) => dispatch({ type: 'updateProject', id: project.id, patch: { boardPrefs: { ...prefs, ...p } } })

  const [dragging, setDragging] = useState<Issue | null>(null)
  const [over, setOver]         = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)
  // Columns render their first 50 cards; large boards stay responsive
  const [cardLimits, setCardLimits] = useState<Record<string, number>>({})
  const cardLimit = (key: string) => cardLimits[key] ?? 50

  const sprint = project.template === 'scrum'
    ? state.sprints.find(s => s.projectId === project.id && s.state === 'active')
    : undefined

  const projectItems = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic')
  const people = [...new Set(projectItems.map(i => i.assigneeId).filter((x): x is string => !!x))]
    .map(id => userOf(state, id)!).filter(Boolean)
    .sort((a, b) => (a.id === state.me?.id ? -1 : b.id === state.me?.id ? 1 : a.name.localeCompare(b.name)))
  const filters = useFilters(people)

  const all = projectItems.filter(i => !sprint || i.sprintId === sprint.id)
  const issues = filters.apply(all).sort((a, b) => a.rank - b.rank)
  const visibleStatuses = project.statuses
  useNavList(visibleStatuses.flatMap(s => issues.filter(i => i.status === s.id).map(i => i.id)))

  if (project.template === 'scrum' && !sprint) {
    return (
      <Empty
        icon={<ListChecks size={22} strokeWidth={1.5} />}
        title="No active sprint"
        body="The board shows the work in the active sprint. Plan a sprint in the backlog and start it to see it here."
        action={<button className="btn btn-primary" onClick={() => openProject(project.id, 'backlog')}>Go to backlog</button>}
      />
    )
  }

  if (all.length === 0) {
    return (
      <Empty
        icon={<Columns2 size={22} strokeWidth={1.5} />}
        title="Visualize your work with a board"
        body={sprint ? `${sprint.name} has no work items yet. Add some from the backlog, or create one here.` : 'Track, organize and prioritize your team’s work. Get started by creating a work item.'}
        action={<button className="btn btn-primary" onClick={() => createIssue({ projectId: project.id, sprintId: sprint?.id })}><Plus size={15} />Create work item</button>}
      />
    )
  }

  // ── Swimlanes ────────────────────────────────────────────
  const epicOf = (i: Issue): string | undefined => {
    const parent = i.parentId ? indexOf(state).byId.get(i.parentId) : undefined
    if (!parent) return undefined
    return parent.type === 'epic' ? parent.id : epicOf(parent)
  }
  const lanes: Lane[] = (() => {
    const g: GroupBy = prefs.groupBy
    if (g === 'assignee') {
      const ids = [...new Set(issues.map(i => i.assigneeId))]
      const users = ids.filter((x): x is string => !!x).map(id => userOf(state, id)!).filter(Boolean)
        .sort((a, b) => (a.id === state.me?.id ? -1 : b.id === state.me?.id ? 1 : a.name.localeCompare(b.name)))
      return [
        ...users.map(u => ({ key: u.id, label: <><Avatar user={u} size={22} /><b>{u.name}</b></>, match: (i: Issue) => i.assigneeId === u.id, patch: { assigneeId: u.id } })),
        { key: 'none', label: <><Avatar size={22} /><b>Unassigned</b></>, match: (i: Issue) => !i.assigneeId, patch: { assigneeId: undefined } },
      ]
    }
    if (g === 'epic') {
      const epics = state.issues.filter(e => e.projectId === project.id && e.type === 'epic' && issues.some(i => epicOf(i) === e.id))
      return [
        ...epics.map(e => ({
          key: e.id,
          label: <><TypeIcon type="epic" size={14} /><span className="mono muted">{e.key}</span><b>{e.title}</b><StatusLozenge status={statusOf(project, e.status)} /></>,
          match: (i: Issue) => epicOf(i) === e.id, patch: { parentId: e.id },
        })),
        { key: 'none', label: <b>Everything else</b>, match: (i: Issue) => !epicOf(i), patch: { parentId: undefined } },
      ]
    }
    if (g === 'priority') {
      return PRIORITIES.map(p => ({
        key: p, label: <><PriorityIcon priority={p} /><b>{PRIORITY_META[p].label}</b></>, match: (i: Issue) => i.priority === p, patch: { priority: p },
      }))
    }
    return [{ key: 'all', label: null, match: () => true }]
  })().filter(l => prefs.groupBy === 'none' || issues.some(l.match))
  const grouped = prefs.groupBy !== 'none'

  // ── Drag and drop ───────────────────────────────────────
  const allowed = (statusId: string) => !dragging || canTransition(project, dragging.status, statusId)
  const drop = (statusId: string, lane: Lane) => {
    const issue = dragging
    setDragging(null); setOver(null)
    if (!issue) return
    const patch: IssuePatch = {}
    if (issue.status !== statusId) {
      if (!canTransition(project, issue.status, statusId)) {
        toast(`The ${project.name} workflow doesn’t allow ${statusOf(project, issue.status)?.name} → ${statusOf(project, statusId)?.name}`, { tone: 'warn' })
        return
      }
      patch.status = statusId
    }
    // Moving between lanes changes the grouped field (sub-items keep their parent)
    if (lane.patch && !lane.match(issue) && !(prefs.groupBy === 'epic' && issue.parentId && indexOf(state).byId.get(issue.parentId)?.type !== 'epic')) {
      Object.assign(patch, lane.patch)
    }
    if (Object.keys(patch).length) dispatch({ type: 'updateIssues', ids: [issue.id], patch })
  }

  const toggleIn = (list: string[], key: string) => list.includes(key) ? list.filter(k => k !== key) : [...list, key]
  const columns = visibleStatuses.map(s => ({ ...s, collapsed: prefs.collapsedCols.includes(s.id) }))
  const template = columns.map(c => c.collapsed ? '44px' : 'minmax(272px, 1fr)').join(' ')
  const daysLeft = sprint?.endsAt ? Math.ceil((sprint.endsAt - Date.now()) / 86_400_000) : undefined

  // ── Keyboard: arrows move between cards ─────────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (!card || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    const cell = card.closest<HTMLElement>('[data-cell]')!
    const cards = [...cell.querySelectorAll<HTMLElement>('[data-card]')]
    const idx = cards.indexOf(card)
    if (e.key === 'ArrowDown') cards[idx + 1]?.focus()
    else if (e.key === 'ArrowUp') cards[idx - 1]?.focus()
    else {
      const row = [...cell.parentElement!.querySelectorAll<HTMLElement>(`[data-lane="${cell.dataset.lane}"]`)]
      const next = row[row.indexOf(cell) + (e.key === 'ArrowRight' ? 1 : -1)]
      const target = next?.querySelectorAll<HTMLElement>('[data-card]')
      target?.[Math.min(idx, target.length - 1)]?.focus()
    }
  }

  return (
    <div className="board-wrap">
      <div className="toolbar">
        {filters.toolbar}
        <div style={{ flex: 1 }} />
        {sprint && (
          <span className="sprint-meta" title={sprint.goal || undefined}>
            <Timer size={14} />
            <b>{sprint.name}</b>
            {daysLeft !== undefined && <span className={daysLeft < 0 ? 'text-danger' : 'muted'}>{daysLeft < 0 ? `${-daysLeft}d overdue` : `${daysLeft}d left`}</span>}
          </span>
        )}
        {sprint && <button className="btn btn-secondary" onClick={() => setCompleting(true)}>Complete sprint</button>}
        <Picker
          value={prefs.groupBy}
          title="Group by"
          className={`btn btn-secondary${grouped ? ' active' : ''}`}
          align="right"
          options={[
            { value: 'none' as GroupBy, label: 'None' }, { value: 'assignee' as GroupBy, label: 'Assignee' },
            { value: 'epic' as GroupBy, label: 'Epic' }, { value: 'priority' as GroupBy, label: 'Priority' },
          ]}
          onChange={groupBy => setPrefs({ groupBy, collapsedLanes: [] })}
          trigger={<>Group{grouped ? `: ${prefs.groupBy[0].toUpperCase() + prefs.groupBy.slice(1)}` : ''}<ChevronDown size={14} /></>}
        />
        <Popover title="View settings" className="btn btn-secondary icon-only" trigger={<Settings2 size={16} />}>
          <div className="section-label">Fields on cards</div>
          {FIELD_LABELS.map(([f, label]) => (
            <label key={f} className="toggle-row">
              <span>{label}</span>
              <Toggle on={prefs.fields[f]} onChange={on => setPrefs({ fields: { ...prefs.fields, [f]: on } })} label={label} />
            </label>
          ))}
          {grouped && (
            <>
              <div className="section-label" style={{ marginTop: 10 }}>Swimlanes</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setPrefs({ collapsedLanes: [] })}>Expand all</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setPrefs({ collapsedLanes: lanes.map(l => l.key) })}>Collapse all</button>
              </div>
            </>
          )}
          <div className="section-label" style={{ marginTop: 10 }}>Columns</div>
          <button className="btn btn-secondary btn-sm" onClick={() => openProject(project.id, 'settings', 'workflow')}>
            <GitBranch size={13} />Edit workflow
          </button>
        </Popover>
      </div>

      <div className="board-scroll" onKeyDown={onKeyDown}>
        <div className="board-grid" style={{ gridTemplateColumns: template }}>
          {columns.map(col => {
            const count = issues.filter(i => i.status === col.id).length
            const over = col.wipLimit != null && count > col.wipLimit
            return (
              <div key={col.id} className={`col-hdr${col.collapsed ? ' collapsed' : ''}${over ? ' over-limit' : ''}${dragging && !allowed(col.id) ? ' disallowed' : ''}`}>
                {col.collapsed ? (
                  <button className="col-hdr-collapsed" onClick={() => setPrefs({ collapsedCols: toggleIn(prefs.collapsedCols, col.id) })}
                    title={`Expand ${col.name}`} aria-label={`Expand ${col.name} column`}>
                    <span className="col-count">{count}</span>
                    <span className="col-vertical">{col.name}</span>
                  </button>
                ) : (
                  <>
                    <span className="col-name">{col.name}</span>
                    <span className="col-count">{count}</span>
                    {col.wipLimit != null && <span className="col-wip" title="Work-in-progress limit">Max {col.wipLimit}</span>}
                    {col.category === 'done' && <Check size={14} className="text-success" aria-label="Done column" />}
                    <div style={{ flex: 1 }} />
                    <button className="icon-btn sm" title={`Collapse ${col.name}`} aria-label={`Collapse ${col.name} column`}
                      onClick={() => setPrefs({ collapsedCols: toggleIn(prefs.collapsedCols, col.id) })}>
                      <ChevronsLeftRight size={13} />
                    </button>
                    <button className="icon-btn sm" title={`Create in ${col.name}`} aria-label={`Create work item in ${col.name}`}
                      onClick={() => createIssue({ projectId: project.id, status: col.id, sprintId: sprint?.id })}>
                      <Plus size={14} />
                    </button>
                  </>
                )}
              </div>
            )
          })}

          {lanes.map(lane => {
            const laneItems = issues.filter(lane.match)
            const laneCollapsed = grouped && prefs.collapsedLanes.includes(lane.key)
            return (
              <div key={lane.key} style={{ display: 'contents' }}>
                {grouped && (
                  <button className="lane-hdr" style={{ gridColumn: '1 / -1' }} aria-expanded={!laneCollapsed}
                    onClick={() => setPrefs({ collapsedLanes: toggleIn(prefs.collapsedLanes, lane.key) })}>
                    {laneCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {lane.label}
                    <span className="muted">({plural(laneItems.length, 'item')})</span>
                  </button>
                )}
                {!laneCollapsed && columns.map(col => {
                  const cellKey = `${lane.key}|${col.id}`
                  const cards = laneItems.filter(i => i.status === col.id)
                  return (
                    <div
                      key={cellKey}
                      data-cell
                      data-lane={lane.key}
                      className={`cell${col.collapsed ? ' collapsed' : ''}${over === cellKey ? ' drop-over' : ''}${dragging && !allowed(col.id) ? ' disallowed' : ''}`}
                      onDragOver={e => { if (allowed(col.id)) { e.preventDefault(); setOver(cellKey) } }}
                      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
                      onDrop={e => { e.preventDefault(); drop(col.id, lane) }}
                    >
                      {!col.collapsed && cards.slice(0, cardLimit(cellKey)).map(issue => (
                        <BoardCard
                          key={issue.id}
                          issue={issue}
                          project={project}
                          fields={prefs.groupBy === 'epic' ? { ...prefs.fields, epic: false } : prefs.fields}
                          dragging={dragging?.id === issue.id}
                          onDragStart={() => setDragging(issue)}
                          onDragEnd={() => { setDragging(null); setOver(null) }}
                        />
                      ))}
                      {!col.collapsed && cards.length > cardLimit(cellKey) && (
                        <button className="cell-create" onClick={() => setCardLimits(l => ({ ...l, [cellKey]: cardLimit(cellKey) + 100 }))}>
                          <ChevronDown size={14} />Show {Math.min(100, cards.length - cardLimit(cellKey))} more
                        </button>
                      )}
                      {!col.collapsed && (
                        <button className="cell-create" onClick={() => createIssue({ projectId: project.id, status: col.id, sprintId: sprint?.id, ...(lane.patch as object) })}>
                          <Plus size={14} />Create
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {completing && sprint && (
        <CompleteSprintModal sprint={sprint} project={project}
          others={state.sprints.filter(s => s.projectId === project.id && s.state === 'planned')}
          onClose={() => setCompleting(false)} />
      )}
    </div>
  )
}
