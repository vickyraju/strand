import { useEffect, useState } from 'react'
import { Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { Modal } from './ui'

// Administration › Incoming mail (spec 0607), as Jira's: mail servers, and the handlers that read them every few minutes
// and turn email into work items and comments.

type Kind = 'imap' | 'graph' | 'files'
interface Server { id: string; name: string; kind: Kind; config: Record<string, any>; hasSecret: boolean; handlers: number }
interface Result { at: string; error: string | null; counts: Record<string, number>; messages: { subject: string; from: string; result: string; key?: string; reason?: string }[] }
interface Handler { id: string; name: string; kind: string; enabled: boolean; delayMinutes: number; params: Record<string, any>; serverId: string; serverName: string; lastRunAt: string | null; lastResult: Result | null }

const HANDLERS: [string, string][] = [
  ['create_or_comment', 'Create a new issue or add a comment to an existing issue'], ['comment_non_quoted', 'Add a comment from the non quoted email body'],
  ['comment_entire', 'Add a comment with the entire email body'], ['create_each', 'Create a new issue from each email message'],
  ['comment_before_marker', 'Add a comment before a specified marker or separator'],
]
const KINDS: Record<Kind, string> = { imap: 'IMAP', graph: 'Microsoft 365 (Graph)', files: 'Message files' }
/** Which of Jira's parameters each handler takes (the server checks the same). */
const TAKES: Record<string, string[]> = {
  create_or_comment: ['project', 'issueType', 'stripQuotes', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'ccAssignee', 'ccWatchers'],
  comment_non_quoted: ['catchEmail', 'bulk', 'forwardEmail', 'defaultReporter'], comment_entire: ['catchEmail', 'bulk', 'forwardEmail', 'defaultReporter'],
  create_each: ['project', 'issueType', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter', 'ccAssignee', 'ccWatchers'],
  comment_before_marker: ['splitRegex', 'catchEmail', 'bulk', 'forwardEmail', 'defaultReporter'],
}
const TEXT_PARAMS: [string, string, string][] = [
  ['project', 'Project key', 'Where new work items go'], ['issueType', 'Work type', 'Key of the work type, such as bug'],
  ['catchEmail', 'Catch email address', 'Only email sent to this address'], ['forwardEmail', 'Forward email', 'Where email that can’t be handled is sent'],
  ['defaultReporter', 'Default reporter', 'Email or username used when the sender isn’t in Strand'], ['splitRegex', 'Split regex', 'Such as /----\\s*Original Message\\s*----/'],
]
const BOOL_PARAMS: [string, string][] = [['stripQuotes', 'Strip quotes'], ['ccAssignee', 'CC assignee'], ['ccWatchers', 'CC watchers']]

export default function IncomingMail() {
  const { toast } = useApp()
  const [servers, setServers] = useState<Server[] | null>(null)
  const [handlers, setHandlers] = useState<Handler[]>([])
  const [server, setServer] = useState<Partial<Server> & { secret?: string } | null>(null)
  const [handler, setHandler] = useState<Partial<Handler> | null>(null)
  const [error, setError] = useState('')
  const [tested, setTested] = useState('')
  const [shown, setShown] = useState<Handler | null>(null)
  const load = () => Promise.all([api<Server[]>('GET', '/api/admin/mail-servers'), api<Handler[]>('GET', '/api/admin/mail-handlers')])
    .then(([s, h]) => { setServers(s); setHandlers(h) }, e => setError(errorMessage(e)))
  useEffect(() => { load() }, [])
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', { tone: 'warn' })

  const saveServer = async () => {
    const s = server!
    const body = { name: s.name, config: { kind: s.kind, ...s.config }, ...(s.secret ? { secret: s.secret } : {}) }
    try { await api(s.id ? 'PUT' : 'POST', s.id ? `/api/admin/mail-servers/${s.id}` : '/api/admin/mail-servers', body); setServer(null); setTested(''); load() } catch (e) { fail(e) }
  }
  const test = async () => {
    const s = server!
    try {
      const r = await api<{ ok: boolean; unread?: number; error?: string }>('POST', '/api/admin/mail-servers/test', { id: s.id, config: { kind: s.kind, ...s.config }, ...(s.secret ? { secret: s.secret } : {}) })
      setTested(r.ok ? `Connected: ${r.unread} unread` : `Couldn’t connect: ${r.error}`)
    } catch (e) { setTested(errorMessage(e)) }
  }
  const saveHandler = async () => {
    const h = handler!
    const params = Object.fromEntries(Object.entries(h.params ?? {}).filter(([k, v]) => TAKES[h.kind!]!.includes(k) && v !== '' && v !== undefined && v !== false))
    const body = { name: h.name, serverId: h.serverId, kind: h.kind, enabled: h.enabled ?? true, delayMinutes: Number(h.delayMinutes ?? 1), params }
    try { await api(h.id ? 'PUT' : 'POST', h.id ? `/api/admin/mail-handlers/${h.id}` : '/api/admin/mail-handlers', body); setHandler(null); load() } catch (e) { fail(e) }
  }
  const setCfg = (k: string, v: unknown) => setServer(s => s && { ...s, config: { ...(s.config ?? {}), [k]: v } })
  const setPar = (k: string, v: unknown) => setHandler(h => h && { ...h, params: { ...(h.params ?? {}), [k]: v } })

  if (error) return <p className="hint error" role="alert">{error}</p>
  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div><h2 className="panel-title">Mail servers</h2><p className="muted">Where incoming email is read from.</p></div>
          <button className="btn btn-secondary" onClick={() => { setServer({ kind: 'imap', config: { port: 993, secure: true, folder: 'INBOX' } }); setTested('') }}><Plus size={14} />Add mail server</button>
        </div>
        {servers && servers.length > 0 && (
          <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>Name</th><th>Kind</th><th>Where</th><th /></tr></thead>
              <tbody>{servers.map(s => (
                <tr key={s.id} style={{ cursor: 'default' }}>
                  <td>{s.name}</td><td>{KINDS[s.kind]}</td>
                  <td className="muted sm">{s.kind === 'imap' ? `${s.config.username}@${s.config.host}:${s.config.port}` : s.kind === 'graph' ? s.config.mailbox : s.config.folder || '(the mail folder)'}</td>
                  <td className="nowrap">
                    <button className="icon-btn sm" aria-label={`Edit ${s.name}`} onClick={() => { setServer({ ...s }); setTested('') }}><Pencil size={14} /></button>
                    {!s.handlers && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} onClick={() => api('DELETE', `/api/admin/mail-servers/${s.id}`).then(load, fail)}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <div><h2 className="panel-title">Mail handlers</h2><p className="muted">Each reads a server every few minutes and makes work items and comments from the email.</p></div>
          <button className="btn btn-primary" disabled={!servers?.length} onClick={() => setHandler({ kind: 'create_or_comment', serverId: servers![0]!.id, delayMinutes: 1, enabled: true, params: { bulk: 'ignore' } })}><Plus size={14} />Add mail handler</button>
        </div>
        {handlers.length > 0 && (
          <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>Name</th><th>Server</th><th>Last run</th><th /></tr></thead>
              <tbody>{handlers.map(h => (
                <tr key={h.id} onClick={() => setShown(h)}>
                  <td><b>{h.name}</b>{!h.enabled && <span className="lozenge lozenge-todo" style={{ marginLeft: 6 }}>Off</span>}<div className="muted sm">{HANDLERS.find(x => x[0] === h.kind)?.[1]}</div></td>
                  <td>{h.serverName}<div className="muted sm">every {h.delayMinutes} min</div></td>
                  <td className="sm">{h.lastResult ? (h.lastResult.error ? <span className="text-danger">{h.lastResult.error}</span>
                    : Object.entries(h.lastResult.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'Nothing new') : '—'}
                    {h.lastRunAt && <div className="muted">{timeAgo(Date.parse(h.lastRunAt))}</div>}</td>
                  <td className="nowrap" onClick={e => e.stopPropagation()}>
                    <button className="icon-btn sm" aria-label={`Run ${h.name} now`} title="Run now" onClick={() => api('POST', `/api/admin/mail-handlers/${h.id}/run`).then(() => { toast(`${h.name} is reading its server`); setTimeout(load, 2000) }, fail)}><Play size={14} /></button>
                    <button className="icon-btn sm" aria-label={`Edit ${h.name}`} onClick={() => setHandler({ ...h })}><Pencil size={14} /></button>
                    <button className="icon-btn sm" aria-label={`Remove ${h.name}`} onClick={() => api('DELETE', `/api/admin/mail-handlers/${h.id}`).then(load, fail)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {server && (
        <Modal title={server.id ? `Edit ${server.name}` : 'Add mail server'} onClose={() => setServer(null)} width={520} footer={<>
          <button className="btn btn-secondary" onClick={() => void test()}>Test</button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={() => setServer(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!server.name?.trim()} onClick={() => void saveServer()}>Save</button>
        </>}>
          <label className="label" htmlFor="ms-name">Name</label>
          <input id="ms-name" className="input" value={server.name ?? ''} onChange={e => setServer({ ...server, name: e.target.value })} />
          <label className="label" htmlFor="ms-kind" style={{ marginTop: 10 }}>Kind</label>
          <select id="ms-kind" className="input" value={server.kind} onChange={e => setServer({ ...server, kind: e.target.value as Kind, config: {} })}>
            {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {server.kind === 'imap' && <>
            {[['host', 'Host'], ['port', 'Port'], ['username', 'Username'], ['folder', 'Folder']].map(([k, l]) => (
              <div key={k}><label className="label" htmlFor={`ms-${k}`} style={{ marginTop: 10 }}>{l}</label>
                <input id={`ms-${k}`} className="input" value={server.config?.[k!] ?? ''} onChange={e => setCfg(k!, k === 'port' ? Number(e.target.value) || '' : e.target.value)} /></div>
            ))}
            <label className="sm" style={{ display: 'block', marginTop: 10 }}><input type="checkbox" checked={server.config?.secure !== false} onChange={e => setCfg('secure', e.target.checked)} /> Use TLS</label>
          </>}
          {server.kind === 'graph' && [['tenantId', 'Tenant id'], ['clientId', 'Application (client) id'], ['mailbox', 'Mailbox address'], ['folder', 'Folder']].map(([k, l]) => (
            <div key={k}><label className="label" htmlFor={`ms-${k}`} style={{ marginTop: 10 }}>{l}</label>
              <input id={`ms-${k}`} className="input" value={server.config?.[k!] ?? ''} onChange={e => setCfg(k!, e.target.value)} /></div>
          ))}
          {server.kind === 'files' && <><label className="label" htmlFor="ms-folder" style={{ marginTop: 10 }}>Folder (inside the server’s mail folder)</label>
            <input id="ms-folder" className="input" value={server.config?.folder ?? ''} onChange={e => setCfg('folder', e.target.value)} /></>}
          {server.kind !== 'files' && <>
            <label className="label" htmlFor="ms-secret" style={{ marginTop: 10 }}>{server.kind === 'imap' ? 'Password' : 'Client secret'}</label>
            <input id="ms-secret" className="input" type="password" autoComplete="new-password" placeholder={server.hasSecret ? 'Unchanged' : ''} value={server.secret ?? ''} onChange={e => setServer({ ...server, secret: e.target.value })} />
          </>}
          {server.kind === 'graph' && <p className="hint">An Entra app registration with the Mail.ReadWrite application permission, limited to this mailbox.</p>}
          {tested && <p className="hint" role="status">{tested}</p>}
        </Modal>
      )}

      {handler && (
        <Modal title={handler.id ? `Edit ${handler.name}` : 'Add mail handler'} onClose={() => setHandler(null)} width={560} footer={<>
          <button className="btn btn-secondary" onClick={() => setHandler(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!handler.name?.trim()} onClick={() => void saveHandler()}>Save</button>
        </>}>
          <label className="label" htmlFor="mh-name">Name</label>
          <input id="mh-name" className="input" value={handler.name ?? ''} onChange={e => setHandler({ ...handler, name: e.target.value })} />
          <div className="form-row" style={{ marginTop: 10 }}>
            <div style={{ flex: 1 }}><label className="label" htmlFor="mh-server">Server</label>
              <select id="mh-server" className="input" value={handler.serverId} onChange={e => setHandler({ ...handler, serverId: e.target.value })}>
                {servers!.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div><label className="label" htmlFor="mh-delay">Every (minutes)</label>
              <input id="mh-delay" className="input" type="number" min={1} max={1440} value={handler.delayMinutes ?? 1} onChange={e => setHandler({ ...handler, delayMinutes: Number(e.target.value) })} /></div>
          </div>
          <label className="label" htmlFor="mh-kind" style={{ marginTop: 10 }}>Handler</label>
          <select id="mh-kind" className="input" value={handler.kind} onChange={e => setHandler({ ...handler, kind: e.target.value })}>
            {HANDLERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {TEXT_PARAMS.filter(([k]) => TAKES[handler.kind!]!.includes(k)).map(([k, l, hint]) => (
            <div key={k}><label className="label" htmlFor={`mh-${k}`} style={{ marginTop: 10 }}>{l}</label>
              <input id={`mh-${k}`} className="input" placeholder={hint} value={handler.params?.[k] ?? ''} onChange={e => setPar(k, e.target.value)} /></div>
          ))}
          <label className="label" htmlFor="mh-bulk" style={{ marginTop: 10 }}>Bulk (automatic) mail</label>
          <select id="mh-bulk" className="input" value={handler.params?.bulk ?? 'ignore'} onChange={e => setPar('bulk', e.target.value)}>
            <option value="ignore">Ignore</option><option value="forward">Forward</option><option value="delete">Delete</option><option value="accept">Accept</option>
          </select>
          <div style={{ marginTop: 10 }}>{BOOL_PARAMS.filter(([k]) => TAKES[handler.kind!]!.includes(k)).map(([k, l]) => (
            <label key={k} className="sm" style={{ marginRight: 14 }}><input type="checkbox" checked={!!handler.params?.[k]} onChange={e => setPar(k, e.target.checked)} /> {l}</label>
          ))}<label className="sm"><input type="checkbox" checked={handler.enabled ?? true} onChange={e => setHandler({ ...handler, enabled: e.target.checked })} /> On</label></div>
        </Modal>
      )}

      {shown && (
        <Modal title={`${shown.name}: last run`} onClose={() => setShown(null)} width={640}>
          {!shown.lastResult ? <p className="muted">It hasn’t run yet.</p> : shown.lastResult.error ? <p className="hint error">{shown.lastResult.error}</p> : shown.lastResult.messages.length === 0 ? <p className="muted">No new email.</p> : (
            <table className="table">
              <thead><tr><th>From</th><th>Subject</th><th>Result</th></tr></thead>
              <tbody>{shown.lastResult.messages.map((m, i) => (
                <tr key={i} style={{ cursor: 'default' }}><td className="sm">{m.from}</td><td className="sm">{m.subject}</td><td className="sm">{m.result}{m.key ? ` ${m.key}` : ''}{m.reason ? <div className="muted">{m.reason}</div> : null}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  )
}
