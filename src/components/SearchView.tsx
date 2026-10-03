import { useState } from 'react'
import { Search as SearchIcon, X, ChevronDown } from 'lucide-react'
import { useStore, projectOf, isDone, type IssueType, type Priority } from '../data/store'
import { navigate, href } from '../router'
import IssueTable, { type TableGroup } from './IssueTable'
import { Picker, TYPE_META, PRIORITY_META, typeOptions, priorityOptions, userOptions, type PickerOption } from './ui'
import { ProjectIcon } from './ProjectView'

type Resolution = 'open' | 'done' | 'all'

export default function SearchView({ query }: { query: string }) {
  const { state } = useStore()
  const [text, setText]           = useState(query)
  const [projectId, setProjectId] = useState<string>()
  const [assignee, setAssignee]   = useState<string | undefined | null>(null) // null = anyone, undefined = unassigned
  const [type, setType]           = useState<IssueType>()
  const [priority, setPriority]   = useState<Priority>()
  const [resolution, setRes]      = useState<Resolution>('open')
  const [label, setLabel]         = useState<string>()
  const [groupBy, setGroupBy]     = useState<TableGroup>('none')

  const q = text.trim().toLowerCase()
  const labels = [...new Set(state.issues.flatMap(i => i.labels))].sort()
  const results = state.issues.filter(i => {
    const p = projectOf(state, i.projectId)
    return (!projectId || i.projectId === projectId)
      && (assignee === null || i.assigneeId === assignee)
      && (!type || i.type === type)
      && (!priority || i.priority === priority)
      && (!label || i.labels.includes(label))
      && (resolution === 'all' || (resolution === 'done') === isDone(p, i))
      && (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
          || i.description.toLowerCase().includes(q) || i.labels.some(l => l.toLowerCase().includes(q)))
  })

  const active = !!(projectId || assignee !== null || type || priority || label || resolution !== 'open')
  const clear = () => { setProjectId(undefined); setAssignee(null); setType(undefined); setPriority(undefined); setLabel(undefined); setRes('open') }
  const any = <T,>(l: string, opts: PickerOption<T>[]) => [{ value: undefined as T, label: l }, ...opts]
  const project = projectOf(state, projectId)
  const assigneeUser = state.users.find(u => u.id === assignee)

  return (
    <div className="page-col">
      <div className="page-hdr"><h1 className="page-title">Search</h1></div>
      <div className="search-bar">
        <label className="search-hero">
          <SearchIcon size={17} />
          <input value={text} autoFocus aria-label="Search work items" placeholder="Search by key, title, description or label"
            onChange={e => { setText(e.target.value); navigate(href({ name: 'search', q: e.target.value }), { replace: true }) }} />
          {text && <button className="icon-btn sm" onClick={() => { setText(''); navigate(href({ name: 'search', q: '' }), { replace: true }) }} aria-label="Clear search"><X size={14} /></button>}
        </label>
        <div className="filters">
          <Picker value={projectId} search title="Project" className={`chip${projectId ? ' chip-on' : ''}`}
            options={any('Any project', state.projects.map(p => ({ value: p.id as string | undefined, label: p.name, icon: <ProjectIcon project={p} size={16} /> })))}
            onChange={setProjectId} trigger={<>{project ? <><ProjectIcon project={project} size={16} />{project.name}</> : 'Project'}<ChevronDown size={13} /></>} />
          <Picker value={assignee} search title="Assignee" className={`chip${assignee !== null ? ' chip-on' : ''}`}
            options={[{ value: null as string | undefined | null, label: 'Anyone' }, ...userOptions(state.users)]}
            onChange={setAssignee} trigger={<>{assignee === null ? 'Assignee' : assigneeUser?.name ?? 'Unassigned'}<ChevronDown size={13} /></>} />
          <Picker value={type} title="Type" options={any('Any type', typeOptions())} onChange={setType} className={`chip${type ? ' chip-on' : ''}`}
            trigger={<>{type ? TYPE_META[type].label : 'Type'}<ChevronDown size={13} /></>} />
          <Picker value={priority} title="Priority" options={any('Any priority', priorityOptions)} onChange={setPriority} className={`chip${priority ? ' chip-on' : ''}`}
            trigger={<>{priority ? PRIORITY_META[priority].label : 'Priority'}<ChevronDown size={13} /></>} />
          {labels.length > 0 && (
            <Picker value={label} search title="Label" options={any('Any label', labels.map(l => ({ value: l as string | undefined, label: l })))} onChange={setLabel}
              className={`chip${label ? ' chip-on' : ''}`} trigger={<>{label ?? 'Label'}<ChevronDown size={13} /></>} />
          )}
          <Picker value={resolution} title="Resolution" className={`chip${resolution !== 'open' ? ' chip-on' : ''}`}
            options={[{ value: 'open' as Resolution, label: 'Open' }, { value: 'done' as Resolution, label: 'Done' }, { value: 'all' as Resolution, label: 'Open and done' }]}
            onChange={setRes} trigger={<>{resolution === 'open' ? 'Open' : resolution === 'done' ? 'Done' : 'Open and done'}<ChevronDown size={13} /></>} />
          {active && <button className="link" onClick={clear}>Clear filters</button>}
          <div style={{ flex: 1 }} />
          <span className="muted">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <IssueTable id="search" issues={results} groupBy={groupBy} onGroupBy={setGroupBy} showProjectColumn
        emptyText={state.issues.length ? 'No work items match. Try fewer filters or a different search.' : 'There are no work items yet.'} />
    </div>
  )
}
