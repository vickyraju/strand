import { useState } from 'react'
import { missingRequired, type FieldRule } from '../../server/src/shared/fieldRules.ts'
import { isMulti } from '../../server/src/shared/customFields.ts'
import { splitLabels } from '../../server/src/shared/labels.ts'
import { ChevronRight, Maximize2, Minimize2, X, CalendarDays, Tag, Zap, IterationCcw, Hash, FileText } from 'lucide-react'
import { useStore, uid, userOf, statusesFor, type FieldDef, type FieldValue, type NewIssue, type IssueType, type Priority } from '../data/store'
import { useApp } from '../appContext'
import { canEdit } from '../data/access'
import {
  Picker, TypeIcon, PriorityIcon, Avatar, typeMeta, priorityLabel, Toggle,
  statusOptions, priorityOptions, typeOptions,
} from './ui'
import { UserPicker } from './UserPicker'
import { ProjectIcon } from './ProjectView'

export default function CreateIssueModal({ defaults, onClose }: {
  defaults: Partial<NewIssue>
  onClose:  () => void
}) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()

  const [projectId, setProjectId] = useState(defaults.projectId ?? state.projects.find(canEdit)?.id ?? '')
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
  const [dueDate, setDueDate]         = useState(defaults.dueDate ?? '')
  const [labels, setLabels]           = useState('')
  const [custom, setCustom]           = useState<Record<string, FieldValue>>({})
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
    setAssigneeId(undefined)   // they may not be in the new project
  }

  // field configurations (spec 0504): hidden fields are left out, required ones are marked and must be filled in
  const rules = project.fieldRules?.[type] ?? {}
  const rule = (k: string): FieldRule => rules[k] ?? {}
  // the create screen (spec 0505): only its fields are offered
  const createTabs = project.screens?.[type]?.create ?? null
  const onCreate = (k: string) => !createTabs || createTabs.some(t => t.fields.includes(k))
  const shown = (k: string) => !rule(k).hidden && onCreate(k)
  const star = (k: string) => (rule(k).required && !rule(k).hidden ? ' *' : '')
  const values = { description, assigneeId, priority, parentId, sprintId, estimate: estimate === '' ? undefined : estimate, dueDate, labels: splitLabels(labels), custom, reporterId: state.me?.id }
  const missing = missingRequired(rules, values)
  // custom fields asked for here: a create screen's own (in its order), else the required ones
  const requiredFields = project.fields.filter(f => shown(`custom.${f.id}`) && (!f.typeKeys || f.typeKeys.includes(type)) && (createTabs ? true : rule(`custom.${f.id}`).required))
    .sort((a, b) => !createTabs ? 0 : createTabs.flatMap(t => t.fields).indexOf(`custom.${a.id}`) - createTabs.flatMap(t => t.fields).indexOf(`custom.${b.id}`))
  const submit = () => {
    if (!title.trim() || missing.length) return
    const id = uid()
    const key = `${project.key}-${project.nextNumber}`
    dispatch({
      type: 'createIssue', id,
      issue: {
        // only what the create screen offers (spec 0505): the rest stays as a new item starts
        projectId, title: title.trim(), description: shown('description') ? description.trim() : '', type, status: statusObj?.id ?? status,
        ...(shown('priority') ? { priority } : {}), assigneeId: shown('assigneeId') ? assigneeId : undefined,
        dueDate: shown('dueDate') ? dueDate || undefined : undefined, startDate: defaults.startDate, sprintId: shown('sprintId') ? sprintId : undefined,
        parentId: type === 'epic' ? undefined : parentId,
        estimate: estimate === '' || !shown('estimate') ? undefined : Math.max(0, Number(estimate)),
        labels: shown('labels') ? splitLabels(labels) : [],
        ...(Object.keys(custom).length ? { custom } : {}),
        ...(type === 'test' && defaults.testFolderId ? { testFolderId: defaults.testFolderId } : {}),
      },
    })
    toast(`Created ${key}`, { issueId: id })
    if (createMore) { setTitle(''); setDescription('') } else onClose()
  }

  const assignee = userOf(state, assigneeId)
  // only the statuses of the chosen type's workflow; one it lacks becomes where that workflow starts
  const allowed = statusesFor(project, type)
  const statusObj = allowed.find(s => s.id === status) ?? allowed[0]

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
            options={state.projects.filter(canEdit).map(p => ({ value: p.id, label: p.name, icon: <ProjectIcon project={p} size={16} /> }))}
            onChange={changeProject}
            trigger={<><ProjectIcon project={project} size={16} />{project.key}</>} />
          <ChevronRight size={13} className="muted" />
          <span className="compose-hdr-label">{parent ? `New item in ${parent.key}` : 'New work item'}</span>
          {project.templates.length > 0 && (
            <Picker value="" title="Use a template" className="chip chip-ghost"
              options={project.templates.map(t => ({ value: t.id, label: t.name, icon: <TypeIcon type={t.type} size={13} /> }))}
              onChange={id => {
                const t = project.templates.find(x => x.id === id)!
                setType(t.type); setPriority(t.priority); setLabels(t.labels.join(', '))
                setEstimate(t.estimate != null ? String(t.estimate) : '')
                setTitle(prev => prev.trim() ? prev : t.title); setDescription(t.description)
              }}
              trigger={<><FileText size={13} className="muted" />Template</>} />
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="icon-btn" onClick={() => setExpanded(v => !v)} title={expanded ? 'Collapse' : 'Expand'} aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="compose-body">
          <input className="compose-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Work item title" aria-label="Title" autoFocus />
          {shown('description') && <textarea className="compose-desc" value={description} onChange={e => setDescription(e.target.value)}
            placeholder={`Add a description…${star('description') ? ' (required)' : ' Markdown is supported.'}`} aria-label={`Description${star('description')}`} />}
          {requiredFields.length > 0 && (
            <div className="compose-required" aria-label="Required fields">
              {requiredFields.map(f => <RequiredField key={f.id} field={f} value={custom[f.id]} rule={rule(`custom.${f.id}`)} projectId={projectId}
                onChange={v => setCustom(c => { const n = { ...c }; if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete n[f.id]; else n[f.id] = v; return n })} />)}
            </div>
          )}
        </div>

        <div className="compose-chips">
          <Picker value={type} options={typeOptions(project, !defaults.parentId)} onChange={setType} title="Type"
            trigger={<><TypeIcon type={type} size={13} project={project} />{typeMeta(type, project).label}</>} />
          <Picker value={statusObj?.id ?? status} options={statusOptions(project, undefined, undefined, type)} onChange={setStatus} title="Status"
            trigger={<><span className="status-dot" style={{ background: statusObj?.color }} />{statusObj?.name}</>} />
          {shown('priority') && <Picker value={priority} options={priorityOptions()} onChange={setPriority} title={`Priority${star('priority')}`}
            trigger={<><PriorityIcon priority={priority} />{priorityLabel(priority)}</>} />}
          {shown('assigneeId') && <UserPicker value={assigneeId} onChange={setAssigneeId} projectId={projectId} title={`Assignee${star('assigneeId')}`}
            trigger={<><Avatar user={assignee} size={16} />{assignee?.name ?? `Assignee${star('assigneeId')}`}</>} />}
          {shown('parentId') && type !== 'epic' && parentOptions.length > 0 && (
            <Picker value={parentId} title="Epic or parent" search
              options={[{ value: undefined, label: 'None' }, ...parentOptions.map(i => ({ value: i.id as string | undefined, label: `${i.key} ${i.title}`, icon: <TypeIcon type={i.type} size={12} /> }))]}
              onChange={setParentId}
              trigger={<><Zap size={13} className="muted" />{parent ? parent.key : 'Epic'}</>} />
          )}
          {shown('sprintId') && project.template === 'scrum' && type !== 'epic' && (
            <Picker value={sprintId} title="Sprint"
              options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name, hint: s.state === 'active' ? 'Active' : undefined }))]}
              onChange={setSprintId}
              trigger={<><IterationCcw size={13} className="muted" />{sprint?.name ?? 'Backlog'}</>} />
          )}
          {shown('estimate') && <label className="chip" title={`Estimate (story points)${star('estimate')}`}>
            <Hash size={13} className="muted" />
            <input type="number" min={0} className="chip-input" style={{ width: 52 }} value={estimate} onChange={e => setEstimate(e.target.value)} placeholder={`Points${star('estimate')}`} aria-label="Estimate" />
          </label>}
          {shown('dueDate') && <label className="chip" title={`Due date${star('dueDate')}`}>
            <CalendarDays size={13} className="muted" />
            <input type="date" className="chip-input" value={dueDate} onChange={e => setDueDate(e.target.value)} aria-label="Due date" />
          </label>}
          {shown('labels') && <label className="chip" title={`Labels, separated by spaces${star('labels')}`}>
            <Tag size={13} className="muted" />
            <input className="chip-input" value={labels} onChange={e => setLabels(e.target.value)} placeholder={`Labels${star('labels')}`} aria-label="Labels" />
          </label>}
        </div>

        <div className="compose-ftr">
          <label className="inline-toggle">
            <Toggle on={createMore} onChange={setCreateMore} label="Create more" />
            Create more
          </label>
          <div style={{ flex: 1 }} />
          {missing.length > 0 && <span className="muted sm" role="status">Required: {missing.map(k => k.startsWith('custom.') ? project.fields.find(f => f.id === k.slice(7))?.name ?? 'a field' : ({ description: 'Description', assigneeId: 'Assignee', priority: 'Priority', estimate: 'Story Points', dueDate: 'Due Date', labels: 'Labels', sprintId: 'Sprint', parentId: 'Parent' } as Record<string, string>)[k] ?? k).join(', ')}</span>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || missing.length > 0} title="Create (⌘↵)">Create</button>
        </div>
      </form>
    </div>
  )
}

/** A required custom field in the create dialog (spec 0504): a simple editor for its type, with its description. */
function RequiredField({ field, value, rule, projectId, onChange }: { field: FieldDef; value: FieldValue | undefined; rule: FieldRule; projectId: string; onChange: (v: FieldValue | undefined) => void }) {
  const { state } = useStore()
  const project = state.projects.find(p => p.id === projectId)
  const opts = (field.options ?? []).filter(o => !o.disabled && !o.parentId)
  const list = Array.isArray(value) ? value : []
  const id = `req-${field.id}`
  let input: React.ReactNode
  if (field.kind === 'select' || field.kind === 'radio') input = <select id={id} className="input input-sm" value={String(value ?? '')} onChange={e => onChange(e.target.value || undefined)}><option value="">Choose…</option>{opts.map(o => <option key={o.id}>{o.name}</option>)}</select>
  else if (field.kind === 'multiselect' || field.kind === 'checkboxes') input = <span className="field-choices">{opts.map(o => <label key={o.id} className="check-row"><input type="checkbox" checked={list.includes(o.name)} onChange={e => onChange(e.target.checked ? [...list, o.name] : list.filter(x => x !== o.name))} />{o.name}</label>)}</span>
  else if (field.kind === 'user' || field.kind === 'users') input = <select id={id} className="input input-sm" value={String(list[0] ?? value ?? '')} onChange={e => onChange(e.target.value ? (field.kind === 'users' ? [e.target.value] : e.target.value) : undefined)}><option value="">Choose…</option>{state.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
  else if (field.kind === 'version' || field.kind === 'versions') input = <select id={id} className="input input-sm" value={String(list[0] ?? value ?? '')} onChange={e => onChange(e.target.value ? (field.kind === 'versions' ? [e.target.value] : e.target.value) : undefined)}><option value="">Choose…</option>{(project?.releases ?? []).filter(r => !r.archived).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
  else input = <input id={id} className="input input-sm" type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'} value={Array.isArray(value) ? value.join(field.kind === 'cascading' ? ' > ' : ' ') : String(value ?? '')}
    placeholder={field.kind === 'cascading' ? 'Option > Child' : isMulti(field.kind) ? 'Separate with spaces' : ''}
    onChange={e => { const t = e.target.value; onChange(!t ? undefined : field.kind === 'number' ? Number(t) : field.kind === 'cascading' ? t.split(/\s*>\s*/) : isMulti(field.kind) ? t.split(/\s+/).filter(Boolean) : t) }} />
  return <label className="compose-req" htmlFor={id}><span className="label">{field.name}{rule.required ? " *" : ""}</span>{input}{rule.description && <span className="hint">{rule.description}</span>}</label>
}

