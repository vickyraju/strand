import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '../api/client'
import { reloadPublicSettings } from '../api/settings-public'
import { useApp } from '../appContext'
import type { PriorityDef, ResolutionDef } from '../data/lists'
import { LoadError, Loading, Modal, PRIORITY_ICONS, PriorityIcon } from './ui'
import { PageAction } from './admin/AdminShell'

// Administration › Priorities and Resolutions (Jira's Administration › Issues, spec 0305): the lists every project uses.
// Renames carry to the work items that have them; deleting one asks which one takes its place.

type Kind = 'priorities' | 'resolutions'
type Row = PriorityDef | ResolutionDef
const idOf = (r: Row) => ('key' in r ? r.key : r.id)

export default function ListsAdmin({ kind }: { kind: Kind }) {
  const { toast } = useApp()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Row | null>(null)
  const one = kind === 'priorities' ? 'priority' : 'resolution'
  const load = () => api<Row[]>('GET', `/api/${kind}`).then(r => { setRows(r); void reloadPublicSettings() }, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [kind])   // eslint-disable-line react-hooks/exhaustive-deps
  const save = (r: Row, patch: Record<string, unknown>) => api('PATCH', `/api/admin/${kind}/${idOf(r)}`, patch)
    .then(() => { void load(); toast(`${(patch.name as string) ?? r.name} saved`) }, e => toast(errorMessage(e), { tone: 'warn' }))

  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!rows) return <Loading />
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={14} />Add {one}</button></PageAction>
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table">
          <thead><tr><th style={{ width: 70 }}>Order</th><th>Name</th><th>Description</th>{kind === 'priorities' && <><th>Colour</th><th>Icon</th></>}<th>Default</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={idOf(r)} style={{ cursor: 'default' }}>
                <td>
                  <button className="icon-btn sm" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => save(r, { position: i - 1 })}><ArrowUp size={13} /></button>
                  <button className="icon-btn sm" aria-label={`Move ${r.name} down`} disabled={i === rows.length - 1} onClick={() => save(r, { position: i + 1 })}><ArrowDown size={13} /></button>
                </td>
                <td><span className="cell-flex">{'key' in r && <PriorityIcon priority={r.key} />}<Cell value={r.name} label={`${r.name}: name`} onSave={name => save(r, { name })} /></span></td>
                <td><Cell value={r.description} label={`${r.name}: description`} onSave={description => save(r, { description })} allowEmpty /></td>
                {'key' in r && <>
                  <td><input type="color" aria-label={`${r.name}: colour`} value={r.color} onChange={e => save(r, { color: e.target.value })} /></td>
                  <td><select className="input input-sm" aria-label={`${r.name}: icon`} value={r.icon} onChange={e => save(r, { icon: e.target.value })}>
                    {Object.keys(PRIORITY_ICONS).map(k => <option key={k} value={k}>{k.replace('-', ' ')}</option>)}
                  </select></td>
                </>}
                <td>{r.isDefault ? <span className="lozenge lozenge-done">Default</span>
                  : <button className="btn btn-ghost btn-sm" onClick={() => save(r, { isDefault: true })}>Make default</button>}</td>
                <td style={{ textAlign: 'right' }}>
                  {rows.length > 1 && <button className="icon-btn sm" aria-label={`Remove ${r.name}`} title="Remove" onClick={() => setRemoving(r)}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddDialog kind={kind} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load() }} />}
      {removing && <RemoveDialog kind={kind} row={removing} others={rows.filter(r => idOf(r) !== idOf(removing))} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); void load() }} />}
    </section>
  )
}

/** Text that saves when it loses focus (or on Enter), if it changed. */
function Cell({ value, label, onSave, allowEmpty }: { value: string; label: string; onSave: (v: string) => void; allowEmpty?: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { const t = v.trim(); if ((t || allowEmpty) && t !== value) onSave(t); else setV(value) }
  return <input className="input input-sm" aria-label={label} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function AddDialog({ kind, onClose, onAdded }: { kind: Kind; onClose: () => void; onAdded: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ name: '', description: '', color: '#6366F1', icon: 'flame' })
  const submit = () => api('POST', `/api/admin/${kind}`, kind === 'priorities' ? f : { name: f.name, description: f.description })
    .then(() => { toast(`${f.name} added`); onAdded() }, e => toast(errorMessage(e), { tone: 'warn' }))
  return (
    <Modal title={kind === 'priorities' ? 'Add priority' : 'Add resolution'} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!f.name.trim()} onClick={submit}>Add</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); if (f.name.trim()) void submit() }}>
        <label className="label" htmlFor="li-name">Name</label>
        <input id="li-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus placeholder={kind === 'priorities' ? 'e.g. Blocker' : 'e.g. Fixed'} />
        <label className="label" htmlFor="li-desc" style={{ marginTop: 12 }}>Description</label>
        <input id="li-desc" className="input" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
        {kind === 'priorities' && <div className="form-row" style={{ marginTop: 12 }}>
          <div><label className="label" htmlFor="li-color">Colour</label><input id="li-color" type="color" value={f.color} onChange={e => setF({ ...f, color: e.target.value })} /></div>
          <div><label className="label" htmlFor="li-icon">Icon</label>
            <select id="li-icon" className="input" value={f.icon} onChange={e => setF({ ...f, icon: e.target.value })}>
              {Object.keys(PRIORITY_ICONS).map(k => <option key={k} value={k}>{k.replace('-', ' ')}</option>)}
            </select></div>
        </div>}
        <p className="hint">It goes to the bottom of the list; move it with the arrows.</p>
      </form>
    </Modal>
  )
}

function RemoveDialog({ kind, row, others, onClose, onRemoved }: { kind: Kind; row: Row; others: Row[]; onClose: () => void; onRemoved: () => void }) {
  const { toast } = useApp()
  const [moveTo, setMoveTo] = useState(idOf(others[0]!))
  const remove = () => api('DELETE', `/api/admin/${kind}/${idOf(row)}?moveTo=${encodeURIComponent(moveTo)}`)
    .then(() => { toast(`${row.name} removed`); onRemoved() }, e => toast(errorMessage(e), { tone: 'warn' }))
  return (
    <Modal title={`Remove “${row.name}”?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" onClick={remove}>Remove</button>
    </>}>
      <p>Work items{kind === 'priorities' ? ', templates and automation rules' : ''} that have it get instead:</p>
      <select className="input" style={{ marginTop: 8 }} aria-label="Replace with" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
        {others.map(o => <option key={idOf(o)} value={idOf(o)}>{o.name}</option>)}
      </select>
      {row.isDefault && <p className="hint">It is the default: the one you choose becomes the default.</p>}
    </Modal>
  )
}
