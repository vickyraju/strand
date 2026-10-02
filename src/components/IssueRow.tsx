import { CalendarDays } from 'lucide-react'
import { useStore, userOf, timeAgo, type Issue, type Project } from '../data/store'
import { useApp } from '../appContext'
import { Picker, TypeIcon, PriorityIcon, Avatar, statusOptions, priorityOptions, userOptions } from './ui'
import { ProjectIcon } from './ProjectView'
import { formatDue, isOverdue } from './BoardCard'

/** One work item as a dense, editable list row. Used by List, Backlog, Your work and Search. */
export default function IssueRow({ issue, project, showProject, trailing, draggable, onDragStart }: {
  issue:        Issue
  project:      Project
  showProject?: boolean
  trailing?:    React.ReactNode
  draggable?:   boolean
  onDragStart?: () => void
}) {
  const { state, dispatch } = useStore()
  const { openIssue } = useApp()
  const status = project.statuses.find(s => s.id === issue.status)
  const parent = issue.parentId ? state.issues.find(i => i.id === issue.parentId) : undefined
  const set = (patch: Partial<Issue>) => dispatch({ type: 'updateIssue', id: issue.id, patch })

  return (
    <div
      className="ir-row"
      onClick={() => openIssue(issue.id)}
      onKeyDown={e => e.key === 'Enter' && e.target === e.currentTarget && openIssue(issue.id)}
      tabIndex={0}
      draggable={draggable}
      onDragStart={e => { e.dataTransfer.setData('text/plain', issue.id); onDragStart?.() }}
    >
      <Picker value={issue.priority} options={priorityOptions} onChange={priority => set({ priority })}
        className="ir-icon-btn" title="Priority" trigger={<PriorityIcon priority={issue.priority} />} />
      {showProject && <ProjectIcon project={project} size={14} />}
      <span className="ir-key">{issue.key}</span>
      <Picker value={issue.status} options={statusOptions(project.statuses)} onChange={s => set({ status: s })}
        className="ir-icon-btn" title={status?.name}
        trigger={<span className="status-dot" style={{ background: status?.color, width: 9, height: 9 }} />} />
      <TypeIcon type={issue.type} size={13} />
      <span className={`ir-title${status?.done ? ' done' : ''}`}>
        {issue.title}
        {parent && <span className="ir-parent"> › {parent.title}</span>}
      </span>
      {issue.labels.slice(0, 2).map(l => <span key={l} className="card-label label-chip">{l}</span>)}
      {issue.dueDate && (
        <span className={`bc-due${isOverdue(issue.dueDate) && !status?.done ? ' overdue' : ''}`} style={{ margin: 0 }}>
          <CalendarDays size={11} strokeWidth={1.75} />{formatDue(issue.dueDate)}
        </span>
      )}
      {issue.estimate != null && <span className="bc-points">{issue.estimate}</span>}
      {trailing}
      <span className="ir-updated">{timeAgo(issue.updatedAt)}</span>
      <Picker value={issue.assigneeId} options={userOptions(state.users)} onChange={assigneeId => set({ assigneeId })}
        className="ir-icon-btn" align="right" title="Assignee"
        trigger={<Avatar user={userOf(state, issue.assigneeId)} size={20} />} />
    </div>
  )
}
