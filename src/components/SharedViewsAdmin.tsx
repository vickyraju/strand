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
  const [error, setError] = useState('')
  const [giving, setGiving] = useState<Row | null>(null)
  const [to, setTo] = useState<string>()
  const load = () => { setError(''); return api<Row[]>('GET', '/api/admin/views').then(setRows, e => setError(errorMessage(e))) }
  useEffect(() => { void load() }, [])
  const sharedWith = (r: Row) => [r.shared ? 'the workspace' : '', ...['project', 'group', 'user'].map(k => {
    const n = r.share.filter(e => e.kind === k).length
    return n ? `${n} ${k === 'user' ? (n === 1 ? 'person' : 'people') : k + (n === 1 ? '' : 's')}` : ''
  })].filter(Boolean).join(', ') || 'nobody'

  if (error) return <LoadError error={error} onRetry={load} />
  if (!rows) return <Loading />
  return (
    <section>
      {!rows.length ? <p className="muted">No shared views.</p> : (
        <div className="card-table" style={{ marginInline: 0, marginTop: 12 }}>
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
      )}
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
