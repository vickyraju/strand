import { useEffect, useState } from 'react'
import { Play, Search } from 'lucide-react'
import { api, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { Modal, plural } from './ui'

// Administration › Jira import (spec 0802): connect to a Jira Data Center, dry-run what would come over, then import it.

interface Run { id: string; url: string; projectKeys: string[]; dryRun: boolean; status: 'queued' | 'running' | 'done' | 'failed'; report: any; createdAt: string; finishedAt: string | null; createdByName: string | null; progress: { text?: string } | null }

export default function JiraImport() {
  const { toast } = useApp()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [keys, setKeys] = useState('')
  const [tested, setTested] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [shown, setShown] = useState<Run | null>(null)
  const load = () => api<Run[]>('GET', '/api/admin/jira-imports').then(r => { setRuns(r); if (!url && r[0]) setUrl(r[0].url) }, () => {})
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // while a run is going, its progress
  useEffect(() => {
    if (!runs.some(r => r.status === 'queued' || r.status === 'running')) return
    const t = setTimeout(load, 2000)
    return () => clearTimeout(t)
  }, [runs])   // eslint-disable-line react-hooks/exhaustive-deps

  const test = () => api<{ ok: boolean; version?: string; title?: string; user?: string; error?: string }>('POST', '/api/admin/jira-import/test', { url, ...(token ? { token } : {}) })
    .then(r => setTested(r.ok ? `Connected to ${r.title || 'Jira'} ${r.version} as ${r.user}` : `Couldn’t connect: ${r.error}`), e => setTested(errorMessage(e)))
  const start = (dryRun: boolean) => api<Run>('POST', '/api/admin/jira-imports', { url, ...(token ? { token } : {}), projectKeys: keys.split(/[\s,]+/).filter(Boolean), dryRun })
    .then(r => { setToken(''); toast(dryRun ? 'Dry run started' : 'Import started'); setRuns([r, ...runs]) }, e => toast(errorMessage(e), { tone: 'warn' }))

  return (
    <>
      <section className="panel">
        <h2 className="panel-title">Jira Data Center</h2>
        <p className="muted">Jira Build POC reads your Jira with your token (it only reads) and brings the projects over with their keys, people, history, comments, work logs and links. Run a dry run first: it shows what would come over and writes nothing.</p>
        <label className="label" htmlFor="ji-url" style={{ marginTop: 10 }}>Jira’s address</label>
        <input id="ji-url" className="input" placeholder="https://jira.example.com" value={url} onChange={e => setUrl(e.target.value)} />
        <label className="label" htmlFor="ji-token" style={{ marginTop: 10 }}>Personal access token</label>
        <input id="ji-token" className="input" type="password" autoComplete="new-password" placeholder={runs.some(r => r.url === url) ? 'Unchanged (the last one for this address)' : ''} value={token} onChange={e => setToken(e.target.value)} />
        <p className="hint">A Jira administrator’s token reads everything; it is stored encrypted and never shown again.</p>
        <label className="label" htmlFor="ji-keys" style={{ marginTop: 10 }}>Project keys</label>
        <input id="ji-keys" className="input" placeholder="PAY, OPS, WEB" value={keys} onChange={e => setKeys(e.target.value.toUpperCase())} />
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={!url} onClick={() => void test()}>Test</button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-secondary" disabled={!url || !keys.trim()} onClick={() => void start(true)}><Search size={14} />Dry run</button>
          <button className="btn btn-primary" disabled={!url || !keys.trim()} onClick={() => void start(false)}><Play size={14} />Import</button>
        </div>
        {tested && <p className="hint" role="status">{tested}</p>}
      </section>

      {runs.length > 0 && (
        <section className="panel">
          <h2 className="panel-title">Runs</h2>
          <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>When</th><th>What</th><th>Projects</th><th>Status</th></tr></thead>
              <tbody>{runs.map(r => (
                <tr key={r.id} onClick={() => setShown(r)}>
                  <td className="sm">{new Date(r.createdAt).toLocaleString()}<div className="muted">{r.createdByName}</div></td>
                  <td>{r.dryRun ? 'Dry run' : 'Import'}</td>
                  <td>{r.projectKeys.join(', ')}</td>
                  <td>{r.status === 'running' ? r.progress?.text ?? 'Running…' : r.status === 'failed' ? <span className="text-danger">Failed</span> : r.status === 'queued' ? 'Waiting…' : 'Done'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {shown && <Modal title={`${shown.dryRun ? 'Dry run' : 'Import'}: ${shown.projectKeys.join(', ')}`} onClose={() => setShown(null)} width={760}><Report run={shown} /></Modal>}
    </>
  )
}

function Report({ run }: { run: Run }) {
  const r = run.report
  if (!r) return <p className="muted">Not finished yet.</p>
  if (r.error) return <p className="hint error">{r.error}</p>
  const yesNo = (xs: { name: string; existing?: boolean; as?: string }[]) => xs.map(x => `${x.name} (${x.as ?? (x.existing ? 'existing' : 'new')})`).join(', ') || '—'
  return (
    <>
      {run.dryRun && r.people && <p>People: {r.people.matched} matched by email, {r.people.new} new (made deactivated){r.people.examples.length ? `: ${r.people.examples.join(', ')}` : ''}.</p>}
      {run.dryRun && r.leftOut?.length > 0 && <p className="hint">Left out (Jira Build POC has no such field type): {r.leftOut.join('; ')}</p>}
      {(r.projects ?? []).map((p: any) => (
        <div key={p.key} style={{ marginBottom: 16 }}>
          <h3 className="subhead">{p.key} {p.name ?? ''}</h3>
          {p.stop && <p className="hint error">{p.stop}</p>}
          {p.error && <p className="hint error">{p.error}</p>}
          {run.dryRun && !p.stop && <ul className="sm">
            <li>{plural(p.workItems, 'work item')}, {plural(p.versions, 'version')}, {plural(p.components, 'component')}, {plural(p.sprints, 'sprint')}</li>
            <li>Statuses: {yesNo(p.statuses)}</li><li>Work types: {yesNo(p.issueTypes)}</li>
            <li>Priorities: {yesNo(p.priorities)}</li><li>Resolutions: {yesNo(p.resolutions)}</li><li>Custom fields: {yesNo(p.customFields)}</li>
          </ul>}
          {p.reconciliation && <table className="table">
            <thead><tr><th>What</th><th className="col-num">In Jira</th><th className="col-num">In Jira Build POC</th><th /></tr></thead>
            <tbody>{p.reconciliation.map((x: any) => (
              <tr key={x.what} style={{ cursor: 'default' }}><td>{x.what}</td><td className="col-num">{x.jira ?? '—'}</td><td className="col-num">{x.ours}</td>
                <td className="sm">{x.same ? '✓' : <span className="text-danger">differs</span>}{x.note ? <span className="muted"> {x.note}</span> : null}</td></tr>
            ))}</tbody>
          </table>}
        </div>
      ))}
      {!run.dryRun && r.waitingLinks > 0 && <p className="hint">{r.waitingLinks} link{r.waitingLinks === 1 ? '' : 's'} wait for items in projects not imported yet; they are made when those come.</p>}
    </>
  )
}
