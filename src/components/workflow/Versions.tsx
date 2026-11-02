import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { Status, Transition } from '../../data/store'
import { describeDiff, diffWorkflows, type Workflow } from '../../data/workflow'
import { Modal, openRow, plural } from '../ui'
import { timeAgo } from '../../data/store'

// Publishing and versions (Jira keeps every published workflow): the save dialog says what changes, which projects it
// reaches and what happens to their work items, and takes a note; the versions dialog lists what was published, compares
// a version with the workflow being edited, and loads one into the editor (nothing changes until it is published again).

/** What applying a workflow did, or would do, to one project (the server's report). */
export interface Impact { project: { id: string; key: string; name: string }; added: string[]; removed: string[]; moves: { type: string; from: string; to: string; count: number }[] }

/** One project's part of a change, in a line: "PAY: adds Review; 3 items move from Review to Done". */
export const impactLine = (i: Impact) => [
  i.added.length ? `adds ${i.added.join(', ')}` : '', i.removed.length ? `removes ${i.removed.join(', ')}` : '',
  ...i.moves.map(m => `${plural(m.count, `${m.type.replace(/_/g, ' ')} item`)} move${m.count === 1 ? 's' : ''} from ${m.from} to ${m.to}`),
].filter(Boolean).join('; ') || 'nothing else changes'

/** "Update workflow": what changes, where work items go, the projects it reaches (null while that's worked out), and a note. */
export function PublishDialog({ before, after, moved, impact, onClose, onPublish }: {
  before: Workflow; after: Workflow; moved: { from: string; to: string }[]; impact: Impact[] | null
  onClose: () => void; onPublish: (note: string) => void
}) {
  const [note, setNote] = useState('')
  const changes = describeDiff(diffWorkflows(before, after))
  return (
    <Modal title="Update workflow" onClose={onClose} width={540} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Keep editing</button>
      <button className="btn btn-primary" disabled={!impact} onClick={() => onPublish(note.trim())}>Update workflow</button>
    </>}>
      {changes.length ? <ul className="change-list">{changes.map(c => <li key={c}>{c}</li>)}</ul> : <p className="muted">Only the layout changes.</p>}
      {moved.length > 0 && (
        <div className="callout callout-warn" role="status" style={{ marginTop: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {moved.map(m => <li key={m.from}>Work items in “{m.from}” move to “{m.to}”, in every project</li>)}
          </ul>
        </div>
      )}
      <div className="wf-impact" role="region" aria-label="Projects">
        {!impact ? <p className="muted" role="status">Working out which projects this reaches…</p>
          : !impact.length ? <p className="muted">No project uses this workflow yet.</p>
          : <>
            <p><b>Applies to {plural(impact.length, 'project')}</b> straight away:</p>
            <ul className="change-list">{impact.map(i => <li key={i.project.id}><b>{i.project.key}</b> {i.project.name}: {impactLine(i)}</li>)}</ul>
          </>}
      </div>
      <label className="label" htmlFor="pub-note" style={{ marginTop: 12 }}>Note for this version (optional)</label>
      <input id="pub-note" className="input" value={note} maxLength={500} placeholder="e.g. Added a review step" onChange={e => setNote(e.target.value)} />
      <p className="hint">Each update is kept as a version you can compare and go back to.</p>
    </Modal>
  )
}

interface VersionRow { version: number; note: string; publishedAt: string; publishedBy: string | null; statuses: number; transitions: number }
interface Snapshot { version: number; statuses: any[]; transitions: any[] }

/** A workflow from the server (as published, or a published version) in the editor's shape. */
export function workflowOf(v: { statuses: any[]; transitions: any[] }, layout: Workflow['layout']): Workflow {
  const statuses: Status[] = v.statuses.map(s => ({ id: s.id, name: s.name, color: s.color, category: s.category, ...(s.description ? { description: s.description } : {}) }))
  const transitions: Transition[] = v.transitions.map(t => ({ id: t.id, name: t.name, from: t.fromIds ?? 'any', to: t.toId ?? null,
    ...(t.rules && Object.keys(t.rules).length ? { rules: t.rules } : {}) }))
  return { statuses, transitions, layout }
}

export function VersionsDialog({ workflowId, current, onClose, onRestore }: {
  workflowId: string; current: Workflow; onClose: () => void; onRestore: (v: Snapshot) => void
}) {
  const [rows, setRows] = useState<VersionRow[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Snapshot | null>(null)
  useEffect(() => { api<VersionRow[]>('GET', `/api/workflows/${workflowId}/versions`).then(setRows, e => setError(errorMessage(e))) }, [workflowId])
  const show = (n: number) => api<Snapshot>('GET', `/api/workflows/${workflowId}/versions/${n}`).then(setOpen, () => setError('Could not load that version.'))
  const changes = open ? describeDiff(diffWorkflows(workflowOf(open, {}), current)) : []

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
                <tr key={r.version} {...openRow(() => void show(r.version), `Version ${r.version}`)}>
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
