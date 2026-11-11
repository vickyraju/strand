import { useEffect, useState } from 'react'
import { Copy, Plus, Star, Trash2, X } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { useStore, type Project } from '../data/store'
import { isGlobalAdmin } from '../data/access'
import { UserSelect } from './UserPicker'
import { Modal } from './ui'

// Administration › Notification schemes (spec 0605), as Jira's: for each event, who hears about it. Projects use one, or None.

interface Entry { id: string; event: string; recipient: string; value: string | null; valueName: string | null }
interface Scheme { id: string; name: string; description: string; isDefault: boolean; projects: number; entries?: Entry[] }

export const EVENTS: [string, string][] = [
  ['issue_created', 'Issue Created'], ['issue_updated', 'Issue Updated'], ['issue_assigned', 'Issue Assigned'], ['issue_resolved', 'Issue Resolved'],
  ['issue_closed', 'Issue Closed'], ['issue_commented', 'Issue Commented'], ['issue_comment_edited', 'Issue Comment Edited'], ['issue_comment_deleted', 'Issue Comment Deleted'],
  ['issue_reopened', 'Issue Reopened'], ['issue_deleted', 'Issue Deleted'], ['issue_moved', 'Issue Moved'], ['issue_worklogged', 'Work Logged On Issue'],
  ['issue_work_started', 'Work Started On Issue'], ['issue_work_stopped', 'Work Stopped On Issue'], ['issue_worklog_updated', 'Issue Worklog Updated'],
  ['issue_worklog_deleted', 'Issue Worklog Deleted'], ['issue_generic', 'Generic Event'],
]
const RECIPIENTS: [string, string][] = [
  ['current_assignee', 'Current Assignee'], ['reporter', 'Reporter'], ['current_user', 'Current User'], ['project_lead', 'Project Lead'], ['component_lead', 'Component Lead'],
  ['all_watchers', 'All Watchers'], ['user', 'Single User'], ['group', 'Group'], ['project_role', 'Project Role'], ['user_field', 'User Custom Field Value'], ['group_field', 'Group Custom Field Value'],
]
const ROLES: Record<string, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }
const label = (e: Entry) => {
  const r = RECIPIENTS.find(x => x[0] === e.recipient)?.[1] ?? e.recipient
  return e.recipient === 'project_role' ? `${r} (${ROLES[e.value ?? ''] ?? e.value})` : e.value ? `${r} (${e.valueName ?? e.value})` : r
}

export default function NotificationSchemes() {
  const { toast } = useApp()
  const [schemes, setSchemes] = useState<Scheme[] | null>(null)
  const [open, setOpen] = useState<Scheme | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ copyOf?: Scheme } | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', { tone: 'warn' })
  const load = () => api<Scheme[]>('GET', '/api/admin/notification-schemes').then(setSchemes, e => setError(e instanceof ApiError ? e.message : 'Could not reach the server.'))
  const show = (id: string) => api<Scheme>('GET', `/api/admin/notification-schemes/${id}`).then(setOpen, fail)
  useEffect(() => { load() }, [])

  const create = async () => {
    try {
      const s = await api<Scheme>('POST', naming?.copyOf ? `/api/admin/notification-schemes/${naming.copyOf.id}/copy` : '/api/admin/notification-schemes', { name: name.trim() })
      setNaming(null); setName(''); load(); setOpen(s)
    } catch (e) { fail(e) }
  }

  if (open) return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">{open.name}{open.isDefault && <span className="lozenge lozenge-todo" style={{ marginLeft: 8 }}>Default</span>}</h2>
          <p className="muted">{open.projects ? `${open.projects} project${open.projects === 1 ? '' : 's'} use${open.projects === 1 ? 's' : ''} it.` : 'No project uses it.'} People never hear about their own changes, and only about work they can see.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => { setOpen(null); load() }}>All schemes</button>
      </div>
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table">
          <thead><tr><th>Event</th><th>Recipients</th><th /></tr></thead>
          <tbody>{EVENTS.map(([ev, evName]) => (
            <tr key={ev} style={{ cursor: 'default' }}>
              <td>{evName}</td>
              <td>{(open.entries ?? []).filter(e => e.event === ev).map(e => (
                <span key={e.id} className="chip" style={{ marginRight: 6 }}>{label(e)}
                  <button className="icon-btn sm" aria-label={`Remove ${label(e)} from ${evName}`} onClick={() => api<Scheme>('DELETE', `/api/admin/notification-schemes/${open.id}/entries/${e.id}`).then(setOpen, fail)}><X size={12} /></button>
                </span>))}</td>
              <td className="nowrap"><button className="btn btn-ghost btn-sm" aria-label={`Add a recipient to ${evName}`} onClick={() => setAdding(ev)}><Plus size={14} />Add</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {adding && <AddRecipient event={adding} onClose={() => setAdding(null)} onAdd={async b => {
        try { setOpen(await api<Scheme>('POST', `/api/admin/notification-schemes/${open.id}/entries`, { event: adding, ...b })); setAdding(null) } catch (e) { fail(e) }
      }} />}
    </section>
  )

  return (
    <section className="panel">
      <div className="panel-title-row">
        <p className="muted">Each project uses a scheme, or None. New projects get the default.</p>
        <button className="btn btn-primary" onClick={() => { setNaming({}); setName('') }}><Plus size={14} />Add scheme</button>
      </div>
      {error && <p className="hint error" role="alert">{error}</p>}
      {schemes && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Name</th><th className="col-num">Projects</th><th /></tr></thead>
            <tbody>{schemes.map(s => (
              <tr key={s.id} onClick={() => show(s.id)}>
                <td><b>{s.name}</b>{s.isDefault && <span className="lozenge lozenge-todo" style={{ marginLeft: 8 }}>Default</span>}<div className="muted sm">{s.description}</div></td>
                <td className="col-num">{s.projects}</td>
                <td className="nowrap" onClick={e => e.stopPropagation()}>
                  {!s.isDefault && <button className="icon-btn sm" title="Make default" aria-label={`Make ${s.name} the default`} onClick={() => api('PATCH', `/api/admin/notification-schemes/${s.id}`, { isDefault: true }).then(load, fail)}><Star size={14} /></button>}
                  <button className="icon-btn sm" title="Copy" aria-label={`Copy ${s.name}`} onClick={() => { setNaming({ copyOf: s }); setName(`Copy of ${s.name}`) }}><Copy size={14} /></button>
                  {!s.isDefault && !s.projects && <button className="icon-btn sm" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => api('DELETE', `/api/admin/notification-schemes/${s.id}`).then(load, fail)}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {naming && (
        <Modal title={naming.copyOf ? `Copy ${naming.copyOf.name}` : 'Add notification scheme'} onClose={() => setNaming(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setNaming(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={create}>{naming.copyOf ? 'Copy' : 'Add'}</button>
        </>}>
          <label className="label" htmlFor="ns-name">Name</label>
          <input id="ns-name" className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </Modal>
      )}
    </section>
  )
}

function AddRecipient({ event, onClose, onAdd }: { event: string; onClose: () => void; onAdd: (b: { recipient: string; value: string | null }) => void }) {
  const [recipient, setRecipient] = useState('all_watchers')
  const [value, setValue] = useState<string | null>(null)
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [fields, setFields] = useState<{ id: string; name: string; kind: string }[]>([])
  useEffect(() => {
    api<{ id: string; name: string }[]>('GET', '/api/groups/search').then(setGroups, () => {})
    api<{ items: { id: string; name: string; kind: string }[] }>('GET', '/api/admin/custom-fields?limit=200').then(r => setFields(r.items), () => {})
  }, [])
  const needs = ['user', 'group', 'project_role', 'user_field', 'group_field'].includes(recipient)
  return (
    <Modal title={`Add a recipient to ${EVENTS.find(e => e[0] === event)?.[1]}`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={needs && !value} onClick={() => onAdd({ recipient, value: needs ? value : null })}>Add</button>
    </>}>
      <label className="label" htmlFor="nr-kind">Recipient</label>
      <select id="nr-kind" className="input" value={recipient} onChange={e => { setRecipient(e.target.value); setValue(null) }}>
        {RECIPIENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {recipient === 'user' && <div style={{ marginTop: 10 }}><UserSelect label="Person" value={value ?? undefined} placeholder="Choose a person…" onChange={id => setValue(id ?? null)} /></div>}
      {recipient === 'group' && <select className="input" aria-label="Group" style={{ marginTop: 10 }} value={value ?? ''} onChange={e => setValue(e.target.value || null)}>
        <option value="">Choose a group…</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
      {recipient === 'project_role' && <select className="input" aria-label="Project role" style={{ marginTop: 10 }} value={value ?? ''} onChange={e => setValue(e.target.value || null)}>
        <option value="">Choose a role…</option>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
      {(recipient === 'user_field' || recipient === 'group_field') && <select className="input" aria-label="Custom field" style={{ marginTop: 10 }} value={value ?? ''} onChange={e => setValue(e.target.value || null)}>
        <option value="">Choose a field…</option>
        {fields.filter(f => (recipient === 'user_field' ? ['user', 'users'] : ['group', 'groups']).includes(f.kind)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}
    </Modal>
  )
}

/** Project settings › Notifications: the project's scheme; a system administrator changes it (spec 0605 R2). */
export function NotificationsPanel({ project }: { project: Project }) {
  const { state } = useStore()
  const { toast } = useApp()
  const [scheme, setScheme] = useState<{ id: string; name: string } | null | undefined>(undefined)
  const [schemes, setSchemes] = useState<Scheme[]>([])
  const admin = isGlobalAdmin(state)
  useEffect(() => {
    api<{ scheme: { id: string; name: string } | null }>('GET', `/api/projects/${encodeURIComponent(project.key)}/notification-scheme`).then(r => setScheme(r.scheme), () => setScheme(undefined))
    if (admin) api<Scheme[]>('GET', '/api/admin/notification-schemes').then(setSchemes, () => {})
  }, [project.key])   // eslint-disable-line react-hooks/exhaustive-deps
  if (scheme === undefined) return null
  return (
    <section className="panel">
      <h2 className="panel-title">Notifications</h2>
      <p className="muted">Who hears about changes to this project’s work: its notification scheme{admin ? '' : ' (a system administrator changes it)'}.</p>
      {admin ? (
        <select className="input" aria-label="Notification scheme" style={{ marginTop: 10, maxWidth: 360 }} value={scheme?.id ?? ''} onChange={e => {
          api<{ scheme: { id: string; name: string } | null }>('PUT', `/api/projects/${encodeURIComponent(project.key)}/notification-scheme`, { schemeId: e.target.value || null })
            .then(r => { setScheme(r.scheme); toast(r.scheme ? `${project.name} uses ${r.scheme.name}` : `${project.name} sends no notifications`) }, err => toast(err.message, { tone: 'warn' }))
        }}>
          <option value="">None (no notifications)</option>
          {schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      ) : <p style={{ marginTop: 8 }}><b>{scheme?.name ?? 'None (no notifications)'}</b></p>}
    </section>
  )
}
