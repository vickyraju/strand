import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { useStore, type LinkType } from '../data/store'
import { Modal, plural } from './ui'

// Administration › Link types (Jira's Issue linking): the kinds of link people can make between work items, each with
// how it reads from both ends. Renaming keeps every link; removing one in use asks where its links go.

type Row = LinkType & { position: number; uses: number }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

export default function LinkTypesAdmin() {
  const { toast } = useApp()
  const { dispatch } = useStore()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Row | null>(null)
  const load = () => api<Row[]>('GET', '/api/link-types').then(r => {
    setRows(r)
    dispatch({ type: 'setLinkTypes', linkTypes: r.map(({ id, name, outward, inward, builtin }) => ({ id, name, outward, inward, builtin })) })
  }, e => setError(message(e)))
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const save = (t: Row, patch: Partial<LinkType>) => api('PATCH', `/api/admin/link-types/${t.id}`, patch).then(() => { void load(); toast(`${patch.name ?? t.name} saved`) }, e => toast(message(e), { tone: 'warn' }))

  if (error) return <p className="hint error" role="alert">{error}</p>
  if (!rows) return <p className="muted" role="status">Loading…</p>
  return (
    <section>
      <p className="muted">The kinds of link people can make between work items, and how each reads from both ends. Changes are recorded in the Audit log.</p>
      <div className="card-table" style={{ marginInline: 0, marginTop: 12 }}>
        <table className="table">
          <thead><tr><th>Name</th><th>Outward (from the item that links)</th><th>Inward (from the linked item)</th><th className="col-num">Links</th><th /></tr></thead>
          <tbody>
            {rows.map(t => (
              <tr key={t.id} style={{ cursor: 'default' }}>
                <td><Cell value={t.name} label={`${t.name}: name`} onSave={name => save(t, { name })} />{t.builtin && <span className="muted sm" title="The app relies on it: it can be renamed, not removed"> built in</span>}</td>
                <td><Cell value={t.outward} label={`${t.name}: outward`} onSave={outward => save(t, { outward })} /></td>
                <td><Cell value={t.inward} label={`${t.name}: inward`} onSave={inward => save(t, { inward })} /></td>
                <td className="col-num">{t.uses}</td>
                <td style={{ textAlign: 'right' }}>
                  {!t.builtin && <button className="icon-btn sm" aria-label={`Remove ${t.name}`} title="Remove" onClick={() => setRemoving(t)}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}><Plus size={14} />Add link type</button>
      {adding && <AddDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load() }} />}
      {removing && <RemoveDialog type={removing} others={rows.filter(r => r.id !== removing.id)} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); void load() }} />}
    </section>
  )
}

/** Text that saves when it loses focus (or on Enter), if it changed and isn't empty. */
function Cell({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { const t = v.trim(); if (t && t !== value) onSave(t); else setV(value) }
  return <input className="input input-sm" aria-label={label} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ name: '', outward: '', inward: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const valid = !!(f.name.trim() && f.outward.trim() && f.inward.trim())
  const submit = () => api('POST', '/api/admin/link-types', f).then(() => { toast(`${f.name} added`); onAdded() },
    e => { setErrors(e instanceof ApiError && e.errors ? e.errors : {}); toast(message(e), { tone: 'warn' }) })
  return (
    <Modal title="Add link type" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!valid} onClick={submit}>Add</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); if (valid) void submit() }}>
        {([['name', 'Name', 'Causes'], ['outward', 'Outward description', 'causes'], ['inward', 'Inward description', 'is caused by']] as const).map(([k, l, ph]) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <label className="label" htmlFor={`lt-${k}`}>{l}</label>
            <input id={`lt-${k}`} className="input" placeholder={`e.g. ${ph}`} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} autoFocus={k === 'name'} />
            {errors[k] && <p className="hint error">{errors[k]}</p>}
          </div>
        ))}
        <p className="hint">“PAY-1 {f.outward || 'causes'} PAY-2”, and from the other end “PAY-2 {f.inward || 'is caused by'} PAY-1”.</p>
      </form>
    </Modal>
  )
}

function RemoveDialog({ type, others, onClose, onRemoved }: { type: Row; others: Row[]; onClose: () => void; onRemoved: () => void }) {
  const { toast } = useApp()
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '')
  const remove = (how: 'move' | 'remove' | 'unused') => {
    const q = how === 'move' ? `?moveTo=${encodeURIComponent(moveTo)}` : how === 'remove' ? '?removeLinks=1' : ''
    api('DELETE', `/api/admin/link-types/${type.id}${q}`).then(() => { toast(`${type.name} removed`); onRemoved() }, e => toast(message(e), { tone: 'warn' }))
  }
  return (
    <Modal title={`Remove “${type.name}”?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      {type.uses > 0 && <button className="btn btn-secondary text-danger" onClick={() => remove('remove')}>Remove the links too</button>}
      <button className="btn btn-danger" onClick={() => remove(type.uses ? 'move' : 'unused')}>{type.uses ? 'Move links and remove' : 'Remove'}</button>
    </>}>
      {type.uses > 0 ? <>
        <p>{plural(type.uses, 'link')} {type.uses === 1 ? 'uses' : 'use'} it. Move {type.uses === 1 ? 'it' : 'them'} to:</p>
        <select className="input" style={{ marginTop: 8 }} aria-label="Move links to" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
          {others.map(o => <option key={o.id} value={o.id}>{o.name} ({o.outward} / {o.inward})</option>)}
        </select>
      </> : <p>No links use it.</p>}
    </Modal>
  )
}
