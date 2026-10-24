import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Status, Transition } from '../../data/store'
import { describeDiff, diffWorkflows, type Workflow } from '../../data/workflow'
import { Modal, plural } from '../ui'
import { timeAgo } from '../../data/store'

// Publishing and versions (Jira keeps every published workflow): the save dialog says what changes and for how many
// work items, and takes a note; the versions dialog lists what was published, compares a version with the workflow
// being edited, and loads one into the editor (nothing changes until it is published again).

/** "Update workflow": what changes, what happens to work items, and a note for the version. */
export function PublishDialog({ before, after, moved, server, onClose, onPublish }: {
  before: Workflow; after: Workflow; moved: { from: string; to: string; count: number }[]; server: boolean
  onClose: () => void; onPublish: (note: string) => void
}) {
  const [note, setNote] = useState('')
  const changes = describeDiff(diffWorkflows(before, after))
  return (
    <Modal title="Update workflow" onClose={onClose} width={540} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Keep editing</button>
      <button className="btn btn-primary" onClick={() => onPublish(note.trim())}>Update workflow</button>
    </>}>
      {changes.length ? <ul className="change-list">{changes.map(c => <li key={c}>{c}</li>)}</ul> : <p className="muted">Only the layout changes.</p>}
      {moved.length > 0 && (
        <div className="callout callout-warn" role="status" style={{ marginTop: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {moved.map(m => <li key={m.from}>Work items in “{m.from}” move to “{m.to}”{m.count ? ` (${plural(m.count, 'item')} here${server ? ', and any not open in this browser' : ''})` : server ? ' (any there are)' : ''}</li>)}
          </ul>
        </div>
      )}
      {server && <>
        <label className="label" htmlFor="pub-note" style={{ marginTop: 12 }}>Note for this version (optional)</label>
        <input id="pub-note" className="input" value={note} maxLength={500} placeholder="e.g. Added a review step" onChange={e => setNote(e.target.value)} />
        <p className="hint">Each update is kept as a version you can compare and go back to.</p>
      </>}
    </Modal>
  )
}

interface VersionRow { version: number; note: string; publishedAt: string; publishedBy: string | null; statuses: number; transitions: number }
interface Snapshot { version: number; statuses: any[]; transitions: any[] }

/** A published version in the editor's shape. Work types that no longer exist are left out of its transitions. */
export function workflowOf(v: Snapshot, layout: Workflow['layout'], typeKeys: string[]): Workflow {
  const statuses: Status[] = v.statuses.map(s => ({ id: s.id, name: s.name, color: s.color, category: s.category,
    ...(s.description ? { description: s.description } : {}), ...(s.wipLimit ? { wipLimit: s.wipLimit } : {}) }))
  const transitions: Transition[] = v.transitions.map(t => {
    const types = (t.typeKeys ?? []).filter((k: string) => typeKeys.includes(k))
    return { id: t.id, name: t.name, from: t.fromIds ?? 'any', to: t.toId ?? null,
      ...(t.rules && Object.keys(t.rules).length ? { rules: t.rules } : {}), ...(types.length ? { types } : {}) }
  })
  return { statuses, transitions, layout }
}

export function VersionsDialog({ projectKey, current, onClose, onRestore }: {
  projectKey: string; current: Workflow; onClose: () => void; onRestore: (v: Snapshot) => void
}) {
  const [rows, setRows] = useState<VersionRow[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Snapshot | null>(null)
  useEffect(() => { api<VersionRow[]>('GET', `/api/projects/${projectKey}/workflow/versions`).then(setRows, e => setError(e instanceof ApiError ? e.message : 'Could not reach the server.')) }, [projectKey])
  const show = (n: number) => api<Snapshot>('GET', `/api/projects/${projectKey}/workflow/versions/${n}`).then(setOpen, () => setError('Could not load that version.'))
  const changes = open ? describeDiff(diffWorkflows(workflowOf(open, {}, []), current)) : []

  return (
    <Modal title={open ? `Version ${open.version}` : 'Workflow versions'} onClose={onClose} width={600} footer={open ? <>
      <button className="btn btn-secondary" onClick={() => setOpen(null)}>All versions</button>
      <button className="btn btn-primary" onClick={() => onRestore(open)}>Load into the editor</button>
    </> : undefined}>
      {error && <p className="hint error" role="alert">{error}</p>}
      {!open && !rows && !error && <p className="muted" role="status">Loading…</p>}
      {!open && rows && !rows.length && <p className="muted">Nothing published yet. Each time you update the workflow, a version is kept here.</p>}
      {!open && rows && rows.length > 0 && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Version</th><th>Note</th><th>Published</th><th>Shape</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.version} tabIndex={0} onClick={() => show(r.version)} onKeyDown={e => e.key === 'Enter' && show(r.version)}>
                  <td>{r.version}</td>
                  <td>{r.note || <span className="muted">No note</span>}</td>
                  <td className="muted sm">{timeAgo(Date.parse(r.publishedAt))}{r.publishedBy ? ` by ${r.publishedBy}` : ''}</td>
                  <td className="muted sm">{plural(r.statuses, 'status')}, {plural(r.transitions, 'transition')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <>
        <p className="muted">Going from version {open.version} to the workflow in the editor:</p>
        {changes.length ? <ul className="change-list">{changes.map(c => <li key={c}>{c}</li>)}</ul> : <p>They are the same.</p>}
        <p className="hint">Loading it replaces what is in the editor. Nothing changes for anyone until you update the workflow; statuses it doesn’t have send their work items to a status you can review first.</p>
      </>}
    </Modal>
  )
}
