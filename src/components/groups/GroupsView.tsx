import { useEffect, useState } from 'react'
import { Plus, Trash2, UsersRound, Crown, Lock, Cloud, X } from 'lucide-react'
import { api, ApiError } from '../../api/client'
import { usePublicSettings } from '../../api/settings-public'
import { useStore } from '../../data/store'
import { useApp } from '../../appContext'
import { href } from '../../router'
import { Avatar, Empty, Modal } from '../ui'

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
import { UserSelect } from '../UserPicker'

// Groups (Jira's groups, which anyone here may make if System settings allow): a list on the left, the chosen group on the
// right. The same screen serves everyone (/groups) and Administration › Groups (`admin`, which also shows system groups
// first). What you may change comes from the server (canManage).

interface Group { id: string; name: string; description: string; kind: 'system' | 'directory' | 'strand'; systemRole: string | null; members: number; owners: { id: string; name: string }[]; isMember: boolean; isOwner: boolean; canManage: boolean }
interface Detail extends Group { people: { id: string; name: string; email: string; initials: string; color: string; active: boolean }[]; projects: { key: string; name: string; role: string }[] }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const KIND = { system: { label: 'System', Icon: Lock, hint: 'Built in: only system administrators change it' }, directory: { label: 'Directory', Icon: Cloud, hint: 'From Entra: change its members there' }, strand: { label: 'Made here', Icon: UsersRound, hint: 'Managed by its owners' } } as const

export default function GroupsView({ admin = false }: { admin?: boolean }) {
  const { state } = useStore()
  const { toast } = useApp()
  const settings = usePublicSettings()
  const [mine, setMine] = useState(!admin)
  const [q, setQ] = useState('')
  const [list, setList] = useState<Group[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const load = () => api<Group[]>('GET', `/api/groups?query=${encodeURIComponent(q)}${mine ? '&mine=1' : ''}`).then(setList, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [q, mine])   // eslint-disable-line react-hooks/exhaustive-deps
  const mayCreate = settings.groups?.whoCanCreate !== 'admins' || state.isAdmin !== false

  return (
    <div className="groups">
      <div className="groups-list">
        <div className="groups-bar">
          <div className="segmented sm" role="tablist" aria-label="Which groups">
            <button role="tab" aria-selected={mine} className={mine ? 'on' : ''} onClick={() => setMine(true)}>Mine</button>
            <button role="tab" aria-selected={!mine} className={!mine ? 'on' : ''} onClick={() => setMine(false)}>All groups</button>
          </div>
          {mayCreate && <button className="btn btn-primary btn-sm" onClick={() => setMaking(true)}><Plus size={14} />New group</button>}
        </div>
        <input className="input" placeholder="Find a group" aria-label="Find a group" value={q} onChange={e => setQ(e.target.value)} />
        {list?.length === 0 && <p className="muted sm">{mine ? 'You aren’t in any group you can see here yet.' : 'No groups match.'}</p>}
        <ul className="groups-items">
          {(list ?? []).map(g => {
            const K = KIND[g.kind]
            return (
              <li key={g.id}><button className={`groups-item${openId === g.id ? ' is-active' : ''}`} onClick={() => setOpenId(g.id)}>
                <span className="groups-item-name"><K.Icon size={14} aria-label={K.label} />{g.name}{g.isOwner && <Crown size={12} className="muted" aria-label="You own it" />}</span>
                <span className="muted sm">{people(g.members)}</span>
              </button></li>
            )
          })}
        </ul>
      </div>
      <div className="groups-detail">
        {openId ? <GroupDetail key={openId} id={openId} onChanged={load} onDeleted={() => { setOpenId(null); void load() }} />
          : <Empty icon={<UsersRound size={22} strokeWidth={1.5} />} title="Groups" body="A group gives a whole team a role in a project at once. Pick a group, or make one: its owners decide who is in it, and project admins decide what it may do in their project." />}
      </div>
      {making && <MakeGroup onClose={() => setMaking(false)} onMade={g => { setMaking(false); setMine(true); setOpenId(g.id); void load(); toast(`Made ${g.name}`) }} />}
    </div>
  )
}

function GroupDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const { state } = useStore()
  const { toast } = useApp()
  const [g, setG] = useState<Detail | null>(null)
  const [adding, setAdding] = useState<'member' | 'owner' | null>(null)
  const load = () => api<Detail>('GET', `/api/groups/${id}`).then(setG, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { void load() }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return <p className="muted" role="status">Loading…</p>
  const act = (p: Promise<unknown>, done: string) => p.then(() => { toast(done); void load(); onChanged() }, e => toast(message(e), { tone: 'warn' }))
  const meId = state.me?.id
  const K = KIND[g.kind]
  const save = (patch: { name?: string; description?: string }) => act(api('PATCH', `/api/groups/${g.id}`, patch), 'Saved')

  return (
    <section aria-label={`Group ${g.name}`}>
      <div className="groups-head">
        {g.canManage ? <input className="input groups-name" aria-label="Group name" defaultValue={g.name} onBlur={e => e.target.value.trim() && e.target.value.trim() !== g.name && save({ name: e.target.value.trim() })} />
          : <h2 className="panel-title">{g.name}</h2>}
        <span className="lozenge lozenge-todo" title={K.hint}><K.Icon size={11} /> {K.label}</span>
        {g.canManage && g.kind === 'strand' && (
          <button className="icon-btn" aria-label="Delete group" title="Delete group" onClick={() => window.confirm(`Delete ${g.name}? Everyone in it loses the project roles it gives.`) &&
            api('DELETE', `/api/groups/${g.id}`).then(() => { toast(`Deleted ${g.name}`); onDeleted() }, e => toast(message(e), { tone: 'warn' }))}><Trash2 size={15} /></button>
        )}
      </div>
      {g.canManage ? <textarea className="input" rows={2} aria-label="Description" placeholder="What is this group for?" defaultValue={g.description}
        onBlur={e => e.target.value !== g.description && save({ description: e.target.value })} />
        : g.description && <p className="muted">{g.description}</p>}
      {g.kind === 'directory' && <p className="muted sm">Its members come from your organisation’s directory (Entra). Change them there.</p>}
      {g.systemRole === 'default-users' && <p className="muted sm">Everyone joins this group when they sign in, and rejoins at their next sign-in if taken out.</p>}
      {g.systemRole === 'system-admins' && <p className="muted sm">Members administer Strand: Administration, System settings and every project. People with Entra’s Strand.Admin role are put back here when they sign in.</p>}

      {g.kind === 'strand' && <>
        <div className="section-title-row" style={{ marginTop: 14 }}>
          <h3 className="subhead">Owners</h3>
          {g.canManage && <button className="btn btn-ghost btn-sm" onClick={() => setAdding('owner')}><Plus size={14} />Add owner</button>}
        </div>
        <div className="rule-chips">
          {g.owners.map(o => <span key={o.id} className="chip-static"><Crown size={11} />{o.name}
            {g.canManage && <button className="chip-x" aria-label={`Remove owner ${o.name}`} onClick={() => act(api('DELETE', `/api/groups/${g.id}/owners/${o.id}`), `${o.name} no longer owns it`)}>×</button>}</span>)}
        </div>
      </>}

      <div className="section-title-row" style={{ marginTop: 14 }}>
        <h3 className="subhead">Members · {g.people.filter(p => p.active).length}</h3>
        {g.canManage && <button className="btn btn-ghost btn-sm" onClick={() => setAdding('member')}><Plus size={14} />Add people</button>}
      </div>
      <ul className="people">
        {g.people.map(p => (
          <li key={p.id} className="person">
            <Avatar user={p as any} size={26} />
            <div className="person-text"><span className="strong">{p.name}</span><span className="muted sm">{p.email}{p.active ? '' : ' · deactivated'}</span></div>
            {(g.canManage || (p.id === meId && g.kind === 'strand')) && (
              <button className="icon-btn sm" aria-label={p.id === meId ? 'Leave group' : `Remove ${p.name}`} title={p.id === meId ? 'Leave' : 'Remove'}
                onClick={() => act(api('DELETE', `/api/groups/${g.id}/members/${p.id}`), p.id === meId ? `You left ${g.name}` : `Removed ${p.name}`)}><X size={14} /></button>
            )}
          </li>
        ))}
      </ul>

      <h3 className="subhead" style={{ marginTop: 14 }}>Roles in projects</h3>
      {g.projects.length === 0 ? <p className="muted sm">No project gives this group a role (among projects you can see). A project admin adds it under the project’s People and access.</p> : (
        <ul className="test-members">{g.projects.map(p => <li key={p.key} className="test-member"><a href={href({ name: 'project', key: p.key, tab: 'settings', sub: 'people' })} className="mono">{p.key}</a><span className="test-member-title">{p.name}</span><span className="muted sm">{p.role}</span></li>)}</ul>
      )}
      {adding && <AddPeople title={adding === 'owner' ? `Add an owner to ${g.name}` : `Add people to ${g.name}`} onClose={() => setAdding(null)}
        onAdd={ids => act(api('POST', `/api/groups/${g.id}/${adding === 'owner' ? 'owners' : 'members'}`, { userIds: ids }), adding === 'owner' ? 'Owner added' : `Added ${people(ids.length)}`).then(() => setAdding(null))} />}
    </section>
  )
}

function AddPeople({ title, onClose, onAdd }: { title: string; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const { state } = useStore()
  const [ids, setIds] = useState<string[]>([])
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!ids.length} onClick={() => onAdd(ids)}>Add {ids.length ? people(ids.length) : ''}</button>
    </>}>
      <UserSelect label="Person" value={undefined} placeholder="Choose a person…" onChange={id => id && !ids.includes(id) && setIds([...ids, id])} />
      <div className="rule-chips" style={{ marginTop: 10 }}>
        {ids.map(id => <span key={id} className="chip-static">{state.users.find(u => u.id === id)?.name ?? 'Someone'}<button className="chip-x" aria-label="Remove" onClick={() => setIds(ids.filter(x => x !== id))}>×</button></span>)}
      </div>
    </Modal>
  )
}

function MakeGroup({ onClose, onMade }: { onClose: () => void; onMade: (g: Group) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const make = () => api<Group>('POST', '/api/groups', { name: name.trim(), description }).then(onMade, e => setError(message(e)))
  return (
    <Modal title="New group" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={make}>Make group</button>
    </>}>
      <label className="label" htmlFor="gr-name">Name</label>
      <input id="gr-name" className="input" autoFocus placeholder="e.g. mobile-developers" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && make()} />
      <label className="label" htmlFor="gr-desc" style={{ marginTop: 10 }}>Description</label>
      <input id="gr-desc" className="input" placeholder="Who is in it" value={description} onChange={e => setDescription(e.target.value)} />
      <p className="muted sm" style={{ marginTop: 10 }}>You’ll own it and be in it. Project admins can then give it a role in their projects.</p>
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}
