import { useEffect, useState } from 'react'
import { Users, ScrollText, Archive, Download, RotateCcw } from 'lucide-react'
import { api, apiEnabled, ApiError } from '../api/client'
import { useStore, timeAgo } from '../data/store'
import { isGlobalAdmin } from '../data/access'
import { useApp } from '../appContext'
import { href, navigate, type AdminSection } from '../router'
import { formatBytes } from '../data/files'
import { Avatar, Empty, Modal, Toggle, plural } from './ui'

const SECTIONS: { id: AdminSection; label: string; Icon: typeof Users }[] = [
  { id: 'people', label: 'People', Icon: Users },
  { id: 'audit', label: 'Audit log', Icon: ScrollText },
  { id: 'backups', label: 'Project backups', Icon: Archive },
]
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

/** Workspace administration, for workspace owners and admins: who is here, what changed, and deleted projects' backups. */
export default function AdminView({ section = 'people' }: { section?: AdminSection }) {
  const { state } = useStore()
  if (!apiEnabled || !isGlobalAdmin(state))
    return <div className="page-col"><Empty icon={<Users size={22} strokeWidth={1.5} />} title="Administration is for workspace admins"
      body={apiEnabled ? 'Ask a workspace admin if you need something changed.' : 'Administration needs Strand to be connected to a server.'} /></div>
  return (
    <div className="page-col">
      <div className="page-hdr"><h1 className="page-title">Administration</h1></div>
      <div className="tabs" role="tablist" aria-label="Administration">
        {SECTIONS.map(({ id, label, Icon }) => (
          <button key={id} role="tab" aria-selected={section === id} className={`tab${section === id ? ' active' : ''}`} onClick={() => navigate(href({ name: 'admin', section: id }))}>
            <Icon size={15} strokeWidth={1.75} />{label}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {section === 'people' && <People />}
        {section === 'audit' && <AuditLog />}
        {section === 'backups' && <Backups />}
      </div>
    </div>
  )
}

/** Loads one endpoint; `reload` fetches it again. */
function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    api<T>('GET', path).then(d => { if (live) setData(d) }, e => { if (live) setError(message(e)) })
    return () => { live = false }
  }, [path, n])
  return { data, error, reload: () => setN(x => x + 1) }
}

interface Person { id: string; name: string; email: string; initials: string; color: string; title: string | null; active: boolean; role: 'owner' | 'admin' | 'member'; projects: number }

function People() {
  const { data, error } = useLoad<Person[]>('/api/admin/users')
  const [q, setQ] = useState('')
  const shown = (data ?? []).filter(p => !q || `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <section>
      <p className="muted">Accounts and admin rights come from your organisation’s sign-in (Microsoft Entra): people are added and deactivated there. Project roles are set in each project’s People and access page.</p>
      <input className="input" style={{ maxWidth: 320, margin: '12px 0' }} placeholder="Find a person" aria-label="Find a person" value={q} onChange={e => setQ(e.target.value)} />
      {error && <p className="hint error" role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {data && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Workspace role</th><th>Projects</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id} style={{ cursor: 'default' }}>
                  <td><span className="admin-person"><Avatar user={{ ...p, title: p.title ?? undefined }} size={24} />{p.name}{p.title && <span className="muted sm">{p.title}</span>}</span></td>
                  <td className="muted">{p.email}</td>
                  <td>{p.role === 'member' ? 'Member' : p.role === 'owner' ? 'Owner' : 'Admin'}</td>
                  <td>{p.projects}</td>
                  <td>{p.active ? <span className="lozenge lozenge-done">Active</span> : <span className="lozenge lozenge-todo">Deactivated</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="muted" style={{ padding: 12 }}>Nobody matches.</p>}
        </div>
      )}
    </section>
  )
}

interface AuditRow { id: string; at: string; actor: string; action: string; projectKey: string | null; targetType: string; target: string | null; before: unknown; after: unknown; ip: string | null }

/** "project.member.role_changed" → "Project member role changed" */
const actionLabel = (a: string) => { const s = a.replace(/[._]/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }
const brief = (v: unknown) => (v == null ? '' : typeof v === 'object' ? Object.entries(v as object).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(', ') : String(v))

function AuditLog() {
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [rows, setRows] = useState<AuditRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const query = (cursor?: string | null) => {
    const q = new URLSearchParams({ limit: '50' })
    if (action.trim()) q.set('action', action.trim())
    if (actor.trim()) q.set('actor', actor.trim())
    if (cursor) q.set('cursor', cursor)
    return `/api/audit?${q}`
  }
  const load = (more = false) => {
    setState('loading')
    api<{ items: AuditRow[]; next: string | null }>('GET', query(more ? next : null)).then(
      r => { setRows(rs => (more ? [...rs, ...r.items] : r.items)); setNext(r.next); setState('ready') },
      e => { setError(message(e)); setState('error') })
  }
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t) }, [action, actor]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section>
      <p className="muted">Who changed people, project settings, workflows, automation and deletions, and when. Entries can’t be edited or removed.</p>
      <div className="form-row" style={{ margin: '12px 0' }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Action, e.g. project.member" aria-label="Filter by action" value={action} onChange={e => setAction(e.target.value)} />
        <input className="input" style={{ maxWidth: 260 }} placeholder="Who (email)" aria-label="Filter by who" value={actor} onChange={e => setActor(e.target.value)} />
      </div>
      {state === 'error' && <p className="hint error" role="alert">{error}</p>}
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th>Target</th><th>Change</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td title={new Date(r.at).toLocaleString()}>{timeAgo(Date.parse(r.at))}</td>
                <td>{r.actor}</td>
                <td>{actionLabel(r.action)}</td>
                <td className="mono">{r.projectKey ?? ''}</td>
                <td>{r.target ?? ''}</td>
                <td className="muted sm admin-change" title={`Before: ${brief(r.before)}\nAfter: ${brief(r.after)}`}>
                  {r.before != null && <span>{brief(r.before)}</span>}{r.before != null && r.after != null && ' → '}{r.after != null && <span>{brief(r.after)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {state === 'ready' && !rows.length && <p className="muted" style={{ padding: 12 }}>Nothing recorded{action || actor ? ' that matches' : ' yet'}.</p>}
      </div>
      {state === 'loading' && <p className="muted" role="status">Loading…</p>}
      {next && state === 'ready' && <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => load(true)}>Show older</button>}
    </section>
  )
}

interface BackupSettings { enabled: boolean; bucket: string | null; prefix: string; effectiveBucket: string | null; allowedBuckets: string[] }
interface Backup { id: string; projectKey: string; projectName: string; items: number; files: number; bytes: number; createdAt: string; restoredAt: string | null }

function Backups() {
  const { toast } = useApp()
  const settings = useLoad<BackupSettings>('/api/admin/settings/project-backups')
  const list = useLoad<Backup[]>('/api/admin/project-backups')
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)

  const save = (patch: Partial<Pick<BackupSettings, 'enabled' | 'bucket'>>) => {
    const s = settings.data!
    api('PUT', '/api/admin/settings/project-backups', { enabled: patch.enabled ?? s.enabled, bucket: patch.bucket !== undefined ? patch.bucket : s.bucket })
      .then(() => { settings.reload(); toast('Backup setting saved') }, e => toast(message(e), { tone: 'warn' }))
  }
  const download = (b: Backup) => api<{ url: string }>('GET', `/api/admin/project-backups/${b.id}/url`)
    .then(r => window.location.assign(r.url), e => toast(message(e), { tone: 'warn' }))
  // A restore runs in the background: follow it until it is done
  const restore = async (b: Backup) => {
    setRestoring(null)
    try {
      const { jobId } = await api<{ jobId: string }>('POST', `/api/admin/project-backups/${b.id}/restore`)
      setWaiting(b.id)
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const j = await api<{ status: string; lastError: string | null }>('GET', `/api/jobs/${jobId}`)
        if (j.status === 'done') { toast(`Restored ${b.projectKey}`); break }
        if (j.status === 'failed') { toast(`Could not restore ${b.projectKey}: ${j.lastError ?? 'unknown error'}`, { tone: 'warn' }); break }
        if (j.lastError && i > 5) { toast(`Still trying to restore ${b.projectKey}: ${j.lastError}`, { tone: 'warn' }); break }
      }
    } catch (e) { toast(message(e), { tone: 'warn' }) }
    setWaiting(null); list.reload()
  }

  const s = settings.data
  return (
    <section>
      <section className="panel">
        <h2 className="panel-title">When a project is deleted</h2>
        {settings.error && <p className="hint error" role="alert">{settings.error}</p>}
        {s && <>
          <div className="form-row" style={{ alignItems: 'center' }}>
            <Toggle on={s.enabled} onChange={enabled => save({ enabled })} label="Back up deleted projects" />
            <span>Back up the whole project first (work items, history, comments, files, settings), so it can be restored</span>
          </div>
          {s.enabled && (s.effectiveBucket
            ? <p className="muted sm" style={{ marginTop: 8 }}>Backups go to <span className="mono">{s.effectiveBucket}/{s.prefix}</span></p>
            : <p className="hint error" style={{ marginTop: 8 }}>No storage is set up for backups, so projects can’t be deleted until it is. Ask your platform team to configure a backup bucket.</p>)}
          {s.enabled && s.allowedBuckets.length > 0 && (
            <label className="form-row" style={{ alignItems: 'center', marginTop: 8 }}>
              <span className="label" style={{ margin: 0 }}>Bucket</span>
              <select className="input" style={{ maxWidth: 280 }} value={s.bucket ?? ''} onChange={e => save({ bucket: e.target.value || null })}>
                <option value="">Default ({s.effectiveBucket && !s.bucket ? s.effectiveBucket : 'server setting'})</option>
                {s.allowedBuckets.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          )}
          {!s.enabled && <p className="hint error" style={{ marginTop: 8 }}>Deleting a project removes it for good.</p>}
        </>}
      </section>

      <section className="panel">
        <h2 className="panel-title">Backups</h2>
        {list.error && <p className="hint error" role="alert">{list.error}</p>}
        {list.data && !list.data.length && <p className="muted">No projects have been deleted with a backup yet.</p>}
        {list.data && list.data.length > 0 && (
          <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>Project</th><th>Deleted</th><th>Contents</th><th></th></tr></thead>
              <tbody>
                {list.data.map(b => (
                  <tr key={b.id} style={{ cursor: 'default' }}>
                    <td><span className="mono">{b.projectKey}</span> {b.projectName}</td>
                    <td title={new Date(b.createdAt).toLocaleString()}>{timeAgo(Date.parse(b.createdAt))}</td>
                    <td className="muted">{plural(b.items, 'work item')}, {plural(b.files, 'file')} · {formatBytes(b.bytes)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => download(b)}><Download size={14} />Download</button>
                      {b.restoredAt ? <span className="muted sm" style={{ marginLeft: 8 }}>Restored {timeAgo(Date.parse(b.restoredAt))}</span>
                        : <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} disabled={waiting === b.id} onClick={() => setRestoring(b)}>
                            <RotateCcw size={14} />{waiting === b.id ? 'Restoring…' : 'Restore'}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {restoring && (
        <Modal title={`Restore ${restoring.projectKey}?`} onClose={() => setRestoring(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setRestoring(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => restore(restoring)}>Restore</button>
        </>}>
          <p>{restoring.projectName} comes back as it was when it was deleted: {plural(restoring.items, 'work item')}, their history and comments, {plural(restoring.files, 'file')}, its settings and its people. Changes made since then elsewhere are not affected.</p>
        </Modal>
      )}
    </section>
  )
}
