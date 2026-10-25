import { useEffect, useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'
import type { Project } from '../data/store'
import { useApp } from '../appContext'
import { ApiError, apiEnabled } from '../api/client'
import { searchUsers } from '../api/users'
import { addMembers, listMembers, removeMember, ROLES, setMemberRole, addGroup, listGroups, removeGroup, searchGroups, setGroupRole, type GroupHit, type ProjectGroup, type ProjectMember, type ProjectRole } from '../api/members'
import type { User } from '../data/reducer'
import { Avatar, Modal } from './ui'

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const asUser = (m: ProjectMember): User => ({ id: m.userId, name: m.name, initials: m.initials, color: m.color })

function RoleSelect({ value, onChange, label, disabled }: { value: ProjectRole; onChange: (r: ProjectRole) => void; label: string; disabled?: boolean }) {
  return (
    <select className="input" style={{ width: 120 }} value={value} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.value as ProjectRole)}>
      {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
    </select>
  )
}

/** Project settings → People and access: who can see this project and what each person may do. */
export default function ProjectPeople({ project }: { project: Project }) {
  const { toast } = useApp()
  const [members, setMembers] = useState<ProjectMember[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<ProjectMember | null>(null)
  const canManage = project.role === 'admin'

  useEffect(() => { listMembers(project.key).then(setMembers, e => setError(message(e))) }, [project.key])
  const run = (job: Promise<ProjectMember[] | void>, done: string) =>
    job.then(r => { if (r) setMembers(r); toast(done) }, e => toast(message(e)))

  if (!apiEnabled) return <div className="settings"><section className="panel"><h2 className="panel-title">People and access</h2><p className="muted">Roles apply when Strand is connected to a server. This workspace is stored in your browser, so everyone using it has full access.</p></section></div>

  return (
    <div className="settings">
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2 className="panel-title">People and access</h2>
            <p className="muted">Only the people listed here, and workspace admins, can see {project.name}.{!canManage && ' Ask a project admin to change this.'}</p>
          </div>
          {canManage && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={14} />Add people</button>}
        </div>
        {error && <p role="alert" className="hint error">{error}</p>}
        {!members && !error && <p className="muted">Loading…</p>}
        <div className="people">
          {members?.map(m => (
            <div key={m.userId} className="person">
              <Avatar user={asUser(m)} size={34} />
              <div className="person-text"><span className="strong">{m.name}</span><span className="muted sm">{m.email}</span></div>
              <div className="person-actions">
                <RoleSelect value={m.role} label={`Role of ${m.name}`} disabled={!canManage}
                  onChange={r => run(setMemberRole(project.key, m.userId, r), `${m.name} is now ${r === 'admin' ? 'an admin' : `a ${r}`}`)} />
                {canManage && <button className="icon-btn" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`} title="Remove"><Trash2 size={14} /></button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Groups project={project} canManage={canManage} />

      <section className="panel">
        <h2 className="panel-title">What each role can do</h2>
        <dl className="role-help">
          {ROLES.map(r => <div key={r.id}><dt className="strong">{r.label}</dt><dd className="muted">{r.can}</dd></div>)}
        </dl>
      </section>

      {adding && <AddPeople project={project} existing={new Set((members ?? []).map(m => m.userId))} onClose={() => setAdding(false)}
        onAdded={m => { setMembers(m); setAdding(false) }} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => { const m = removing; setRemoving(null); run(removeMember(project.key, m.userId).then(() => listMembers(project.key)), `${m.name} removed`) }}>Remove</button>
        </>}>
          <p>{removing.name} will no longer see {project.name}. Their work items stay, and so do their comments. Their stars and recently viewed items for this project are cleared.</p>
        </Modal>
      )}
    </div>
  )
}

function AddPeople({ project, existing, onClose, onAdded }: { project: Project; existing: Set<string>; onClose: () => void; onAdded: (m: ProjectMember[]) => void }) {
  const { toast } = useApp()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<User[]>([])
  const [picked, setPicked] = useState<User[]>([])
  const [role, setRole] = useState<ProjectRole>('member')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => { searchUsers(query).then(p => setFound(p.items), () => setFound([])) }, 200)
    return () => clearTimeout(t)
  }, [query])

  const choices = found.filter(u => !existing.has(u.id) && !picked.some(p => p.id === u.id))
  const save = () => {
    setBusy(true)
    addMembers(project.key, picked.map(u => u.id), role).then(onAdded, e => { toast(message(e)); setBusy(false) })
  }
  return (
    <Modal title="Add people" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!picked.length || busy} onClick={save}>Add{picked.length ? ` ${picked.length}` : ''}</button>
    </>}>
      <label className="label" htmlFor="pp-search">Search the workspace</label>
      <input id="pp-search" className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or email" autoFocus />
      {picked.length > 0 && <div className="chips" style={{ marginTop: 8 }}>{picked.map(u => (
        <button key={u.id} className="chip" onClick={() => setPicked(picked.filter(p => p.id !== u.id))} aria-label={`Don’t add ${u.name}`}><Avatar user={u} size={16} />{u.name} ×</button>
      ))}</div>}
      <ul aria-label="People" style={{ listStyle: 'none', padding: 0, margin: '8px 0', maxHeight: 220, overflow: 'auto' }}>
        {choices.map(u => <li key={u.id}><button className="picker-item" onClick={() => setPicked([...picked, u])}><Avatar user={u} size={20} />{u.name}</button></li>)}
        {!choices.length && <li className="picker-empty">No one else to add.</li>}
      </ul>
      <span className="label">Role</span>
      <RoleSelect value={role} onChange={setRole} label="Role" />
      <p className="muted sm" style={{ marginTop: 6 }}>{ROLES.find(r => r.id === role)!.can}</p>
    </Modal>
  )
}

/** Who decides who is in a group: shown wherever a group is given a role, since they then decide who has it. */
const managedBy = (g: { kind?: string; owners?: string[] }) =>
  g.kind === 'directory' ? ' · from the directory' : g.kind === 'system' ? ' · built in' : g.owners?.length ? ` · managed by ${g.owners.join(', ')}` : ''

/** Groups with a role in the project. Joining or leaving a team (in Entra) changes who has the role. */
function Groups({ project, canManage }: { project: Project; canManage: boolean }) {
  const { toast } = useApp()
  const [groups, setGroups] = useState<ProjectGroup[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<ProjectGroup | null>(null)
  useEffect(() => { listGroups(project.key).then(setGroups, () => setGroups([])) }, [project.key])
  const run = (job: Promise<ProjectGroup[] | void>, done: string) =>
    job.then(r => { if (r) setGroups(r); toast(done) }, e => toast(message(e)))
  if (!groups || (!groups.length && !canManage)) return null
  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Groups</h2>
          <p className="muted">Everyone in a group has its role here. Who is in a group is decided by its owners (or, for directory groups, by Entra). If someone has a role of their own as well, the higher one counts.</p>
        </div>
        {canManage && <button className="btn btn-secondary" onClick={() => setAdding(true)}><Plus size={14} />Add a group</button>}
      </div>
      {!groups.length && <p className="muted">No groups yet.</p>}
      <div className="people">
        {groups.map(g => (
          <div key={g.groupId} className="person">
            <span className="avatar" style={{ width: 34, height: 34, background: 'var(--sunken)', color: 'var(--text-2)' }}><Users size={16} /></span>
            <div className="person-text"><span className="strong">{g.name}</span><span className="muted sm">{g.members} {g.members === 1 ? 'person' : 'people'}{managedBy(g)}</span></div>
            <div className="person-actions">
              <RoleSelect value={g.role} label={`Role of ${g.name}`} disabled={!canManage}
                onChange={r => run(setGroupRole(project.key, g.groupId, r), `${g.name} is now ${r === 'admin' ? 'an admin' : `a ${r}`} group`)} />
              {canManage && <button className="icon-btn" onClick={() => setRemoving(g)} aria-label={`Remove ${g.name}`} title="Remove"><Trash2 size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
      {adding && <AddGroup existing={new Set(groups.map(g => g.groupId))} onClose={() => setAdding(false)}
        onAdd={(id, role) => { setAdding(false); run(addGroup(project.key, id, role), 'Group added') }} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => { const g = removing; setRemoving(null); run(removeGroup(project.key, g.groupId).then(() => listGroups(project.key)), `${g.name} removed`) }}>Remove</button>
        </>}>
          <p>People in {removing.name} lose the access it gave them, unless they have a role of their own here.</p>
        </Modal>
      )}
    </section>
  )
}

function AddGroup({ existing, onClose, onAdd }: { existing: Set<string>; onClose: () => void; onAdd: (groupId: string, role: ProjectRole) => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<GroupHit[]>([])
  const [picked, setPicked] = useState<GroupHit | null>(null)
  const [role, setRole] = useState<ProjectRole>('member')
  useEffect(() => {
    const t = setTimeout(() => { searchGroups(query).then(setFound, () => setFound([])) }, 200)
    return () => clearTimeout(t)
  }, [query])
  const choices = found.filter(g => !existing.has(g.id))
  return (
    <Modal title="Add a group" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!picked} onClick={() => picked && onAdd(picked.id, role)}>Add</button>
    </>}>
      <label className="label" htmlFor="pg-search">Search groups</label>
      <input id="pg-search" className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Group name" autoFocus />
      <ul aria-label="Groups" style={{ listStyle: 'none', padding: 0, margin: '8px 0', maxHeight: 220, overflow: 'auto' }}>
        {choices.map(g => (
          <li key={g.id}><button className="picker-item" aria-selected={picked?.id === g.id} onClick={() => setPicked(g)}>
            <Users size={16} />{g.name}<span className="picker-hint">{g.members} {g.members === 1 ? 'person' : 'people'}{managedBy(g)}</span></button></li>
        ))}
        {!choices.length && <li className="picker-empty">{query ? 'No group matches.' : 'No groups to add. Anyone can make one under Groups.'}</li>}
      </ul>
      <span className="label">Role</span>
      <RoleSelect value={role} onChange={setRole} label="Role" />
      <p className="muted sm" style={{ marginTop: 6 }}>{ROLES.find(r => r.id === role)!.can}</p>
    </Modal>
  )
}
