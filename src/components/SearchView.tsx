import { useEffect, useState } from 'react'
import { Search as SearchIcon, X, ChevronDown, Bookmark, MoreHorizontal, Pencil, Trash2, Users, Lock, Save } from 'lucide-react'
import { useStore, projectOf, uid, type IssueType, type Priority, type ViewFilters, type ViewResolution } from '../data/store'
import { applyFilters, filtersActive, EMPTY_FILTERS } from '../data/views'
import { useApp } from '../appContext'
import { navigate, href } from '../router'
import IssueTable, { type TableGroup } from './IssueTable'
import { Picker, Menu, Modal, Toggle, TYPE_META, PRIORITY_META, typeOptions, priorityOptions, Avatar, type PickerOption } from './ui'
import { ProjectIcon } from './ProjectView'

export default function SearchView({ query, viewId }: { query: string; viewId?: string }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const view = state.views.find(v => v.id === viewId)
  const [f, setF] = useState<ViewFilters>(view?.filters ?? { ...EMPTY_FILTERS, q: query })
  const [groupBy, setGroupBy] = useState<TableGroup>('none')
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Switching views (sidebar, back button) loads that view's filters
  useEffect(() => { setF(view?.filters ?? { ...EMPTY_FILTERS, q: query }) }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<ViewFilters>) => setF(prev => ({ ...prev, ...patch }))
  const results = applyFilters(state, f, state.me?.id)
  const labels = [...new Set(state.issues.flatMap(i => i.labels))].sort()
  const dirty = !!view && JSON.stringify(view.filters) !== JSON.stringify(f)
  const canEdit = !view || view.ownerId === state.me?.id
  const any = <T,>(l: string, opts: PickerOption<T>[]) => [{ value: undefined as T, label: l }, ...opts]
  const project = projectOf(state, f.projectId)
  const assigneeLabel = f.assignee === null ? 'Assignee' : f.assignee === 'me' ? 'Me' : f.assignee === '' ? 'Unassigned' : state.users.find(u => u.id === f.assignee)?.name ?? 'Assignee'

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
            <span className="lozenge lozenge-todo" title={view.shared ? 'Everyone in the workspace can see this view' : 'Only you can see this view'}>
              {view.shared ? 'Shared' : 'Private'}
            </span>
            {view.ownerId !== state.me?.id && <span className="muted sm">by {state.users.find(u => u.id === view.ownerId)?.name}</span>}
          </>
        ) : <h1 className="page-title">Search</h1>}
        <div style={{ flex: 1 }} />
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
            { label: view.shared ? 'Make private' : 'Share with workspace', icon: view.shared ? <Lock size={14} /> : <Users size={14} />,
              onClick: () => { dispatch({ type: 'saveView', view: { ...view, shared: !view.shared } }); toast(view.shared ? 'View is now private' : 'View shared with the workspace') } },
            { label: 'Delete view', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setConfirmDelete(true) },
          ]} />
        )}
      </div>

      <div className="search-bar">
        <label className="search-hero">
          <SearchIcon size={17} />
          <input value={f.q} autoFocus={!view} aria-label="Search work items" placeholder="Search by key, title, description or label" onChange={e => onText(e.target.value)} />
          {f.q && <button className="icon-btn sm" onClick={() => onText('')} aria-label="Clear search"><X size={14} /></button>}
        </label>
        <div className="filters">
          <Picker value={f.projectId} search title="Project" className={`chip${f.projectId ? ' chip-on' : ''}`}
            options={any('Any project', state.projects.map(p => ({ value: p.id as string | undefined, label: p.name, icon: <ProjectIcon project={p} size={16} /> })))}
            onChange={projectId => set({ projectId })} trigger={<>{project ? <><ProjectIcon project={project} size={16} />{project.name}</> : 'Project'}<ChevronDown size={13} /></>} />
          <Picker value={f.assignee} search title="Assignee" className={`chip${f.assignee !== null ? ' chip-on' : ''}`}
            options={[
              { value: null as string | null, label: 'Anyone' },
              { value: 'me', label: 'Me (whoever is viewing)', icon: <Avatar user={state.me} size={20} /> },
              { value: '', label: 'Unassigned', icon: <Avatar size={20} /> },
              ...state.users.map(u => ({ value: u.id as string | null, label: u.name, icon: <Avatar user={u} size={20} /> })),
            ]}
            onChange={assignee => set({ assignee })} trigger={<>{assigneeLabel}<ChevronDown size={13} /></>} />
          <Picker value={f.type} title="Type" options={any('Any type', typeOptions())} onChange={(type: IssueType | undefined) => set({ type })} className={`chip${f.type ? ' chip-on' : ''}`}
            trigger={<>{f.type ? TYPE_META[f.type].label : 'Type'}<ChevronDown size={13} /></>} />
          <Picker value={f.priority} title="Priority" options={any('Any priority', priorityOptions)} onChange={(priority: Priority | undefined) => set({ priority })} className={`chip${f.priority ? ' chip-on' : ''}`}
            trigger={<>{f.priority ? PRIORITY_META[f.priority].label : 'Priority'}<ChevronDown size={13} /></>} />
          {labels.length > 0 && (
            <Picker value={f.label} search title="Label" options={any('Any label', labels.map(l => ({ value: l as string | undefined, label: l })))} onChange={label => set({ label })}
              className={`chip${f.label ? ' chip-on' : ''}`} trigger={<>{f.label ?? 'Label'}<ChevronDown size={13} /></>} />
          )}
          <Picker value={f.resolution} title="Resolution" className={`chip${f.resolution !== 'open' ? ' chip-on' : ''}`}
            options={[{ value: 'open' as ViewResolution, label: 'Open' }, { value: 'done' as ViewResolution, label: 'Done' }, { value: 'all' as ViewResolution, label: 'Open and done' }]}
            onChange={resolution => set({ resolution })} trigger={<>{f.resolution === 'open' ? 'Open' : f.resolution === 'done' ? 'Done' : 'Open and done'}<ChevronDown size={13} /></>} />
          {filtersActive(f) && <button className="link" onClick={() => setF({ ...EMPTY_FILTERS })}>Clear filters</button>}
          <div style={{ flex: 1 }} />
          <span className="muted">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <IssueTable id={view ? `view:${view.id}` : 'search'} issues={results} groupBy={groupBy} onGroupBy={setGroupBy} showProjectColumn
        emptyText={state.issues.length ? 'No work items match. Try fewer filters or a different search.' : 'There are no work items yet.'} />

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
          <p>{view.shared ? 'Everyone loses access to this view, and dashboard gadgets using it are removed.' : 'Dashboard gadgets using this view are removed.'} Work items aren’t affected.</p>
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
