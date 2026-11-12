import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { href } from '../router'
import { LoadError, Loading } from './ui'

// Administration › Archived work items (spec 0508), as Jira DC's Archived issues: newest first, searchable; Restore brings an
// item back with its sub-items.

interface Row { id: string; key: string; title: string; type: string; project: string; archivedAt: string; archivedBy: string | null }

export default function ArchivedItems() {
  const { toast } = useApp()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState('')
  const load = (cursor?: string) => api<{ items: Row[]; next: string | null }>('GET', `/api/admin/archived-items?query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    .then(r => { setRows(cursor ? [...(rows ?? []), ...r.items] : r.items); setNext(r.next) }, e => setError(errorMessage(e)))
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t) }, [query])   // eslint-disable-line react-hooks/exhaustive-deps
  const restore = (r: Row) => api<{ restored: string[] }>('POST', `/api/issues/${encodeURIComponent(r.key)}/unarchive`)
    .then(x => { toast(`Restored ${x.restored.join(', ')}`); void load() }, e => toast(errorMessage(e), { tone: 'warn' }))
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  return (
    <section>
      <input className="input" style={{ maxWidth: 320, marginBottom: 12 }} placeholder="Find by key or summary" aria-label="Find archived work items" value={query} onChange={e => setQuery(e.target.value)} />
      {!rows ? <Loading /> : !rows.length ? <p className="muted">No archived work items{query ? ' match' : ''}.</p> : (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table" aria-label="Archived work items">
            <thead><tr><th>Key</th><th>Summary</th><th>Project</th><th>Archived</th><th /></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td className="mono"><a href={href({ name: 'issue', key: r.key })}>{r.key}</a></td><td>{r.title}</td><td className="sm">{r.project}</td>
                <td className="sm">{new Date(r.archivedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}{r.archivedBy && <span className="muted"> · {r.archivedBy}</span>}</td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => void restore(r)}>Restore</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {next && <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => void load(next)}>Load more</button>}
    </section>
  )
}
