import { useEffect, useState } from 'react'
import ShareViewDialog from './ShareViewDialog'
import { Search as SearchIcon, X, ChevronDown, Bookmark, MoreHorizontal, Pencil, Trash2, Users, Lock, Save, Download } from 'lucide-react'
import { useStore, projectOf, uid, type Issue, type IssueType, type Priority, type ViewFilters, type ViewResolution } from '../data/store'
import { applyFilters, filtersActive, EMPTY_FILTERS } from '../data/views'
import { useApp } from '../appContext'
import { navigate, href } from '../router'
import IssueTable, { type TableGroup } from './IssueTable'
import { Picker, Menu, Modal, Toggle, typeMeta, PRIORITY_META, typeOptions, priorityOptions, Avatar, type PickerOption } from './ui'
import { ProjectIcon } from './ProjectView'
import { api, apiEnabled } from '../api/client'
import type { Row } from '../api/map'
import { useSearch, searchProjects, searchLabels, exportSearchCsv } from '../api/work'
import { useUserSearch } from '../api/users'
import { useRemoteList } from '../api/remoteList'
import { useEnsureProjects, projectKeyOf } from '../api/useEnsureProjects'

export default function SearchView({ query, viewId }: { query: string; viewId?: string }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const view = state.views.find(v => v.id === viewId)
  const [f, setF] = useState<ViewFilters>(view?.filters ?? { ...EMPTY_FILTERS, q: query })
  const [groupBy, setGroupBy] = useState<TableGroup>('none')
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Switching views (sidebar, back button) loads that view's filters
  useEffect(() => { setF(view?.filters ?? { ...EMPTY_FILTERS, q: query }) }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<ViewFilters>) => setF(prev => ({ ...prev, ...patch }))
  // With an API, results come from the server's cross-project search: the app does not hold
  // every work item, so this is the only way to find one. Without one, filter the local store.
  const server = useSearch(f)
  // Assignee filter: the workspace's people are searched on the server, not held as a local list.
  const people = useUserSearch()
  const results: Issue[] = apiEnabled ? server.items : applyFilters(state, f, state.me?.id)
  // Projects and labels are searched on the server too: the browser only holds the projects you have opened
  const projects = useRemoteList(searchProjects, p => p.id)
  const labelList = useRemoteList(async q => (await searchLabels(q)).map(name => ({ name })), l => l.name)
  useEnsureProjects(results.map(i => projectKeyOf(i.key)))                       // so each row knows its workflow and shows its status
  const labels = apiEnabled ? labelList.items.map(l => l.name) : [...new Set(state.issues.flatMap(i => i.labels))].sort()
  const dirty = !!view && JSON.stringify(view.filters) !== JSON.stringify(f)
  const canEdit = !view || view.ownerId === state.me?.id || !!view.canEdit
  /** Only its owner (or a workspace admin) decides who can see it, deletes it, or gives it away. */
  const governs = !!view && (view.ownerId === state.me?.id || (apiEnabled && !!state.isAdmin))
  const [sharing, setSharing] = useState(false)
  const any = <T,>(l: string, opts: PickerOption<T>[]) => [{ value: undefined as T, label: l }, ...opts]
  const projectRow = projects.byId(f.projectId)
  const project = projectOf(state, f.projectId) ?? (projectRow ? { name: projectRow.name, color: projectRow.color } : undefined)
  // A saved view can name a project this browser has not seen: look its name up once
  useEffect(() => {
    if (apiEnabled && f.projectId && !projectOf(state, f.projectId) && !projects.byId(f.projectId))
      api<Row>('GET', `/api/projects/${encodeURIComponent(f.projectId)}`).then(r => { projects.remember({ id: r.id, key: r.key, name: r.name, color: r.color }); set({}) }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.projectId])
  const assigneeName = (id: string | null) => {
    if (id === null) return 'Assignee'
    if (id === 'me') return 'Me'
    if (id === '') return 'Unassigned'
    return people.userById(id)?.name ?? state.users.find(u => u.id === id)?.name ?? 'Assignee'
  }
  const assigneeLabel = assigneeName(f.assignee)
  const assigneeOptions: PickerOption<string | null>[] = [
    { value: null, label: 'Anyone' },
    { value: 'me', label: 'Me (whoever is viewing)', icon: <Avatar user={state.me} size={20} /> },
    { value: '', label: 'Unassigned', icon: <Avatar size={20} /> },
    ...people.users.map(u => ({ value: u.id as string | null, label: u.name, icon: <Avatar user={u} size={20} /> })),
  ]

  const onText = (q: string) => {
    set({ q })
    if (!view) navigate(href({ name: 'search', q }), { replace: true })
  }

  return (
    <div className="page-col">
      <div className="page-hdr">
        {view ? (
          <>
            <Bookmark size={20} className="tone-green" />
            <h1 className="page-title">{view.name}</h1>
            <span className="lozenge lozenge-todo" title={view.shared ? 'Everyone in the workspace can see this view' : view.share?.length ? 'Shared with some projects, groups or people' : 'Only you can see this view'}>
              {view.shared || view.share?.length ? 'Shared' : 'Private'}
            </span>
            {view.ownerId !== state.me?.id && <span className="muted sm">by {state.users.find(u => u.id === view.ownerId)?.name}</span>}
          </>
        ) : <h1 className="page-title">Search</h1>}
        <div style={{ flex: 1 }} />
        {apiEnabled && results.length > 0 && (
          <button className="btn btn-secondary" disabled={exporting} onClick={() => {
            setExporting(true)
            exportSearchCsv(f).then(() => toast('Exported to CSV'), e => toast(e instanceof Error ? e.message : 'Export failed', { tone: 'warn' }))
              .finally(() => setExporting(false))
          }}><Download size={15} />{exporting ? 'Exporting…' : 'Export CSV'}</button>
        )}
        {view && dirty && canEdit && (
          <>
            <button className="btn btn-ghost" onClick={() => setF(view.filters)}>Discard changes</button>
            <button className="btn btn-primary" onClick={() => { dispatch({ type: 'saveView', view: { ...view, filters: f } }); toast(`Updated ${view.name}`) }}><Save size={15} />Save view</button>
          </>
        )}
        {(!view || dirty) && filtersActive(f) && (
          <button className={`btn ${view ? 'btn-secondary' : 'btn-primary'}`} onClick={() => setNaming('new')}><Bookmark size={15} />{view ? 'Save as new view' : 'Save as view'}</button>
        )}
        {view && canEdit && (
          <Menu title="View actions" className="icon-btn" trigger={<MoreHorizontal size={17} />} items={[
            { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setNaming('rename') },
            ...(governs ? [{ label: 'Share…', icon: view.shared || view.share?.length ? <Users size={14} /> : <Lock size={14} />, onClick: () => setSharing(true) }] : []),
            ...(governs ? [{ label: 'Delete view', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setConfirmDelete(true) }] : []),
          ]} />
        )}
        {sharing && view && <ShareViewDialog view={view} onClose={() => setSharing(false)} onSave={(shared, share) => {
          dispatch({ type: 'saveView', view: { ...view, shared, share } }); setSharing(false); toast(shared || share.length ? `${view.name} is shared` : `${view.name} is private`)
        }} />}
      </div>

      <div className="search-bar">
        <label className="search-hero">
          <SearchIcon size={17} />
          <input value={f.q} autoFocus={!view} aria-label="Search work items" placeholder="Search by key, title, description or label" onChange={e => onText(e.target.value)} />
          {f.q && <button className="icon-btn sm" onClick={() => onText('')} aria-label="Clear search"><X size={14} /></button>}
        </label>
        <div className="filters">
          <Picker value={f.projectId} search title="Project" className={`chip${f.projectId ? ' chip-on' : ''}`}
            options={any('Any project', (apiEnabled ? projects.items : state.projects).map(p => ({ value: p.id as string | undefined, label: p.name, icon: <ProjectIcon project={p} size={16} /> })))}
            remote={apiEnabled ? { onSearch: projects.search, searching: projects.busy } : undefined}
            onChange={projectId => set({ projectId })} trigger={<>{project ? <><ProjectIcon project={project} size={16} />{project.name}</> : 'Project'}<ChevronDown size={13} /></>} />
          <Picker value={f.assignee} search title="Assignee" className={`chip${f.assignee !== null ? ' chip-on' : ''}`}
            options={apiEnabled ? assigneeOptions : [
              { value: null as string | null, label: 'Anyone' },
              { value: 'me', label: 'Me (whoever is viewing)', icon: <Avatar user={state.me} size={20} /> },
              { value: '', label: 'Unassigned', icon: <Avatar size={20} /> },
              ...state.users.map(u => ({ value: u.id as string | null, label: u.name, icon: <Avatar user={u} size={20} /> })),
            ]}
            remote={apiEnabled ? { onSearch: people.search, searching: people.busy } : undefined}
            onChange={assignee => set({ assignee })} trigger={<>{assigneeLabel}<ChevronDown size={13} /></>} />
          <Picker value={f.type} title="Type" options={any('Any type', typeOptions(undefined, true, state.projects))} onChange={(type: IssueType | undefined) => set({ type })} className={`chip${f.type ? ' chip-on' : ''}`}
            trigger={<>{f.type ? typeMeta(f.type, undefined, state.projects).label : 'Type'}<ChevronDown size={13} /></>} />
          <Picker value={f.priority} title="Priority" options={any('Any priority', priorityOptions)} onChange={(priority: Priority | undefined) => set({ priority })} className={`chip${f.priority ? ' chip-on' : ''}`}
            trigger={<>{f.priority ? PRIORITY_META[f.priority].label : 'Priority'}<ChevronDown size={13} /></>} />
          {(apiEnabled || labels.length > 0) && (
            <Picker value={f.label} search title="Label" options={any('Any label', labels.map(l => ({ value: l as string | undefined, label: l })))} onChange={label => set({ label })}
              remote={apiEnabled ? { onSearch: labelList.search, searching: labelList.busy } : undefined}
              className={`chip${f.label ? ' chip-on' : ''}`} trigger={<>{f.label ?? 'Label'}<ChevronDown size={13} /></>} />
          )}
          <Picker value={f.resolution} title="Resolution" className={`chip${f.resolution !== 'open' ? ' chip-on' : ''}`}
            options={[{ value: 'open' as ViewResolution, label: 'Open' }, { value: 'done' as ViewResolution, label: 'Done' }, { value: 'all' as ViewResolution, label: 'Open and done' }]}
            onChange={resolution => set({ resolution })} trigger={<>{f.resolution === 'open' ? 'Open' : f.resolution === 'done' ? 'Done' : 'Open and done'}<ChevronDown size={13} /></>} />
          {filtersActive(f) && <button className="link" onClick={() => setF({ ...EMPTY_FILTERS })}>Clear filters</button>}
          <div style={{ flex: 1 }} />
          <span className="muted">{apiEnabled && server.status === 'loading' ? 'Searching…' : `${results.length}${apiEnabled && server.next ? '+' : ''} result${results.length === 1 && !(apiEnabled && server.next) ? '' : 's'}`}</span>
        </div>
      </div>
      <IssueTable id={view ? `view:${view.id}` : 'search'} issues={results} groupBy={groupBy} onGroupBy={setGroupBy} showProjectColumn
        emptyText={apiEnabled ? (server.status === 'loading' ? 'Searching…' : filtersActive(f) ? 'No work items match. Try fewer filters or a different search.' : 'There are no work items yet.') : state.issues.length ? 'No work items match. Try fewer filters or a different search.' : 'There are no work items yet.'} />
      {apiEnabled && server.next && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 24px' }}>
          <button className="btn btn-ghost" onClick={server.loadMore}>Load more results</button>
        </div>
      )}
      {apiEnabled && server.status === 'error' && (
        <div style={{ textAlign: 'center', padding: 16 }}>
          <button className="btn btn-ghost" onClick={server.retry}>Search failed — retry</button>
        </div>
      )}

      {naming && (
        <NameDialog
          title={naming === 'new' ? 'Save view' : 'Rename view'}
          initial={naming === 'rename' ? view!.name : ''}
          showShare={naming === 'new'}
          onClose={() => setNaming(null)}
          onSave={(name, shared) => {
            if (naming === 'rename') { dispatch({ type: 'saveView', view: { ...view!, name } }); toast('View renamed') }
            else {
              const id = uid()
              dispatch({ type: 'saveView', view: { id, name, shared, ownerId: state.me!.id, filters: f } })
              toast(`Saved ${name}`)
              navigate(href({ name: 'search', q: '', view: id }))
            }
            setNaming(null)
          }}
        />
      )}
      {confirmDelete && view && (
        <Modal title={`Delete “${view.name}”?`} onClose={() => setConfirmDelete(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { dispatch({ type: 'deleteView', id: view.id }); toast('View deleted', { undo: 'deleteView' }); navigate(href({ name: 'search', q: '' })) }}>Delete view</button>
          </>}>
          <p>{view.shared ? 'Everyone loses access to this view. ' : ''}Work items aren’t affected.</p>
        </Modal>
      )}
    </div>
  )
}

function NameDialog({ title, initial, showShare, onClose, onSave }: {
  title: string; initial: string; showShare: boolean; onClose: () => void; onSave: (name: string, shared: boolean) => void
}) {
  const [name, setName] = useState(initial)
  const [shared, setShared] = useState(false)
  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="view-name" type="submit" disabled={!name.trim()}>Save</button>
      </>}>
      <form id="view-name" onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(name.trim(), shared) }}>
        <label className="label" htmlFor="vn">Name</label>
        <input id="vn" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My open bugs" autoFocus />
        {showShare && (
          <label className="toggle-row" style={{ marginTop: 12 }}>
            <span>Share with everyone in the workspace</span>
            <Toggle on={shared} onChange={setShared} label="Share with everyone in the workspace" />
          </label>
        )}
      </form>
    </Modal>
  )
}
