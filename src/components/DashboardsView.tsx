import { useState } from 'react'
import { Plus, LayoutDashboard, MoreHorizontal, ArrowUp, ArrowDown, Maximize2, Minimize2, Trash2, Pencil, Bookmark } from 'lucide-react'
import { useStore, uid, userOf, projectOf, isDone, type Dashboard, type Gadget, type GadgetKind, type Issue, type State } from '../data/store'
import { applyFilters } from '../data/views'
import { burndown, createdVsResolved } from '../data/analytics'
import { useApp } from '../appContext'
import { navigate, href } from '../router'
import { Donut, HBars, ColumnChart, LineChart, Legend } from './charts'
import { Avatar, Empty, Menu, Modal, TypeIcon, StatusLozenge, plural, formatDate, isOverdue } from './ui'

const GADGETS: { kind: GadgetKind; name: string; desc: string; needs?: 'project' | 'scrum' | 'view' }[] = [
  { kind: 'assigned', name: 'Assigned to me',       desc: 'Open work assigned to whoever is viewing.' },
  { kind: 'due',      name: 'Due soon',             desc: 'Open work due in the next 7 days, across projects.' },
  { kind: 'view',     name: 'Saved view',           desc: 'Results of one of your saved views.', needs: 'view' },
  { kind: 'status',   name: 'Status overview',      desc: 'Work items in a project by status.', needs: 'project' },
  { kind: 'created',  name: 'Created vs resolved',  desc: 'Is a project’s backlog growing? Last 30 days.', needs: 'project' },
  { kind: 'workload', name: 'Team workload',        desc: 'Open work per person in a project.', needs: 'project' },
  { kind: 'burndown', name: 'Sprint burndown',      desc: 'The active sprint of a Scrum project.', needs: 'scrum' },
]

/** Sensible first dashboard so the page is useful straight away. */
function starterDashboard(state: State, ownerId: string): Dashboard {
  const scrum = state.projects.find(p => p.template === 'scrum')
  const first = state.projects[0]
  return {
    id: uid(), name: 'My dashboard', ownerId,
    gadgets: [
      { id: uid(), kind: 'assigned' },
      { id: uid(), kind: 'due' },
      ...(scrum ? [{ id: uid(), kind: 'burndown' as const, projectId: scrum.id }] : []),
      ...(first ? [{ id: uid(), kind: 'status' as const, projectId: first.id }, { id: uid(), kind: 'created' as const, projectId: first.id, wide: true }] : []),
    ],
  }
}

export default function DashboardsView({ id }: { id?: string }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const mine = state.dashboards
  const dash = mine.find(d => d.id === id) ?? (id ? undefined : mine[0])

  const create = () => {
    const d = starterDashboard(state, state.me!.id)
    if (mine.length) { d.name = `Dashboard ${mine.length + 1}`; d.gadgets = [] }
    dispatch({ type: 'saveDashboard', dashboard: d })
    navigate(href({ name: 'dashboards', id: d.id }))
  }

  if (!dash) {
    return (
      <div className="page-col">
        <div className="page-hdr"><h1 className="page-title">Dashboards</h1></div>
        <Empty icon={<LayoutDashboard size={22} strokeWidth={1.5} />} title={id ? 'Dashboard not found' : 'See everything at a glance'}
        body="Dashboards bring your work, your saved views and project reports together on one page."
        action={<button className="btn btn-primary" onClick={create}><Plus size={15} />Create dashboard</button>} />
      </div>
    )
  }

  const save = (patch: Partial<Dashboard>) => dispatch({ type: 'saveDashboard', dashboard: { ...dash, ...patch } })
  const setGadgets = (gadgets: Gadget[]) => save({ gadgets })
  const move = (i: number, dir: -1 | 1) => {
    const next = [...dash.gadgets]
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    setGadgets(next)
  }

  return (
    <div className="page">
      <div className="page-hdr">
        <LayoutDashboard size={22} className="tone-green" />
        <h1 className="page-title">{dash.name}</h1>
        {mine.length > 1 && (
          <Menu title="Switch dashboard" className="btn btn-ghost btn-sm" trigger={<>Switch</>} align="left"
            items={mine.map(d => ({ label: d.name, icon: <LayoutDashboard size={14} />, onClick: () => navigate(href({ name: 'dashboards', id: d.id })) }))} />
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} />Add gadget</button>
        <Menu title="Dashboard actions" className="icon-btn" trigger={<MoreHorizontal size={17} />} items={[
          { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
          { label: 'New dashboard', icon: <Plus size={14} />, onClick: create },
          { label: 'Delete dashboard', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setDeleting(true) },
        ]} />
      </div>

      {dash.gadgets.length === 0 ? (
        <Empty icon={<LayoutDashboard size={22} strokeWidth={1.5} />} title="This dashboard is empty" body="Add gadgets for your work, saved views and project reports."
          action={<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} />Add gadget</button>} />
      ) : (
        <div className="dash-grid">
          {dash.gadgets.map((g, i) => (
            <section key={g.id} className={`panel gadget${g.wide ? ' wide' : ''}`}>
              <div className="gadget-hdr">
                <h2 className="panel-title">{gadgetTitle(state, g)}</h2>
                <Menu title="Gadget actions" className="icon-btn sm" trigger={<MoreHorizontal size={15} />} items={[
                  { label: g.wide ? 'Make narrow' : 'Make wide', icon: g.wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />, onClick: () => setGadgets(dash.gadgets.map(x => x.id === g.id ? { ...x, wide: !x.wide } : x)) },
                  ...(i > 0 ? [{ label: 'Move up', icon: <ArrowUp size={14} />, onClick: () => move(i, -1) }] : []),
                  ...(i < dash.gadgets.length - 1 ? [{ label: 'Move down', icon: <ArrowDown size={14} />, onClick: () => move(i, 1) }] : []),
                  { label: 'Remove', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setGadgets(dash.gadgets.filter(x => x.id !== g.id)) },
                ]} />
              </div>
              <GadgetBody gadget={g} />
            </section>
          ))}
        </div>
      )}

      {adding && <AddGadget onClose={() => setAdding(false)} onAdd={g => { setGadgets([...dash.gadgets, g]); toast('Gadget added'); setAdding(false) }} />}
      {renaming && <RenameDialog name={dash.name} onClose={() => setRenaming(false)} onSave={name => { save({ name }); setRenaming(false) }} />}
      {deleting && (
        <Modal title={`Delete ${dash.name}?`} onClose={() => setDeleting(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { dispatch({ type: 'deleteDashboard', id: dash.id }); setDeleting(false); navigate(href({ name: 'dashboards' })) }}>Delete</button>
          </>}>
          <p>Only the dashboard is deleted. Work items, views and projects stay.</p>
        </Modal>
      )}
    </div>
  )
}

function gadgetTitle(state: State, g: Gadget) {
  const meta = GADGETS.find(x => x.kind === g.kind)!
  if (g.kind === 'view') return state.views.find(v => v.id === g.viewId)?.name ?? 'Saved view'
  const p = projectOf(state, g.projectId)
  return p ? `${meta.name} · ${p.name}` : meta.name
}

function MiniList({ issues, empty }: { issues: Issue[]; empty: string }) {
  const { state } = useStore()
  const { openIssue } = useApp()
  if (issues.length === 0) return <p className="muted sm gadget-empty">{empty}</p>
  return (
    <div className="mini-list">
      {issues.slice(0, 8).map(i => {
        const p = projectOf(state, i.projectId)!
        return (
          <button key={i.id} className="mini-row" onClick={() => openIssue(i.id)}>
            <TypeIcon type={i.type} size={13} />
            <span className="mono muted">{i.key}</span>
            <span className="cell-ellipsis">{i.title}</span>
            {i.dueDate && <span className={`sm nowrap${isOverdue(i.dueDate) ? ' text-danger' : ' muted'}`}>{formatDate(i.dueDate)}</span>}
            <StatusLozenge status={p.statuses.find(s => s.id === i.status)} />
            <Avatar user={userOf(state, i.assigneeId)} size={20} />
          </button>
        )
      })}
      {issues.length > 8 && <p className="muted sm" style={{ padding: '6px 4px 0' }}>and {issues.length - 8} more</p>}
    </div>
  )
}

function GadgetBody({ gadget: g }: { gadget: Gadget }) {
  const { state } = useStore()
  const me = state.me!
  const open = (i: Issue) => !isDone(projectOf(state, i.projectId), i) && i.type !== 'epic'
  const project = projectOf(state, g.projectId)
  const gone = <p className="muted sm gadget-empty">This gadget’s project or view was deleted. Remove it from the dashboard menu.</p>

  switch (g.kind) {
    case 'assigned':
      return <MiniList issues={state.issues.filter(i => i.assigneeId === me.id && open(i)).sort((a, b) => b.updatedAt - a.updatedAt)} empty="Nothing assigned to you." />
    case 'due': {
      const week = Date.now() + 7 * 86_400_000
      const due = state.issues.filter(i => open(i) && i.dueDate && new Date(i.dueDate + 'T23:59').getTime() < week).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
      return <MiniList issues={due} empty="Nothing due in the next 7 days." />
    }
    case 'view': {
      const view = state.views.find(v => v.id === g.viewId)
      if (!view) return gone
      const results = applyFilters(state, view.filters, me.id)
      return (
        <>
          <button className="link sm" style={{ marginBottom: 6 }} onClick={() => navigate(href({ name: 'search', q: '', view: view.id }))}>
            <Bookmark size={12} />{plural(results.length, 'result')} · open view
          </button>
          <MiniList issues={results} empty="No work items match this view." />
        </>
      )
    }
    case 'status': {
      if (!project) return gone
      const items = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic')
      return <Donut ariaLabel={`${project.name} by status`} center={{ value: String(items.length), label: 'work items' }}
        data={project.statuses.map(s => ({ label: s.name, value: items.filter(i => i.status === s.id).length, color: s.color }))} size={150} />
    }
    case 'created': {
      if (!project) return gone
      const d = createdVsResolved(state, project, 30)
      return <>
        <ColumnChart ariaLabel="Created vs resolved" labels={d.labels} height={200}
          series={[{ label: 'Created', color: '#DC2626', values: d.created }, { label: 'Resolved', color: '#16A34A', values: d.resolved }]} />
        <Legend items={[{ label: 'Created', color: '#DC2626' }, { label: 'Resolved', color: '#16A34A' }]} />
      </>
    }
    case 'workload': {
      if (!project) return gone
      const openItems = state.issues.filter(i => i.projectId === project.id && open(i))
      const rows = [...new Set(openItems.map(i => i.assigneeId ?? ''))].map(id => ({ user: userOf(state, id || undefined), n: openItems.filter(i => (i.assigneeId ?? '') === id).length })).sort((a, b) => b.n - a.n)
      return rows.length ? <HBars data={rows.map(r => ({ key: r.user?.id ?? 'none', label: <><Avatar user={r.user} size={18} />{r.user?.name ?? 'Unassigned'}</>, value: r.n, color: r.user?.color ?? '#A8A29E' }))} />
        : <p className="muted sm gadget-empty">No open work.</p>
    }
    case 'burndown': {
      if (!project) return gone
      const sprint = state.sprints.find(s => s.projectId === project.id && s.state === 'active')
      if (!sprint) return <p className="muted sm gadget-empty">{project.name} has no active sprint.</p>
      const b = burndown(state, project, sprint)!
      return <>
        <p className="muted sm" style={{ marginBottom: 6 }}>{sprint.name} · {b.total} points committed</p>
        <LineChart ariaLabel={`Burndown for ${sprint.name}`} labels={b.labels} height={200}
          series={[{ label: 'Remaining', color: '#DC2626', values: b.remaining }, { label: 'Guideline', color: '#A8A29E', values: b.ideal, dashed: true }]} />
      </>
    }
  }
}

function AddGadget({ onClose, onAdd }: { onClose: () => void; onAdd: (g: Gadget) => void }) {
  const { state } = useStore()
  const [kind, setKind] = useState<GadgetKind>('assigned')
  const meta = GADGETS.find(g => g.kind === kind)!
  const projects = meta.needs === 'scrum' ? state.projects.filter(p => p.template === 'scrum') : state.projects
  const views = state.views.filter(v => v.shared || v.ownerId === state.me?.id)
  const [projectId, setProjectId] = useState(projects[0]?.id)
  const [viewId, setViewId] = useState(views[0]?.id)
  const pid = projects.some(p => p.id === projectId) ? projectId : projects[0]?.id
  const missing = (meta.needs === 'view' && !viewId) || ((meta.needs === 'project' || meta.needs === 'scrum') && !pid)

  return (
    <Modal title="Add gadget" onClose={onClose} width={560}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={missing} onClick={() => onAdd({
          id: uid(), kind, projectId: meta.needs === 'project' || meta.needs === 'scrum' ? pid : undefined,
          viewId: meta.needs === 'view' ? viewId : undefined, wide: kind === 'created' || kind === 'burndown',
        })}>Add</button>
      </>}>
      <div className="gadget-picker" role="radiogroup" aria-label="Gadget">
        {GADGETS.map(g => (
          <button key={g.kind} role="radio" aria-checked={kind === g.kind} className={`template-card${kind === g.kind ? ' selected' : ''}`} onClick={() => setKind(g.kind)}>
            <span className="template-name">{g.name}</span>
            <span className="template-desc">{g.desc}</span>
          </button>
        ))}
      </div>
      {(meta.needs === 'project' || meta.needs === 'scrum') && (
        projects.length ? <>
          <label className="label" htmlFor="g-proj" style={{ marginTop: 14 }}>Project</label>
          <select id="g-proj" className="input" value={pid} onChange={e => setProjectId(e.target.value)}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </> : <p className="hint error">{meta.needs === 'scrum' ? 'You need a Scrum project for this gadget.' : 'Create a project first.'}</p>
      )}
      {meta.needs === 'view' && (
        views.length ? <>
          <label className="label" htmlFor="g-view" style={{ marginTop: 14 }}>Saved view</label>
          <select id="g-view" className="input" value={viewId} onChange={e => setViewId(e.target.value)}>
            {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </> : <p className="hint error">Save a search as a view first (Search → Save as view).</p>
      )}
    </Modal>
  )
}

function RenameDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (n: string) => void }) {
  const [v, setV] = useState(name)
  return (
    <Modal title="Rename dashboard" onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</button>
      </>}>
      <input className="input" value={v} onChange={e => setV(e.target.value)} autoFocus aria-label="Dashboard name" onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onSave(v.trim()) }} />
    </Modal>
  )
}

