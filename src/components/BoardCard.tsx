import { MoreHorizontal, CalendarDays, Ban, UserCheck, Link2, Trash2, ArrowRight, Eye } from 'lucide-react'
import { useStore, userOf, blockersOf, transitionsFrom, type Issue, type Project, type CardField } from '../data/store'
import { useApp } from '../appContext'
import { href } from '../router'
import { TypeIcon, PriorityIcon, Avatar, Menu, formatDate, isOverdue, type MenuItem } from './ui'

/** "Move to Done", or "Approve → Done" when the transition has its own name. */
export function transitionLabel(project: Project, t: { name: string; to: string }) {
  const target = project.statuses.find(s => s.id === t.to)?.name ?? ''
  return t.name === target ? `Move to ${target}` : `${t.name} → ${target}`
}

export default function BoardCard({ issue, project, fields, dragging, onDragStart, onDragEnd }: {
  issue:        Issue
  project:      Project
  fields:       Record<CardField, boolean>
  dragging?:    boolean
  onDragStart?: () => void
  onDragEnd?:   () => void
}) {
  const { state, dispatch } = useStore()
  const { openIssue, toast } = useApp()
  const status   = project.statuses.find(s => s.id === issue.status)
  const done     = status?.category === 'done'
  const epic     = issue.parentId ? state.issues.find(i => i.id === issue.parentId && i.type === 'epic') : undefined
  const subItems = state.issues.filter(i => i.parentId === issue.id)
  const subDone  = subItems.filter(i => project.statuses.find(s => s.id === i.status)?.category === 'done').length
  const blocked  = blockersOf(state, issue).length > 0
  const assignee = userOf(state, issue.assigneeId)

  const menu: MenuItem[] = [
    { label: 'Open', icon: <Eye size={14} />, onClick: () => openIssue(issue.id) },
    ...transitionsFrom(project, issue.status).map((t, i) => ({
      label: transitionLabel(project, t),
      icon: <ArrowRight size={14} />, divider: i === 0,
      onClick: () => dispatch({ type: 'updateIssues', ids: [issue.id], patch: { status: t.to } }),
    })),
    ...(issue.assigneeId !== state.me?.id ? [{ label: 'Assign to me', icon: <UserCheck size={14} />, divider: true,
      onClick: () => dispatch({ type: 'updateIssues', ids: [issue.id], patch: { assigneeId: state.me?.id } }) }] : []),
    { label: 'Copy link', icon: <Link2 size={14} />, divider: issue.assigneeId === state.me?.id,
      onClick: () => { navigator.clipboard?.writeText(location.origin + href({ name: 'issue', key: issue.key })); toast('Link copied') } },
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, divider: true,
      onClick: () => { dispatch({ type: 'deleteIssues', ids: [issue.id] }); toast(`Deleted ${issue.key}`, { undo: 'deleteIssues' }) } },
  ]

  return (
    <div
      className={`card${dragging ? ' dragging' : ''}${blocked && !done ? ' blocked' : ''}`}
      draggable
      data-card={issue.id}
      onDragStart={e => { e.dataTransfer.setData('text/plain', issue.id); e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
      onDragEnd={onDragEnd}
      onClick={() => openIssue(issue.id)}
      onKeyDown={e => { if (e.key === 'Enter') openIssue(issue.id) }}
      tabIndex={0}
      aria-label={`${issue.key}: ${issue.title}. ${status?.name}${assignee ? `, assigned to ${assignee.name}` : ''}`}
    >
      <div className="card-title">{issue.title}</div>

      {(blocked && !done) || (fields.epic && epic) || (fields.labels && issue.labels.length > 0) ? (
        <div className="card-tags">
          {blocked && !done && <span className="tag tag-danger"><Ban size={11} />Blocked</span>}
          {fields.epic && epic && <span className="tag tag-epic" title={`Epic: ${epic.title}`}>{epic.title}</span>}
          {fields.labels && issue.labels.slice(0, 3).map(l => <span key={l} className="tag">{l}</span>)}
        </div>
      ) : null}

      {fields.due && issue.dueDate && (
        <div className={`due${isOverdue(issue.dueDate) && !done ? ' overdue' : ''}`}>
          <CalendarDays size={12} />{formatDate(issue.dueDate)}
        </div>
      )}

      <div className="card-foot">
        {fields.type && <TypeIcon type={issue.type} size={14} />}
        {fields.key && <span className={`card-key${done ? ' done' : ''}`}>{issue.key}</span>}
        {fields.subitems && subItems.length > 0 && (
          <span className="card-sub" title={`${subDone} of ${subItems.length} sub-items done`}>
            <span className="mini-bar"><span style={{ width: `${(subDone / subItems.length) * 100}%` }} /></span>{subDone}/{subItems.length}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {fields.estimate && issue.estimate != null && <span className="points" title="Story points">{issue.estimate}</span>}
        {fields.priority && issue.priority !== 'none' && <PriorityIcon priority={issue.priority} />}
        <span className="card-menu"><Menu title={`Actions for ${issue.key}`} className="icon-btn sm" trigger={<MoreHorizontal size={15} />} items={menu} /></span>
        {fields.assignee && <Avatar user={assignee} size={24} />}
      </div>
    </div>
  )
}
