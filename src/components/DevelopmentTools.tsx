import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { api, API_URL, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { ConfirmDialog, LoadError, Loading, Modal } from './ui'

// Administration › Development tools (spec 0707), Jira's DVCS accounts for GitHub: an installation GitHub reports waits
// until an admin connects it, so nobody else's work can reach the app's items through a public GitHub App.

interface Repo { id: string; fullName: string; projectKeys: string[] }
interface Account { id: string; accountLogin: string; installationId: number; status: 'pending' | 'active' | 'suspended'; createdAt: string; repositories: Repo[] }
interface Delivery { id: string; event: string; status: 'received' | 'processed' | 'failed'; error: string | null; receivedAt: string }
interface Info { receiverPath: string; secretSet: boolean; accounts: Account[]; deliveries: Delivery[] }

const STATUS = { pending: ['Waiting', 'lozenge-overdue'], active: ['Connected', 'lozenge-done'], suspended: ['Paused', 'lozenge-todo'] } as const

export default function DevelopmentTools() {
  const { toast } = useApp()
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<Account | null>(null)
  const [limiting, setLimiting] = useState<Repo | null>(null)
  const load = () => api<Info>('GET', '/api/admin/development').then(setInfo, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!info) return <Loading />
  const receiver = `${API_URL ?? ''}${info.receiverPath}`
  const setStatus = (a: Account, status: 'active' | 'suspended') =>
    api('PUT', `/api/admin/development/accounts/${a.id}`, { status }).then(() => { toast(`${a.accountLogin} ${status === 'active' ? 'connected' : 'paused'}`); void load() }, e => toast(errorMessage(e), { tone: 'warn' }))
  return (
    <section>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel-title">GitHub</h2>
        <p className="muted">Create a GitHub App with this webhook address and secret, subscribe it to <b>Pull requests</b>, <b>Pull request reviews</b>, <b>Pushes</b>, <b>Branch or tag creation</b> and <b>deletion</b>, and install it. Then connect the account here.</p>
        <div className="cell-flex" style={{ marginTop: 8 }}>
          <span className="settings-label">Webhook address</span><code className="mono sm">{receiver}</code>
          <button className="icon-btn sm" aria-label="Copy the webhook address" onClick={() => void navigator.clipboard?.writeText(receiver)}><Copy size={14} /></button>
        </div>
        <p className="sm" style={{ marginTop: 6 }}>{info.secretSet ? 'The server has the webhook secret.' : <span className="text-danger">The server has no webhook secret: set GITHUB_WEBHOOK_SECRET to the GitHub App’s secret.</span>}</p>
      </div>

      {!info.accounts.length ? <p className="muted">No GitHub accounts yet. Once the GitHub App is installed, its account appears here, waiting to be connected.</p>
        : info.accounts.map(a => (
          <div key={a.id} className="panel" style={{ marginBottom: 12 }} aria-label={`GitHub account ${a.accountLogin}`}>
            <div className="cell-flex">
              <h3 className="panel-title" style={{ margin: 0 }}>{a.accountLogin}</h3>
              <span className={`lozenge ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>
              <span className="muted sm">installation {a.installationId} · since {timeAgo(Date.parse(a.createdAt))}</span>
              <span style={{ marginLeft: 'auto' }} />
              {a.status !== 'active' && <button className="btn btn-primary btn-sm" onClick={() => void setStatus(a, 'active')}>{a.status === 'pending' ? 'Connect' : 'Resume'}</button>}
              {a.status === 'active' && <button className="btn btn-secondary btn-sm" onClick={() => void setStatus(a, 'suspended')}>Pause</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setRemoving(a)}>Remove</button>
            </div>
            {a.status === 'pending' && <p className="hint">Nothing it sends is kept until you connect it. Connect only accounts your organisation owns.</p>}
            {a.repositories.length > 0 && (
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>Repository</th><th>Links work items in</th><th /></tr></thead>
                <tbody>{a.repositories.map(r => (
                  <tr key={r.id} style={{ cursor: 'default' }}>
                    <td className="mono sm">{r.fullName}</td>
                    <td className="sm">{r.projectKeys.length ? r.projectKeys.join(', ') : <span className="muted">Any project</span>}</td>
                    <td style={{ textAlign: 'right' }}><button className="link sm" onClick={() => setLimiting(r)}>Change</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        ))}

      <h2 className="panel-title" style={{ marginTop: 20 }}>Recent deliveries</h2>
      {!info.deliveries.length ? <p className="muted">None yet.</p> : (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Event</th><th>Received</th><th>Result</th></tr></thead>
            <tbody>{info.deliveries.map(d => (
              <tr key={d.id} style={{ cursor: 'default' }}>
                <td className="mono sm">{d.event}</td><td className="sm">{timeAgo(Date.parse(d.receivedAt))}</td>
                <td className="sm">{d.status === 'failed' ? <span className="text-danger">Failed: {d.error}</span> : d.status === 'processed' ? 'Processed' : 'Received'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {removing && <ConfirmDialog title={`Remove ${removing.accountLogin}?`} action="Remove" onClose={() => setRemoving(null)}
        onConfirm={() => api('DELETE', `/api/admin/development/accounts/${removing.id}`).then(() => { toast(`${removing.accountLogin} removed`); setRemoving(null); void load() })}>
        Its repositories, and every branch, commit and pull request it sent, go from Jira Build POC’s work items. GitHub keeps them; uninstall the GitHub App there to stop its deliveries.
      </ConfirmDialog>}
      {limiting && <LimitDialog repo={limiting} onClose={() => setLimiting(null)} onSaved={() => { setLimiting(null); void load() }} />}
    </section>
  )
}

function LimitDialog({ repo, onClose, onSaved }: { repo: Repo; onClose: () => void; onSaved: () => void }) {
  const [keys, setKeys] = useState(repo.projectKeys.join(', '))
  const [error, setError] = useState('')
  const save = () => api('PUT', `/api/admin/development/repositories/${repo.id}`, { projectKeys: keys.split(/[\s,]+/).filter(Boolean) })
    .then(onSaved, e => setError(e instanceof ApiError ? e.errors?.projectKeys ?? e.message : errorMessage(e)))
  return (
    <Modal title={repo.fullName} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => void save()}>Save</button>
    </>}>
      <label className="label" htmlFor="dev-keys">Links work items in</label>
      <input id="dev-keys" className="input" value={keys} onChange={e => setKeys(e.target.value)} placeholder="Any project" aria-invalid={!!error} />
      {error ? <p className="hint error">{error}</p> : <p className="hint">Project keys, separated by commas. Empty: a key from any project links.</p>}
    </Modal>
  )
}
