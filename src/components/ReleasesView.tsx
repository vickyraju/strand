import { useEffect, useState, type ReactNode } from 'react'
import { Plus, Rocket, ArrowLeft, MoreHorizontal, Pencil, Trash2, CalendarDays, Archive, Merge } from 'lucide-react'
import { useStore, uid, isDone, itemsInRelease, type Project, type Release } from '../data/store'
import { useApp } from '../appContext'
import IssueTable, { type TableGroup } from './IssueTable'
import { Empty, Menu, Modal, plural, formatDate } from './ui'
import { api, apiEnabled, errorMessage } from '../api/client'
import { issueSync } from '../api/sync'
import { changeOnServer } from '../api/settings'

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
  const [merging, setMerging] = useState<Release | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [groupBy, setGroupBy] = useState<TableGroup>('status')
  const releases = project.releases
  const setReleases = (next: Release[]) => dispatch({ type: 'updateProject', id: project.id, patch: { releases: next } })
  const itemsOf = (r: Release) => itemsInRelease(state.issues.filter(i => i.projectId === project.id), r.id)
  const current = releases.find(r => r.id === releaseId)

  const archive = (r: Release, archived: boolean) => { setReleases(releases.map(x => x.id === r.id ? { ...x, archived } : x)); toast(`${r.name} ${archived ? 'archived' : 'unarchived'}`) }
  // Jira's version actions; an archived version only comes back or goes (spec 0304 R4)
  const actions = (r: Release) => (
    <Menu title={`Actions for ${r.name}`} className="icon-btn sm" trigger={<MoreHorizontal size={15} />} items={r.archived ? [
      { label: 'Unarchive', icon: <Archive size={14} />, onClick: () => archive(r, false) },
      { label: 'Delete', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setDeleting(r) },
    ] : [
      { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setEditing(r) },
      ...(r.released
        ? [{ label: 'Mark as unreleased', icon: <Rocket size={14} />, onClick: () => setReleases(releases.map(x => x.id === r.id ? { ...x, released: false, releasedAt: undefined } : x)) }]
        : [{ label: 'Release', icon: <Rocket size={14} />, onClick: () => setReleasing(r) }]),
      ...(releases.some(x => x.id !== r.id && !x.archived) ? [{ label: 'Merge into another version', icon: <Merge size={14} />, onClick: () => setMerging(r) }] : []),
      { label: 'Archive', icon: <Archive size={14} />, onClick: () => archive(r, true) },
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
    {deleting && <DeleteVersionDialog project={project} release={deleting} onClose={() => setDeleting(null)}
      onDone={() => { setDeleting(null); if (current) openProject(project.id, 'releases') }} />}
    {merging && <MergeVersionDialog project={project} release={merging} onClose={() => setMerging(null)}
      onDone={() => { setMerging(null); if (current) openProject(project.id, 'releases') }} />}
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
          {current.archived && <span className="lozenge">Archived</span>}
          <span className="muted sm"><CalendarDays size={13} style={{ verticalAlign: -2 }} /> {current.startDate ? formatDate(current.startDate) : 'No start'} – {current.releaseDate ? formatDate(current.releaseDate) : 'No release date'}</span>
          <div style={{ flex: 1 }} />
          {!current.released && !current.archived && <button className="btn btn-primary" onClick={() => setReleasing(current)}><Rocket size={15} />Release</button>}
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
          emptyText="No work items in this release yet. Set the Fix versions field on work items to add them." />
        {modals}
      </div>
    )
  }

  // ── All releases ──────────────────────────────────────────
  if (releases.length === 0) {
    return <>
      <Empty icon={<Rocket size={22} strokeWidth={1.5} />} title="Plan what ships when"
        body="Releases group work items into versions you ship, with progress and dates. Add work to a release from its Fix versions field."
        action={<button className="btn btn-primary" onClick={() => setEditing({ id: uid(), name: '', description: '', released: false })}><Plus size={15} />Create release</button>} />
      {modals}
    </>
  }
  const archived = releases.filter(r => r.archived).length
  const sorted = releases.filter(r => showArchived || !r.archived).sort((a, b) => Number(a.released) - Number(b.released) || (a.releaseDate ?? '9').localeCompare(b.releaseDate ?? '9'))
  return (
    <div className="page-col">
      <div className="toolbar">
        <span className="muted">{plural(releases.filter(r => !r.released && !r.archived).length, 'unreleased version')}</span>
        <div style={{ flex: 1 }} />
        {archived > 0 && <label className="cell-flex sm"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />Show archived ({archived})</label>}
        <button className="btn btn-primary" onClick={() => setEditing({ id: uid(), name: '', description: '', released: false })}><Plus size={15} />Create release</button>
      </div>
      <div className="table-scroll" style={{ paddingTop: 12 }}>
        <table className="table" style={{ minWidth: 820 }}>
          <thead>
            <tr><th>Version</th><th style={{ width: 120 }}>Status</th><th style={{ width: 260 }}>Progress</th><th style={{ width: 120 }}>Start</th><th style={{ width: 120 }}>Release</th><th style={{ width: 300 }}>Description</th><th style={{ width: 48 }}><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const p = progress(r)
              const [label, cls] = STATE_LABEL[releaseState(r)]
              return (
                <tr key={r.id} tabIndex={0} onClick={() => openProject(project.id, 'releases', r.id)} onKeyDown={e => e.key === 'Enter' && openProject(project.id, 'releases', r.id)}>
                  <td><span className="cell-flex strong"><Rocket size={15} className="muted" />{r.name}</span></td>
                  <td><span className={`lozenge ${cls}`}>{r.archived ? 'Archived' : label}</span></td>
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
  const open = state.issues.filter(i => i.projectId === project.id && !!i.fixReleaseIds?.includes(release.id) && !isDone(project, i))
  const others = project.releases.filter(r => r.id !== release.id && !r.released && !r.archived)
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
            <option value="">Leave it in {release.name}</option>
          </select>
        </>
      )}
    </Modal>
  )
}

/** Fix or affects versions with `from` in them get `to` instead (once), or lose it. */
const swap = (list: string[] | undefined, from: string, to?: string) => list?.includes(from) ? [...new Set(list.flatMap(x => x === from ? (to ? [to] : []) : [x]))] : list

/** How many live items have a version as a fix and as an affects version: from the server (it may hold more than this
 *  browser has loaded), else counted here. */
function useUsage(project: Project, release: Release) {
  const { state } = useStore()
  const mine = state.issues.filter(i => i.projectId === project.id)
  const local = { fix: mine.filter(i => i.fixReleaseIds?.includes(release.id)).length, affects: mine.filter(i => i.affectsReleaseIds?.includes(release.id)).length }
  const [usage, setUsage] = useState<{ fix: number; affects: number } | null>(apiEnabled ? null : local)
  useEffect(() => {
    if (apiEnabled) api<{ fix: number; affects: number }>('GET', `/api/projects/${project.key}/releases/${release.id}/usage`).then(setUsage, () => setUsage(local))
  }, [project.key, release.id])   // eslint-disable-line react-hooks/exhaustive-deps
  return usage
}

/** Changes a version on the server with its items (or, in a workspace kept in this browser, here), then shows `next`. */
function useVersionChange(project: Project) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  return async (o: { call: () => Promise<unknown>; next: Release[]; local: (i: (typeof state.issues)[number]) => Partial<{ fixReleaseIds: string[]; affectsReleaseIds: string[] }> | null; done: string }) => {
    const show = () => dispatch({ type: 'updateProject', id: project.id, patch: { releases: o.next } })
    try {
      if (apiEnabled) { await issueSync.idle(); await changeOnServer('releases', o.call, { ...project, releases: o.next }, show) }
      else {
        for (const i of state.issues.filter(i => i.projectId === project.id)) { const patch = o.local(i); if (patch) dispatch({ type: 'updateIssues', ids: [i.id], patch }) }
        show()
      }
      toast(o.done)
      return true
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }); return false }
  }
}

function VersionChoice({ id, label, project, not, value, onChange, none }: { id: string; label: string; project: Project; not: string; value: string; onChange: (v: string) => void; none?: string }) {
  return <>
    <label className="label" htmlFor={id}>{label}</label>
    <select id={id} className="input" value={value} onChange={e => onChange(e.target.value)}>
      {none !== undefined && <option value="">{none}</option>}
      {project.releases.filter(r => r.id !== not && !r.archived).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  </>
}

/** Jira's Delete version: its items' fix and affects versions can each move to another version, or lose it (spec 0304 R1). */
function DeleteVersionDialog({ project, release, onClose, onDone }: { project: Project; release: Release; onClose: () => void; onDone: () => void }) {
  const usage = useUsage(project, release)
  const change = useVersionChange(project)
  const [fixTo, setFixTo] = useState(''), [affectsTo, setAffectsTo] = useState('')
  const q = new URLSearchParams({ ...(fixTo ? { fixTo } : {}), ...(affectsTo ? { affectsTo } : {}) }).toString()
  const body: ReactNode = !usage ? <p className="muted">Counting its work items…</p> : !usage.fix && !usage.affects ? <p>No work items use {release.name}.</p> : <>
    {usage.fix > 0 && <div style={{ marginBottom: 14 }}><VersionChoice id="del-fix" project={project} not={release.id} value={fixTo} onChange={setFixTo}
      label={`${plural(usage.fix, 'work item')} ${usage.fix === 1 ? 'has' : 'have'} it as a fix version: move to`} none="Remove it from them" /></div>}
    {usage.affects > 0 && <div style={{ marginBottom: 14 }}><VersionChoice id="del-affects" project={project} not={release.id} value={affectsTo} onChange={setAffectsTo}
      label={`${plural(usage.affects, 'work item')} ${usage.affects === 1 ? 'has' : 'have'} it as an affects version: move to`} none="Remove it from them" /></div>}
    <p className="muted sm">The work items themselves aren’t deleted.</p>
  </>
  return (
    <Modal title={`Delete ${release.name}?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" disabled={!usage} onClick={async () => {
        const ok = await change({
          call: () => api('DELETE', `/api/projects/${project.key}/releases/${release.id}${q ? `?${q}` : ''}`),
          next: project.releases.filter(r => r.id !== release.id),
          local: i => (i.fixReleaseIds?.includes(release.id) || i.affectsReleaseIds?.includes(release.id))
            ? { fixReleaseIds: swap(i.fixReleaseIds, release.id, fixTo || undefined) ?? [], affectsReleaseIds: swap(i.affectsReleaseIds, release.id, affectsTo || undefined) ?? [] } : null,
          done: `${release.name} deleted`,
        })
        if (ok) onDone()
      }}>Delete version</button>
    </>}>{body}</Modal>
  )
}

/** Jira's Merge versions: this version's items get the chosen one instead, and this one is deleted (spec 0304 R3). */
function MergeVersionDialog({ project, release, onClose, onDone }: { project: Project; release: Release; onClose: () => void; onDone: () => void }) {
  const usage = useUsage(project, release)
  const change = useVersionChange(project)
  const [into, setInto] = useState(project.releases.find(r => r.id !== release.id && !r.archived)?.id ?? '')
  const target = project.releases.find(r => r.id === into)
  return (
    <Modal title={`Merge ${release.name}`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!target} onClick={async () => {
        const ok = await change({
          call: () => api('POST', `/api/projects/${project.key}/releases/${into}/merge`, { from: [release.id] }),
          next: project.releases.filter(r => r.id !== release.id),
          local: i => (i.fixReleaseIds?.includes(release.id) || i.affectsReleaseIds?.includes(release.id))
            ? { fixReleaseIds: swap(i.fixReleaseIds, release.id, into) ?? [], affectsReleaseIds: swap(i.affectsReleaseIds, release.id, into) ?? [] } : null,
          done: `${release.name} merged into ${target!.name}`,
        })
        if (ok) onDone()
      }}><Merge size={15} />Merge</button>
    </>}>
      <div style={{ marginBottom: 14 }}><VersionChoice id="merge-into" label="Merge into" project={project} not={release.id} value={into} onChange={setInto} /></div>
      <p className="muted sm">{usage ? `${plural(usage.fix + usage.affects, 'use')} of ${release.name} on work items will point to ${target?.name ?? 'the version you choose'}. ` : ''}{release.name} is then deleted.</p>
    </Modal>
  )
}
