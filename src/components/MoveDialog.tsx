import { useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '../api/client'
import { issueSync } from '../api/sync'
import { sprintDeps } from '../api/sprints'
import { loadProjectByKey } from '../api/load'
import { searchProjects, type ProjectOption } from '../api/work'
import { useApp } from '../appContext'
import { useStore, type Issue, type Project } from '../data/store'
import { Modal } from './ui'

// Jira's Move (spec 0501): the target project, its type and status, then a preview of every change (Jira's confirmation
// page) before anything moves. The item takes the target's next key; its old key keeps opening it.

interface Planned { id: string; key: string; newKey: string; changes: { field: string; from: unknown; to: unknown }[] }
const show = (v: unknown) => (v == null || v === '' ? '—' : String(v))

export default function MoveDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { dispatch } = useStore()
  const { toast, openIssue } = useApp()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<ProjectOption[]>([])
  const [target, setTarget] = useState<Project | null>(null)
  const [type, setType] = useState(issue.type)
  const [statusId, setStatusId] = useState('')
  const [preview, setPreview] = useState<Planned[] | null>(null)
  const [error, setError] = useState('')
  const [needStatus, setNeedStatus] = useState(false)
  const [busy, setBusy] = useState(false)
  const from = issue.key.split('-')[0]

  useEffect(() => {
    const t = setTimeout(() => searchProjects(query).then(ps => setFound(ps.filter(p => p.key !== from)), () => {}), 200)
    return () => clearTimeout(t)
  }, [query, from])

  // the project typed (its key, or the name and key the list offers), once the search has it
  const match = found.find(x => x.key === query.trim().toUpperCase() || `${x.name} (${x.key})` === query)
  useEffect(() => { if (match && match.key !== target?.key) choose(match.key) }, [match?.key])   // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (key: string) => {
    setPreview(null); setError(''); setNeedStatus(false); setStatusId('')
    loadProjectByKey(key).then(({ project, sprints }) => {
      dispatch({ type: 'loadProject', project, sprints })
      setTarget(project)
      setType(project.types?.some(t => t.key === issue.type) ? issue.type : project.types?.find(t => t.key !== 'epic')?.key ?? 'task')
    }, e => setError(errorMessage(e)))
  }
  const body = (dryRun: boolean) => ({ projectKey: target!.key, type, ...(statusId ? { statusId } : {}), dryRun })
  const check = async () => {
    setBusy(true); setError('')
    try {
      await issueSync.idle()                     // the move takes what the server has: send pending edits first
      const r = await api<{ items: Planned[] }>('POST', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}/move`, body(true))
      setPreview(r.items); setNeedStatus(false)
    } catch (e) {
      if (e instanceof ApiError && e.errors?.statusId) setNeedStatus(true)
      setError(errorMessage(e)); setPreview(null)
    } finally { setBusy(false) }
  }
  useEffect(() => { if (target) void check() }, [target?.key, type, statusId])   // eslint-disable-line react-hooks/exhaustive-deps

  const move = async () => {
    setBusy(true)
    try {
      const moved = await api<{ id: string; key: string }>('POST', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}/move`, body(false))
      await sprintDeps.reloadProject(issue.projectId)
      await sprintDeps.reloadProject(target!.id)
      onClose()
      openIssue(moved.id)
      toast(`Moved ${issue.key} to ${moved.key}`)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Move ${issue.key}`} onClose={onClose} width={620} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !preview} onClick={() => void move()}>{busy && preview ? 'Moving…' : 'Move'}</button>
    </>}>
      <label className="label" htmlFor="mv-project">Move to project</label>
      <input id="mv-project" className="input" list="mv-projects" placeholder="Type a project’s name or key" value={query} autoFocus
        onChange={e => setQuery(e.target.value)} />
      <datalist id="mv-projects">{found.map(p => <option key={p.id} value={`${p.name} (${p.key})`} />)}</datalist>
      {target && <>
        <div className="form-row" style={{ marginTop: 12, gap: 12 }}>
          <label className="label" style={{ flex: 1 }}>Work type
            <select className="input" aria-label="Work type" value={type} onChange={e => setType(e.target.value)}>
              {(target.types ?? []).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </label>
          {needStatus && <label className="label" style={{ flex: 1 }}>Status in {target.key}
            <select className="input" aria-label="New status" value={statusId} onChange={e => setStatusId(e.target.value)}>
              <option value="">Choose…</option>
              {target.statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>}
        </div>
      </>}
      {error && <p className="hint error" role="alert">{error}</p>}
      {preview && (
        <div style={{ marginTop: 12 }} aria-label="What changes">
          <p className="hint" style={{ marginTop: 0 }}>Comments, attachments, work logs, history, links and watchers stay. The old key keeps opening it.</p>
          {preview.map(p => (
            <div key={p.id} className="panel" style={{ padding: '8px 12px', marginBottom: 8 }}>
              <b className="mono">{p.key} → {p.newKey}</b>
              <table className="table" style={{ marginTop: 4 }}>
                <tbody>{p.changes.filter(c => c.field !== 'Key').map((c, n) => (
                  <tr key={n} style={{ cursor: 'default' }}><td className="sm">{c.field}</td><td className="sm muted">{show(c.from)}</td><td className="sm">→ {show(c.to)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
