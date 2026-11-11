import { useEffect, useState } from 'react'
import { Plus, Trash2, UsersRound, Crown, Lock, Cloud, X } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import { usePublicSettings } from '../../api/settings-public'
import { useStore } from '../../data/store'
import { useApp } from '../../appContext'
import { href } from '../../router'
import { Avatar, ConfirmDialog, Empty, Loading, LoadError, Modal, Picker } from '../ui'
import { PageAction } from '../admin/AdminShell'

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
import { UserSelect } from '../UserPicker'

// Groups (Jira's groups, which anyone here may make if System settings allow): a list on the left, the chosen group on the
// right. The same screen serves everyone (/groups) and Administration › Groups (`admin`, which also shows system groups
// first). What you may change comes from the server (canManage).

interface Group { id: string; name: string; description: string; kind: 'system' | 'directory' | 'strand'; systemRole: string | null; members: number; owners: { id: string; name: string }[]; isMember: boolean; isOwner: boolean; canManage: boolean }
type Member = { id: string; name: string; email: string; initials: string; color: string; active: boolean }
interface Detail extends Group { people: Member[]; morePeople: string | null; projects: { key: string; name: string; role: string }[]; restrictedComments: number | null }
const KIND = { system: { label: 'System', Icon: Lock, hint: 'Built in: only system administrators change it' }, directory: { label: 'Directory', Icon: Cloud, hint: 'From Entra: change its members there' }, strand: { label: 'Made here', Icon: UsersRound, hint: 'Managed by its owners' } } as const

export default function GroupsView({ admin = false, openId, onOpen }: { admin?: boolean; openId: string | null; onOpen: (id: string | null) => void }) {
  const { state } = useStore()
  const { toast } = useApp()
  const settings = usePublicSettings()
  const [mine, setMine] = useState(!admin)
  const [q, setQ] = useState('')
  const [list, setList] = useState<Group[] | null>(null)
  const [listError, setListError] = useState('')
  const [next, setNext] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  // a page at a time ("Show more"): a directory can bring thousands of groups
  const load = (more = false) => {
    setListError('')
    const url = `/api/groups?limit=100&query=${encodeURIComponent(q)}${mine ? '&mine=1' : ''}${more && next ? `&cursor=${encodeURIComponent(next)}` : ''}`
    return api<{ items: Group[]; next: string | null }>('GET', url).then(r => { setList(xs => (more ? [...(xs ?? []), ...r.items] : r.items)); setNext(r.next) }, e => setListError(errorMessage(e)))
  }
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
          {mayCreate && <PageAction><button className="btn btn-primary" onClick={() => setMaking(true)}><Plus size={14} />New group</button></PageAction>}
        </div>
        <input className="input" placeholder="Find a group" aria-label="Find a group" value={q} onChange={e => setQ(e.target.value)} />
        {listError && <LoadError error={listError} onRetry={() => load(!!list?.length)} />}
        {!list && !listError && <Loading />}
        {list?.length === 0 && <p className="muted sm">{mine ? 'You aren’t in any group you can see here yet.' : 'No groups match.'}</p>}
        <ul className="groups-items">
          {(list ?? []).map(g => {
            const K = KIND[g.kind]
            return (
              <li key={g.id}><button className={`groups-item${openId === g.id ? ' is-active' : ''}`} aria-current={openId === g.id ? 'true' : undefined} onClick={() => onOpen(g.id)}>
                <span className="groups-item-name"><K.Icon size={14} aria-label={K.label} />{g.name}{g.isOwner && <Crown size={12} className="muted" aria-label="You own it" />}</span>
                <span className="muted sm">{people(g.members)}</span>
              </button></li>
            )
          })}
        </ul>
        {next && !listError && <button className="btn btn-secondary btn-sm" onClick={() => void load(true)}>Show more groups</button>}
      </div>
      <div className="groups-detail">
        {openId ? <GroupDetail key={openId} id={openId} onChanged={load} onDeleted={() => { onOpen(null); void load() }} />
          : <Empty icon={<UsersRound size={22} strokeWidth={1.5} />} title="Pick a group" body="Its members, owners, and the roles it has in projects show here." />}
      </div>
      {making && <MakeGroup onClose={() => setMaking(false)} onMade={g => { setMaking(false); setMine(true); onOpen(g.id); void load(); toast(`Made ${g.name}`) }} />}
    </div>
  )
}

function GroupDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const { state } = useStore()
  const { toast } = useApp()
  const [g, setG] = useState<Detail | null>(null)
  const [adding, setAdding] = useState<'member' | 'owner' | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<null | { kind: 'delete' } | { kind: 'member' | 'owner'; id: string; name: string }>(null)
  const [swap, setSwap] = useState<{ id: string; name: string } | null>(null)
  const load = () => { setError(''); setMembers(null); return api<Detail>('GET', `/api/groups/${encodeURIComponent(id)}`).then(setG, e => setError(errorMessage(e))) }
  useEffect(() => { void load() }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  // members past the first page, or found by search (a group can hold thousands)
  const [memberQ, setMemberQ] = useState('')
  const [members, setMembers] = useState<Member[] | null>(null)          // null: the first page, as the group came
  const [membersNext, setMembersNext] = useState<string | null>(null)
  const memberPage = (cursor: string | null, query: string) =>
    api<{ items: Member[]; next: string | null }>('GET', `/api/groups/${encodeURIComponent(id)}/members?limit=100&query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
  useEffect(() => {
    if (!memberQ.trim()) { setMembers(null); return }
    const t = setTimeout(() => memberPage(null, memberQ.trim()).then(r => { setMembers(r.items); setMembersNext(r.next) }, e => toast(errorMessage(e), { tone: 'warn' })), 200)
    return () => clearTimeout(t)
  }, [memberQ])   // eslint-disable-line react-hooks/exhaustive-deps
  const moreMembers = () => {
    const from = members ? membersNext : g?.morePeople ?? null
    return memberPage(from, memberQ.trim()).then(r => { setMembers([...(members ?? g?.people ?? []), ...r.items]); setMembersNext(r.next) }, e => toast(errorMessage(e), { tone: 'warn' }))
  }
  if (error) return <LoadError error={error} onRetry={load} />
  if (!g) return <Loading rows={5} />
  const act = (p: Promise<unknown>, done: string) => p.then(() => { toast(done); void load(); onChanged() }, e => toast(errorMessage(e), { tone: 'warn' }))
  const meId = state.me?.id
  const K = KIND[g.kind]
  const save = (patch: { description: string }) => act(api('PATCH', `/api/groups/${g.id}`, patch), 'Saved')

  return (
    <section aria-label={`Group ${g.name}`}>
      <div className="groups-head">
        <h2 className="groups-name" title={g.canManage ? 'A group’s name can’t be changed once it is made' : undefined}>{g.name}</h2>
        <span className="lozenge lozenge-todo" title={K.hint}><K.Icon size={11} /> {K.label}</span>
        {g.canManage && g.kind === 'strand' && (
          <button className="icon-btn" aria-label="Delete group" title="Delete group" onClick={() => setConfirm({ kind: 'delete' })}><Trash2 size={15} /></button>
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
            {g.canManage && <button className="chip-x" aria-label={`Remove owner ${o.name}`} onClick={() => setConfirm({ kind: 'owner', id: o.id, name: o.name })}>×</button>}</span>)}
        </div>
      </>}

      <div className="section-title-row" style={{ marginTop: 14 }}>
        <h3 className="subhead">Members · {g.members.toLocaleString()} active</h3>
        {g.canManage && <button className="btn btn-ghost btn-sm" onClick={() => setAdding('member')}><Plus size={14} />Add people</button>}
      </div>
      {(g.morePeople || memberQ) && <input className="input" style={{ maxWidth: 320, marginBottom: 6 }} placeholder="Find a member" aria-label="Find a member" value={memberQ} onChange={e => setMemberQ(e.target.value)} />}
      <ul className="people">
        {(members ?? g.people).map(p => (
          <li key={p.id} className="person">
            <Avatar user={p as any} size={26} />
            <div className="person-text"><span className="strong">{p.name}</span><span className="muted sm">{p.email}{p.active ? '' : ' · deactivated'}</span></div>
            {(g.canManage || (p.id === meId && g.kind === 'strand')) && (
              <button className="icon-btn sm" aria-label={p.id === meId ? 'Leave group' : `Remove ${p.name}`} title={p.id === meId ? 'Leave' : 'Remove'}
                onClick={() => setConfirm({ kind: 'member', id: p.id, name: p.name })}><X size={14} /></button>
            )}
          </li>
        ))}
      </ul>
      {(members ? membersNext : !memberQ && g.morePeople) && <button className="btn btn-secondary btn-sm" onClick={() => void moreMembers()}>Show more members</button>}
      {members && !members.length && <p className="muted sm">Nobody in it matches.</p>}

      <h3 className="subhead" style={{ marginTop: 14 }}>Roles in projects</h3>
      {g.projects.length === 0 ? <p className="muted sm">No project gives this group a role (among projects you can see). A project admin adds it under the project’s People and access.</p> : (
        <ul className="test-members">{g.projects.map(p => <li key={p.key} className="test-member"><a href={href({ name: 'project', key: p.key, tab: 'settings', sub: 'people' })} className="mono">{p.key}</a><span className="test-member-title">{p.name}</span><span className="muted sm">{p.role}</span></li>)}</ul>
      )}
      {confirm?.kind === 'delete' && (
        <ConfirmDialog title={`Delete ${g.name}?`} action="Delete group" typeToConfirm={g.projects.length ? g.name : undefined} onClose={() => { setConfirm(null); setSwap(null) }}
          onConfirm={() => api('DELETE', `/api/groups/${g.id}${swap ? `?swapGroupId=${swap.id}` : ''}`).then(() => { toast(`Deleted ${g.name}`); onDeleted() })}>
          <p>{g.projects.length
            ? <>Its {people(g.members)} lose the roles it gives in {g.projects.length === 1 ? '1 project' : `${g.projects.length} projects`} ({g.projects.slice(0, 3).map(p => p.key).join(', ')}{g.projects.length > 3 ? ` and ${g.projects.length - 3} more` : ''}), unless they have a role there another way.</>
            : <>No project gives it a role, so nobody loses access.</>} This can’t be undone.</p>
          {!!g.restrictedComments && <SwapGroup count={g.restrictedComments} not={g.id} value={swap} onChange={setSwap} />}
        </ConfirmDialog>
      )}
      {confirm && confirm.kind !== 'delete' && (
        <ConfirmDialog title={confirm.id === meId ? `Leave ${g.name}?` : confirm.kind === 'owner' ? `Remove ${confirm.name} as an owner?` : `Remove ${confirm.name} from ${g.name}?`}
          action={confirm.id === meId ? 'Leave' : 'Remove'} onClose={() => setConfirm(null)}
          onConfirm={() => api('DELETE', `/api/groups/${g.id}/${confirm.kind === 'owner' ? 'owners' : 'members'}/${confirm.id}`).then(() => {
            toast(confirm.kind === 'owner' ? `${confirm.name} no longer owns it` : confirm.id === meId ? `You left ${g.name}` : `Removed ${confirm.name}`); void load(); onChanged()
          })}>
          <p>{confirm.kind === 'owner' ? `${confirm.id === meId ? 'You' : 'They'} can no longer change the group, its members or its owners.`
            : g.projects.length ? `${confirm.id === meId ? 'You' : 'They'} lose the roles this group gives in ${g.projects.length === 1 ? '1 project' : `${g.projects.length} projects`}, unless ${confirm.id === meId ? 'you' : 'they'} have a role there another way.`
            : 'No project gives this group a role, so no access changes.'}</p>
        </ConfirmDialog>
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
  const make = () => api<Group>('POST', '/api/groups', { name: name.trim(), description }).then(onMade, e => setError(errorMessage(e)))
  return (
    <Modal title="New group" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={make}>Make group</button>
    </>}>
      <label className="label" htmlFor="gr-name">Name</label>
      <input id="gr-name" className="input" autoFocus placeholder="e.g. mobile-developers" value={name} aria-describedby="gr-name-hint" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && make()} />
      <div id="gr-name-hint" className="hint">The name can’t be changed once the group is made.</div>
      <label className="label" htmlFor="gr-desc" style={{ marginTop: 10 }}>Description</label>
      <input id="gr-desc" className="input" placeholder="Who is in it" value={description} onChange={e => setDescription(e.target.value)} />
      <p className="muted sm" style={{ marginTop: 10 }}>You’ll own it and be in it. Project admins can then give it a role in their projects.</p>
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

/** Spec 0106: comments restricted to a group being deleted move to another group, as Jira's swap group. Searched on the server. */
function SwapGroup({ count, not, value, onChange }: { count: number; not: string; value: { id: string; name: string } | null; onChange: (g: { id: string; name: string }) => void }) {
  const mine = useStore().state.isAdmin !== true      // an owner moves them only to a group they're in or own
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => { setBusy(true); api<{ items: { id: string; name: string }[] }>('GET', `/api/groups?limit=50${mine ? '&mine=1' : ''}&query=${encodeURIComponent(query)}`).then(r => setFound(r.items.filter(g => g.id !== not)), () => {}).finally(() => setBusy(false)) }, 200)
    return () => clearTimeout(t)
  }, [query, not, mine])
  return <>
    <p>{count === 1 ? '1 comment is' : `${count} comments are`} restricted to this group. Choose the group {count === 1 ? 'it moves' : 'they move'} to:</p>
    <Picker value={value?.id} search remote={{ onSearch: setQuery, searching: busy }} className="btn btn-secondary btn-sm" title="Move comments to"
      options={found.map(g => ({ value: g.id as string | undefined, label: g.name }))}
      onChange={id => { const g = found.find(x => x.id === id); if (g) onChange(g) }}
      trigger={value ? value.name : 'Choose a group…'} />
  </>
}

