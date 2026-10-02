import { useState } from 'react'
import { ChevronRight, Maximize2, Minimize2, X, CalendarDays, Tag } from 'lucide-react'
import { useStore, uid, userOf, type NewIssue, type IssueType, type Priority } from '../data/store'
import { useApp } from '../appContext'
import {
  Picker, TypeIcon, PriorityIcon, Avatar, TYPE_META, PRIORITY_META,
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
  const [priority, setPriority]       = useState<Priority>(defaults.priority ?? 'none')
  const [assigneeId, setAssigneeId]   = useState<string | undefined>(defaults.assigneeId)
  const [dueDate, setDueDate]         = useState('')
  const [labels, setLabels]           = useState('')
  const [createMore, setCreateMore]   = useState(false)
  const [expanded, setExpanded]       = useState(false)

  if (!project) return null
  const parent = state.issues.find(i => i.id === defaults.parentId)
  const sprintId = defaults.sprintId && state.sprints.some(s => s.id === defaults.sprintId && s.projectId === projectId)
    ? defaults.sprintId : undefined

  const changeProject = (id: string) => {
    setProjectId(id)
    setStatus(state.projects.find(p => p.id === id)!.statuses[0].id)
  }

  const submit = () => {
    if (!title.trim()) return
    const id = uid()
    const key = `${project.key}-${project.nextNumber}`
    dispatch({
      type: 'createIssue', id,
      issue: {
        projectId, title: title.trim(), description: description.trim(), type, status, priority, assigneeId,
        dueDate: dueDate || undefined, sprintId, parentId: parent?.id,
        labels: labels.split(',').map(l => l.trim()).filter(Boolean),
      },
    })
    toast(`Created ${key}`, id)
    if (createMore) {
      setTitle('')
      setDescription('')
    } else {
      onClose()
    }
  }

  const assignee = userOf(state, assigneeId)
  const statusObj = project.statuses.find(s => s.id === status)

  return (
    <div className="modal-backdrop ci-backdrop" onMouseDown={onClose}>
      <form
        className={`ci-modal${expanded ? ' expanded' : ''}`}
        onMouseDown={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); submit() }}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
        }}
        aria-label="Create work item"
      >
        <div className="ci-hdr">
          <Picker
            value={projectId}
            options={state.projects.map(p => ({ value: p.id, label: p.name, icon: <ProjectIcon project={p} size={16} /> }))}
            onChange={changeProject}
            className="chip chip-ghost"
            title="Project"
            trigger={<><ProjectIcon project={project} size={16} />{project.key}</>}
          />
          <ChevronRight size={13} strokeWidth={1.5} color="#A8A29E" />
          <span className="ci-hdr-label">{parent ? `New sub-item of ${parent.key}` : 'New work item'}</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="dhdr-btn" onClick={() => setExpanded(v => !v)} title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <Minimize2 size={14} strokeWidth={1.5} /> : <Maximize2 size={14} strokeWidth={1.5} />}
          </button>
          <button type="button" className="dhdr-btn" onClick={onClose} title="Close (Esc)"><X size={15} strokeWidth={1.5} /></button>
        </div>

        <div className="ci-body">
          <input
            className="ci-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Work item title"
            aria-label="Title"
            autoFocus
          />
          <textarea
            className="ci-desc"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Add description…"
            aria-label="Description"
          />
        </div>

        <div className="ci-chips">
          <Picker value={type} options={typeOptions} onChange={setType} title="Type"
            trigger={<><TypeIcon type={type} size={13} />{TYPE_META[type].label}</>} />
          <Picker value={status} options={statusOptions(project.statuses)} onChange={setStatus} title="Status"
            trigger={<><span className="status-dot" style={{ background: statusObj?.color }} />{statusObj?.name}</>} />
          <Picker value={priority} options={priorityOptions} onChange={setPriority} title="Priority"
            trigger={<><PriorityIcon priority={priority} />{priority === 'none' ? 'Priority' : PRIORITY_META[priority].label}</>} />
          <Picker value={assigneeId} options={userOptions(state.users)} onChange={setAssigneeId} title="Assignee"
            trigger={<><Avatar user={assignee} size={16} />{assignee?.name ?? 'Assignee'}</>} />
          <label className="chip" title="Due date">
            <CalendarDays size={13} strokeWidth={1.5} />
            <input type="date" className="chip-date" value={dueDate} onChange={e => setDueDate(e.target.value)} aria-label="Due date" />
          </label>
          <label className="chip" title="Labels, separated by commas">
            <Tag size={13} strokeWidth={1.5} />
            <input className="chip-input" value={labels} onChange={e => setLabels(e.target.value)} placeholder="Labels" aria-label="Labels" />
          </label>
        </div>

        <div className="ci-ftr">
          <span className="ci-hint">{sprintId ? `Adds to ${state.sprints.find(s => s.id === sprintId)?.name}` : ''}</span>
          <div style={{ flex: 1 }} />
          <label className="toggle-row" style={{ gap: 8, padding: 0, cursor: 'pointer' }}>
            <span className="toggle-label" style={{ fontSize: 12, color: '#78716C' }}>Create more</span>
            <span
              className={`toggle-track${createMore ? ' on' : ''}`}
              role="switch"
              aria-checked={createMore}
              tabIndex={0}
              onClick={() => setCreateMore(v => !v)}
              onKeyDown={e => e.key === ' ' && (e.preventDefault(), setCreateMore(v => !v))}
            >
              <span className={`toggle-thumb${createMore ? ' on' : ' off'}`} />
            </span>
          </label>
          <button type="submit" className="btn-primary" disabled={!title.trim()} title="Create (⌘↵)">Create</button>
        </div>
      </form>
    </div>
  )
}
