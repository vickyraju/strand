// Create board (Jira's "Create board"): a name, Scrum or Kanban (fixed once made), and which work items it shows: this
// project's, or whatever a filter (JQL, any projects) finds, with a count of matches while it is written.
import { useEffect, useState } from 'react'
import { Columns2, ListChecks } from 'lucide-react'
import type { Board, Project } from '../../data/store'
import { api, errorMessage } from '../../api/client'
import JqlBox from '../JqlBox'
import { Modal, plural } from '../ui'

const TYPES = [
  { id: 'kanban', name: 'Kanban', desc: 'Work flows across the board; Done items drop off after 14 days.', Icon: Columns2 },
  { id: 'scrum', name: 'Scrum', desc: 'The board shows the active sprint, planned in its backlog.', Icon: ListChecks },
] as const

export default function CreateBoard({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (b: Board) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<Board['type']>(project.template)
  const [source, setSource] = useState<'project' | 'filter'>('project')
  const [jql, setJql] = useState(`project = ${project.key}`)
  const [check, setCheck] = useState<{ jql: string; count?: number; error?: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // How many items the filter finds, a moment after typing stops (and at once on Check)
  const run = (q: string) => api<{ count: number }>('POST', '/api/jql/check', { jql: q })
    .then(r => setCheck({ jql: q, count: r.count }), e => setCheck({ jql: q, error: errorMessage(e) }))
  useEffect(() => {
    if (source !== 'filter' || !jql.trim()) return
    const t = setTimeout(() => run(jql.trim()), 500)
    return () => clearTimeout(t)
  }, [jql, source])   // eslint-disable-line react-hooks/exhaustive-deps
  const checked = check?.jql === jql.trim() ? check : undefined

  const ready = name.trim() && (source === 'project' || (jql.trim() && !checked?.error)) && !busy
  const submit = async () => {
    if (!ready) return
    setBusy(true); setError('')
    try { onCreated(await api<Board>('POST', `/api/projects/${encodeURIComponent(project.key)}/boards`, { name: name.trim(), type, ...(source === 'filter' ? { jql: jql.trim() } : {}) })) }
    catch (e) { setError(errorMessage(e)); setBusy(false) }
  }

  return (
    <Modal title="Create board" onClose={onClose} width={600} footer={<>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form="create-board" className="btn btn-primary" disabled={!ready}>{busy ? 'Creating…' : 'Create board'}</button>
    </>}>
      <form id="create-board" onSubmit={e => { e.preventDefault(); void submit() }}>
        <label className="label" htmlFor="cb-name">Name</label>
        <input id="cb-name" className="input" value={name} maxLength={100} placeholder="e.g. Bugs board" autoFocus onChange={e => setName(e.target.value)} />

        <label className="label" style={{ marginTop: 18 }}>Type</label>
        <div className="template-grid" role="radiogroup" aria-label="Type">
          {TYPES.map(({ id, name: tName, desc, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={type === id} className={`template-card${type === id ? ' selected' : ''}`} onClick={() => setType(id)}>
              <span className="template-icon"><Icon size={18} strokeWidth={1.75} /></span>
              <span className="template-name">{tName}</span>
              <span className="template-desc">{desc}</span>
            </button>
          ))}
        </div>
        <div className="hint">The type can’t be changed once the board is made.</div>

        <fieldset style={{ border: 0, padding: 0, margin: '18px 0 0', minWidth: 0 }}>
          <legend className="label">Work items</legend>
          <label className="radio-row">
            <input type="radio" name="cb-source" checked={source === 'project'} onChange={() => setSource('project')} />
            <span>Everything in {project.name}</span>
          </label>
          <label className="radio-row">
            <input type="radio" name="cb-source" checked={source === 'filter'} onChange={() => setSource('filter')} />
            <span>Work items a filter finds (from this project or several)</span>
          </label>
        </fieldset>
        {source === 'filter' && (
          <div style={{ marginTop: 8 }}>
            <JqlBox value={jql} action="Check" onChange={setJql} onRun={q => { setJql(q); void run(q) }} serverError={checked?.error} />
            {checked?.count !== undefined && <p className="hint" role="status">{plural(checked.count, 'work item')} match{checked.count === 1 ? 'es' : ''} now.</p>}
          </div>
        )}
        <div className="hint" style={{ marginTop: 12 }}>The board is listed in {project.name}. Its columns start as this project’s statuses; its administrators can change the filter, columns, swimlanes and quick filters later.</div>
        {error && <p role="alert" className="text-danger" style={{ marginTop: 8 }}>{error}</p>}
      </form>
    </Modal>
  )
}
