import { useEffect, useState, type ReactNode } from 'react'
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

/** What a change does across every project it reaches (the server's summary: never a line per project). */
export interface Summary { projects: number; changed: number; itemsMoved: number; added: string[]; removed: string[]; moves: { from: string; to: string; count: number }[]; top: Impact[] }

/** A change's reach, readable at any size: how many projects, how many change and how many items move (and where), and
 *  the projects most affected. `children`: where to see every project (a count that opens the list). */
export function SummaryView({ s, children }: { s: Summary; children?: ReactNode }) {
  if (!s.projects) return <p className="muted">No project uses this yet, so no project changes.</p>
  return (
    <div className="summary">
      <p><b>Applies to {plural(s.projects, 'project')}</b>{children ? <> ({children})</> : null}.{' '}
        {s.changed ? <>{s.changed === s.projects ? (s.projects === 1 ? 'It changes' : 'Every one changes') : `${s.changed.toLocaleString()} of them change`}{s.added.length || s.removed.length ? ': ' : ''}{[s.added.length ? `${s.changed === 1 ? 'it gains' : 'they gain'} ${s.added.join(', ')}` : '', s.removed.length ? `${s.added.length ? '' : s.changed === 1 ? 'it ' : 'they '}lose${s.changed === 1 ? 's' : ''} ${s.removed.join(', ')}` : ''].filter(Boolean).join(' and ')}.</>
          : 'None of them changes beyond their transitions.'}</p>
      {s.itemsMoved > 0 && <>
        <p><b>{plural(s.itemsMoved, 'work item')}</b> move{s.itemsMoved === 1 ? 's' : ''} to another status:</p>
        <ul className="change-list">{s.moves.map(m => <li key={`${m.from}>${m.to}`}>{m.count.toLocaleString()} from {m.from} to {m.to}</li>)}</ul>
      </>}
      {s.top.length > 0 && <>
        <p className="muted sm" style={{ marginTop: 8 }}>{s.changed > s.top.length ? `The ${s.top.length} projects most changed` : s.changed === 1 ? 'The project that changes' : 'Projects that change'}:</p>
        <ul className="change-list sm">{s.top.map(i => <li key={i.project.id}><b>{i.project.key}</b> {i.project.name}: {impactLine(i)}</li>)}</ul>
      </>}
      {s.projects > 1 && <p className="hint">It applies in the background, a project at a time; you can leave this page. Each moved item’s history says so.</p>}
    </div>
  )
}

/** "Update workflow": what changes, where work items go, what it does to the projects using it (null while that's worked out), and a note. */
export function PublishDialog({ before, after, moved, impact, onClose, onPublish, seeAll }: {
  before: Workflow; after: Workflow; moved: { from: string; to: string }[]; impact: Summary | null; seeAll?: ReactNode
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
        {!impact ? <p className="muted" role="status">Working out what this does to the projects using it…</p> : <SummaryView s={impact}>{seeAll}</SummaryView>}
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
