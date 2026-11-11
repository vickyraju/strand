import { useEffect, useState } from 'react'
import { Plus, Send, RotateCcw, Copy } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { ConfirmDialog, LoadError, Loading, Modal, Toggle } from './ui'
import { PageAction } from './admin/AdminShell'

// Administration › Webhooks (spec 0705), as Jira's, with what Jira lacks: each call is signed, retried and shown.

interface Hook { id: string; name: string; description: string; url: string; events: string[]; jql: string | null; excludeBody: boolean; enabled: boolean; lastCall: { event: string; state: string; statusCode: number | null; at: string } | null }
interface Call { id: string; event: string; url: string; state: 'queued' | 'retrying' | 'delivered' | 'failed'; attempts: number; statusCode: number | null; error: string | null; createdAt: string }

/** Every event Jira DC's webhooks offer, in its groups (spec 0715). */
const GROUPS: [string, [string, string][]][] = [
  ['Issue', [['jira:issue_created', 'created'], ['jira:issue_updated', 'updated'], ['jira:issue_deleted', 'deleted'], ['jira:worklog_updated', 'worklog changed']]],
  ['Comment', [['comment_created', 'created'], ['comment_updated', 'updated'], ['comment_deleted', 'deleted']]],
  ['Worklog', [['worklog_created', 'created'], ['worklog_updated', 'updated'], ['worklog_deleted', 'deleted']]],
  ['Issue link', [['issuelink_created', 'created'], ['issuelink_deleted', 'deleted']]],
  ['Project', [['project_created', 'created'], ['project_updated', 'updated'], ['project_deleted', 'deleted']]],
  ['Version', [['jira:version_released', 'released'], ['jira:version_unreleased', 'unreleased'], ['jira:version_created', 'created'], ['jira:version_moved', 'moved'], ['jira:version_updated', 'updated'], ['jira:version_deleted', 'deleted or merged']]],
  ['User', [['user_created', 'created'], ['user_updated', 'updated'], ['user_deleted', 'deleted (anonymised)']]],
  ['Jira configuration', [['option_voting_changed', 'voting'], ['option_watching_changed', 'watching'], ['option_unassigned_issues_changed', 'unassigned issues'],
    ['option_subtasks_changed', 'sub-tasks'], ['option_attachments_changed', 'attachments'], ['option_issuelinks_changed', 'issue links'], ['option_timetracking_changed', 'time tracking']]],
  ['Sprint', [['sprint_created', 'created'], ['sprint_deleted', 'deleted'], ['sprint_updated', 'updated'], ['sprint_started', 'started'], ['sprint_closed', 'closed']]],
  ['Board', [['board_created', 'created'], ['board_updated', 'updated'], ['board_deleted', 'deleted'], ['board_configuration_changed', 'configuration changed']]],
]
/** Chosen for webhooks moved from Jira, but nothing in Strand makes these changes. */
const NEVER_SENT = new Set(['jira:version_moved', 'option_watching_changed', 'option_unassigned_issues_changed', 'option_subtasks_changed', 'option_issuelinks_changed', 'option_timetracking_changed'])

export default function WebhooksAdmin() {
  const [rows, setRows] = useState<Hook[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Hook | 'new' | null>(null)
  const [viewing, setViewing] = useState<Hook | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const load = () => api<Hook[]>('GET', '/api/admin/webhooks').then(setRows, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!rows) return <Loading />
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} />Create a webhook</button></PageAction>
      {!rows.length ? <p className="muted">No webhooks yet. A webhook tells another system when work changes here: Jira’s events and body, signed so the receiver knows it came from Strand.</p>
        : <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Last call</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(h => (
                <tr key={h.id} onClick={() => setViewing(h)}>
                  <td className="strong">{h.name}</td><td className="mono sm" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.url}</td>
                  <td className="muted sm">{h.events.length ? `${h.events.length} events` : 'All events'}{h.jql ? ' · filtered' : ''}</td>
                  <td className="sm">{h.lastCall ? <><CallState state={h.lastCall.state} /> {h.lastCall.event} · {timeAgo(Date.parse(h.lastCall.at))}</> : <span className="muted">None yet</span>}</td>
                  <td>{h.enabled ? <span className="lozenge lozenge-done">Enabled</span> : <span className="lozenge lozenge-todo">Disabled</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      {editing && <Editor hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(h, s) => { setEditing(null); void load(); if (s) setSecret(s); if (h && editing !== 'new') setViewing(h) }} />}
      {viewing && <Calls hook={viewing} onClose={() => setViewing(null)} onEdit={() => { setEditing(viewing); setViewing(null) }} onSecret={setSecret} onChanged={() => void load()} />}
      {secret && <Modal title="The signing secret" onClose={() => setSecret(null)} footer={<button className="btn btn-primary" onClick={() => setSecret(null)}>Done</button>}>
        <p>Copy it now: it isn’t shown again. Each call carries <span className="mono">X-Strand-Signature: sha256=…</span>, the HMAC-SHA256 of the body with this secret.</p>
        <div className="cell-flex" style={{ marginTop: 10 }}><code className="mono secret-box" aria-label="Signing secret">{secret}</code>
          <button className="icon-btn sm" aria-label="Copy the secret" onClick={() => void navigator.clipboard?.writeText(secret)}><Copy size={14} /></button></div>
      </Modal>}
    </section>
  )
}

const CallState = ({ state }: { state: string }) => <span className={`lozenge lozenge-${state === 'delivered' ? 'done' : state === 'failed' ? 'todo' : 'in-progress'}`}>{state}</span>

function Editor({ hook, onClose, onSaved }: { hook: Hook | null; onClose: () => void; onSaved: (h: Hook | null, secret?: string) => void }) {
  const [f, setF] = useState({ name: hook?.name ?? '', description: hook?.description ?? '', url: hook?.url ?? 'https://', events: hook?.events ?? [], jql: hook?.jql ?? '', excludeBody: hook?.excludeBody ?? false, enabled: hook?.enabled ?? true })
  const [all, setAll] = useState(!hook || !hook.events.length)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const toggle = (e: string) => setF({ ...f, events: f.events.includes(e) ? f.events.filter(x => x !== e) : [...f.events, e] })
  const save = async () => {
    setErrors({})
    const b = { ...f, events: all ? [] : f.events, jql: f.jql.trim() || null }
    try {
      const r = hook ? await api<Hook>('PUT', `/api/admin/webhooks/${hook.id}`, b) : await api<Hook & { secret: string }>('POST', '/api/admin/webhooks', b)
      onSaved(r, (r as { secret?: string }).secret)
    } catch (e) { setErrors(e instanceof ApiError ? { ...e.errors, '': e.message } : { '': errorMessage(e) }) }
  }
  return (
    <Modal title={hook ? `Edit ${hook.name}` : 'Create a webhook'} onClose={onClose} width={640} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!f.name.trim() || (!all && !f.events.length)} onClick={() => void save()}>{hook ? 'Save' : 'Create'}</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        {errors[''] && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        <label className="label" htmlFor="wh-name">Name</label>
        <input id="wh-name" className="input" maxLength={100} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus />
        <label className="label" htmlFor="wh-url" style={{ marginTop: 12 }}>URL</label>
        <input id="wh-url" className="input mono" value={f.url} onChange={e => setF({ ...f, url: e.target.value })} aria-invalid={!!errors.url} />
        {errors.url ? <p className="hint error">{errors.url}</p> : <p className="hint">https only. Variables: {'{issue.key}'} {'{project.key}'} {'{sprint.id}'} {'{version.id}'} {'{board.id}'} {'{modifiedUser.name}'}</p>}
        <label className="label" htmlFor="wh-desc" style={{ marginTop: 12 }}>Description</label>
        <input id="wh-desc" className="input" maxLength={1000} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
        <p className="label" style={{ marginTop: 14 }}>Events</p>
        <label className="check-row"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />All events</label>
        {!all && <div className="webhook-events">
          {GROUPS.map(([g, evs]) => (
            <div key={g}><b className="sm">{g}</b>
              {evs.map(([e, l]) => <label key={e} className="check-row" title={NEVER_SENT.has(e) ? 'Never sent: Strand has no such change' : e}>
                <input type="checkbox" checked={f.events.includes(e)} onChange={() => toggle(e)} />{l}{NEVER_SENT.has(e) && <span className="muted sm"> (never sent)</span>}</label>)}
            </div>
          ))}
        </div>}
        <label className="label" htmlFor="wh-jql" style={{ marginTop: 12 }}>JQL filter (issue, comment, work log and link events)</label>
        <input id="wh-jql" className="input mono" placeholder="project = PAY AND type = bug" value={f.jql} onChange={e => setF({ ...f, jql: e.target.value })} aria-invalid={!!errors.jql} />
        {errors.jql && <p className="hint error">{errors.jql}</p>}
        <label className="check-row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.excludeBody} onChange={e => setF({ ...f, excludeBody: e.target.checked })} />Exclude body</label>
        <div className="settings-row" style={{ marginTop: 8 }}><span className="settings-label">Enabled</span><Toggle on={f.enabled} label="Enabled" onChange={v => setF({ ...f, enabled: v })} /></div>
      </form>
    </Modal>
  )
}

function Calls({ hook, onClose, onEdit, onSecret, onChanged }: { hook: Hook; onClose: () => void; onEdit: () => void; onSecret: (s: string) => void; onChanged: () => void }) {
  const { toast } = useApp()
  const [calls, setCalls] = useState<Call[] | null>(null)
  const [removing, setRemoving] = useState(false)
  const load = () => api<Call[]>('GET', `/api/admin/webhooks/${hook.id}/calls`).then(setCalls, e => toast(errorMessage(e), { tone: 'warn' }))
  useEffect(() => { void load(); const t = setInterval(() => void load(), 3000); return () => clearInterval(t) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: unknown) => toast(errorMessage(e), { tone: 'warn' })
  return (
    <Modal title={hook.name} onClose={onClose} width={760} footer={<>
      <button className="btn btn-ghost text-danger" style={{ marginRight: 'auto' }} onClick={() => setRemoving(true)}>Delete</button>
      <button className="btn btn-secondary" onClick={() => api<{ secret: string }>('POST', `/api/admin/webhooks/${hook.id}/secret`).then(r => onSecret(r.secret), fail)}>New secret</button>
      <button className="btn btn-secondary" onClick={() => api('POST', `/api/admin/webhooks/${hook.id}/test`).then(() => { toast('Ping sent'); void load() }, fail)}><Send size={13} />Test</button>
      <button className="btn btn-primary" onClick={onEdit}>Edit</button>
    </>}>
      <p className="mono sm" style={{ wordBreak: 'break-all' }}>{hook.url}</p>
      {hook.description && <p className="muted">{hook.description}</p>}
      <p className="label" style={{ marginTop: 14 }}>Recent calls</p>
      {!calls ? <Loading rows={3} /> : !calls.length ? <p className="muted">No calls yet. Send a test.</p> :
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table" aria-label="Recent calls">
            <thead><tr><th>Event</th><th>When</th><th>Result</th><th className="col-num">Attempts</th><th /></tr></thead>
            <tbody>
              {calls.map(c => (
                <tr key={c.id} style={{ cursor: 'default' }}>
                  <td className="mono sm">{c.event}</td><td className="muted sm">{timeAgo(Date.parse(c.createdAt))}</td>
                  <td className="sm"><CallState state={c.state} /> {c.statusCode ?? ''} <span className="muted">{c.error ?? ''}</span></td>
                  <td className="col-num">{c.attempts}</td>
                  <td><button className="icon-btn sm" aria-label={`Redeliver ${c.event}`} title="Redeliver" onClick={() => api('POST', `/api/admin/webhooks/${hook.id}/calls/${c.id}/redeliver`).then(() => { toast('Sent again'); void load() }, fail)}><RotateCcw size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      {removing && <ConfirmDialog title={`Delete ${hook.name}?`} action="Delete" onClose={() => setRemoving(false)}
        onConfirm={async () => { await api('DELETE', `/api/admin/webhooks/${hook.id}`); toast(`${hook.name} deleted`); onChanged(); onClose() }}>
        <p>It stops at once, and its recent calls go with it.</p>
      </ConfirmDialog>}
    </Modal>
  )
}
