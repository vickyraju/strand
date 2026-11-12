// A Kanban board's backlog (spec 0406), as Jira's: two ranked sections, Backlog (the Kanban backlog's statuses) and the
// board's first column ("Selected for Development"). Dragging between them moves the items to the other section's status;
// dragging within one ranks. Several selected items move together, or not at all.
import { useState } from 'react'
import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core'
import { ArrowDownToLine, ArrowRightLeft, ArrowUpToLine, Plus } from 'lucide-react'
import { cardColor, moveContext, useStore, indexOf, type Board, type Issue, type Project } from '../data/store'
import { priorityOf } from '../data/lists'
import { canEdit } from '../data/access'
import { useBoardItems } from '../api/boards'
import { useEnsureProjects } from '../api/useEnsureProjects'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import IssueRow from './IssueRow'
import BulkBar from './BulkBar'
import { planMove } from './TransitionDialog'
import { planDrop, statusesIn, useBoardSensors } from './boardDnd'
import { KB_BACKLOG, KB_SELECTED, backlogAnnouncements, backlogCollision, backlogKeyboard, boxTarget, endTarget, planBacklogDrop, planSectionMove, rowTarget } from './backlogDnd'
import { Menu, plural, typeMeta } from './ui'
import { useDurations } from '../api/settings-public'
import BacklogPanels, { usePanels } from './BacklogPanels'

export default function KanbanBacklog({ project, board, switcher }: { project: Project; board: Board; switcher?: React.ReactNode }) {
  const { state, dispatch } = useStore()
  const { createIssue, moveIssue, toast } = useApp()
  const found = useBoardItems(board, { quick: [], scope: 'backlog' })
  const [loadedAt] = useState(() => Date.now())
  const [dragging, setDragging] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const { byId } = indexOf(state)
  const onBoard = new Set(found.ids)
  const items = [...found.ids.map(id => byId.get(id)).filter((i): i is Issue => !!i),
    ...state.issues.filter(i => i.createdAt > loadedAt && i.projectId === board.projectId && !onBoard.has(i.id))].filter(i => i.type !== 'epic')
  useEnsureProjects([...new Set(items.map(i => i.key.split('-')[0]!))])
  const projectOf = (i: Issue) => state.projects.find(p => p.id === i.projectId) ?? project
  const filters = useFilters([], project)

  const sections: Record<string, { name: string; statusIds: string[] }> = { [KB_BACKLOG]: { name: 'Backlog', statusIds: board.kanbanBacklog ?? [] }, [KB_SELECTED]: board.columns[0]! }
  const inSection = (key: string, i: Issue) => statusesIn(projectOf(i), sections[key]!).includes(i.status)
  const panels = usePanels()
  const { format } = useDurations()
  const sorted = panels.apply(filters.apply(items)).sort((a, b) => a.rank - b.rank)
  const lists: Record<string, Issue[]> = { [KB_BACKLOG]: sorted.filter(i => inSection(KB_BACKLOG, i)), [KB_SELECTED]: sorted.filter(i => inSection(KB_SELECTED, i)) }
  const ordered = [...lists[KB_BACKLOG]!, ...lists[KB_SELECTED]!]
  useNavList(ordered.map(i => i.id))
  const sectionOf = (id: string) => (lists[KB_SELECTED]!.some(i => i.id === id) ? KB_SELECTED : KB_BACKLOG)

  const select = (id: string, on: boolean, shift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && anchor) {
        const ids = ordered.map(i => i.id)
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
        ids.slice(a, b + 1).forEach(x => (on ? next.add(x) : next.delete(x)))
      } else if (on) next.add(id); else next.delete(id)
      return next
    })
    setAnchor(id)
  }
  const idsFor = (id: string | null) => (!id ? [] : selected.has(id) ? ordered.filter(i => selected.has(i.id)).map(i => i.id) : [id])
  const carried = new Set(idsFor(dragging))

  /** Into `to`: change the status where needed (R4), then rank before `beforeId` or at the end (R5). */
  const moveInto = (ids: string[], to: string, beforeId?: string) => {
    const moving = ids.map(id => byId.get(id)!).filter(Boolean)
    const plan = planSectionMove(moving.filter(i => sectionOf(i.id) !== to),
      i => planDrop({ project: projectOf(i), issue: i, column: sections[to]!, moveLane: false, ctx: moveContext(state, i) }))
    if ('blocked' in plan) { toast(plan.blocked, { tone: 'warn' }); return }
    for (const i of moving) dispatch({ type: 'moveIssue', id: i.id, container: null, ...(beforeId ? { beforeId } : {}) })
    for (const m of plan.moves) {
      const i = byId.get(m.id)!
      if (planMove(state, i, m.status).kind === 'ask') moveIssue(i.id, m.status)                     // its transition screen
      else dispatch({ type: 'updateIssues', ids: [i.id], patch: { status: m.status } })
    }
  }
  const sensors = useBoardSensors(backlogKeyboard, canEdit(project))
  const listName = (key: string) => (key === KB_SELECTED ? board.columns[0]!.name : 'Backlog')
  const targetList = (over: string) => (over.startsWith('row:') ? sectionOf(over.slice(4)) : over.slice(over.indexOf(':') + 1))
  const litList = overId && !overId.startsWith('row:') ? targetList(overId) : null
  const announcements = backlogAnnouncements({
    key: id => items.find(i => i.id === id)?.key ?? 'The work item',
    count: () => carried.size,
    listOf: id => listName(sectionOf(String(id))),
    place: over => (String(over).startsWith('row:') ? `before ${items.find(i => i.id === String(over).slice(4))?.key ?? 'a work item'} in ${listName(targetList(String(over)))}` : `the end of ${listName(targetList(String(over)))}`),
  })
  const onDragStart = ({ active }: DragStartEvent) => setDragging(String(active.id))
  const onDragOver = ({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null)
  const onDragEnd = ({ over }: DragEndEvent) => {
    const ids = idsFor(dragging)
    setDragging(null); setOverId(null)
    if (!over) return
    if (panels.drop(ids, String(over.id))) return                                          // onto an epic or a version (spec 0407)
    const moves = planBacklogDrop({ dragged: ids, overId: String(over.id), containerOf: sectionOf })
    if (moves.length) moveInto(moves.map(m => m.id), targetList(String(over.id)), moves[0]!.beforeId)
  }
  const rank = (i: Issue, list: Issue[], where: 'top' | 'bottom') => moveInto([i.id], sectionOf(i.id), where === 'top' ? list.find(x => x.id !== i.id)?.id : undefined)

  const section = (key: string) => {
    const list = lists[key]!
    return (
      <Section key={key} id={key} highlight={litList === key} title={listName(key)} count={list.length}
        onCreate={key === KB_BACKLOG ? () => createIssue({ projectId: board.projectId, status: statusesIn(project, sections[KB_BACKLOG]!)[0] }) : undefined}>
        {list.length === 0 && <div className="drop-hint">{key === KB_BACKLOG ? 'Nothing waiting. New work in the Kanban backlog’s statuses shows here.' : `Drag work here to move it to ${listName(key)}: it shows on the board.`}</div>}
        {list.map(i => (
          <Row key={i.id} issue={i} project={projectOf(i)} listId={key} last={list.at(-1)?.id === i.id}
            stripe={cardColor(board.cardColors, i, { typeColor: typeMeta(i.type, projectOf(i)).color, priorityColor: priorityOf(i.priority).color, match: found.colors.get(i.id) })}
            selected={selected.has(i.id)} onSelect={(on, shift) => select(i.id, on, shift)} dragging={carried.has(i.id)}
            lineBefore={overId === rowTarget(i.id) && !carried.has(i.id)} lineAtEnd={overId === endTarget(key)}
            trailing={<Menu title={`Move ${i.key}`} className="icon-btn sm" trigger={<ArrowRightLeft size={14} />} items={[
              { label: 'Top of backlog', icon: <ArrowUpToLine size={14} />, onClick: () => rank(i, list, 'top') },
              { label: 'Bottom of backlog', icon: <ArrowDownToLine size={14} />, onClick: () => rank(i, list, 'bottom') },
              { label: `Move to ${listName(key === KB_BACKLOG ? KB_SELECTED : KB_BACKLOG)}`, icon: <ArrowRightLeft size={14} />, divider: true,
                onClick: () => moveInto([i.id], key === KB_BACKLOG ? KB_SELECTED : KB_BACKLOG) },
            ]} />} />
        ))}
      </Section>
    )
  }

  return (
    <div className="page-col">
      <div className="toolbar">{switcher}{filters.toolbar}<div style={{ flex: 1 }} /><span className="muted sm">{plural(ordered.length, 'item')}</span></div>
      <DndContext sensors={sensors} collisionDetection={backlogCollision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
        onDragCancel={() => { setDragging(null); setOverId(null) }} accessibility={{ announcements }}>
        <div className="backlog-with-panels">
          <BacklogPanels board={board} project={project} open={panels.open} setOpen={panels.setOpen} epic={panels.epic} setEpic={panels.setEpic}
            version={panels.version} setVersion={panels.setVersion} refresh={panels.refresh} format={format} />
          <div className="backlog-scroll">{section(KB_SELECTED)}{section(KB_BACKLOG)}</div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (() => { const i = items.find(x => x.id === dragging); return i && <IssueRow issue={i} project={projectOf(i)} ghost ghostCount={carried.size} /> })()}
        </DragOverlay>
      </DndContext>
      <BulkBar ids={[...selected].filter(id => ordered.some(i => i.id === id))} onClear={() => setSelected(new Set())} />
    </div>
  )
}

function Section({ id, title, count, highlight, onCreate, children }: { id: string; title: string; count: number; highlight: boolean; onCreate?: () => void; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: boxTarget(id) })
  return (
    <div ref={setNodeRef} className={`sprint-box${highlight ? ' drop-over' : ''}`} aria-label={title}>
      <div className="sprint-hdr"><span className="sprint-name">{title}</span><span className="muted">{plural(count, 'item')}</span></div>
      {children}
      {onCreate && <button className="cell-create" onClick={onCreate}><Plus size={14} />Create</button>}
    </div>
  )
}

function Row({ issue, project, listId, last, stripe, selected, onSelect, dragging, lineBefore, lineAtEnd, trailing }: {
  issue: Issue; project: Project; listId: string; last: boolean; stripe?: string; selected: boolean; onSelect: (on: boolean, shift: boolean) => void
  dragging: boolean; lineBefore: boolean; lineAtEnd: boolean; trailing: React.ReactNode
}) {
  const drag = useDraggable({ id: issue.id })
  const drop = useDroppable({ id: rowTarget(issue.id) })
  const end = useDroppable({ id: endTarget(listId), disabled: !last })
  return (
    <div ref={drop.setNodeRef} className={`rank-slot${lineBefore ? ' drop-before' : ''}`}>
      <IssueRow stripe={stripe} issue={issue} project={project} selected={selected} onSelect={onSelect} drag={drag} dragging={dragging} trailing={trailing} />
      {last && <div ref={end.setNodeRef} className={`rank-end${lineAtEnd ? ' drop-line' : ''}`} aria-hidden="true" />}
    </div>
  )
}
