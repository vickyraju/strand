import { useEffect, useState } from 'react'
import { Plus, Trash2, Lock } from 'lucide-react'
import { useStore, type LevelMember, type Project, type SecurityLevel } from '../data/store'
import { api, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { UserSelect } from './UserPicker'
import { Modal, plural } from './ui'

// Project settings › Security levels (Jira's issue security): a work item given a level is seen only by the level's
// members. Members are project roles, groups, people, and the item's reporter or assignee. Admins aren't let in by
// default: list them (or their role) to give them access.

const ROLE = { admin: 'Project admins', member: 'Members', viewer: 'Viewers' } as const
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

export default function SecurityLevelsPanel({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [levels, setLevels] = useState<SecurityLevel[] | null>(null)
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [editing, setEditing] = useState<SecurityLevel | null>(null)
  const [removing, setRemoving] = useState<SecurityLevel | null>(null)
  const base = `/api/projects/${encodeURIComponent(project.key)}/security-levels`
  const load = () => api<SecurityLevel[]>('GET', base).then(l => {
    setLevels(l)
    dispatch({ type: 'updateProject', id: project.id, patch: { securityLevels: l.map(({ items: _i, ...x }) => x) } })
  }, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { void load(); api<{ id: string; name: string }[]>('GET', '/api/groups/search').then(setGroups, () => {}) }, [project.key])   // eslint-disable-line react-hooks/exhaustive-deps
  const describe = (m: LevelMember) => m.kind === 'role' ? ROLE[m.role] : m.kind === 'reporter' ? 'The reporter' : m.kind === 'assignee' ? 'The assignee'
    : m.kind === 'group' ? `Group ${groups.find(g => g.id === m.id)?.name ?? ''}` : state.users.find(u => u.id === m.id)?.name ?? 'Someone'

  const save = async (l: SecurityLevel) => {
    try {
      const body = { name: l.name, description: l.description, members: l.members }
      await api(l.id ? 'PATCH' : 'POST', l.id ? `${base}/${l.id}` : base, body)
      setEditing(null); toast(`Saved ${l.name}`); void load()
    } catch (e) { toast(message(e), { tone: 'warn' }) }
  }
  return (
    <section className="panel" aria-label="Security levels">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Security levels</h2>
          <p className="muted">A work item given a level is seen only by the level’s members, everywhere: boards, search, links, reports, notifications and exports.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setEditing({ id: '', name: '', description: '', members: [{ kind: 'role', role: 'admin' }, { kind: 'reporter' }] })}><Plus size={14} />Add level</button>
      </div>
      {levels && levels.length === 0 && <p className="muted sm">No security levels: everyone in the project sees every item.</p>}
      {levels && levels.length > 0 && (
        <div className="people">
          {levels.map(l => (
            <div key={l.id} className="person">
              <span className="rule-icon" style={{ width: 30, height: 30 }}><Lock size={15} /></span>
              <div className="person-text">
                <span className="strong">{l.name}</span>
                <span className="muted sm">{l.members.map(describe).join(', ')} · {plural(l.items ?? 0, 'work item')}</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(l)}>Edit</button>
              <button className="icon-btn" onClick={() => setRemoving(l)} aria-label={`Delete ${l.name}`} title="Delete"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {editing && <LevelDialog level={editing} project={project} groups={groups} describe={describe} onClose={() => setEditing(null)} onSave={save} />}
      {removing && <RemoveDialog level={removing} others={(levels ?? []).filter(l => l.id !== removing.id)} onClose={() => setRemoving(null)}
        onRemove={moveTo => api('DELETE', `${base}/${removing.id}${removing.items ? `?moveTo=${moveTo}` : ''}`).then(() => { setRemoving(null); toast(`${removing.name} removed`); void load() }, e => toast(message(e), { tone: 'warn' }))} />}
    </section>
  )
}

function LevelDialog({ level, project, groups, describe, onClose, onSave }: {
  level: SecurityLevel; project: Project; groups: { id: string; name: string }[]; describe: (m: LevelMember) => string; onClose: () => void; onSave: (l: SecurityLevel) => void
}) {
  const [l, setL] = useState(level)
  const has = (m: LevelMember) => l.members.some(x => JSON.stringify(x) === JSON.stringify(m))
  const add = (m: LevelMember) => { if (!has(m)) setL({ ...l, members: [...l.members, m] }) }
  const valid = !!l.name.trim() && l.members.length > 0
  return (
    <Modal title={level.id ? `Edit ${level.name}` : 'Add security level'} onClose={onClose} width={540} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...l, name: l.name.trim() })}>Save</button>
    </>}>
      <label className="label" htmlFor="sl-name">Name</label>
      <input id="sl-name" className="input" autoFocus value={l.name} placeholder="e.g. Security team" onChange={e => setL({ ...l, name: e.target.value })} />
      <label className="label" htmlFor="sl-desc" style={{ marginTop: 10 }}>Description</label>
      <input id="sl-desc" className="input" value={l.description} onChange={e => setL({ ...l, description: e.target.value })} />
      <h3 className="subhead" style={{ marginTop: 14 }}>Who can see items with this level</h3>
      <div className="rule-chips" style={{ marginBottom: 8 }}>
        {l.members.map((m, i) => <span key={i} className="chip-static">{describe(m)}<button className="chip-x" aria-label={`Remove ${describe(m)}`} onClick={() => setL({ ...l, members: l.members.filter((_, k) => k !== i) })}>×</button></span>)}
      </div>
      <div className="form-row">
        <select className="input" aria-label="Add a role or the reporter/assignee" value="" onChange={e => {
          const v = e.target.value
          if (v === 'reporter' || v === 'assignee') add({ kind: v })
          else if (v) add({ kind: 'role', role: v as 'admin' | 'member' | 'viewer' })
        }}>
          <option value="">+ A role, reporter or assignee…</option>
          {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="reporter">The item’s reporter</option><option value="assignee">The item’s assignee</option>
        </select>
        {groups.length > 0 && (
          <select className="input" aria-label="Add a group" value="" onChange={e => e.target.value && add({ kind: 'group', id: e.target.value })}>
            <option value="">+ A group…</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>
      <div style={{ marginTop: 8 }}><UserSelect label="Add a person" projectId={project.key} value={undefined} placeholder="+ A person…" onChange={id => id && add({ kind: 'user', id })} /></div>
      {l.members.length === 0 && <p className="hint error">Add at least one.</p>}
    </Modal>
  )
}

function RemoveDialog({ level, others, onClose, onRemove }: { level: SecurityLevel; others: SecurityLevel[]; onClose: () => void; onRemove: (moveTo: string) => void }) {
  const [moveTo, setMoveTo] = useState('none')
  return (
    <Modal title={`Remove “${level.name}”?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" onClick={() => onRemove(moveTo)}>Remove</button>
    </>}>
      {level.items ? <>
        <p>{plural(level.items, 'work item')} {level.items === 1 ? 'has' : 'have'} this level. Give {level.items === 1 ? 'it' : 'them'}:</p>
        <select className="input" style={{ marginTop: 8 }} aria-label="Give them" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
          <option value="none">No level (everyone in the project sees {level.items === 1 ? 'it' : 'them'})</option>
          {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </> : <p>No work items have this level.</p>}
    </Modal>
  )
}
