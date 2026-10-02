import { MoreHorizontal, CalendarDays } from 'lucide-react'
import { useStore, userOf, type Issue, type Project } from '../data/store'
import { Picker, TypeIcon, PriorityIcon, Avatar, statusOptions } from './ui'

export function formatDue(date: string) {
  return new Date(date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
export const isOverdue = (date?: string) => !!date && new Date(date + 'T23:59') < new Date()

export default function BoardCard({ issue, project, onOpen, dragging, onDragStart, onDragEnd }: {
  issue:        Issue
  project:      Project
  onOpen:       () => void
  dragging?:    boolean
  onDragStart?: () => void
  onDragEnd?:   () => void
}) {
  const { state, dispatch } = useStore()
  const subItems = state.issues.filter(i => i.parentId === issue.id)
  const subDone  = subItems.filter(i => project.statuses.find(s => s.id === i.status)?.done).length
  const done = !!project.statuses.find(s => s.id === issue.status)?.done

  return (
    <div
      className={`board-card${dragging ? ' ghost' : ''}`}
      draggable
      onDragStart={e => { e.dataTransfer.setData('text/plain', issue.id); e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={e => e.key === 'Enter' && onOpen()}
      tabIndex={0}
      aria-label={`${issue.key} ${issue.title}`}
    >
      <div className="bc-title" style={done ? { color: '#78716C' } : undefined}>{issue.title}</div>

      {issue.labels.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {issue.labels.slice(0, 3).map(l => <span key={l} className="card-label label-chip">{l}</span>)}
        </div>
      )}

      {issue.dueDate && (
        <div className={`bc-due${isOverdue(issue.dueDate) && !done ? ' overdue' : ''}`}>
          <CalendarDays size={11} strokeWidth={1.75} />{formatDue(issue.dueDate)}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <TypeIcon type={issue.type} size={13} />
        <span className="bc-key" style={done ? { textDecoration: 'line-through' } : undefined}>{issue.key}</span>
        {subItems.length > 0 && <span className="bc-subtasks">{subDone}/{subItems.length}</span>}
        <div style={{ flex: 1 }} />
        {issue.estimate != null && <span className="bc-points" title="Estimate">{issue.estimate}</span>}
        <PriorityIcon priority={issue.priority} />
        <Picker
          value={issue.status}
          options={statusOptions(project.statuses)}
          onChange={status => dispatch({ type: 'updateIssue', id: issue.id, patch: { status } })}
          className="bc-menu-btn"
          align="right"
          title={`Move ${issue.key}`}
          trigger={<MoreHorizontal size={14} strokeWidth={1.5} />}
        />
        <Avatar user={userOf(state, issue.assigneeId)} size={20} />
      </div>
    </div>
  )
}
