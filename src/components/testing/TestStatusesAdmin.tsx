import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { useApp } from '../../appContext'
import { Modal } from '../ui'
import { message, refreshTestStatuses, type TestStatus } from './shared'

// System settings › Test statuses (Xray's test and step statuses): the built-in ones keep what they mean (their name,
// colour and rank can change); admins add their own. A run status says whether it is final and what it means for a
// requirement; a step status says which run status it counts as.
const MEANS = { ok: 'OK (passed)', nok: 'NOK (failed)', notrun: 'Not run', unknown: 'Unknown' } as const

export default function TestStatusesAdmin() {
  const { toast } = useApp()
  const [list, setList] = useState<TestStatus[]>([])
  const [editing, setEditing] = useState<Partial<TestStatus> | null>(null)
  const load = () => api<TestStatus[]>('GET', '/api/test-statuses').then(l => { setList(l); refreshTestStatuses() }, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (s: Partial<TestStatus>) => {
    const body = { name: s.name, description: s.description ?? '', color: s.color, rank: s.rank ?? 5, ...(s.builtin ? {} : { final: s.final ?? true, mapsTo: s.mapsTo }) }
    try {
      await api(s.key ? 'PATCH' : 'POST', s.key ? `/api/admin/test-statuses/${s.kind}/${s.key}` : '/api/admin/test-statuses', s.key ? body : { ...body, kind: s.kind })
      setEditing(null); void load(); toast(`Saved ${s.name}`)
    } catch (e) { toast(message(e), { tone: 'warn' }) }
  }
  const remove = (s: TestStatus) => window.confirm(`Remove “${s.name}”?`) && api('DELETE', `/api/admin/test-statuses/${s.kind}/${s.key}`).then(load, e => toast(message(e), { tone: 'warn' }))
  const runName = (k: string) => list.find(x => x.kind === 'run' && x.key === k)?.name ?? k

  return (
    <section className="panel" aria-label="Test statuses">
      <h2 className="panel-title">Test statuses</h2>
      <p className="muted">What a test run or one of its steps can end up as. Built-in statuses keep their meaning; add your own for cases like “Blocked” or “Flaky”.</p>
      {(['run', 'step'] as const).map(kind => (
        <div key={kind} style={{ marginTop: 12 }}>
          <div className="section-title-row">
            <h3 className="subhead">{kind === 'run' ? 'Run statuses' : 'Step statuses'}</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ kind, name: '', color: '#6366F1', final: true, mapsTo: kind === 'run' ? 'unknown' : 'TODO', rank: 5 })}><Plus size={14} />Add</button>
          </div>
          <table className="table">
            <thead><tr><th>Status</th><th>{kind === 'run' ? 'Means' : 'Counts as'}</th>{kind === 'run' && <th>Final</th>}<th className="col-num">Rank</th><th /></tr></thead>
            <tbody>
              {list.filter(s => s.kind === kind).map(s => (
                <tr key={s.key} onClick={() => setEditing(s)} style={{ cursor: 'pointer' }}>
                  <td><span className="test-lozenge" style={{ background: s.color }}>{s.name}</span>{s.builtin && <span className="muted sm"> built in</span>}</td>
                  <td className="muted">{kind === 'run' ? MEANS[s.mapsTo as keyof typeof MEANS] : runName(s.mapsTo)}</td>
                  {kind === 'run' && <td className="muted">{s.final ? 'Yes' : 'No'}</td>}
                  <td className="col-num muted">{s.rank}</td>
                  <td onClick={e => e.stopPropagation()}>{!s.builtin && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} onClick={() => remove(s)}><Trash2 size={13} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {editing && <StatusDialog status={editing} runStatuses={list.filter(s => s.kind === 'run')} onClose={() => setEditing(null)} onSave={save} />}
    </section>
  )
}

function StatusDialog({ status, runStatuses, onClose, onSave }: { status: Partial<TestStatus>; runStatuses: TestStatus[]; onClose: () => void; onSave: (s: Partial<TestStatus>) => void }) {
  const [s, setS] = useState(status)
  return (
    <Modal title={status.key ? `Edit ${status.name}` : `Add ${status.kind} status`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!s.name?.trim()} onClick={() => onSave({ ...s, name: s.name!.trim() })}>Save</button>
    </>}>
      <label className="label" htmlFor="ts-name">Name</label>
      <input id="ts-name" className="input" autoFocus value={s.name ?? ''} onChange={e => setS({ ...s, name: e.target.value })} />
      <label className="label" htmlFor="ts-desc" style={{ marginTop: 10 }}>Description</label>
      <input id="ts-desc" className="input" value={s.description ?? ''} onChange={e => setS({ ...s, description: e.target.value })} />
      <div className="form-row" style={{ marginTop: 10 }}>
        <label><span className="label">Colour</span><input type="color" aria-label="Colour" value={s.color} onChange={e => setS({ ...s, color: e.target.value })} /></label>
        <label><span className="label">Rank</span><input className="input" type="number" min={0} max={1000} aria-label="Rank" value={s.rank ?? 5} onChange={e => setS({ ...s, rank: Number(e.target.value) })} /></label>
      </div>
      {!s.builtin && (s.kind === 'run' ? <>
        <label className="label" htmlFor="ts-means" style={{ marginTop: 10 }}>What it means for a requirement</label>
        <select id="ts-means" className="input" value={s.mapsTo} onChange={e => setS({ ...s, mapsTo: e.target.value })}>
          {Object.entries(MEANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check-row" style={{ marginTop: 10 }}><input type="checkbox" checked={!!s.final} onChange={e => setS({ ...s, final: e.target.checked })} /> Final: the run is over</label>
      </> : <>
        <label className="label" htmlFor="ts-maps" style={{ marginTop: 10 }}>Counts as</label>
        <select id="ts-maps" className="input" value={s.mapsTo} onChange={e => setS({ ...s, mapsTo: e.target.value })}>
          {runStatuses.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      </>)}
      <p className="muted sm" style={{ marginTop: 10 }}>When results are combined, a higher rank wins (after a failure, which always does).</p>
    </Modal>
  )
}
