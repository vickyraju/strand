import { useEffect, useMemo, useState } from 'react'
import { cardColor } from '../data/reducer'
import { priorityOf } from '../data/lists'
import { typeMeta } from './ui'
import { DndContext, DragOverlay, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import {
  Plus, Columns2, ListChecks, ChevronDown, ChevronRight, ChevronsLeftRight, Settings2, Check, GitBranch, Timer, Kanban,
} from 'lucide-react'
import {
  useStore, userOf, moveContext, statusOf, indexOf, DEFAULT_FIELDS,
  type Project, type Issue, type Board, type CardField, type GroupBy, type IssuePatch,
} from '../data/store'
import { canAdmin, canEdit } from '../data/access'
import { api, apiEnabled, errorMessage } from '../api/client'
import { lastBoard, reloadBoards, useBoard, useBoardItems, useBoards, useBoardView } from '../api/boards'
import { useEnsureProjects } from '../api/useEnsureProjects'
import { href, navigate, useLocation } from '../router'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import BoardCard, { CardGhost } from './BoardCard'
import { planMove } from './TransitionDialog'
import { BOARD_INSTRUCTIONS, boardAnnouncements, boardCollision, planDrop, statusesIn, useBoardSensors } from './boardDnd'
import { CompleteSprintModal, NO_SPRINTS } from './BacklogView'
import CreateBoard from './boards/CreateBoard'
import { Avatar, Empty, Loading, LoadError, Picker, Popover, Toggle, PriorityIcon, priorityLabel, priorityKeys, TypeIcon, StatusLozenge, plural } from './ui'

export const FIELD_LABELS: [CardField, string][] = [
  ['type', 'Work type'], ['key', 'Key'], ['epic', 'Epic'], ['labels', 'Labels'], ['due', 'Due date'],
  ['estimate', 'Story points'], ['priority', 'Priority'], ['assignee', 'Assignee'], ['subitems', 'Sub-item progress'],
]
type LaneBy = Board['swimlanes']['by']
const LANE_LABEL: Record<LaneBy, string> = { none: 'None', assignee: 'Assignee', epic: 'Epic', priority: 'Priority', project: 'Project', queries: 'Queries' }

interface Lane {
  key:    string
  label:  React.ReactNode
  match:  (i: Issue) => boolean
  /** Fields to change when a card is dropped into this lane. */
  patch?: IssuePatch
}

/** A local workspace (no server) has one board, made from the project's statuses and its board settings. */
function localBoard(project: Project): Board {
  return {
    id: `local:${project.id}`, name: `${project.key} board`, type: project.template, jql: '', position: 0, projectId: project.id, projectKey: project.key,
    columns: project.statuses.map(s => ({ id: s.id, name: s.name, statusIds: [s.globalStatusId ?? s.id], ...(s.wipLimit ? { max: s.wipLimit } : {}) })),
    swimlanes: { by: project.boardPrefs.groupBy }, quickFilters: [], cardFields: project.boardPrefs.fields, doneDays: null,
    canManage: canAdmin(project), admins: [],
  }
}

/** One cell of the board (a column within a swimlane): a place cards can be dropped. */
function DroppableCell({ id, laneKey, collapsed, blocked, children }: {
  id: string; laneKey: string; collapsed: boolean; blocked: boolean; children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { laneKey } })
  return (
    <div ref={setNodeRef} data-cell data-lane={laneKey}
      className={`cell${collapsed ? ' collapsed' : ''}${isOver && !blocked ? ' drop-over' : ''}${blocked ? ' disallowed' : ''}${isOver && blocked ? ' drop-refused' : ''}`}>
      {children}
    </div>
  )
}

const CREATE = 'create-board', CONFIGURE = 'configure-board'

/** The Board tab: the project's boards (Jira's boards: several per project, each with its own filter), the one chosen
 *  in the address (`sub`) or the one last used here, and its quick filters (`quick`, ids, kept in the address). */
export default function BoardView({ project, sub, quick }: { project: Project; sub?: string; quick?: string }) {
  const [listVersion, setListVersion] = useState(0)
  const { dispatch } = useStore()
  const [creating, setCreating] = useState(false)
  const [made, setMade] = useState<Board[]>([])                    // boards made here, until the list from the server has them
  const listed = useBoards(project, listVersion)
  const boards = [...listed, ...made.filter(b => !listed.some(x => x.id === b.id))]
  const remembered = lastBoard.get(project.id)
  const id = apiEnabled ? (boards.find(b => b.id === sub) ?? boards.find(b => b.id === remembered) ?? boards[0])?.id : undefined
  const { board: remote, error, reload, replace } = useBoard(id)
  const board = apiEnabled ? remote : localBoard(project)

  useEffect(() => {
    if (!id) return
    lastBoard.set(project.id, id)
    if (sub !== id) navigate(href({ name: 'project', key: project.key, tab: 'board', sub: id }), { replace: true })   // an address that names it
  }, [id, sub])   // eslint-disable-line react-hooks/exhaustive-deps

  const switcher = apiEnabled && (
    <>
      {boards.length > 0 && (
        <Picker value={id} title="Boards" className="btn btn-secondary board-switch" search={boards.length > 8}
          options={[
            ...boards.map(b => ({ value: b.id as string | undefined, label: b.name, hint: b.type === 'scrum' ? 'Scrum' : 'Kanban' })),
            ...(id ? [{ value: CONFIGURE as string | undefined, label: 'Configure board', icon: <Settings2 size={14} /> }] : []),
            ...(canAdmin(project) ? [{ value: CREATE as string | undefined, label: 'Create board', icon: <Plus size={14} /> }] : []),
          ]}
          onChange={b => b === CREATE ? setCreating(true) : navigate(href({ name: 'project', key: project.key, tab: b === CONFIGURE ? 'boards' : 'board', sub: b === CONFIGURE ? id : b }))}
          trigger={<><Kanban size={15} /><b>{boards.find(b => b.id === id)?.name ?? 'Board'}</b><ChevronDown size={14} /></>} />
      )}
      {creating && (
        <CreateBoard project={project} onClose={() => setCreating(false)}
          onCreated={b => { setCreating(false); setMade(m => [...m, b]); setListVersion(v => v + 1); void reloadBoards(project.key, dispatch); navigate(href({ name: 'project', key: project.key, tab: 'board', sub: b.id })) }} />
      )}
    </>
  )

  if (error) return <div className="board-wrap"><div className="toolbar">{switcher}</div><LoadError error={error} onRetry={reload} /></div>
  if (!board) return <div className="board-wrap"><div className="toolbar">{switcher}</div><Loading rows={4} /></div>
  return <BoardScreen key={board.id} project={project} board={board} switcher={switcher} quick={quick ? quick.split(',') : []} onChanged={replace} />
}

function BoardScreen({ project, board, switcher, quick: asked, onChanged }: {
  project: Project; board: Board; switcher: React.ReactNode; quick: string[]; onChanged: (b: Board) => void
}) {
  const { state, dispatch } = useStore()
  const { createIssue, openProject, toast, moveIssue } = useApp()
  const { peek } = useLocation()
  const local = !apiEnabled
  const quick = asked.filter(q => board.quickFilters.some(f => f.id === q))   // ids from an old link that are gone are dropped
  const fields: Record<CardField, boolean> = { ...DEFAULT_FIELDS, ...board.cardFields }
  const groupBy = board.swimlanes.by
  const { view, save: saveView } = useBoardView(board.id)

  /** A change to the board itself (its administrators and the project's admins): to the server, or to a local workspace's project. */
  const change = async (patch: Partial<Pick<Board, 'swimlanes' | 'cardFields'>>) => {
    if (local) {
      dispatch({ type: 'updateProject', id: project.id, patch: { boardPrefs: { ...project.boardPrefs,
        ...(patch.swimlanes ? { groupBy: patch.swimlanes.by as GroupBy } : {}), ...(patch.cardFields ? { fields: { ...fields, ...patch.cardFields } } : {}) } } })
      return
    }
    onChanged({ ...board, ...patch })
    try { onChanged(await api<Board>('PATCH', `/api/boards/${encodeURIComponent(board.id)}`, patch)) }
    catch (e) { onChanged(board); toast(errorMessage(e), { tone: 'warn' }) }
  }

  const [dragging, setDragging] = useState<Issue | null>(null)
  const [completing, setCompleting] = useState(false)
  // Columns render their first 50 cards; large boards stay responsive
  const [cardLimits, setCardLimits] = useState<Record<string, number>>({})
  const cardLimit = (key: string) => cardLimits[key] ?? 50

  const sprint = board.type === 'scrum'
    ? state.sprints.find(s => (s.boardId ? s.boardId === board.id : s.projectId === board.projectId) && s.state === 'active')
    : undefined

  // ── The board's items ───────────────────────────────────
  const found = useBoardItems(local ? null : board, { quick, version: sprint?.id })
  const [loadedAt] = useState(() => Date.now())
  const { byId } = indexOf(state)
  const onBoard = new Set(found.ids)
  // the board's card colour for each card (spec 0409)
  const stripeOf = (i: Issue) => cardColor(board.cardColors, i, { typeColor: typeMeta(i.type, projectOf(i)).color, priorityColor: priorityOf(i.priority).color, match: found.colors.get(i.id) })
  const boardItems = (local
    ? state.issues.filter(i => i.projectId === project.id && (!sprint || i.sprintId === sprint.id))
    : [
        ...found.ids.map(id => byId.get(id)).filter((i): i is Issue => !!i),
        // made here since the board loaded: shown until the next load, which asks the board's filter
        ...state.issues.filter(i => i.createdAt > loadedAt && i.projectId === board.projectId && !onBoard.has(i.id) && (!sprint || i.sprintId === sprint.id)),
      ]).filter(i => i.type !== 'epic')
  useEnsureProjects([...new Set(boardItems.map(i => i.key.split('-')[0]!))])
  const projectOf = (i: Issue) => state.projects.find(p => p.id === i.projectId)

  const columns = board.columns.map(c => ({ ...c, collapsed: view.cols.includes(c.id) }))
  /** Which column each item is in: the one naming its status (as a global status). Items in an unmapped status aren't shown. */
  const colOf = (i: Issue) => {
    const s = projectOf(i)?.statuses.find(x => x.id === i.status)
    const g = s && (s.globalStatusId ?? s.id)
    return g ? columns.find(c => c.statusIds.includes(g))?.id : undefined
  }

  const people = [...new Set(boardItems.map(i => i.assigneeId).filter((x): x is string => !!x))]
    .map(id => userOf(state, id)!).filter(Boolean)
    .sort((a, b) => (a.id === state.me?.id ? -1 : b.id === state.me?.id ? 1 : a.name.localeCompare(b.name)))
  const filters = useFilters(people, project, { mine: !board.quickFilters.length })
  const issues = filters.apply(boardItems).filter(i => colOf(i)).sort((a, b) => a.rank - b.rank)
  useNavList(columns.flatMap(c => issues.filter(i => colOf(i) === c.id).map(i => i.id)))

  // ── Swimlanes ────────────────────────────────────────────
  const epicOf = (i: Issue): string | undefined => {
    const parent = i.parentId ? byId.get(i.parentId) : undefined
    if (!parent) return undefined
    return parent.type === 'epic' ? parent.id : epicOf(parent)
  }
  const lanes: Lane[] = (() => {
    if (groupBy === 'assignee') {
      return [
        ...people.map(u => ({ key: u.id, label: <><Avatar user={u} size={22} /><b>{u.name}</b></>, match: (i: Issue) => i.assigneeId === u.id, patch: { assigneeId: u.id } })),
        { key: 'none', label: <><Avatar size={22} /><b>Unassigned</b></>, match: (i: Issue) => !i.assigneeId, patch: { assigneeId: undefined } },
      ]
    }
    if (groupBy === 'epic') {
      const ids = new Set(issues.map(epicOf).filter((x): x is string => !!x))
      const epics = [...ids].map(id => byId.get(id)!).filter(Boolean).sort((a, b) => a.rank - b.rank)
      return [
        ...epics.map(e => ({
          key: e.id,
          label: <><TypeIcon type="epic" size={14} /><span className="mono muted">{e.key}</span><b>{e.title}</b>{projectOf(e) && <StatusLozenge status={statusOf(projectOf(e)!, e.status)} />}</>,
          match: (i: Issue) => epicOf(i) === e.id, patch: { parentId: e.id },
        })),
        { key: 'none', label: <b>Everything else</b>, match: (i: Issue) => !epicOf(i), patch: { parentId: undefined } },
      ]
    }
    if (groupBy === 'priority') {
      return priorityKeys().map(p => ({
        key: p, label: <><PriorityIcon priority={p} /><b>{priorityLabel(p)}</b></>, match: (i: Issue) => i.priority === p, patch: { priority: p },
      }))
    }
    if (groupBy === 'project') {
      return [...new Set(issues.map(i => i.projectId))].map(pid => state.projects.find(p => p.id === pid)!).filter(Boolean)
        .sort((a, b) => (a.id === board.projectId ? -1 : b.id === board.projectId ? 1 : a.name.localeCompare(b.name)))
        .map(p => ({ key: p.id, label: <><span className="mono muted">{p.key}</span><b>{p.name}</b></>, match: (i: Issue) => i.projectId === p.id }))
    }
    if (groupBy === 'queries') {
      return [
        ...(board.swimlanes.queries ?? []).map(q => ({ key: q.id, label: <b>{q.name}</b>, match: (i: Issue) => found.lanes.get(i.id) === q.id })),
        { key: '', label: <b>Everything else</b>, match: (i: Issue) => !found.lanes.get(i.id) },
      ]
    }
    return [{ key: 'all', label: null, match: () => true }]
  })().filter(l => groupBy === 'none' || issues.some(l.match))
  const grouped = groupBy !== 'none'

  // ── Drag and drop ───────────────────────────────────────
  const sensors = useBoardSensors(undefined, canEdit(project))
  /** Forbidden columns grey out while a card is being dragged. */
  const dragCtx = useMemo(() => (dragging ? moveContext(state, dragging) : undefined), [dragging])   // eslint-disable-line react-hooks/exhaustive-deps
  const allowed = (col: Board['columns'][number]) => {
    const p = dragging && projectOf(dragging)
    return !dragging || !p || !('blocked' in planDrop({ project: p, issue: dragging, column: col, moveLane: false, ctx: dragCtx }))
  }
  const cardFields = groupBy === 'epic' ? { ...fields, epic: false } : fields
  const planFor = (issue: Issue, cellId: unknown) => {
    const cut = String(cellId).lastIndexOf('|')
    const laneKey = String(cellId).slice(0, cut), column = columns.find(c => c.id === String(cellId).slice(cut + 1))!
    const lane = lanes.find(l => l.key === laneKey)!
    const moveLane = !!lane.patch && !lane.match(issue) && !(groupBy === 'epic' && issue.parentId && byId.get(issue.parentId)?.type !== 'epic')   // sub-items keep their parent
    const p = projectOf(issue)
    if (!p) return { blocked: 'This work item’s project is still loading' }
    return planDrop({ project: p, issue, column, lanePatch: lane.patch, moveLane, ctx: moveContext(state, issue) })
  }
  const issueOf = (id: unknown) => byId.get(String(id))
  const announcements = boardAnnouncements({
    key: id => issueOf(id)?.key ?? 'The work item',
    status: id => { const i = issueOf(id), p = i && projectOf(i); return (p && statusOf(p, i.status)?.name) ?? '' },
    column: cellId => columns.find(c => c.id === String(cellId).slice(String(cellId).lastIndexOf('|') + 1))?.name ?? '',
    verdict: (id, cellId) => {
      const issue = issueOf(id)
      const plan = issue ? planFor(issue, cellId) : { patch: {} }
      return 'blocked' in plan ? 'blocked' : Object.keys(plan.patch).length ? 'moves' : 'stays'
    },
  })
  const onDragStart = ({ active }: DragStartEvent) => setDragging(issueOf(active.id) ?? null)
  const onDragEnd = ({ over }: DragEndEvent) => {
    const issue = dragging
    setDragging(null)
    if (!issue || !over) return
    const plan = planFor(issue, over.id)
    if ('blocked' in plan) { toast(plan.blocked, { tone: 'warn' }); return }
    // a move whose transition asks for input (or isn't ready) goes through its screen; the swimlane change is made now
    const { status, ...rest } = plan.patch
    if (status && planMove(state, issue, status).kind === 'ask') {
      if (Object.keys(rest).length) dispatch({ type: 'updateIssues', ids: [issue.id], patch: rest })
      moveIssue(issue.id, status)
      return
    }
    if (Object.keys(plan.patch).length) dispatch({ type: 'updateIssues', ids: [issue.id], patch: plan.patch })
  }

  const toggleIn = (list: string[], key: string) => list.includes(key) ? list.filter(k => k !== key) : [...list, key]
  const setQuick = (ids: string[]) => navigate(href({ name: 'project', key: project.key, tab: 'board', sub: board.id, ...(ids.length ? { quick: ids.join(',') } : {}) }, peek), { replace: true })
  const template = columns.map(c => c.collapsed ? '44px' : 'minmax(272px, 1fr)').join(' ')
  const daysLeft = sprint?.endsAt ? Math.ceil((sprint.endsAt - Date.now()) / 86_400_000) : undefined
  /** The first of a column's statuses in the board's own project: where "Create" in that column starts new work. */
  const startIn = (c: Board['columns'][number]) => statusesIn(project, c)[0]
  const isDone = (c: Board['columns'][number]) => { const s = statusesIn(project, c); return s.length > 0 && s.every(x => statusOf(project, x)?.category === 'done') }

  // ── Keyboard: arrows move between cards ─────────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dragging) return                                          // the arrow keys are moving a card, not the focus
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

  const toolbar = (
    <>
      <div className="toolbar">
        {switcher}
        {filters.toolbar}
        <div style={{ flex: 1 }} />
        {sprint && (
          <span className="sprint-meta" title={sprint.goal || undefined}>
            <Timer size={14} />
            <b>{sprint.name}</b>
            {daysLeft !== undefined && <span className={daysLeft < 0 ? 'text-danger' : 'muted'}>{daysLeft < 0 ? `${-daysLeft}d overdue` : `${daysLeft}d left`}</span>}
          </span>
        )}
        {sprint && <button className="btn btn-secondary" disabled={board.canManageSprints === false} title={board.canManageSprints === false ? NO_SPRINTS : undefined} onClick={() => setCompleting(true)}>Complete sprint</button>}
        {board.canManage && (
          <Picker
            value={groupBy}
            title="Swimlanes"
            className={`btn btn-secondary${grouped ? ' active' : ''}`}
            align="right"
            options={(['none', 'assignee', 'epic', 'priority', ...(local ? [] : ['project'] as const), ...(board.swimlanes.queries?.length ? ['queries'] as const : [])] as LaneBy[])
              .map(by => ({ value: by, label: LANE_LABEL[by] }))}
            onChange={by => { change({ swimlanes: { ...board.swimlanes, by } }); saveView({ ...view, lanes: [] }) }}
            trigger={<>Group{grouped ? `: ${LANE_LABEL[groupBy]}` : ''}<ChevronDown size={14} /></>}
          />
        )}
        <Popover title="View settings" className="btn btn-secondary icon-only" trigger={<Settings2 size={16} />}>
          {board.canManage && (
            <>
              <div className="section-label">Fields on cards</div>
              {FIELD_LABELS.map(([f, label]) => (
                <label key={f} className="toggle-row">
                  <span>{label}</span>
                  <Toggle on={fields[f]} onChange={on => change({ cardFields: { ...board.cardFields, [f]: on } })} label={label} />
                </label>
              ))}
            </>
          )}
          {grouped && (
            <>
              <div className="section-label" style={{ marginTop: board.canManage ? 10 : 0 }}>Swimlanes</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => saveView({ ...view, lanes: [] })}>Expand all</button>
                <button className="btn btn-secondary btn-sm" onClick={() => saveView({ ...view, lanes: lanes.map(l => l.key) })}>Collapse all</button>
              </div>
            </>
          )}
          <div className="section-label" style={{ marginTop: board.canManage || grouped ? 10 : 0 }}>Columns</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" disabled={!view.cols.length} onClick={() => saveView({ ...view, cols: [] })}>Expand all</button>
            <button className="btn btn-secondary btn-sm" onClick={() => openProject(project.id, 'settings', 'workflow')}><GitBranch size={13} />Workflow</button>
          </div>
        </Popover>
      </div>
      {board.quickFilters.length > 0 && (
        <div className="quick-filters" role="group" aria-label="Quick filters">
          <span className="muted">Quick filters</span>
          {board.quickFilters.map(f => {
            const on = quick.includes(f.id)
            return (
              <button key={f.id} className={`chip${on ? ' chip-on' : ''}`} aria-pressed={on} title={f.jql}
                onClick={() => setQuick(on ? quick.filter(q => q !== f.id) : [...quick, f.id])}>
                {on && <Check size={13} />}{f.name}
              </button>
            )
          })}
          {quick.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setQuick([])}>Clear</button>}
        </div>
      )}
      {found.status === 'ready' && found.total > found.ids.length && (
        <p className="board-cap" role="status">
          Showing the first {found.ids.length.toLocaleString()} of {plural(found.total, 'work item')}. Narrow the board’s filter or turn on a quick filter to see the rest.
        </p>
      )}
    </>
  )

  if (board.type === 'scrum' && !sprint) {
    return (
      <div className="board-wrap">
        {toolbar}
        <Empty
          icon={<ListChecks size={22} strokeWidth={1.5} />}
          title="No active sprint"
          body="The board shows the work in the active sprint. Plan a sprint in the backlog and start it to see it here."
          action={<button className="btn btn-primary" onClick={() => openProject(project.id, 'backlog', local ? undefined : board.id)}>Go to backlog</button>}
        />
      </div>
    )
  }
  if (!local && found.status === 'error') return <div className="board-wrap">{toolbar}<LoadError error={found.error} onRetry={found.retry} /></div>
  if (!local && found.status === 'loading' && !found.ids.length) return <div className="board-wrap">{toolbar}<Loading rows={4} /></div>
  if (boardItems.length === 0 && !quick.length) {
    return (
      <div className="board-wrap">
        {toolbar}
        <Empty
          icon={<Columns2 size={22} strokeWidth={1.5} />}
          title="Visualize your work with a board"
          body={sprint ? `${sprint.name} has no work items yet. Add some from the backlog, or create one here.`
            : board.kanbanBacklog?.length ? 'Nothing in progress. Work waiting in the Kanban backlog shows here once it is moved to the board’s first column.'
            : board.jql && board.jql !== `project = ${project.key}` ? `No work items match this board’s filter: ${board.jql}`
            : 'Track, organize and prioritize your team’s work. Get started by creating a work item.'}
          action={board.kanbanBacklog?.length
            ? <button className="btn btn-primary" onClick={() => openProject(project.id, 'backlog', local ? undefined : board.id)}>Go to backlog</button>
            : <button className="btn btn-primary" onClick={() => createIssue({ projectId: project.id, sprintId: sprint?.id })}><Plus size={15} />Create work item</button>}
        />
      </div>
    )
  }

  return (
    <div className="board-wrap">
      {toolbar}
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}
        accessibility={{ announcements, screenReaderInstructions: { draggable: BOARD_INSTRUCTIONS } }}>
      <div className="board-scroll" onKeyDown={onKeyDown}>
        <div className="board-grid" style={{ gridTemplateColumns: template }}>
          {columns.map(col => {
            const count = issues.filter(i => colOf(i) === col.id).length
            const over = col.max != null && count > col.max, under = col.min != null && count < col.min
            const limits = [col.min != null && `Min ${col.min}`, col.max != null && `Max ${col.max}`].filter(Boolean).join(' · ')
            const start = startIn(col)
            return (
              <div key={col.id} className={`col-hdr${col.collapsed ? ' collapsed' : ''}${over ? ' over-limit' : under ? ' under-limit' : ''}${dragging && !allowed(col) ? ' disallowed' : ''}`}
                title={over ? `Over the maximum of ${col.max}` : under ? `Under the minimum of ${col.min}` : undefined}>
                {col.collapsed ? (
                  <button className="col-hdr-collapsed" onClick={() => saveView({ ...view, cols: toggleIn(view.cols, col.id) })}
                    title={`Expand ${col.name}`} aria-label={`Expand ${col.name} column`}>
                    <span className="col-count">{count}</span>
                    <span className="col-vertical">{col.name}</span>
                  </button>
                ) : (
                  <>
                    <span className="col-name">{col.name}</span>
                    <span className="col-count">{count}</span>
                    {limits && <span className="col-wip" title="Column limits">{limits}</span>}
                    {isDone(col) && <Check size={14} className="text-success" aria-label="Done column" />}
                    <div style={{ flex: 1 }} />
                    <button className="icon-btn sm" title={`Collapse ${col.name}`} aria-label={`Collapse ${col.name} column`}
                      onClick={() => saveView({ ...view, cols: toggleIn(view.cols, col.id) })}>
                      <ChevronsLeftRight size={13} />
                    </button>
                    {start && (
                      <button className="icon-btn sm" title={`Create in ${col.name}`} aria-label={`Create work item in ${col.name}`}
                        onClick={() => createIssue({ projectId: project.id, status: start, sprintId: sprint?.id })}>
                        <Plus size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}

          {lanes.map(lane => {
            const laneItems = issues.filter(lane.match)
            const laneCollapsed = grouped && view.lanes.includes(lane.key)
            return (
              <div key={lane.key} style={{ display: 'contents' }}>
                {grouped && (
                  <button className="lane-hdr" style={{ gridColumn: '1 / -1' }} aria-expanded={!laneCollapsed}
                    onClick={() => saveView({ ...view, lanes: toggleIn(view.lanes, lane.key) })}>
                    {laneCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {lane.label}
                    <span className="muted">({plural(laneItems.length, 'item')})</span>
                  </button>
                )}
                {!laneCollapsed && columns.map(col => {
                  const cellKey = `${lane.key}|${col.id}`
                  const cards = laneItems.filter(i => colOf(i) === col.id)
                  const start = startIn(col)
                  return (
                    <DroppableCell key={cellKey} id={cellKey} laneKey={lane.key} collapsed={col.collapsed} blocked={!allowed(col)}>
                      {!col.collapsed && cards.slice(0, cardLimit(cellKey)).map(issue => (
                        <BoardCard
                          key={issue.id}
                          issue={issue}
                          project={projectOf(issue)!}
                          fields={cardFields}
                          dragging={dragging?.id === issue.id}
                          stripe={stripeOf(issue)}
                        />
                      ))}
                      {!col.collapsed && cards.length > cardLimit(cellKey) && (
                        <button className="cell-create" onClick={() => setCardLimits(l => ({ ...l, [cellKey]: cardLimit(cellKey) + 100 }))}>
                          <ChevronDown size={14} />Show {Math.min(100, cards.length - cardLimit(cellKey))} more
                        </button>
                      )}
                      {!col.collapsed && start && (
                        <button className="cell-create" onClick={() => createIssue({ projectId: project.id, status: start, sprintId: sprint?.id, ...(lane.patch as object) })}>
                          <Plus size={14} />Create
                        </button>
                      )}
                    </DroppableCell>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && projectOf(dragging) && <CardGhost issue={dragging} project={projectOf(dragging)!} fields={cardFields} />}
      </DragOverlay>
      </DndContext>

      {completing && sprint && (
        <CompleteSprintModal sprint={sprint} project={project} board={board} boardId={local ? undefined : board.id}
          others={state.sprints.filter(s => (s.boardId ? s.boardId === board.id : s.projectId === project.id) && s.state === 'planned')}
          onClose={() => setCompleting(false)} />
      )}
    </div>
  )
}
