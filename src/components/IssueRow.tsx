import { CalendarDays, Ban } from 'lucide-react'
import { useStore, userOf, blockersOf, timeAgo, type Issue, type Project } from '../data/store'
import { useApp } from '../appContext'
import { Picker, TypeIcon, PriorityIcon, Avatar, Checkbox, statusOptions, priorityOptions, userOptions, formatDate, isOverdue } from './ui'
import { ProjectIcon } from './ProjectView'

/** A dense, editable work item row for backlogs, sub-items and personal lists. */
export default function IssueRow({ issue, project, showProject, trailing, selected, onSelect, draggable, onDragStart, onDragEnd, showUpdated = true }: {
  issue:        Issue
  project:      Project
  showProject?: boolean
  trailing?:    React.ReactNode
  selected?:    boolean
  onSelect?:    (on: boolean, shift: boolean) => void
  draggable?:   boolean
  onDragStart?: () => void
  onDragEnd?:   () => void
  showUpdated?: boolean
}) {
  const { state, dispatch } = useStore()
  const { openIssue } = useApp()
  const status = project.statuses.find(s => s.id === issue.status)
  const done = status?.category === 'done'
  const blocked = !done && blockersOf(state, issue).length > 0
  const parent = issue.parentId ? state.issues.find(i => i.id === issue.parentId) : undefined
  const set = (patch: Partial<Issue>) => dispatch({ type: 'updateIssues', ids: [issue.id], patch })

  return (
    <div
      className={`row${selected ? ' selected' : ''}`}
      data-row={issue.id}
      role="button"
      tabIndex={0}
      onClick={e => { if (onSelect && (e.shiftKey || e.metaKey)) onSelect(!selected, e.shiftKey); else openIssue(issue.id) }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') openIssue(issue.id)
        if (e.key === 'x' && onSelect) { e.preventDefault(); onSelect(!selected, e.shiftKey) }
      }}
      draggable={draggable}
      onDragStart={e => { e.dataTransfer.setData('text/plain', issue.id); e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
      onDragEnd={onDragEnd}
      aria-label={`${issue.key} ${issue.title}`}
    >
      {onSelect && (
        <span className="row-check" onClick={e => e.stopPropagation()}>
          <Checkbox checked={!!selected} label={`Select ${issue.key}`} onChange={(on, e) => onSelect(on, e.shiftKey)} />
        </span>
      )}
      <TypeIcon type={issue.type} size={14} />
      {showProject && <ProjectIcon project={project} size={16} />}
      <span className={`row-key mono${done ? ' done' : ''}`}>{issue.key}</span>
      <span className="row-title">
        {blocked && <Ban size={13} className="text-danger" aria-label="Blocked" />}
        <span className={done ? 'done-text' : ''}>{issue.title}</span>
        {parent && <span className="muted row-parent">{parent.title}</span>}
      </span>
      {issue.labels.slice(0, 2).map(l => <span key={l} className="tag hide-sm">{l}</span>)}
      {issue.dueDate && (
        <span className={`due hide-sm${isOverdue(issue.dueDate) && !done ? ' overdue' : ''}`}><CalendarDays size={12} />{formatDate(issue.dueDate)}</span>
      )}
      {issue.estimate != null && <span className="points">{issue.estimate}</span>}
      <Picker value={issue.status} options={statusOptions(project, issue.status)} onChange={s => set({ status: s })}
        className={`status-cell sm cat-${status?.category}`} title="Change status" trigger={status?.name} />
      <Picker value={issue.priority} options={priorityOptions} onChange={priority => set({ priority })}
        className="icon-btn sm" title="Change priority" trigger={<PriorityIcon priority={issue.priority} />} />
      {trailing}
      {showUpdated && <span className="row-updated hide-sm">{timeAgo(issue.updatedAt)}</span>}
      <Picker value={issue.assigneeId} search options={userOptions(state.users)} onChange={assigneeId => set({ assigneeId })}
        className="icon-btn" align="right" title="Change assignee" trigger={<Avatar user={userOf(state, issue.assigneeId)} size={24} />} />
    </div>
  )
}
