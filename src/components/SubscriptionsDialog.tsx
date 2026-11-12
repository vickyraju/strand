import { useEffect, useState } from 'react'
import { Play, Pencil, Trash2 } from 'lucide-react'
import { holds, useStore, type SavedView } from '../data/store'
import { api } from '../api/client'
import { useApp } from '../appContext'
import { Modal } from './ui'

/** A subscription as the server gives it (spec 0604). */
interface Sub { id: string; createdBy: string; createdByName: string; groupId: string | null; groupName: string | null; cron: string; onlyWhenChanged?: boolean; emailWhenEmpty: boolean; nextRunAt: string | null; lastRunAt: string | null }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const EVERY = [['', 'Once'], ['m15', 'Every 15 minutes'], ['m30', 'Every 30 minutes'], ['h1', 'Every hour'], ['h2', 'Every 2 hours'], ['h3', 'Every 3 hours'], ['h4', 'Every 4 hours'], ['h6', 'Every 6 hours'], ['h12', 'Every 12 hours']] as const
type Form = { mode: 'daily' | 'weekly' | 'monthly' | 'advanced'; time: string; every: string; days: number[]; monthly: string; cron: string; groupId: string; emailWhenEmpty: boolean; onlyWhenChanged: boolean }
const BLANK: Form = { mode: 'daily', time: '07:00', every: '', days: [2], monthly: '1', cron: '0 0 7 ? * *', groupId: '', emailWhenEmpty: false, onlyWhenChanged: false }

/** Jira's schedule choices as the Quartz cron Jira stores (spec 0604 R2). Days: 1 is Sunday. */
export function cronOf(f: Form): string {
  if (f.mode === 'advanced') return f.cron.trim()
  const [h, m] = f.time.split(':').map(Number) as [number, number]
  const at = !f.every ? `0 ${m} ${h}` : f.every.startsWith('m') ? `0 0/${f.every.slice(1)} *` : `0 0 0/${f.every.slice(1)}`
  if (f.mode === 'daily') return `${at} ? * *`
  if (f.mode === 'weekly') return `${at} ? * ${[...f.days].sort().join(',') || '2'}`
  // monthly: a day number, the last day ("L"), the n-th weekday ("3#2") or the last one ("6L")
  return /^\d+$/.test(f.monthly) || f.monthly === 'L' ? `${at} ${f.monthly} * ?` : `${at} ? * ${f.monthly}`
}

/** A saved view's subscriptions: who gets it, when, Run now; and the form to add or change one (Jira's filter subscriptions). */
export default function SubscriptionsDialog({ view, onClose }: { view: SavedView; onClose: () => void }) {
  const { state } = useStore()
  const { toast } = useApp()
  const [subs, setSubs] = useState<Sub[] | null>(null)
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null)
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState('')
  const canGroup = holds(state, 'group-subscriptions')                   // Manage group filter subscriptions (spec 0717)
  const load = () => api<Sub[]>('GET', `/api/views/${view.id}/subscriptions`).then(setSubs, e => setError(e.message))
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing && canGroup && !groups.length) api<{ id: string; name: string }[]>('GET', '/api/groups/search').then(setGroups, () => {}) }, [editing])   // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const f = editing!.form
    const body = { cron: cronOf(f), groupId: f.groupId || null, emailWhenEmpty: f.emailWhenEmpty, onlyWhenChanged: f.onlyWhenChanged }
    try {
      await api(editing!.id ? 'PATCH' : 'POST', editing!.id ? `/api/subscriptions/${editing!.id}` : `/api/views/${view.id}/subscriptions`, body)
      setEditing(null); setError(''); load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t save the subscription') }
  }
  const run = (s: Sub) => api('POST', `/api/subscriptions/${s.id}/run`).then(() => toast('Sending it now'), e => toast(e.message, { tone: 'warn' }))
  const remove = (s: Sub) => api('DELETE', `/api/subscriptions/${s.id}`).then(load, e => toast(e.message, { tone: 'warn' }))
  const set = (p: Partial<Form>) => setEditing(e => e && { ...e, form: { ...e.form, ...p } })

  if (editing) {
    const f = editing.form
    return (
      <Modal title={editing.id ? 'Change subscription' : `Subscribe to “${view.name}”`} onClose={() => setEditing(null)} width={520} footer={<>
        <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>{editing.id ? 'Save' : 'Subscribe'}</button>
      </>}>
        <label className="field-label" htmlFor="sub-to">Recipients</label>
        <select id="sub-to" className="input" value={f.groupId} onChange={e => set({ groupId: e.target.value })}>
          <option value="">Just me</option>
          {canGroup && groups.map(g => <option key={g.id} value={g.id}>Group: {g.name}</option>)}
        </select>
        <label className="field-label" htmlFor="sub-mode" style={{ marginTop: 12 }}>Schedule</label>
        <select id="sub-mode" className="input" value={f.mode} onChange={e => set({ mode: e.target.value as Form['mode'] })}>
          <option value="daily">Daily</option><option value="weekly">Days per week</option><option value="monthly">Days per month</option><option value="advanced">Advanced (cron)</option>
        </select>
        {f.mode === 'weekly' && (
          <div className="form-row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {DAYS.map((d, i) => (
              <label key={d} className="sm"><input type="checkbox" checked={f.days.includes(i + 1)} onChange={e => set({ days: e.target.checked ? [...f.days, i + 1] : f.days.filter(x => x !== i + 1) })} /> {d.slice(0, 3)}</label>
            ))}
          </div>
        )}
        {f.mode === 'monthly' && (
          <select className="input" aria-label="Which day of the month" style={{ marginTop: 8 }} value={f.monthly} onChange={e => set({ monthly: e.target.value })}>
            {Array.from({ length: 31 }, (_, i) => <option key={i} value={String(i + 1)}>Day {i + 1}</option>)}
            <option value="L">The last day</option>
            {['first', 'second', 'third', 'fourth'].flatMap((n, k) => DAYS.map((d, i) => <option key={`${n}${d}`} value={`${i + 1}#${k + 1}`}>The {n} {d}</option>))}
            {DAYS.map((d, i) => <option key={`last${d}`} value={`${i + 1}L`}>The last {d}</option>)}
          </select>
        )}
        {f.mode === 'advanced' ? (
          <>
            <input className="input" aria-label="Cron expression" style={{ marginTop: 8 }} value={f.cron} onChange={e => set({ cron: e.target.value })} />
            <p className="hint">Quartz cron, as Jira uses: seconds minutes hours day-of-month month day-of-week [year], for example 0 0 9 ? * MON-FRI.</p>
          </>
        ) : (
          <div className="form-row" style={{ marginTop: 8 }}>
            <select className="input" aria-label="How often in the day" value={f.every} onChange={e => set({ every: e.target.value })}>
              {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {!f.every && <input className="input" type="time" aria-label="At" value={f.time} onChange={e => set({ time: e.target.value || '07:00' })} />}
          </div>
        )}
        <label className="sm" style={{ display: 'block', marginTop: 12 }}>
          <input type="checkbox" checked={f.emailWhenEmpty} onChange={e => set({ emailWhenEmpty: e.target.checked })} /> Email even if there are no work items
        </label>
        <label className="sm" style={{ display: 'block', marginTop: 6 }}>
          <input type="checkbox" checked={f.onlyWhenChanged} onChange={e => set({ onlyWhenChanged: e.target.checked })} /> Email only when the results changed since the last email
        </label>
        <p className="hint">Times are the server’s. Each recipient gets the work items they can see.</p>
        {error && <p className="hint error" role="alert">{error}</p>}
      </Modal>
    )
  }

  return (
    <Modal title={`Subscriptions to “${view.name}”`} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Close</button>
      <button className="btn btn-primary" onClick={() => setEditing({ form: BLANK })}>New subscription</button>
    </>}>
      {subs === null ? <p className="muted sm">Loading…</p> : subs.length === 0 ? <p className="muted sm">No subscriptions yet: get this view by email on a schedule.</p> : (
        <table className="table">
          <thead><tr><th>Recipients</th><th>Schedule</th><th>Next</th><th /></tr></thead>
          <tbody>{subs.map(s => (
            <tr key={s.id}>
              <td>{s.groupName ? `Group: ${s.groupName}` : s.createdBy === state.me?.id ? 'Just me' : s.createdByName}</td>
              <td><code className="sm">{s.cron}</code></td>
              <td className="sm muted">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</td>
              <td className="nowrap">
                <button className="icon-btn sm" aria-label="Run now" title="Run now" onClick={() => run(s)}><Play size={14} /></button>
                <button className="icon-btn sm" aria-label="Change" title="Change" onClick={() => setEditing({ id: s.id, form: { ...BLANK, mode: 'advanced', cron: s.cron, groupId: s.groupId ?? '', emailWhenEmpty: s.emailWhenEmpty, onlyWhenChanged: !!s.onlyWhenChanged } })}><Pencil size={14} /></button>
                <button className="icon-btn sm" aria-label="Remove" title="Remove" onClick={() => remove(s)}><Trash2 size={14} /></button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}
