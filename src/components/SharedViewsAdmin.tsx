import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { UserSelect } from './UserPicker'
import { LoadError, Loading, Modal } from './ui'

// Administration › Shared views (Jira's "Filters" admin page): every view shared beyond its owner, and any whose owner
// has left, so an admin can give it to someone who will look after it.

interface Row { id: string; name: string; ownerId: string; ownerName: string; ownerActive: boolean; shared: boolean; share: { kind: string }[] }

export default function SharedViewsAdmin() {
  const { toast } = useApp()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [ownerLeft, setOwnerLeft] = useState(false)
  const [error, setError] = useState('')
  const [giving, setGiving] = useState<Row | null>(null)
  const [to, setTo] = useState<string>()
  // a page at a time, those whose owner left first: there can be thousands of shared views
  const load = (more = false) => {
    setError('')
    const p = new URLSearchParams({ limit: '50', ...(q.trim() ? { query: q.trim() } : {}), ...(ownerLeft ? { ownerLeft: '1' } : {}), ...(more && next ? { cursor: next } : {}) })
    return api<{ items: Row[]; total: number; next: string | null }>('GET', `/api/admin/views?${p}`)
      .then(r => { setRows(xs => (more ? [...(xs ?? []), ...r.items] : r.items)); setTotal(r.total); setNext(r.next) }, e => setError(errorMessage(e)))
  }
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t) }, [q, ownerLeft])   // eslint-disable-line react-hooks/exhaustive-deps
  const sharedWith = (r: Row) => [r.shared ? 'the workspace' : '', ...['project', 'group', 'user'].map(k => {
    const n = r.share.filter(e => e.kind === k).length
    return n ? `${n} ${k === 'user' ? (n === 1 ? 'person' : 'people') : k + (n === 1 ? '' : 's')}` : ''
  })].filter(Boolean).join(', ') || 'nobody'

  return (
    <section>
      <div className="people-filters">
        <input className="input" style={{ maxWidth: 260 }} placeholder="Find a view or owner" aria-label="Find a view or owner" value={q} onChange={e => setQ(e.target.value)} />
        <label className="check-row"><input type="checkbox" checked={ownerLeft} onChange={e => setOwnerLeft(e.target.checked)} /> Only views whose owner has left</label>
      </div>
      {error && <LoadError error={error} onRetry={() => void load(!!rows?.length && !!next)} />}
      {!rows && !error && <Loading />}
      {rows && !rows.length ? <p className="muted">{q || ownerLeft ? 'No shared view matches.' : 'No shared views.'}</p> : rows && (<>
        <p className="muted sm" role="status" style={{ marginBottom: 6 }}>Showing {rows.length.toLocaleString()} of {total.toLocaleString()}</p>
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>View</th><th>Owner</th><th>Shared with</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td>{r.name}</td>
                  <td>{r.ownerName}{!r.ownerActive && <span className="lozenge lozenge-todo" style={{ marginLeft: 6 }}>Left</span>}</td>
                  <td className="muted">{sharedWith(r)}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => { setGiving(r); setTo(undefined) }}>Change owner</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {next && !error && <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => void load(true)}>Show more views</button>}
      </>)}
      {giving && (
        <Modal title={`Change the owner of “${giving.name}”`} onClose={() => setGiving(null)} footer={<>
          <button className="btn btn-secondary" onClick={() => setGiving(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!to} onClick={() => api('PATCH', `/api/views/${giving.id}`, { ownerId: to }).then(() => {
            toast(`${giving.name} has a new owner`); setGiving(null); void load()
          }, e => toast(errorMessage(e), { tone: 'warn' }))}>Change owner</button>
        </>}>
          <UserSelect label="New owner" value={to} onChange={setTo} excludeId={giving.ownerId} />
          <p className="hint">They can then change it, share it and delete it. Recorded in the Audit log.</p>
        </Modal>
      )}
    </section>
  )
}
