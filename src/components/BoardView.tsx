import { useState } from 'react'
import { Plus, Search, Columns2, ListChecks } from 'lucide-react'
import { useStore, type Project, type Issue } from '../data/store'
import { useApp } from '../appContext'
import BoardCard from './BoardCard'
import { plural } from './BacklogView'
import { Avatar, Empty } from './ui'

/** Shared toolbar filter: text + "only my items". */
export function useIssueFilter() {
  const { state } = useStore()
  const [query, setQuery]   = useState('')
  const [mineOnly, setMine] = useState(false)
  const apply = (issues: Issue[]) => {
    const q = query.trim().toLowerCase()
    return issues.filter(i =>
      (!mineOnly || i.assigneeId === state.me?.id) &&
      (!q || i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || i.labels.some(l => l.toLowerCase().includes(q))))
  }
  const toolbar = (
    <>
      <label className="tb-search">
        <Search size={13} strokeWidth={1.5} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter work items" aria-label="Filter work items" />
      </label>
      <button className={`density-btn${mineOnly ? ' active' : ''}`} onClick={() => setMine(v => !v)} aria-pressed={mineOnly}>
        <Avatar user={state.me ?? undefined} size={16} />
        Only my items
      </button>
    </>
  )
  return { apply, toolbar, filtering: !!query.trim() || mineOnly }
}

export default function BoardView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openIssue, createIssue, openProject } = useApp()
  const { apply, toolbar, filtering } = useIssueFilter()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overCol, setOverCol]       = useState<string | null>(null)

  const sprint = project.template === 'scrum'
    ? state.sprints.find(s => s.projectId === project.id && s.state === 'active')
    : undefined

  if (project.template === 'scrum' && !sprint) {
    return (
      <Empty
        icon={<ListChecks size={20} strokeWidth={1.5} />}
        title="No active sprint"
        body="The board shows the work in your active sprint. Plan a sprint in the backlog and start it to see it here."
        action={<button className="btn-primary" onClick={() => openProject(project.id, 'backlog')}>Go to backlog</button>}
      />
    )
  }

  const all = state.issues.filter(i => i.projectId === project.id && (!sprint || i.sprintId === sprint.id))
  const issues = apply(all)

  if (all.length === 0) {
    return (
      <Empty
        icon={<Columns2 size={20} strokeWidth={1.5} />}
        title="Visualize your work with a board"
        body="Track, organize and prioritize your team's work. Get started by creating a work item."
        action={<button className="btn-primary" onClick={() => createIssue({ projectId: project.id, sprintId: sprint?.id })}><Plus size={14} strokeWidth={2} />Create work item</button>}
      />
    )
  }

  const drop = (statusId: string) => {
    if (draggingId) dispatch({ type: 'updateIssue', id: draggingId, patch: { status: statusId } })
    setDraggingId(null)
    setOverCol(null)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <div className="bv-toolbar">
        {toolbar}
        <div style={{ flex: 1 }} />
        <span className="bv-toolbar-count">
          {sprint ? `${sprint.name} · ` : ''}{filtering ? `${issues.length} of ${plural(all.length, 'item')}` : plural(all.length, 'item')}
        </span>
      </div>

      <div className="board-area">
        {project.statuses.map(s => {
          const cards = issues.filter(i => i.status === s.id).sort((a, b) => b.updatedAt - a.updatedAt)
          return (
            <div
              key={s.id}
              className={`board-col${overCol === s.id ? ' drop-target' : ''}`}
              style={{ borderTopColor: s.color }}
              onDragOver={e => { e.preventDefault(); setOverCol(s.id) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null) }}
              onDrop={e => { e.preventDefault(); drop(s.id) }}
            >
              <div className="board-col-hdr">
                <span className="board-col-dot" style={{ background: s.color }} />
                <span className="board-col-label">{s.name}</span>
                <span className="wip-count wip-count-ok">{cards.length}</span>
                <div style={{ flex: 1 }} />
                <button
                  className="col-hdr-btn"
                  title={`Create in ${s.name}`}
                  aria-label={`Create work item in ${s.name}`}
                  onClick={() => createIssue({ projectId: project.id, status: s.id, sprintId: sprint?.id })}
                >
                  <Plus size={13} strokeWidth={2} />
                </button>
              </div>

              <div className="board-col-body">
                {cards.map(issue => (
                  <BoardCard
                    key={issue.id}
                    issue={issue}
                    project={project}
                    onOpen={() => openIssue(issue.id)}
                    dragging={draggingId === issue.id}
                    onDragStart={() => setDraggingId(issue.id)}
                    onDragEnd={() => { setDraggingId(null); setOverCol(null) }}
                  />
                ))}
                <button className="col-create" onClick={() => createIssue({ projectId: project.id, status: s.id, sprintId: sprint?.id })}>
                  <Plus size={13} strokeWidth={1.75} />Create
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
