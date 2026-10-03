import { useState } from 'react'
import { ChevronRight, Maximize2, Minimize2, X, CalendarDays, Tag, Zap, IterationCcw, Hash } from 'lucide-react'
import { useStore, uid, userOf, type NewIssue, type IssueType, type Priority } from '../data/store'
import { useApp } from '../appContext'
import {
  Picker, TypeIcon, PriorityIcon, Avatar, TYPE_META, PRIORITY_META, Toggle,
  statusOptions, priorityOptions, typeOptions, userOptions,
} from './ui'
import { ProjectIcon } from './ProjectView'

export default function CreateIssueModal({ defaults, onClose }: {
  defaults: Partial<NewIssue>
  onClose:  () => void
}) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()

  const [projectId, setProjectId] = useState(defaults.projectId ?? state.projects[0]?.id)
  const project = state.projects.find(p => p.id === projectId)

  const [title, setTitle]             = useState('')
  const [description, setDescription] = useState('')
  const [type, setType]               = useState<IssueType>(defaults.type ?? 'task')
  const [status, setStatus]           = useState(defaults.status ?? project?.statuses[0].id ?? '')
  const [priority, setPriority]       = useState<Priority>(defaults.priority ?? 'medium')
  const [assigneeId, setAssigneeId]   = useState<string | undefined>(defaults.assigneeId)
  const [parentId, setParentId]       = useState<string | undefined>(defaults.parentId)
  const [sprintId, setSprintId]       = useState<string | undefined>(defaults.sprintId)
  const [estimate, setEstimate]       = useState('')
  const [dueDate, setDueDate]         = useState('')
  const [labels, setLabels]           = useState('')
  const [createMore, setCreateMore]   = useState(false)
  const [expanded, setExpanded]       = useState(false)

  if (!project) return null
  const parent = state.issues.find(i => i.id === parentId)
  // Parents: the project's epics, plus the item a sub-item was started from
  const parentOptions = state.issues.filter(i => i.projectId === projectId && (i.type === 'epic' || i.id === defaults.parentId))
  const sprints = state.sprints.filter(s => s.projectId === projectId && s.state !== 'closed')
  const sprint = sprints.find(s => s.id === sprintId)

  const changeProject = (id: string) => {
    setProjectId(id)
    setStatus(state.projects.find(p => p.id === id)!.statuses[0].id)
    setParentId(undefined)
    setSprintId(undefined)
  }

  const submit = () => {
    if (!title.trim()) return
    const id = uid()
    const key = `${project.key}-${project.nextNumber}`
    dispatch({
      type: 'createIssue', id,
      issue: {
        projectId, title: title.trim(), description: description.trim(), type, status, priority, assigneeId,
        dueDate: dueDate || undefined, sprintId, parentId: type === 'epic' ? undefined : parentId,
        estimate: estimate === '' ? undefined : Math.max(0, Number(estimate)),
        labels: labels.split(',').map(l => l.trim()).filter(Boolean),
      },
    })
    toast(`Created ${key}`, { issueId: id })
    if (createMore) { setTitle(''); setDescription('') } else onClose()
  }

  const assignee = userOf(state, assigneeId)
  const statusObj = project.statuses.find(s => s.id === status)

  return (
    <div className="modal-backdrop top" onMouseDown={onClose}>
      <form
        className={`compose${expanded ? ' expanded' : ''}`}
        role="dialog" aria-modal="true" aria-label="Create work item"
        onMouseDown={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); submit() }}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
        }}
      >
        <div className="compose-hdr">
          <Picker value={projectId} search title="Project" className="chip chip-ghost"
            options={state.projects.map(p => ({ value: p.id, label: p.name, icon: <ProjectIcon project={p} size={16} /> }))}
            onChange={changeProject}
            trigger={<><ProjectIcon project={project} size={16} />{project.key}</>} />
          <ChevronRight size={13} className="muted" />
          <span className="compose-hdr-label">{parent ? `New item in ${parent.key}` : 'New work item'}</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="icon-btn" onClick={() => setExpanded(v => !v)} title={expanded ? 'Collapse' : 'Expand'} aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="compose-body">
          <input className="compose-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Work item title" aria-label="Title" autoFocus />
          <textarea className="compose-desc" value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Add a description… Markdown is supported." aria-label="Description" />
        </div>

        <div className="compose-chips">
          <Picker value={type} options={typeOptions(!defaults.parentId)} onChange={setType} title="Type"
            trigger={<><TypeIcon type={type} size={13} />{TYPE_META[type].label}</>} />
          <Picker value={status} options={statusOptions(project)} onChange={setStatus} title="Status"
            trigger={<><span className="status-dot" style={{ background: statusObj?.color }} />{statusObj?.name}</>} />
          <Picker value={priority} options={priorityOptions} onChange={setPriority} title="Priority"
            trigger={<><PriorityIcon priority={priority} />{PRIORITY_META[priority].label}</>} />
          <Picker value={assigneeId} options={userOptions(state.users)} onChange={setAssigneeId} title="Assignee" search
            trigger={<><Avatar user={assignee} size={16} />{assignee?.name ?? 'Assignee'}</>} />
          {type !== 'epic' && parentOptions.length > 0 && (
            <Picker value={parentId} title="Epic or parent" search
              options={[{ value: undefined, label: 'None' }, ...parentOptions.map(i => ({ value: i.id as string | undefined, label: `${i.key} ${i.title}`, icon: <TypeIcon type={i.type} size={12} /> }))]}
              onChange={setParentId}
              trigger={<><Zap size={13} className="muted" />{parent ? parent.key : 'Epic'}</>} />
          )}
          {project.template === 'scrum' && type !== 'epic' && (
            <Picker value={sprintId} title="Sprint"
              options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name, hint: s.state === 'active' ? 'Active' : undefined }))]}
              onChange={setSprintId}
              trigger={<><IterationCcw size={13} className="muted" />{sprint?.name ?? 'Backlog'}</>} />
          )}
          <label className="chip" title="Estimate (story points)">
            <Hash size={13} className="muted" />
            <input type="number" min={0} className="chip-input" style={{ width: 52 }} value={estimate} onChange={e => setEstimate(e.target.value)} placeholder="Points" aria-label="Estimate" />
          </label>
          <label className="chip" title="Due date">
            <CalendarDays size={13} className="muted" />
            <input type="date" className="chip-input" value={dueDate} onChange={e => setDueDate(e.target.value)} aria-label="Due date" />
          </label>
          <label className="chip" title="Labels, separated by commas">
            <Tag size={13} className="muted" />
            <input className="chip-input" value={labels} onChange={e => setLabels(e.target.value)} placeholder="Labels" aria-label="Labels" />
          </label>
        </div>

        <div className="compose-ftr">
          <label className="inline-toggle">
            <Toggle on={createMore} onChange={setCreateMore} label="Create more" />
            Create more
          </label>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim()} title="Create (⌘↵)">Create</button>
        </div>
      </form>
    </div>
  )
}
