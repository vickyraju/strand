import { useState } from 'react'
import { Plus, Rocket, ArrowLeft, MoreHorizontal, Pencil, Trash2, CalendarDays } from 'lucide-react'
import { useStore, uid, isDone, type Project, type Release } from '../data/store'
import { useApp } from '../appContext'
import IssueTable, { type TableGroup } from './IssueTable'
import { Empty, Menu, Modal, plural, formatDate } from './ui'

type ReleaseState = 'released' | 'overdue' | 'unreleased'
const today = () => new Date().toISOString().slice(0, 10)

export function releaseState(r: Release): ReleaseState {
  if (r.released) return 'released'
  return r.releaseDate && r.releaseDate < today() ? 'overdue' : 'unreleased'
}
const STATE_LABEL: Record<ReleaseState, [string, string]> = {
  released: ['Released', 'lozenge-done'], overdue: ['Overdue', 'lozenge-overdue'], unreleased: ['Unreleased', 'lozenge-todo'],
}

export default function ReleasesView({ project, releaseId }: { project: Project; releaseId?: string }) {
  const { state, dispatch } = useStore()
  const { openProject, toast } = useApp()
  const [editing, setEditing] = useState<Release | null>(null)
  const [releasing, setReleasing] = useState<Release | null>(null)
  const [deleting, setDeleting] = useState<Release | null>(null)
  const [groupBy, setGroupBy] = useState<TableGroup>('status')
  const releases = project.releases
  const setReleases = (next: Release[]) => dispatch({ type: 'updateProject', id: project.id, patch: { releases: next } })
  const itemsOf = (r: Release) => state.issues.filter(i => i.projectId === project.id && i.releaseId === r.id)
  const current = releases.find(r => r.id === releaseId)

  const actions = (r: Release) => (
    <Menu title={`Actions for ${r.name}`} className="icon-btn sm" trigger={<MoreHorizontal size={15} />} items={[
      { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setEditing(r) },
      ...(r.released
        ? [{ label: 'Mark as unreleased', icon: <Rocket size={14} />, onClick: () => setReleases(releases.map(x => x.id === r.id ? { ...x, released: false, releasedAt: undefined } : x)) }]
        : [{ label: 'Release', icon: <Rocket size={14} />, onClick: () => setReleasing(r) }]),
      { label: 'Delete', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setDeleting(r) },
    ]} />
  )

  const progress = (r: Release) => {
    const items = itemsOf(r)
    const done = items.filter(i => isDone(project, i)).length
    const inProgress = items.filter(i => project.statuses.find(s => s.id === i.status)?.category === 'in-progress').length
    return { items, done, inProgress, todo: items.length - done - inProgress }
  }

  const modals = <>
    {editing && (
      <ReleaseDialog release={editing} isNew={!releases.some(r => r.id === editing.id)} onClose={() => setEditing(null)}
        onSave={r => { setReleases(releases.some(x => x.id === r.id) ? releases.map(x => x.id === r.id ? r : x) : [...releases, r]); toast(`Saved ${r.name}`); setEditing(null) }} />
    )}
    {releasing && <ReleaseDialogConfirm project={project} release={releasing} onClose={() => setReleasing(null)} />}
    {deleting && (
      <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => {
            const ids = itemsOf(deleting).map(i => i.id)
            if (ids.length) dispatch({ type: 'updateIssues', ids, patch: { releaseId: undefined } })
            setReleases(releases.filter(r => r.id !== deleting.id)); setDeleting(null)
            if (current) openProject(project.id, 'releases')
          }}>Delete release</button>
        </>}>
        <p>{plural(itemsOf(deleting).length, 'work item')} will no longer be in a release. The items themselves aren’t deleted.</p>
      </Modal>
    )}
  </>

  // ── One release ───────────────────────────────────────────
  if (current) {
    const p = progress(current)
    const [label, cls] = STATE_LABEL[releaseState(current)]
    return (
      <div className="page-col">
        <div className="wf-bar">
          <button className="btn btn-ghost" onClick={() => openProject(project.id, 'releases')}><ArrowLeft size={15} />Releases</button>
          <h2 className="wf-title">{current.name}</h2>
          <span className={`lozenge ${cls}`}>{label}</span>
          <span className="muted sm"><CalendarDays size={13} style={{ verticalAlign: -2 }} /> {current.startDate ? formatDate(current.startDate) : 'No start'} – {current.releaseDate ? formatDate(current.releaseDate) : 'No release date'}</span>
          <div style={{ flex: 1 }} />
          {!current.released && <button className="btn btn-primary" onClick={() => setReleasing(current)}><Rocket size={15} />Release</button>}
          {actions(current)}
        </div>
        <div className="release-summary">
          {current.description && <p className="muted">{current.description}</p>}
          <div className="kpis">
            <div><b>{p.items.length}</b><span>work items</span></div>
            <div><b>{p.done}</b><span>done</span></div>
            <div><b>{p.inProgress}</b><span>in progress</span></div>
            <div><b>{p.todo}</b><span>to do</span></div>
          </div>
          <ReleaseBar {...p} />
        </div>
        <IssueTable id={`release:${current.id}`} issues={p.items} project={project} groupBy={groupBy} onGroupBy={setGroupBy}
          emptyText="No work items in this release yet. Set the Release field on work items to add them." />
        {modals}
      </div>
    )
  }

  // ── All releases ──────────────────────────────────────────
  if (releases.length === 0) {
    return <>
      <Empty icon={<Rocket size={22} strokeWidth={1.5} />} title="Plan what ships when"
        body="Releases group work items into versions you ship, with progress and dates. Add work to a release from its Release field."
        action={<button className="btn btn-primary" onClick={() => setEditing({ id: uid(), name: '', description: '', released: false })}><Plus size={15} />Create release</button>} />
      {modals}
    </>
  }
  const sorted = [...releases].sort((a, b) => Number(a.released) - Number(b.released) || (a.releaseDate ?? '9').localeCompare(b.releaseDate ?? '9'))
  return (
    <div className="page-col">
      <div className="toolbar">
        <span className="muted">{plural(releases.filter(r => !r.released).length, 'unreleased version')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setEditing({ id: uid(), name: '', description: '', released: false })}><Plus size={15} />Create release</button>
      </div>
      <div className="table-scroll" style={{ paddingTop: 12 }}>
        <table className="table" style={{ minWidth: 820 }}>
          <thead>
            <tr><th>Version</th><th style={{ width: 120 }}>Status</th><th style={{ width: 260 }}>Progress</th><th style={{ width: 120 }}>Start</th><th style={{ width: 120 }}>Release</th><th style={{ width: 300 }}>Description</th><th style={{ width: 48 }} /></tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const p = progress(r)
              const [label, cls] = STATE_LABEL[releaseState(r)]
              return (
                <tr key={r.id} tabIndex={0} onClick={() => openProject(project.id, 'releases', r.id)} onKeyDown={e => e.key === 'Enter' && openProject(project.id, 'releases', r.id)}>
                  <td><span className="cell-flex strong"><Rocket size={15} className="muted" />{r.name}</span></td>
                  <td><span className={`lozenge ${cls}`}>{label}</span></td>
                  <td><span className="cell-flex"><ReleaseBar {...p} /><span className="muted sm nowrap">{p.done}/{p.items.length}</span></span></td>
                  <td className="muted">{r.startDate ? formatDate(r.startDate) : '—'}</td>
                  <td className={releaseState(r) === 'overdue' ? 'text-danger' : 'muted'}>{r.releaseDate ? formatDate(r.releaseDate) : '—'}</td>
                  <td className="muted"><span className="cell-ellipsis" style={{ display: 'block' }}>{r.description}</span></td>
                  <td onClick={e => e.stopPropagation()}>{actions(r)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {modals}
    </div>
  )
}

function ReleaseBar({ items, done, inProgress, todo }: { items: unknown[]; done: number; inProgress: number; todo: number }) {
  return (
    <span className="release-bar" title={`${done} done · ${inProgress} in progress · ${todo} to do`}>
      {items.length === 0 ? null : <>
        <span style={{ flex: done, background: 'var(--success)' }} />
        <span style={{ flex: inProgress, background: 'var(--info)' }} />
        <span style={{ flex: todo, background: 'var(--border-strong)' }} />
      </>}
    </span>
  )
}

function ReleaseDialog({ release, isNew, onClose, onSave }: { release: Release; isNew: boolean; onClose: () => void; onSave: (r: Release) => void }) {
  const [r, setR] = useState(release)
  const invalidDates = !!(r.startDate && r.releaseDate && r.startDate > r.releaseDate)
  return (
    <Modal title={isNew ? 'Create release' : `Edit ${release.name}`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!r.name.trim() || invalidDates} onClick={() => onSave({ ...r, name: r.name.trim(), description: r.description.trim() })}>Save</button>
      </>}>
      <label className="label" htmlFor="rel-name">Version name</label>
      <input id="rel-name" className="input" value={r.name} onChange={e => setR({ ...r, name: e.target.value })} placeholder="e.g. 2.6.0" autoFocus />
      <div className="form-row" style={{ marginTop: 14 }}>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="rel-start">Start date</label>
          <input id="rel-start" className="input" type="date" value={r.startDate ?? ''} onChange={e => setR({ ...r, startDate: e.target.value || undefined })} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="rel-date">Release date</label>
          <input id="rel-date" className="input" type="date" value={r.releaseDate ?? ''} aria-invalid={invalidDates} onChange={e => setR({ ...r, releaseDate: e.target.value || undefined })} />
        </div>
      </div>
      {invalidDates && <p className="hint error">The release date must be after the start date.</p>}
      <label className="label" htmlFor="rel-desc" style={{ marginTop: 14 }}>Description</label>
      <textarea id="rel-desc" className="input" rows={3} value={r.description} onChange={e => setR({ ...r, description: e.target.value })} placeholder="What’s in this release?" />
    </Modal>
  )
}

function ReleaseDialogConfirm({ project, release, onClose }: { project: Project; release: Release; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const open = state.issues.filter(i => i.projectId === project.id && i.releaseId === release.id && !isDone(project, i))
  const others = project.releases.filter(r => r.id !== release.id && !r.released)
  const [moveTo, setMoveTo] = useState<string>(others[0]?.id ?? '')
  return (
    <Modal title={`Release ${release.name}`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => {
          dispatch({ type: 'releaseVersion', projectId: project.id, releaseId: release.id, moveTo: moveTo || undefined })
          toast(`${release.name} released`, { undo: 'releaseVersion' }); onClose()
        }}><Rocket size={15} />Release</button>
      </>}>
      {open.length === 0 ? <p>All work in {release.name} is done. Ready to ship.</p> : (
        <>
          <p className="callout callout-warn" style={{ marginBottom: 12 }}>{plural(open.length, 'work item')} in this release {open.length === 1 ? 'isn’t' : 'aren’t'} done yet.</p>
          <label className="label" htmlFor="rel-move">Move unfinished work to</label>
          <select id="rel-move" className="input" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
            {others.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            <option value="">No release</option>
          </select>
        </>
      )}
    </Modal>
  )
}
