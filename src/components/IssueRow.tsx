import type { useDraggable } from '@dnd-kit/core'
import { CalendarDays, Ban } from 'lucide-react'
import { useStore, userOf, blockersOf, indexOf, timeAgo, moveContext, type Issue, type Project } from '../data/store'
import { useApp } from '../appContext'
import { Picker, TypeIcon, PriorityIcon, Avatar, Checkbox, statusOptions, priorityOptions, formatDate, isOverdue } from './ui'
import { UserPicker } from './UserPicker'
import { ProjectIcon } from './ProjectView'

export interface IssueRowProps {
  issue:        Issue
  project:      Project
  showProject?: boolean
  trailing?:    React.ReactNode
  selected?:    boolean
  onSelect?:    (on: boolean, shift: boolean) => void
  showUpdated?: boolean
  /** Makes the row draggable (the backlog passes dnd-kit's `useDraggable` result). The row's title button is what the keyboard picks up. */
  drag?:        ReturnType<typeof useDraggable>
  /** This is the row being dragged (its place in the list shows it faded). */
  dragging?:    boolean
  /** The copy that follows the pointer while dragging: looks like the row, does nothing. `ghostCount` > 1 shows how many items travel together. */
  ghost?:       boolean
  ghostCount?:  number
}

/** A dense, editable work item row for backlogs, sub-items and personal lists. */
export default function IssueRow({ issue, project, showProject, trailing, selected, onSelect, showUpdated = true, drag, dragging, ghost, ghostCount }: IssueRowProps) {
  const { state, dispatch } = useStore()
  const { openIssue, moveIssue } = useApp()
  const status = project.statuses.find(s => s.id === issue.status)
  const done = status?.category === 'done'
  const blocked = !done && blockersOf(state, issue).length > 0
  const parent = issue.parentId ? indexOf(state).byId.get(issue.parentId) : undefined
  const set = (patch: Partial<Issue>) => dispatch({ type: 'updateIssues', ids: [issue.id], patch })

  return (
    <div
      ref={drag?.setNodeRef} {...drag?.listeners}
      className={`row${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${ghost ? ' ghost' : ''}`}
      onClick={ghost ? undefined : e => { if (onSelect && (e.shiftKey || e.metaKey)) onSelect(!selected, e.shiftKey); else openIssue(issue.id) }}
      aria-hidden={ghost || undefined}
    >
      {ghost && ghostCount !== undefined && ghostCount > 1 && <span className="ghost-count" aria-hidden="true">{ghostCount}</span>}
      {onSelect && (
        <span className="row-check" onClick={e => e.stopPropagation()}>
          <Checkbox checked={!!selected} label={`Select ${issue.key}`} onChange={(on, e) => onSelect(on, e.shiftKey)} />
        </span>
      )}
      <TypeIcon type={issue.type} size={14} />
      {showProject && <ProjectIcon project={project} size={16} />}
      <span className={`row-key mono${done ? ' done' : ''}`}>{issue.key}</span>
      {/* The row's one focusable target: opens the item; X selects it */}
      <button type="button" ref={drag?.setActivatorNodeRef} {...drag?.attributes} className="row-title" data-row={issue.id} tabIndex={ghost ? -1 : 0}
        onClick={e => { if (onSelect && (e.shiftKey || e.metaKey)) return; e.stopPropagation(); openIssue(issue.id) }}
        onKeyDown={e => { if (e.key === 'x' && onSelect) { e.preventDefault(); onSelect(!selected, e.shiftKey) } }}>
        {blocked && <Ban size={13} className="text-danger" aria-label="Blocked" role="img" />}
        <span className={done ? 'done-text' : ''}>{issue.title}</span>
        {parent && <span className="muted row-parent">{parent.title}</span>}
      </button>
      {issue.labels.slice(0, 2).map(l => <span key={l} className="tag hide-sm">{l}</span>)}
      {issue.dueDate && (
        <span className={`due hide-sm${isOverdue(issue.dueDate) && !done ? ' overdue' : ''}`}><CalendarDays size={12} />{formatDate(issue.dueDate)}</span>
      )}
      {issue.estimate != null && <span className="points">{issue.estimate}</span>}
      <Picker value={issue.status} options={statusOptions(project, issue.status, moveContext(state, issue))} onChange={s => moveIssue(issue.id, s)}
        className={`status-cell sm cat-${status?.category}`} title="Change status" trigger={status?.name} />
      <Picker value={issue.priority} options={priorityOptions} onChange={priority => set({ priority })}
        className="icon-btn sm" title="Change priority" trigger={<PriorityIcon priority={issue.priority} />} />
      {trailing}
      {showUpdated && <span className="row-updated hide-sm">{timeAgo(issue.updatedAt)}</span>}
      <UserPicker value={issue.assigneeId} onChange={assigneeId => set({ assigneeId })} projectId={issue.projectId}
        className="icon-btn" align="right" title="Change assignee" trigger={<Avatar user={userOf(state, issue.assigneeId)} size={24} />} />
    </div>
  )
}
