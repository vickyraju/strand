import { useState } from 'react'
import { Search as SearchIcon, X } from 'lucide-react'
import { useStore, projectOf, isDone, type IssueType, type Priority } from '../data/store'
import IssueRow from './IssueRow'
import { Picker, TYPE_META, PRIORITY_META, typeOptions, priorityOptions, userOptions, type PickerOption } from './ui'
import { ProjectIcon } from './ProjectView'

type Resolution = 'open' | 'done' | 'all'
type Sort = 'updated' | 'created' | 'priority'
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export default function SearchView({ initialQuery = '' }: { initialQuery?: string }) {
  const { state } = useStore()
  const [query, setQuery]         = useState(initialQuery)
  const [projectId, setProjectId] = useState<string>()
  const [assignee, setAssignee]   = useState<string | undefined | null>(null) // null = anyone, undefined = unassigned
  const [type, setType]           = useState<IssueType>()
  const [priority, setPriority]   = useState<Priority>()
  const [resolution, setRes]      = useState<Resolution>('open')
  const [sort, setSort]           = useState<Sort>('updated')

  const q = query.trim().toLowerCase()
  const results = state.issues
    .filter(i => {
      const p = projectOf(state, i.projectId)
      return (!projectId || i.projectId === projectId)
        && (assignee === null || i.assigneeId === assignee)
        && (!type || i.type === type)
        && (!priority || i.priority === priority)
        && (resolution === 'all' || (resolution === 'done') === isDone(p, i))
        && (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
            || i.description.toLowerCase().includes(q) || i.labels.some(l => l.toLowerCase().includes(q)))
    })
    .sort((a, b) =>
      sort === 'priority' ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt
      : sort === 'created' ? b.createdAt - a.createdAt
      : b.updatedAt - a.updatedAt)

  const active = !!(projectId || assignee !== null || type || priority || resolution !== 'open')
  const clear = () => { setProjectId(undefined); setAssignee(null); setType(undefined); setPriority(undefined); setRes('open') }
  const any = <T,>(label: string, opts: PickerOption<T>[]) => [{ value: undefined as T, label }, ...opts]
  const project = projectOf(state, projectId)
  const assigneeUser = state.users.find(u => u.id === assignee)

  return (
    <div className="pv-root" style={{ overflow: 'hidden' }}>
      <div className="pv-header"><h1 className="pv-title">Search</h1></div>

      <div style={{ padding: '0 24px' }}>
        <label className="sv-input">
          <SearchIcon size={15} strokeWidth={1.5} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by key, title, description or label" autoFocus aria-label="Search work items" />
          {query && <button className="col-hdr-btn" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>}
        </label>

        <div className="sv-filters">
          <Picker value={projectId} options={any('Any project', state.projects.map(p => ({ value: p.id as string | undefined, label: p.name, icon: <ProjectIcon project={p} size={14} /> })))}
            onChange={setProjectId} className={`chip${projectId ? ' chip-on' : ''}`}
            trigger={<>{project ? <><ProjectIcon project={project} size={14} />{project.name}</> : 'Project'}</>} />
          <Picker value={assignee} options={[{ value: null as string | undefined | null, label: 'Anyone' }, ...userOptions(state.users)]}
            onChange={setAssignee} className={`chip${assignee !== null ? ' chip-on' : ''}`}
            trigger={<>{assignee === null ? 'Assignee' : assigneeUser?.name ?? 'Unassigned'}</>} />
          <Picker value={type} options={any('Any type', typeOptions)} onChange={setType} className={`chip${type ? ' chip-on' : ''}`}
            trigger={<>{type ? TYPE_META[type].label : 'Type'}</>} />
          <Picker value={priority} options={any('Any priority', priorityOptions)} onChange={setPriority} className={`chip${priority ? ' chip-on' : ''}`}
            trigger={<>{priority ? PRIORITY_META[priority].label : 'Priority'}</>} />
          <Picker value={resolution} options={[{ value: 'open' as Resolution, label: 'Open' }, { value: 'done' as Resolution, label: 'Done' }, { value: 'all' as Resolution, label: 'Open and done' }]}
            onChange={setRes} className={`chip${resolution !== 'open' ? ' chip-on' : ''}`}
            trigger={<>{resolution === 'open' ? 'Open' : resolution === 'done' ? 'Done' : 'Open and done'}</>} />
          {active && <button className="wi-link" onClick={clear}>Clear filters</button>}
          <div style={{ flex: 1 }} />
          <span className="ir-group-count">{results.length} result{results.length === 1 ? '' : 's'}</span>
          <Picker value={sort} align="right" options={[{ value: 'updated' as Sort, label: 'Recently updated' }, { value: 'created' as Sort, label: 'Newest' }, { value: 'priority' as Sort, label: 'Priority' }]}
            onChange={setSort} className="chip chip-ghost"
            trigger={<>Sort: {sort === 'updated' ? 'Recently updated' : sort === 'created' ? 'Newest' : 'Priority'}</>} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 32px' }}>
        {results.length === 0
          ? <div className="yw-empty-tab">{state.issues.length ? 'No work items match. Try fewer filters or another search.' : 'There are no work items yet.'}</div>
          : results.map(i => <IssueRow key={i.id} issue={i} project={projectOf(state, i.projectId)!} showProject />)}
      </div>
    </div>
  )
}
