import { Fragment, useEffect, useRef, useState } from 'react'
import { Users, Download, RotateCcw } from 'lucide-react'
import { api, apiEnabled, errorMessage } from '../api/client'
import { useStore, timeAgo } from '../data/store'
import { isGlobalAdmin } from '../data/access'
import { useApp } from '../appContext'
import { href, navigate, type AdminSection } from '../router'
import { formatBytes } from '../data/files'
import { Avatar, ConfirmDialog, Empty, LoadError, Loading, Modal, openRow, plural, Toggle } from './ui'
import SystemSettings, { SETTINGS_PAGES } from './SystemSettings'
import AdminShell, { ITEMS, PageAction } from './admin/AdminShell'
import { AnonymiseDialog, CreateUserDialog, EditUserDialog } from './admin/LocalUsers'
import { GroupPicker, Progress, useJob, type GroupRef } from './admin/scale'
import TestStatusesAdmin from './testing/TestStatusesAdmin'
import GroupsView from './groups/GroupsView'
import WorkflowsAdmin from './WorkflowsAdmin'
import WorkflowBuilder from './WorkflowBuilder'
import LinkTypesAdmin from './LinkTypesAdmin'
import ListsAdmin from './ListsAdmin'
import AuthMethods from './AuthMethods'
import UserDirectories from './UserDirectories'
import ProjectCategories from './ProjectCategories'
import WebhooksAdmin from './WebhooksAdmin'
import DevelopmentTools from './DevelopmentTools'
import GlobalAutomation from './GlobalAutomation'
import CustomFieldsAdmin from './CustomFieldsAdmin'
import FieldConfigsAdmin from './FieldConfigsAdmin'
import ScreensAdmin from './ScreensAdmin'
import SharedViewsAdmin from './SharedViewsAdmin'
import ArchivedProjects from './admin/ArchivedProjects'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Administration (system administrators: people, groups, workflows, audit, backups, settings…). For everyone else the
 *  same area is Configuration, with only what they may manage there: groups. */
export default function AdminView({ section = 'people', item }: { section?: AdminSection; item?: string }) {
  const { state } = useStore()
  if (!apiEnabled)
    return <div className="page-col"><Empty icon={<Users size={22} strokeWidth={1.5} />} title="Administration needs a server"
      body="Administration needs Strand to be connected to a server." /></div>
  // system administrators see everything; everyone else sees Configuration with what they may manage: groups
  const admin = isGlobalAdmin(state)
  const items = admin ? ITEMS : ITEMS.filter(s => s.id === 'groups')
  if (!items.some(s => s.id === section)) section = 'groups'
  // a workflow open in the editor takes the whole page
  if (section === 'workflows' && item && UUID.test(item)) return <WorkflowBuilder id={item} onBack={() => navigate(href({ name: 'admin', section: 'workflows' }))} />
  const settingsPage = section === 'settings' ? (SETTINGS_PAGES.find(p => p.id === item) ?? SETTINGS_PAGES[0]).id : undefined
  return (
    <AdminShell title={admin ? 'Administration' : 'Configuration'} items={items} section={section}
      sub={settingsPage ? SETTINGS_PAGES.map(p => ({ id: p.id, label: p.label, current: p.id === settingsPage })) : undefined}>
      {section === 'people' && <People />}
      {section === 'groups' && <GroupsView admin={admin} openId={item && UUID.test(item) ? item : null} onOpen={id => navigate(href({ name: 'admin', section: 'groups', ...(id ? { item: id } : {}) }))} />}
      {section === 'auth-methods' && <AuthMethods />}
      {section === 'directories' && <UserDirectories />}
      {section === 'project-categories' && <ProjectCategories />}
      {section === 'webhooks' && <WebhooksAdmin />}
      {section === 'development' && <DevelopmentTools />}
      {section === 'automation' && <GlobalAutomation />}
      {section === 'custom-fields' && <CustomFieldsAdmin />}
      {section === 'field-configurations' && <FieldConfigsAdmin />}
      {section === 'screens' && <ScreensAdmin />}
      {section === 'workflows' && <WorkflowsAdmin tab={item === 'statuses' || item === 'schemes' ? item : 'workflows'} />}
      {section === 'link-types' && <LinkTypesAdmin />}
      {(section === 'priorities' || section === 'resolutions') && <ListsAdmin kind={section} />}
      {section === 'test-statuses' && <TestStatusesAdmin />}
      {section === 'settings' && <SystemSettings page={settingsPage} />}
      {section === 'audit' && <AuditLog />}
      {section === 'archived' && <ArchivedProjects />}
      {section === 'backups' && <Backups />}
      {section === 'views' && <SharedViewsAdmin />}
    </AdminShell>
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
    api<T>('GET', path).then(d => { if (live) setData(d) }, e => { if (live) setError(errorMessage(e)) })
    return () => { live = false }
  }, [path, n])
  return { data, error, reload: () => setN(x => x + 1) }
}

interface Person {
  id: string; name: string; email: string; initials: string; color: string; title: string | null; active: boolean; role: 'owner' | 'admin' | 'member'; projects: number
  lastActiveAt: string | null; lastSignInAt: string | null; directory?: string | null; username?: string | null; hasPassword?: boolean; anonymisedAt?: string | null; groups: { id: string; name: string }[]
}
type BulkAction = 'deactivate' | 'reactivate' | 'add-to-group' | 'remove-from-group'
const BULK: Record<BulkAction, string> = { deactivate: 'Deactivate', reactivate: 'Reactivate', 'add-to-group': 'Add to group…', 'remove-from-group': 'Remove from group…' }
const PAGE = 50

/** Everyone, with last activity and groups (resolution's user browser), searched, filtered and paged on the server:
 *  pick people, or take everyone a filter matches (any number, changed in the background). */
function People() {
  const { toast } = useApp()
  const refused = useLoad<{ at: string; userId: string | null; email: string | null; name: string | null; active: boolean | null }[]>('/api/admin/users/refused-sign-ins')
  const [q, setQ] = useState('')
  const [inactive, setInactive] = useState('')            // '' | days | 'never'
  const [status, setStatus] = useState<'all' | 'active' | 'deactivated'>('all')
  const [inGroup, setInGroup] = useState<'in' | 'out'>('in')
  const [group, setGroup] = useState<GroupRef | null>(null)
  const [rows, setRows] = useState<Person[] | null>(null)
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [picked, setPicked] = useState<Map<string, string>>(new Map())       // id → name
  const [everyone, setEveryone] = useState(false)                             // everyone the filter matches, not just those picked
  const [bulk, setBulk] = useState<{ action: BulkAction; group: GroupRef | null } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Person | null>(null)
  const [anonymising, setAnonymising] = useState<Person | null>(null)
  const seq = useRef(0)
  const filter: Record<string, string> = { ...(q.trim() ? { query: q.trim() } : {}), status, ...(inactive ? { inactive } : {}), ...(group ? (inGroup === 'in' ? { group: group.id } : { notInGroup: group.id }) : {}) }
  const load = (more = false) => {
    const mine = ++seq.current
    setError(''); if (more) setLoadingMore(true)
    const p = new URLSearchParams({ ...filter, limit: String(PAGE), ...(more && next ? { cursor: next } : {}) })
    api<{ items: Person[]; total: number; next: string | null }>('GET', `/api/admin/users?${p}`).then(r => {
      if (mine !== seq.current) return
      setRows(xs => (more ? [...(xs ?? []), ...r.items] : r.items)); setTotal(r.total); setNext(r.next); setLoadingMore(false)
    }, e => { if (mine === seq.current) { setError(errorMessage(e)); setLoadingMore(false) } })
  }
  const key = JSON.stringify(filter)
  useEffect(() => { setEveryone(false); const t = setTimeout(() => load(), q ? 250 : 0); return () => clearTimeout(t) }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  const job = useJob(jobId, (st, result) => {
    setJobId(null); setPicked(new Map()); setEveryone(false); load()
    toast(st === 'done' ? `Changed ${result.changed.toLocaleString()}${result.unchanged ? `, ${result.unchanged.toLocaleString()} already so` : ''}${result.stopped ? `. Stopped: ${result.stopped}` : ''}` : 'The change could not be finished',
      st === 'done' && !result.stopped ? undefined : { tone: 'warn' })
  })
  const shown = rows ?? []
  const allShown = shown.length > 0 && shown.every(p => picked.has(p.id))
  const count = everyone ? total : picked.size
  const apply = async () => {
    if (!bulk) return
    if (bulk.action.endsWith('group') && !bulk.group) throw new Error('Choose a group first')
    const body = { action: bulk.action, ...(bulk.group ? { groupId: bulk.group.id } : {}) }
    if (everyone) {
      const r = await api<{ jobId: string; matched: number }>('POST', '/api/admin/users/bulk', { ...body, filter })
      setJobId(r.jobId); return
    }
    const r = await api<{ changed: number; unchanged: number }>('POST', '/api/admin/users/bulk', { ...body, userIds: [...picked.keys()] })
    toast(`${BULK[bulk.action].replace('…', '')}: ${r.changed} changed${r.unchanged ? `, ${r.unchanged} already so` : ''}`); setPicked(new Map()); load()
  }
  const pick = (ids: Person[], on: boolean) => { const m = new Map(picked); for (const p of ids) { if (on) m.set(p.id, p.name); else m.delete(p.id) } setPicked(m) }
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setCreating(true)}>Create user</button></PageAction>
      <div className="people-filters">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Find a person" aria-label="Find a person" value={q} onChange={e => setQ(e.target.value)} />
        <select className="input" aria-label="Inactive" value={inactive} onChange={e => setInactive(e.target.value)}>
          <option value="">Any activity</option><option value="30">Inactive 30+ days</option><option value="90">Inactive 90+ days</option><option value="180">Inactive 180+ days</option><option value="365">Inactive a year or more</option><option value="never">Never used Strand</option>
        </select>
        <select className="input" aria-label="Status" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
          <option value="all">Active and deactivated</option><option value="active">Active</option><option value="deactivated">Deactivated</option>
        </select>
        <select className="input" aria-label="In or not in the group" value={inGroup} onChange={e => setInGroup(e.target.value as 'in' | 'out')}>
          <option value="in">In group</option><option value="out">Not in group</option>
        </select>
        <GroupPicker label="Group" value={group} onChange={setGroup} placeholder="Any group" />
      </div>
      {jobId && <div className="apply-banner">{job?.progress ? <Progress label="Changing people" done={job.progress.done ?? 0} total={job.progress.total ?? 0} /> : <span role="status">Starting…</span>}</div>}
      {(picked.size > 0 || everyone) && !jobId && (
        <div className="bulk-bar" role="region" aria-label="Change selected people">
          <b>{everyone ? `All ${total.toLocaleString()} matching` : `${picked.size.toLocaleString()} selected`}</b>
          {!everyone && allShown && total > shown.length && <button className="btn btn-ghost btn-sm" onClick={() => setEveryone(true)}>Select all {total.toLocaleString()} matching</button>}
          <select className="input input-sm" aria-label="Bulk action" value="" onChange={e => e.target.value && setBulk({ action: e.target.value as BulkAction, group: null })}>
            <option value="">Change them…</option>{Object.entries(BULK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => { setPicked(new Map()); setEveryone(false) }}>Clear</button>
        </div>
      )}
      {error && <LoadError error={error} onRetry={() => load(!!rows?.length && !!next)} />}
      {!rows && !error && <Loading rows={6} />}
      {rows && <>
        <p className="muted sm" role="status" style={{ marginBottom: 6 }}>Showing {shown.length.toLocaleString()} of {total.toLocaleString()}</p>
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" aria-label="Select everyone shown" checked={allShown || everyone} disabled={everyone} onChange={e => pick(shown, e.target.checked)} /></th>
              <th>Name</th><th>Email</th><th>Role</th><th>Groups</th><th>Last active</th><th>Status</th><th />
            </tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id}>
                  <td><input type="checkbox" aria-label={`Select ${p.name}`} checked={everyone || picked.has(p.id)} disabled={everyone} onChange={e => pick([p], e.target.checked)} /></td>
                  <td><span className="admin-person"><Avatar user={{ ...p, title: p.title ?? undefined }} size={24} /><span className="admin-person-name">{p.name}{p.title && <span className="muted sm">{p.title}</span>}</span></span></td>
                  <td className="muted">{p.email}{p.directory && <span className="tag" style={{ marginLeft: 6 }} title="Their details and status come from this user directory">Directory: {p.directory}</span>}</td>
                  <td>{p.role === 'member' ? 'Member' : p.role === 'owner' ? 'Owner' : 'Admin'}</td>
                  <td className="muted sm admin-wrap">{p.groups.length > 4 ? `${p.groups.slice(0, 3).map(g => g.name).join(', ')} and ${p.groups.length - 3} more` : p.groups.map(g => g.name).join(', ')}</td>
                  <td className="muted" title={p.lastSignInAt ? `Last sign-in ${new Date(p.lastSignInAt).toLocaleString()}` : 'Never signed in'}>{p.lastActiveAt ? timeAgo(Date.parse(p.lastActiveAt)) : 'Never'}</td>
                  <td>{p.active ? <span className="lozenge lozenge-done">Active</span> : <span className="lozenge lozenge-todo">Deactivated</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {p.anonymisedAt ? <span className="muted sm">Anonymised</span> : <>
                      {!p.directory && p.username !== 'recovery_admin' && <button className="btn btn-ghost btn-sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>Edit</button>}
                      {!p.active && p.role !== 'owner' && <button className="btn btn-ghost btn-sm" aria-label={`Anonymise ${p.name}`} onClick={() => setAnonymising(p)}>Anonymise…</button>}
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="muted" style={{ padding: 12 }}>Nobody matches.</p>}
        </div>
        {next && <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={loadingMore} onClick={() => load(true)}>{loadingMore ? 'Loading…' : `Load ${Math.min(PAGE, total - shown.length).toLocaleString()} more`}</button>}
      </>}
      {!!refused.data?.length && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 className="panel-title">Sign-in attempts by deactivated people</h2>
          <p className="muted sm">Someone here may need to be reactivated: find them above and choose Reactivate.</p>
          <ul className="test-members">{refused.data.map(r => <li key={`${r.userId}:${r.at}`} className="test-member"><span className="test-member-title">{r.name ?? r.email} <span className="muted sm">{r.email}</span></span><span className="muted sm">{timeAgo(Date.parse(r.at))}{r.active ? ' · reactivated since' : ''}</span></li>)}</ul>
        </div>
      )}
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={() => load()} />}
      {editing && <EditUserDialog person={editing} onClose={() => setEditing(null)} onSaved={() => load()} />}
      {anonymising && <AnonymiseDialog person={anonymising} onClose={() => setAnonymising(null)} onDone={() => load()} />}
      {bulk && (
        <ConfirmDialog title={`${BULK[bulk.action].replace('…', '')}: ${count.toLocaleString()} ${count === 1 ? 'person' : 'people'}`}
          action={BULK[bulk.action].replace('…', '')} danger={bulk.action === 'deactivate'} typeToConfirm={everyone && count > 100 ? String(count) : undefined}
          onClose={() => setBulk(null)} onConfirm={apply}>
          {bulk.action.endsWith('group') && <GroupPicker label="Which group" value={bulk.group} onChange={g => setBulk({ ...bulk, group: g })} />}
          {bulk.action === 'deactivate' && <p>They won’t be able to sign in until someone reactivates them. Their work, history and comments stay. You are never deactivated this way.</p>}
          {bulk.action === 'reactivate' && <p>They can sign in again with the access they had.</p>}
          {everyone ? <p className="muted sm">Everyone the filter matches now. It runs in the background; you can leave this page.</p>
            : <p className="muted sm">{[...picked.values()].slice(0, 8).join(', ')}{picked.size > 8 ? ` and ${picked.size - 8} more` : ''}</p>}
        </ConfirmDialog>
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
  const [project, setProject] = useState('')
  const [from, setFrom] = useState('')                     // YYYY-MM-DD, inclusive
  const [to, setTo] = useState('')                         // YYYY-MM-DD, inclusive
  const [rows, setRows] = useState<AuditRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const query = (cursor?: string | null) => {
    const q = new URLSearchParams({ limit: '50' })
    if (action.trim()) q.set('action', action.trim())
    if (actor.trim()) q.set('actor', actor.trim())
    if (project.trim()) q.set('project', project.trim())
    if (from) q.set('from', new Date(`${from}T00:00`).toISOString())
    if (to) { const d = new Date(`${to}T00:00`); d.setDate(d.getDate() + 1); q.set('to', d.toISOString()) }
    if (cursor) q.set('cursor', cursor)
    return `/api/audit?${q}`
  }
  const filtered = !!(action || actor || project || from || to)
  const load = (more = false) => {
    setState('loading')
    api<{ items: AuditRow[]; next: string | null }>('GET', query(more ? next : null)).then(
      r => { setRows(rs => (more ? [...rs, ...r.items] : r.items)); setNext(r.next); setState('ready') },
      e => { setError(errorMessage(e)); setState('error') })
  }
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t) }, [action, actor, project, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section>
      <div className="people-filters">
        <input className="input" style={{ maxWidth: 220 }} placeholder="Action, e.g. project.member" aria-label="Filter by action" value={action} onChange={e => setAction(e.target.value)} />
        <input className="input" style={{ maxWidth: 200 }} placeholder="Who (email)" aria-label="Filter by who" value={actor} onChange={e => setActor(e.target.value)} />
        <input className="input mono" style={{ maxWidth: 130 }} placeholder="Project key" aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value.toUpperCase())} />
        <label className="form-row" style={{ alignItems: 'center', gap: 6 }}><span className="muted sm">From</span>
          <input className="input" type="date" aria-label="From date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
        <label className="form-row" style={{ alignItems: 'center', gap: 6 }}><span className="muted sm">to</span>
          <input className="input" type="date" aria-label="To date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
        {filtered && <button className="btn btn-ghost btn-sm" onClick={() => { setAction(''); setActor(''); setProject(''); setFrom(''); setTo('') }}>Clear</button>}
      </div>
      {state === 'error' && <LoadError error={error} onRetry={() => load(rows.length > 0)} />}
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th>Target</th><th>Change</th></tr></thead>
          <tbody>
            {rows.map(r => {
              const has = r.before != null || r.after != null
              return (
                <Fragment key={r.id}>
                  <tr {...(has ? openRow(() => setOpen(open === r.id ? null : r.id), `${open === r.id ? 'Hide' : 'Show'} the change`) : {})} aria-expanded={has ? open === r.id : undefined}>
                    <td title={new Date(r.at).toLocaleString()}>{timeAgo(Date.parse(r.at))}</td>
                    <td>{r.actor}</td>
                    <td>{actionLabel(r.action)}</td>
                    <td className="mono">{r.projectKey ?? ''}</td>
                    <td>{r.target ?? ''}</td>
                    <td className="muted sm admin-change">
                      {r.before != null && <span>{brief(r.before)}</span>}{r.before != null && r.after != null && ' → '}{r.after != null && <span>{brief(r.after)}</span>}
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="audit-detail"><td colSpan={6}>
                      <dl>
                        <dt>When</dt><dd>{new Date(r.at).toLocaleString()}{r.ip ? ` · from ${r.ip}` : ''}</dd>
                        {r.before != null && <><dt>Before</dt><dd><pre>{JSON.stringify(r.before, null, 2)}</pre></dd></>}
                        {r.after != null && <><dt>After</dt><dd><pre>{JSON.stringify(r.after, null, 2)}</pre></dd></>}
                      </dl>
                    </td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {state === 'ready' && !rows.length && <p className="muted" style={{ padding: 12 }}>Nothing recorded{filtered ? ' that matches' : ' yet'}.</p>}
      </div>
      {state === 'loading' && <Loading rows={rows.length ? 1 : 6} />}
      {next && state === 'ready' && <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => load(true)}>Show older</button>}
    </section>
  )
}

interface BackupSettings { enabled: boolean; bucket: string | null; prefix: string; effectiveBucket: string | null; allowedBuckets: string[] }
interface Backup { id: string; projectKey: string; projectName: string; items: number; files: number; bytes: number; createdAt: string; restoredAt: string | null }

function Backups() {
  const { toast } = useApp()
  const settings = useLoad<BackupSettings>('/api/admin/settings/project-backups')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Backup[] | null>(null)
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [listError, setListError] = useState('')
  const load = (more = false) => {
    setListError('')
    const p = new URLSearchParams({ limit: '50', ...(q.trim() ? { query: q.trim() } : {}), ...(more && next ? { cursor: next } : {}) })
    api<{ items: Backup[]; total: number; next: string | null }>('GET', `/api/admin/project-backups?${p}`)
      .then(r => { setRows(xs => (more ? [...(xs ?? []), ...r.items] : r.items)); setTotal(r.total); setNext(r.next) }, e => setListError(errorMessage(e)))
  }
  useEffect(() => { const t = setTimeout(() => load(), q ? 250 : 0); return () => clearTimeout(t) }, [q])   // eslint-disable-line react-hooks/exhaustive-deps
  const list = { reload: () => load() }
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)

  const save = (patch: Partial<Pick<BackupSettings, 'enabled' | 'bucket'>>) => {
    const s = settings.data!
    api('PUT', '/api/admin/settings/project-backups', { enabled: patch.enabled ?? s.enabled, bucket: patch.bucket !== undefined ? patch.bucket : s.bucket })
      .then(() => { settings.reload(); toast('Backup setting saved') }, e => toast(errorMessage(e), { tone: 'warn' }))
  }
  const download = (b: Backup) => api<{ url: string }>('GET', `/api/admin/project-backups/${b.id}/url`)
    .then(r => window.location.assign(r.url), e => toast(errorMessage(e), { tone: 'warn' }))
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
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
    setWaiting(null); list.reload()
  }

  const s = settings.data
  return (
    <section>
      <section className="panel">
        <h2 className="panel-title">When a project is deleted</h2>
        {settings.error && <LoadError error={settings.error} onRetry={settings.reload} />}
        {!settings.data && !settings.error && <Loading rows={2} />}
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
        {(total > 10 || q) && <input className="input" style={{ maxWidth: 280, marginBottom: 8 }} placeholder="Find a project by key or name" aria-label="Find a backup" value={q} onChange={e => setQ(e.target.value)} />}
        {listError && <LoadError error={listError} onRetry={() => load(!!rows?.length && !!next)} />}
        {!rows && !listError && <Loading />}
        {rows && !rows.length && <p className="muted">{q ? 'No backup matches.' : 'No projects have been deleted with a backup yet.'}</p>}
        {rows && rows.length > 0 && <p className="muted sm" role="status" style={{ marginBottom: 6 }}>Showing {rows.length.toLocaleString()} of {total.toLocaleString()}</p>}
        {rows && rows.length > 0 && (
          <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>Project</th><th>Deleted</th><th>Contents</th><th></th></tr></thead>
              <tbody>
                {rows.map(b => (
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
        {next && !listError && <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => load(true)}>Show older backups</button>}
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
