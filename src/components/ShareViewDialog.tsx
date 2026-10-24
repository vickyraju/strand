import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useStore, type SavedView, type ViewShare } from '../data/store'
import { api, apiEnabled } from '../api/client'
import { UserSelect } from './UserPicker'
import { Modal, Toggle } from './ui'

/** Jira's filter sharing: the whole workspace, or particular projects, groups and people, each to view or to edit. */
export default function ShareViewDialog({ view, onClose, onSave }: { view: SavedView; onClose: () => void; onSave: (shared: boolean, share: ViewShare[]) => void }) {
  const { state } = useStore()
  const [shared, setShared] = useState(view.shared)
  const [share, setShare] = useState<ViewShare[]>(view.share ?? [])
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { if (apiEnabled) api<{ id: string; name: string }[]>('GET', '/api/groups/search').then(setGroups, () => {}) }, [])
  const nameOf = (e: ViewShare) => e.kind === 'project' ? state.projects.find(p => p.id === e.id)?.name
    : e.kind === 'group' ? groups.find(g => g.id === e.id)?.name : state.users.find(u => u.id === e.id)?.name
  const add = (kind: ViewShare['kind'], id: string | undefined) => { if (id && !share.some(e => e.kind === kind && e.id === id)) setShare([...share, { kind, id, can: 'view' }]) }

  return (
    <Modal title={`Share “${view.name}”`} onClose={onClose} width={520} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => onSave(shared, share)}>Save</button>
    </>}>
      <label className="toggle-row">
        <span>Everyone in the workspace can view it</span>
        <Toggle on={shared} onChange={setShared} label="Everyone in the workspace can view it" />
      </label>
      {apiEnabled && <>
        <h3 className="subhead" style={{ marginTop: 14 }}>Also shared with</h3>
        {share.length === 0 && <p className="muted sm">Nobody else yet.</p>}
        {share.map((e, i) => (
          <div key={`${e.kind}:${e.id}`} className="form-row" style={{ alignItems: 'center', marginBottom: 6 }}>
            <span style={{ flex: 1 }}><span className="muted sm">{e.kind === 'project' ? 'Project' : e.kind === 'group' ? 'Group' : 'Person'}</span> {nameOf(e) ?? '…'}</span>
            <select className="input input-sm" aria-label={`What ${nameOf(e) ?? 'they'} can do`} value={e.can} onChange={ev => setShare(share.map((x, k) => (k === i ? { ...x, can: ev.target.value as ViewShare['can'] } : x)))}>
              <option value="view">Can view</option><option value="edit">Can edit</option>
            </select>
            <button className="icon-btn sm" aria-label={`Stop sharing with ${nameOf(e) ?? 'them'}`} onClick={() => setShare(share.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="form-row" style={{ marginTop: 10 }}>
          <select className="input" aria-label="Share with a project" value="" onChange={e => add('project', e.target.value)}>
            <option value="">+ A project’s people…</option>
            {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {groups.length > 0 && (
            <select className="input" aria-label="Share with a group" value="" onChange={e => add('group', e.target.value)}>
              <option value="">+ A group…</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          <UserSelect label="Share with a person" value={undefined} placeholder="+ A person…" onChange={id => add('user', id)} />
        </div>
        <p className="hint">People can only ever see work items in projects they have access to. “Can edit” lets them change its name and filters; only you (or a workspace admin) change who it is shared with.</p>
      </>}
    </Modal>
  )
}
