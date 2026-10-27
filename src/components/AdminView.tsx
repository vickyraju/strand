import { useEffect, useState } from 'react'
import { Users, ScrollText, Archive, Download, RotateCcw, SlidersHorizontal, Link2, Bookmark, UsersRound, UserMinus } from 'lucide-react'
import { api, apiEnabled, ApiError } from '../api/client'
import { useStore, timeAgo } from '../data/store'
import { isGlobalAdmin } from '../data/access'
import { useApp } from '../appContext'
import { href, navigate, type AdminSection } from '../router'
import { formatBytes } from '../data/files'
import { Avatar, Empty, Modal, Toggle, plural } from './ui'
import SystemSettings from './SystemSettings'
import GroupsView from './groups/GroupsView'
import LicenseCleanup from './LicenseCleanup'
import LinkTypesAdmin from './LinkTypesAdmin'
import SharedViewsAdmin from './SharedViewsAdmin'

const SECTIONS: { id: AdminSection; label: string; Icon: typeof Users }[] = [
  { id: 'people', label: 'People', Icon: Users },
  { id: 'groups', label: 'Groups', Icon: UsersRound },
  { id: 'license', label: 'License cleanup', Icon: UserMinus },
  { id: 'audit', label: 'Audit log', Icon: ScrollText },
  { id: 'backups', label: 'Project backups', Icon: Archive },
  { id: 'link-types', label: 'Link types', Icon: Link2 },
  { id: 'views', label: 'Shared views', Icon: Bookmark },
  { id: 'settings', label: 'System settings', Icon: SlidersHorizontal },
]
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

/** Administration (system administrators: people, groups, audit, backups, settings…). For everyone else the same
 *  area is Configuration, with only what they may manage there: groups. */
export default function AdminView({ section = 'people' }: { section?: AdminSection }) {
  const { state } = useStore()
  if (!apiEnabled)
    return <div className="page-col"><Empty icon={<Users size={22} strokeWidth={1.5} />} title="Administration needs a server"
      body="Administration needs Strand to be connected to a server." /></div>
  // system administrators see everything; everyone else sees Configuration with what they may manage: groups
  const admin = isGlobalAdmin(state)
  const sections = admin ? SECTIONS : SECTIONS.filter(s => s.id === 'groups')
  if (!sections.some(s => s.id === section)) section = 'groups'
  return (
    <div className="page-col">
      <div className="page-hdr"><h1 className="page-title">{admin ? 'Administration' : 'Configuration'}</h1></div>
      <div className="tabs" role="tablist" aria-label={admin ? 'Administration' : 'Configuration'}>
        {sections.map(({ id, label, Icon }) => (
          <button key={id} role="tab" aria-selected={section === id} className={`tab${section === id ? ' active' : ''}`} onClick={() => navigate(href({ name: 'admin', section: id }))}>
            <Icon size={15} strokeWidth={1.75} />{label}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {section === 'people' && <People />}
        {section === 'groups' && <GroupsView admin={admin} />}
        {section === 'license' && <LicenseCleanup />}
        {section === 'audit' && <AuditLog />}
        {section === 'backups' && <Backups />}
        {section === 'link-types' && <LinkTypesAdmin />}
        {section === 'views' && <SharedViewsAdmin />}
        {section === 'settings' && <SystemSettings />}
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

interface Person {
  id: string; name: string; email: string; initials: string; color: string; title: string | null; active: boolean; role: 'owner' | 'admin' | 'member'; projects: number
  lastActiveAt: string | null; lastSignInAt: string | null; groups: { id: string; name: string }[]
}
type BulkAction = 'deactivate' | 'reactivate' | 'add-to-group' | 'remove-from-group'
const BULK: Record<BulkAction, string> = { deactivate: 'Deactivate', reactivate: 'Reactivate', 'add-to-group': 'Add to group…', 'remove-from-group': 'Remove from group…' }
const daysSince = (at: string | null) => (at ? (Date.now() - Date.parse(at)) / 86_400_000 : Infinity)

/** Everyone, with last activity and groups (resolution's user browser): filter, pick, and change many at once. */
function People() {
  const { toast } = useApp()
  const { data, error, reload } = useLoad<Person[]>('/api/admin/users')
  const refused = useLoad<{ at: string; userId: string | null; email: string | null; name: string | null; active: boolean | null }[]>('/api/admin/users/refused-sign-ins')
  const [q, setQ] = useState('')
  const [inactive, setInactive] = useState('')            // '' | days | 'never'
  const [status, setStatus] = useState<'all' | 'active' | 'deactivated'>('all')
  const [group, setGroup] = useState('')                  // '' | in:<id> | out:<id>
  const [picked, setPicked] = useState<string[]>([])
  const [bulk, setBulk] = useState<{ action: BulkAction; groupId: string } | null>(null)
  const groups = [...new Map((data ?? []).flatMap(p => p.groups).map(g => [g.id, g])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const shown = (data ?? []).filter(p => (!q || `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()))
    && (status === 'all' || (status === 'active') === p.active)
    && (!inactive || (inactive === 'never' ? !p.lastActiveAt : daysSince(p.lastActiveAt) > Number(inactive)))
    && (!group || (group.startsWith('in:') ? p.groups.some(g => g.id === group.slice(3)) : !p.groups.some(g => g.id === group.slice(4)))))
  const allPicked = shown.length > 0 && shown.every(p => picked.includes(p.id))
  const apply = () => {
    if (!bulk) return
    api<{ changed: number; unchanged: number }>('POST', '/api/admin/users/bulk', { userIds: picked, action: bulk.action, ...(bulk.groupId ? { groupId: bulk.groupId } : {}) })
      .then(r => { toast(`${BULK[bulk.action].replace('…', '')}: ${r.changed} changed${r.unchanged ? `, ${r.unchanged} already so` : ''}`); setBulk(null); setPicked([]); reload() }, e => toast(message(e), { tone: 'warn' }))
  }
  return (
    <section>
      <p className="muted">Everyone who has signed in. Accounts come from your organisation’s sign-in (Microsoft Entra); here you can see who is active, filter, and change many people at once. Admin rights come from the system-administrators group.</p>
      <div className="people-filters">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Find a person" aria-label="Find a person" value={q} onChange={e => setQ(e.target.value)} />
        <select className="input" aria-label="Inactive" value={inactive} onChange={e => setInactive(e.target.value)}>
          <option value="">Any activity</option><option value="30">Inactive 30+ days</option><option value="90">Inactive 90+ days</option><option value="180">Inactive 180+ days</option><option value="never">Never used Strand</option>
        </select>
        <select className="input" aria-label="Status" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
          <option value="all">Active and deactivated</option><option value="active">Active</option><option value="deactivated">Deactivated</option>
        </select>
        <select className="input" aria-label="Group" value={group} onChange={e => setGroup(e.target.value)}>
          <option value="">Any group</option>
          {groups.map(g => <option key={`in:${g.id}`} value={`in:${g.id}`}>In {g.name}</option>)}
          {groups.map(g => <option key={`out:${g.id}`} value={`out:${g.id}`}>Not in {g.name}</option>)}
        </select>
      </div>
      {picked.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Change selected people">
          <b>{picked.length} selected</b>
          <select className="input input-sm" aria-label="Bulk action" value="" onChange={e => e.target.value && setBulk({ action: e.target.value as BulkAction, groupId: '' })}>
            <option value="">Change them…</option>{Object.entries(BULK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
      {error && <p className="hint error" role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {data && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" aria-label="Select everyone shown" checked={allPicked} onChange={e => setPicked(e.target.checked ? [...new Set([...picked, ...shown.map(p => p.id)])] : picked.filter(id => !shown.some(p => p.id === id)))} /></th>
              <th>Name</th><th>Email</th><th>Role</th><th>Groups</th><th>Last active</th><th>Status</th>
            </tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id} style={{ cursor: 'default' }}>
                  <td><input type="checkbox" aria-label={`Select ${p.name}`} checked={picked.includes(p.id)} onChange={e => setPicked(e.target.checked ? [...picked, p.id] : picked.filter(x => x !== p.id))} /></td>
                  <td><span className="admin-person"><Avatar user={{ ...p, title: p.title ?? undefined }} size={24} />{p.name}{p.title && <span className="muted sm">{p.title}</span>}</span></td>
                  <td className="muted">{p.email}</td>
                  <td>{p.role === 'member' ? 'Member' : p.role === 'owner' ? 'Owner' : 'Admin'}</td>
                  <td className="muted sm">{p.groups.map(g => g.name).join(', ')}</td>
                  <td className="muted" title={p.lastSignInAt ? `Last sign-in ${new Date(p.lastSignInAt).toLocaleString()}` : 'Never signed in'}>{p.lastActiveAt ? timeAgo(Date.parse(p.lastActiveAt)) : 'Never'}</td>
                  <td>{p.active ? <span className="lozenge lozenge-done">Active</span> : <span className="lozenge lozenge-todo">Deactivated</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="muted" style={{ padding: 12 }}>Nobody matches.</p>}
        </div>
      )}
      {!!refused.data?.length && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 className="panel-title">Sign-in attempts by deactivated people</h2>
          <p className="muted sm">Someone here may need to be reactivated: select them above and choose Reactivate.</p>
          <ul className="test-members">{refused.data.map(r => <li key={`${r.userId}:${r.at}`} className="test-member"><span className="test-member-title">{r.name ?? r.email} <span className="muted sm">{r.email}</span></span><span className="muted sm">{timeAgo(Date.parse(r.at))}{r.active ? ' · reactivated since' : ''}</span></li>)}</ul>
        </div>
      )}
      {bulk && (
        <Modal title={`${BULK[bulk.action].replace('…', '')}: ${picked.length} ${picked.length === 1 ? 'person' : 'people'}`} onClose={() => setBulk(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setBulk(null)}>Cancel</button>
          <button className={`btn ${bulk.action === 'deactivate' ? 'btn-danger' : 'btn-primary'}`} disabled={bulk.action.endsWith('group') && !bulk.groupId} onClick={apply}>{BULK[bulk.action].replace('…', '')}</button>
        </>}>
          {bulk.action.endsWith('group') && (
            <select className="input" aria-label="Which group" value={bulk.groupId} onChange={e => setBulk({ ...bulk, groupId: e.target.value })}>
              <option value="">Choose a group…</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {bulk.action === 'deactivate' && <p>They won’t be able to sign in until someone reactivates them. Their work, history and comments stay.</p>}
          {bulk.action === 'reactivate' && <p>They can sign in again with the access they had.</p>}
          <p className="muted sm">{(data ?? []).filter(p => picked.includes(p.id)).map(p => p.name).join(', ')}</p>
        </Modal>
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
