import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { LoadError, Loading, Modal, plural } from './ui'
import { PageAction } from './admin/AdminShell'

// Administration › User directories (spec 0712), as Jira's: Active Directory or LDAP, Read Only, in the order the login
// form tries them. Each one can be edited, tested, synchronised now, disabled and moved. Its password is never shown.

type Type = 'ad' | 'ldap'
interface Config {
  host: string; port: number; security: 'none' | 'ldaps' | 'starttls'; bindDn: string; baseDn: string; userDn: string; groupDn: string
  pageSize: number; syncMinutes: number; incremental: boolean; fullSyncHours: number; connectTimeoutSeconds: number; readTimeoutSeconds: number
  user: { objectClass: string; filter: string; username: string; firstName: string; lastName: string; displayName: string; email: string; guid: string }
  group: { objectClass: string; filter: string; name: string; description: string }
  membership: { groupMember: string; userMemberOf: string; useMemberOf: boolean; nested: boolean }
}
interface LastSync { at: string; ok: boolean; ms: number; error?: string; mode?: 'full' | 'incremental'; why?: string; users?: Record<string, any>; groups?: Record<string, any> }
interface Dir {
  id: string; name: string; type: Type; position: number; enabled: boolean; config: Config; hasPassword: boolean; users: number
  lastSync: LastSync | null; syncing: { jobId: string; status: string; progress: { done?: number } | null } | null
}
interface Step { step: string; ok: boolean; detail: string }
const TYPES: Record<Type, string> = { ad: 'Microsoft Active Directory', ldap: 'LDAP' }

export default function UserDirectories() {
  const { toast } = useApp()
  const [dirs, setDirs] = useState<Dir[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Dir | Type | null>(null)
  const [adding, setAdding] = useState(false)
  const [internal, setInternal] = useState<{ name: string; users: number } | null>(null)
  useEffect(() => { api<{ name: string; users: number }>('GET', '/api/admin/directories/internal').then(setInternal, () => {}) }, [dirs])
  const load = () => api<Dir[]>('GET', '/api/admin/directories').then(setDirs, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  // while one synchronises, follow its progress
  const syncing = dirs?.some(d => d.syncing)
  useEffect(() => {
    if (!syncing) return
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [syncing])

  const fail = (e: unknown) => toast(errorMessage(e), { tone: 'warn' })
  const move = (d: Dir, by: -1 | 1) => {
    const ids = dirs!.map(x => x.id), i = ids.indexOf(d.id)
    ;[ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!]
    api<Dir[]>('PUT', '/api/admin/directories/order', { ids }).then(setDirs, fail)
  }
  const toggle = (d: Dir) => api('PUT', `/api/admin/directories/${d.id}`, { name: d.name, enabled: !d.enabled, config: d.config })
    .then(() => { toast(`${d.name} ${d.enabled ? 'disabled' : 'enabled'}`); void load() }, fail)
  const sync = (d: Dir, full = false) => api('POST', `/api/admin/directories/${d.id}/sync`, { full }).then(() => { toast(`${full ? 'Fully synchronising' : 'Synchronising'} ${d.name}`); void load() }, fail)

  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!dirs) return <Loading />
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={14} />Add directory</button></PageAction>
      {!dirs.length && <p className="muted" style={{ marginBottom: 12 }}>Add your company’s Active Directory or LDAP server so people can sign in with their corp id and password, and their groups come with them.</p>}
      <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Order</th><th>Directory</th><th>Type</th><th className="col-num">People</th><th>Last synchronised</th><th /></tr></thead>
            <tbody>
              {internal && <tr style={{ cursor: 'default' }}>
                <td className="muted sm">Always first</td>
                <td>{internal.name}</td><td className="muted">Internal</td><td className="col-num">{internal.users}</td>
                <td className="muted">Kept in Strand: create and edit people in People</td><td />
              </tr>}
              {dirs.map((d, i) => (
                <tr key={d.id} style={{ cursor: 'default' }}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn sm" aria-label={`Move ${d.name} up`} disabled={i === 0} onClick={() => move(d, -1)}><ArrowUp size={14} /></button>
                    <button className="icon-btn sm" aria-label={`Move ${d.name} down`} disabled={i === dirs.length - 1} onClick={() => move(d, 1)}><ArrowDown size={14} /></button>
                  </td>
                  <td>{d.name}{!d.enabled && <span className="tag" style={{ marginLeft: 6 }}>Disabled</span>}{d.config.security === 'none' && <span className="tag" style={{ marginLeft: 6 }} title="Passwords travel unencrypted">Not encrypted</span>}</td>
                  <td className="muted">{TYPES[d.type]}</td>
                  <td className="col-num">{d.users}</td>
                  <td><SyncStatus d={d} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(d)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" disabled={!d.enabled || !!d.syncing} onClick={() => sync(d)}>Synchronise</button>
                    {d.type === 'ad' && d.config.incremental && <button className="btn btn-ghost btn-sm" disabled={!d.enabled || !!d.syncing} title="Read everything, applying deletions now" onClick={() => sync(d, true)}>Full synchronisation</button>}
                    <button className="btn btn-ghost btn-sm" onClick={() => toggle(d)}>{d.enabled ? 'Disable' : 'Enable'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      {adding && <Modal title="Add a user directory" onClose={() => setAdding(false)} footer={<button className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button>}>
        <p style={{ marginBottom: 12 }}>Which kind of directory?</p>
        {(Object.keys(TYPES) as Type[]).map(t => (
          <button key={t} className="btn btn-secondary" style={{ display: 'block', width: '100%', marginBottom: 8 }} onClick={() => { setAdding(false); setEditing(t) }}>{TYPES[t]}</button>
        ))}
      </Modal>}
      {editing && <Editor dir={typeof editing === 'string' ? null : editing} type={typeof editing === 'string' ? editing : editing.type}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />}
    </section>
  )
}

function SyncStatus({ d }: { d: Dir }) {
  if (d.syncing) return <span role="status">Synchronising…{d.syncing.progress?.done ? ` ${plural(d.syncing.progress.done, 'user')} read` : ''}</span>
  const s = d.lastSync
  if (!s) return <span className="muted">Not yet</span>
  if (!s.ok) return <span className="text-danger" title={s.error}>Failed {timeAgo(Date.parse(s.at))}: {s.error}</span>
  const u = s.users ?? {}, skipped = (u.skipped?.length ?? 0) + (s.groups?.skipped?.length ?? 0)
  const what = [u.created && `${u.created} new`, u.updated && `${u.updated} updated`, u.deactivated && `${u.deactivated} deactivated`, u.reactivated && `${u.reactivated} reactivated`].filter(Boolean).join(', ')
  const mode = s.mode === 'incremental' ? 'Incremental' : s.mode === 'full' ? 'Full' : ''
  return <span title={[s.why, ...(skipped ? [...(u.skipped ?? []), ...(s.groups?.skipped ?? [])].map((x: any) => `${x.name}: ${x.why}`) : [])].filter(Boolean).join('\n') || undefined}>
    {timeAgo(Date.parse(s.at))}<span className="muted">{mode ? ` · ${mode}` : ''}{what ? ` · ${what}` : ''}{skipped ? ` · ${skipped} skipped` : ''}</span>
  </span>
}

const SERVER: [keyof Config, string, string?][] = [
  ['host', 'Hostname'], ['port', 'Port'], ['bindDn', 'Username', 'The service account Strand reads the directory as: a DN, or user@domain for Active Directory'],
  ['baseDn', 'Base DN', 'e.g. DC=corp,DC=example,DC=com'],
]
const ADVANCED: [keyof Config, string, string?][] = [
  ['userDn', 'Additional user DN', 'Under the base DN, e.g. OU=People'], ['groupDn', 'Additional group DN', 'Under the base DN, e.g. OU=Groups'],
  ['syncMinutes', 'Synchronise every (minutes)'], ['pageSize', 'Search page size'], ['connectTimeoutSeconds', 'Connection timeout (seconds)'], ['readTimeoutSeconds', 'Read timeout (seconds)'],
]
const USER: [keyof Config['user'], string][] = [
  ['objectClass', 'User object class'], ['filter', 'User object filter'], ['username', 'User name attribute'], ['firstName', 'First name attribute'],
  ['lastName', 'Last name attribute'], ['displayName', 'Display name attribute'], ['email', 'Email attribute'], ['guid', 'Unique id attribute'],
]
const GROUP: [keyof Config['group'], string][] = [['objectClass', 'Group object class'], ['filter', 'Group object filter'], ['name', 'Group name attribute'], ['description', 'Group description attribute']]

/** Jira's directory form: server, advanced, user schema, group schema and membership, with Test settings. */
function Editor({ dir, type, onClose, onSaved }: { dir: Dir | null; type: Type; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const [name, setName] = useState(dir?.name ?? (type === 'ad' ? 'Active Directory' : 'LDAP'))
  const [c, setC] = useState<Config | null>(dir?.config ?? null)
  const [password, setPassword] = useState('')
  const [testUser, setTestUser] = useState({ username: '', password: '' })
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  useEffect(() => {
    if (!dir) api<Record<Type, Omit<Config, 'host' | 'bindDn' | 'baseDn'>>>('GET', '/api/admin/directories/presets')
      .then(p => setC({ host: '', bindDn: '', baseDn: '', ...p[type] }), e => toast(errorMessage(e), { tone: 'warn' }))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null

  const set = (k: keyof Config, v: unknown) => setC({ ...c, [k]: v })
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErrors({})
    try { await f() } catch (e) { setErrors(e instanceof ApiError ? { ...flat(e.errors), '': e.message } : { '': errorMessage(e) }) } finally { setBusy('') }
  }
  const test = () => run('test', async () => {
    const r = await api<{ steps: Step[] }>('POST', '/api/admin/directories/test', { id: dir?.id, config: c, ...(password ? { password } : {}), ...(testUser.username ? { testUser } : {}) })
    setSteps(r.steps)
  })
  const save = () => run('save', async () => {
    const body = { name, enabled: dir?.enabled ?? true, config: c, ...(password ? { password } : {}) }
    if (dir) await api('PUT', `/api/admin/directories/${dir.id}`, body)
    else await api('POST', '/api/admin/directories', { ...body, type })
    toast(`${name} saved${dir ? '' : ': synchronising'}`)
    onSaved()
  })
  const text = (k: string, label: string, value: string | number, onChange: (v: string) => void, hint?: string, inputType = 'text') => (
    <div key={k} className="dir-field">
      <label className="label" htmlFor={`dir-${k}`}>{label}</label>
      <input id={`dir-${k}`} className="input" type={inputType} value={value} onChange={e => onChange(e.target.value)} aria-invalid={!!errors[k]} />
      {errors[k] ? <p className="hint error">{errors[k]}</p> : hint && <p className="hint">{hint}</p>}
    </div>
  )
  const field = ([k, label, hint]: [keyof Config, string, string?]) => {
    const v = c[k] as string | number
    return text(k, label, v, s => set(k, typeof v === 'number' ? (s === '' ? '' : Number(s)) : s), hint, typeof v === 'number' ? 'number' : 'text')
  }
  return (
    <Modal title={dir ? `Edit ${dir.name}` : `Add ${TYPES[type]}`} onClose={onClose} width={720} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-secondary" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test settings'}</button>
      <button className="btn btn-primary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
    </>}>
      <form className="dir-form" onSubmit={e => { e.preventDefault(); void save() }}>
        {errors[''] && <p role="alert" className="text-danger">{errors['']}</p>}
        <h3 className="dir-section">Server settings</h3>
        {text('name', 'Name', name, setName)}
        {SERVER.slice(0, 2).map(field)}
        <div className="dir-field">
          <label className="label" htmlFor="dir-security">Encryption</label>
          <select id="dir-security" className="input" value={c.security} onChange={e => set('security', e.target.value)}>
            <option value="ldaps">LDAPS (SSL)</option><option value="starttls">StartTLS</option><option value="none">None</option>
          </select>
          {c.security === 'none' && <p className="hint error">Passwords will travel unencrypted. Use LDAPS (port 636) or StartTLS.</p>}
        </div>
        {SERVER.slice(2).map(field)}
        {text('password', 'Password', password, setPassword, dir?.hasPassword ? 'Unchanged unless you type a new one (needed again when the server or username changes)' : 'The service account’s password', 'password')}
        <h3 className="dir-section">Advanced</h3>
        {ADVANCED.map(field)}
        {type === 'ad' && <>
          <label className="check-row"><input type="checkbox" checked={c.incremental} onChange={e => setC({ ...c, incremental: e.target.checked })} />Enable incremental synchronisation</label>
          <p className="hint">Reads only what changed since the last run (uSNChanged). A full synchronisation still runs at least every:</p>
          {field(['fullSyncHours', 'Full synchronisation every (hours)', 'Applies people and groups deleted or moved out of scope'])}
        </>}
        <h3 className="dir-section">User schema</h3>
        {USER.map(([k, label]) => text(`user.${k}`, label, c.user[k], v => setC({ ...c, user: { ...c.user, [k]: v } })))}
        <h3 className="dir-section">Group schema</h3>
        {GROUP.map(([k, label]) => text(`group.${k}`, label, c.group[k], v => setC({ ...c, group: { ...c.group, [k]: v } })))}
        <h3 className="dir-section">Membership schema</h3>
        {text('membership.groupMember', 'Group members attribute', c.membership.groupMember, v => setC({ ...c, membership: { ...c.membership, groupMember: v } }))}
        {text('membership.userMemberOf', 'User membership attribute', c.membership.userMemberOf, v => setC({ ...c, membership: { ...c.membership, userMemberOf: v } }))}
        <label className="check-row"><input type="checkbox" checked={c.membership.useMemberOf} onChange={e => setC({ ...c, membership: { ...c.membership, useMemberOf: e.target.checked } })} />Use the user membership attribute when finding a user’s groups</label>
        <label className="check-row"><input type="checkbox" checked={c.membership.nested} onChange={e => setC({ ...c, membership: { ...c.membership, nested: e.target.checked } })} />Enable nested groups</label>
        <h3 className="dir-section">Test settings</h3>
        <p className="hint" style={{ marginTop: 0 }}>Optionally, a person to look up and sign in as, to check the schema and their password.</p>
        <div className="form-row">
          {text('test-user', 'Test username', testUser.username, v => setTestUser({ ...testUser, username: v }))}
          {text('test-password', 'Test password', testUser.password, v => setTestUser({ ...testUser, password: v }), undefined, 'password')}
        </div>
        {steps && <ul className="dir-steps" aria-label="Test results">
          {steps.map(s => <li key={s.step} className={s.ok ? '' : 'text-danger'}><b>{s.ok ? '✓' : '✗'} {s.step}</b>: {s.detail}</li>)}
        </ul>}
      </form>
    </Modal>
  )
}

/** The server's per-field messages, keyed as the form's fields are (config.user.filter → user.filter). */
const flat = (errors?: Record<string, string>) => Object.fromEntries(Object.entries(errors ?? {}).map(([k, v]) => [k.replace(/^config\./, ''), v]))
