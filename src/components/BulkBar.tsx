import { useEffect, useState } from 'react'
import { X, Trash2, ArrowRightLeft, Archive, Eye, EyeOff, Shuffle } from 'lucide-react'
import { api, apiEnabled, errorMessage } from '../api/client'
import { issueSync, patchOf } from '../api/sync'
import { mapIssue } from '../api/map'
import { sprintDeps } from '../api/sprints'
import { searchProjects, type ProjectOption } from '../api/work'
import { useStore, type Issue, type IssuePatch, type Priority } from '../data/store'
import { usePublicSettings } from '../api/settings-public'
import { planMove } from './TransitionDialog'
import { useApp } from '../appContext'
import { Modal, Picker, statusOptions, priorityOptions, plural } from './ui'
import { UserPicker } from './UserPicker'
import { can, canAdmin } from '../data/access'
import DeleteItemsDialog from './DeleteItemsDialog'
import { planEpicDrop, planVersionDrop } from './panelRules'

/** Floating "N selected" action bar (Linear style) for any list of work items. */
export default function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [confirm, setConfirm] = useState(false)
  const [moving, setMoving] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [notify, setNotify] = useState(true)
  if (ids.length === 0) return null

  const items = state.issues.filter(i => ids.includes(i.id))
  const projectIds = [...new Set(items.map(i => i.projectId))]
  const project = projectIds.length === 1 ? state.projects.find(p => p.id === projectIds[0]) : undefined
  // Delete issues (spec 0202): only when I may delete in every project the selection is in
  const mayDelete = projectIds.every(id => can(state.projects.find(p => p.id === id), 'deleteIssues'))
  const mayMove = apiEnabled && projectIds.every(id => can(state.projects.find(p => p.id === id), 'moveIssues'))   // spec 0501
  // Jira's "Send mail for this update" (spec 0605 R5): system administrators, or project admins of every item
  const mayQuiet = apiEnabled && (state.isAdmin === true || projectIds.every(id => canAdmin(state.projects.find(p => p.id === id))))
  const sprints = project?.template === 'scrum' ? state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed') : []

  // Epic and fix version, as the backlog's panels set them (spec 0407 R4, R9): a keyboard way to do what dragging does
  const isEpic = (id: string) => state.issues.find(i => i.id === id)?.type === 'epic'
  const epics = project ? state.issues.filter(i => i.type === 'epic' && i.projectId === project.id && i.epicStatus !== 'Done') : []   // Epic Status (spec 0716)
  const versions = project?.releases.filter(r => !r.archived && !r.released) ?? []
  const toEpic = (epicId: string | null) => {
    const plan = planEpicDrop(items, epicId, { isEpic, isSubItem: i => !!i.parentId && !isEpic(i.parentId) })
    if ('blocked' in plan) { toast(plan.blocked, { tone: 'warn' }); return }
    for (const m of plan.moves) dispatch({ type: 'updateIssues', ids: [m.id], patch: { parentId: m.parentId ?? undefined } })
    toast(`Updated epic on ${plural(plan.moves.length, 'item')}`)
  }
  const toVersion = (versionId: string | null) => {
    const moves = planVersionDrop(items, versionId)
    for (const m of moves) dispatch({ type: 'updateIssues', ids: [m.id], patch: { fixReleaseIds: m.fixReleaseIds } })
    toast(`Updated fix versions on ${plural(moves.length, 'item')}`)
  }

  // Jira DC's bulk Archive (spec 0508): system administrators; sub-items go with their parent
  const archiveAll = async () => {
    try {
      await issueSync.idle()
      const r = await api<{ archived: string[] }>('POST', '/api/issues/bulk/archive', { issues: items.map(i => issueSync.serverKey(i)) })
      dispatch({ type: 'mergeIssues', issues: items.map(i => ({ ...i, archivedAt: Date.now() })) })
      toast(`Archived ${plural(r.archived.length, 'item')}`); onClear()
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
  }
  // Jira's bulk Watch and Stop watching (spec 0510 R1)
  const watchAll = async (watching: boolean) => {
    try {
      await issueSync.idle()
      const r = await api<{ count: number }>('POST', '/api/issues/bulk/watch', { issues: items.map(i => issueSync.serverKey(i)), watching })
      for (const i of items) {
        const has = i.watcherIds.includes(state.me!.id)
        if (has !== watching) dispatch({ type: 'mergeIssues', issues: [{ ...i, watcherIds: watching ? [...i.watcherIds, state.me!.id] : i.watcherIds.filter(w => w !== state.me!.id) }] })
      }
      toast(watching ? `Watching ${plural(r.count, 'item')}` : `Stopped watching ${plural(r.count, 'item')}`)
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
  }
  const apply = (patch: IssuePatch, what: string) => {
    let target = ids
    if (patch.status && project) {
      // only items this move can go through for, as they are: a move that asks for input is made one item at a time
      target = items.filter(i => i.status === patch.status || planMove(state, i, patch.status!).kind === 'direct').map(i => i.id)
      const skipped = ids.length - target.length
      if (skipped) toast(`${plural(skipped, 'item')} couldn’t move: the workflow doesn’t allow it, or the move needs details. Move ${skipped === 1 ? 'it' : 'them'} one at a time.`, { tone: 'warn' })
    }
    if (target.length && !notify) {   // straight to the server's bulk edit, which notifies nobody
      const chosen = items.filter(i => target.includes(i.id))
      void issueSync.idle().then(() => api<{ issues: any[] }>('POST', '/api/issues/bulk/edit', {
        issues: chosen.map(i => issueSync.serverKey(i)), patch: patchOf(chosen[0]!, { ...chosen[0]!, ...patch } as any) ?? {}, sendNotifications: false,
      })).then(r => {
        const fresh = r.issues.map(mapIssue)
        issueSync.merge(fresh); dispatch({ type: 'mergeIssues', issues: fresh })
        toast(`Updated ${what} on ${plural(target.length, 'item')}, without notifications`)
      }, e => toast(errorMessage(e), { tone: 'warn' }))
    } else if (target.length) {
      dispatch({ type: 'updateIssues', ids: target, patch })
      toast(`Updated ${what} on ${plural(target.length, 'item')}`, { undo: 'updateIssues' })
    }
  }

  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label={`${ids.length} selected`}>
        <span className="bulk-count">{ids.length} selected</span>
        <button className="icon-btn sm" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)"><X size={14} /></button>
        <span className="bulk-sep" />
        {project && !apiEnabled && (
          <Picker value="" options={statusOptions(project)} onChange={s => apply({ status: s }, 'status')} className="btn btn-ghost btn-sm" title="Change status" trigger="Status" />
        )}
        {apiEnabled && <button className="btn btn-ghost btn-sm" onClick={() => setTransitioning(true)}><Shuffle size={14} />Transition</button>}
        <UserPicker value={undefined} onChange={a => apply({ assigneeId: a }, 'assignee')} className="btn btn-ghost btn-sm" title="Change assignee"
          trigger="Assignee" allowUnassigned projectId={project?.id} />
        <Picker value={'' as Priority | ''} options={priorityOptions()} onChange={p => apply({ priority: p as Priority }, 'priority')} className="btn btn-ghost btn-sm" title="Change priority" trigger="Priority" />
        {sprints.length > 0 && (
          <Picker value={null as string | undefined | null}
            options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name }))]}
            onChange={s => apply({ sprintId: s ?? undefined }, 'sprint')} className="btn btn-ghost btn-sm" title="Move to sprint" trigger="Sprint" />
        )}
        {epics.length > 0 && (
          <Picker value={'' as string} options={[{ value: '-', label: 'No epic' }, ...epics.map(e => ({ value: e.id, label: e.title }))]}
            onChange={e => toEpic(e === '-' ? null : e)} className="btn btn-ghost btn-sm" title="Change epic" trigger="Epic" />
        )}
        {versions.length > 0 && (
          <Picker value={'' as string} options={[{ value: '-', label: 'No fix versions' }, ...versions.map(r => ({ value: r.id, label: r.name }))]}
            onChange={v => toVersion(v === '-' ? null : v)} className="btn btn-ghost btn-sm" title="Add fix version" trigger="Version" />
        )}
        {mayMove && <button className="btn btn-ghost btn-sm" onClick={() => setMoving(true)}><ArrowRightLeft size={14} />Move</button>}
        {apiEnabled && <button className="btn btn-ghost btn-sm" title="Watch them all" onClick={() => void watchAll(true)}><Eye size={14} />Watch</button>}
        {apiEnabled && <button className="btn btn-ghost btn-sm" title="Stop watching them all" onClick={() => void watchAll(false)}><EyeOff size={14} />Unwatch</button>}
        {mayQuiet && <label className="sm nowrap" title="Off: nobody is notified of these changes"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} /> Send notifications</label>}
        {apiEnabled && state.isAdmin === true && <button className="btn btn-ghost btn-sm" onClick={() => void archiveAll()}><Archive size={14} />Archive</button>}
        {mayDelete && <>
          <span className="bulk-sep" />
          <button className="btn btn-ghost btn-sm text-danger" onClick={() => setConfirm(true)}><Trash2 size={14} />Delete</button>
        </>}
      </div>

      {confirm && <DeleteItemsDialog ids={ids} onClose={() => setConfirm(false)} onDeleted={onClear} />}
      {transitioning && <BulkTransition items={items} notify={notify} onClose={() => setTransitioning(false)} />}
      {moving && <BulkMove keys={items.map(i => issueSync.serverKey(i))} from={projectIds} notify={notify} onClose={() => setMoving(false)} onMoved={onClear} />}
    </>
  )
}

/** Jira's bulk Move (spec 0501): the selected items to one project; statuses map by name, else by category. */
function BulkMove({ keys, from, notify, onClose, onMoved }: { keys: string[]; from: string[]; notify: boolean; onClose: () => void; onMoved: () => void }) {
  const { toast } = useApp()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<ProjectOption[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const t = setTimeout(() => searchProjects(query).then(setFound, () => {}), 200); return () => clearTimeout(t) }, [query])
  const target = found.find(p => p.key === query.trim().toUpperCase() || `${p.name} (${p.key})` === query)
  const move = async () => {
    if (!target) return
    setBusy(true); setError('')
    try {
      await issueSync.idle()
      const r = await api<{ moved: { key: string; newKey: string }[] }>('POST', '/api/issues/bulk/move', { issues: keys, projectKey: target.key, sendNotifications: notify })
      for (const id of [...from, target.id]) await sprintDeps.reloadProject(id)
      toast(`Moved ${plural(r.moved.length, 'item')} to ${target.key}`); onMoved(); onClose()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Move ${plural(keys.length, 'item')}`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!target || busy} onClick={() => void move()}>{busy ? 'Moving…' : 'Move'}</button>
    </>}>
      <label className="label" htmlFor="bmv-project">Move to project</label>
      <input id="bmv-project" className="input" list="bmv-projects" value={query} autoFocus placeholder="Type a project’s name or key" onChange={e => setQuery(e.target.value)} />
      <datalist id="bmv-projects">{found.map(p => <option key={p.id} value={`${p.name} (${p.key})`} />)}</datalist>
      <p className="hint">Each item keeps its status where the target’s workflow has it, else one of the same kind. Versions and components go to those of the same name. Sub-items move with their parent; the old keys keep working.</p>
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

/** Jira's bulk Transition (spec 0510 R2): a status by name, the same fields and comment for all; then each item's outcome. */
function BulkTransition({ items, notify, onClose }: { items: Issue[]; notify: boolean; onClose: () => void }) {
  const { state } = useStore()
  const [to, setTo] = useState('')
  const [resolution, setResolution] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<{ key: string; outcome: string; reason?: string }[] | null>(null)
  const [error, setError] = useState('')
  const projects = [...new Set(items.map(i => i.projectId))].map(id => state.projects.find(p => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p)
  const names = [...new Set(projects.flatMap(p => p.statuses.map(s => s.name)))]
  const toDone = projects.some(p => p.statuses.some(s => s.name === to && s.category === 'done'))
  const go = async () => {
    setBusy(true); setError('')
    try {
      await issueSync.idle()
      const r = await api<{ results: { key: string; outcome: string; reason?: string }[] }>('POST', '/api/issues/bulk/transition', {
        issues: items.map(i => issueSync.serverKey(i)), toStatus: to, fields: toDone && resolution ? { resolution } : {}, ...(comment.trim() ? { comment } : {}), sendNotifications: notify })
      setResults(r.results)
      for (const id of projects.map(p => p.id)) await sprintDeps.reloadProject(id)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const { resolutions } = usePublicSettings()
  return (
    <Modal title={`Transition ${plural(items.length, 'item')}`} onClose={onClose} width={560} footer={results ? <button className="btn btn-primary" onClick={onClose}>Close</button> : <>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!to || busy} onClick={() => void go()}>{busy ? 'Moving…' : 'Transition'}</button>
    </>}>
      {results ? (
        <table className="table">
          <thead><tr><th>Item</th><th>Outcome</th></tr></thead>
          <tbody>{results.map(r => (
            <tr key={r.key} style={{ cursor: 'default' }}><td className="mono">{r.key}</td><td className="sm">{r.outcome === 'done' ? 'Moved' : r.outcome === 'unchanged' ? 'Already there' : r.outcome === 'skipped' ? 'Skipped' : 'Not moved'}{r.reason ? <span className="muted">: {r.reason}</span> : null}</td></tr>
          ))}</tbody>
        </table>
      ) : <>
        <label className="label" htmlFor="bt-to">Move to</label>
        <select id="bt-to" className="input" value={to} onChange={e => setTo(e.target.value)}>
          <option value="">Choose a status…</option>
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {toDone && resolutions.length > 0 && <>
          <label className="label" htmlFor="bt-res" style={{ marginTop: 10 }}>Resolution</label>
          <select id="bt-res" className="input" value={resolution} onChange={e => setResolution(e.target.value)}>
            <option value="">The workflow’s default</option>
            {resolutions.map((r: { name: string }) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </>}
        <label className="label" htmlFor="bt-comment" style={{ marginTop: 10 }}>Comment (optional)</label>
        <textarea id="bt-comment" className="input" rows={3} value={comment} onChange={e => setComment(e.target.value)} />
        <p className="hint">Each item moves through a transition its own workflow allows. One that can’t, or whose transition needs something else, is reported and the others still move.</p>
        {error && <p className="hint error" role="alert">{error}</p>}
      </>}
    </Modal>
  )
}

