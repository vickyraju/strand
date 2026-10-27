import { Fragment, useEffect, useState } from 'react'
import { Eye, Play, Save } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { timeAgo } from '../data/store'
import { Toggle } from './ui'

// Administration › License cleanup (resolution's User Deactivator and License Optimizer, built in): seats in use, the
// daily rule, a preview that changes nothing, run now, and every past run.

type Action = 'remove-access' | 'remove-groups' | 'deactivate'
interface Rule { enabled: boolean; inactiveDays: number; action: Action; groupIds: string[]; warnDays: number; excludedGroupIds: string[]; protectLeads: boolean; reportTo: string[] }
interface P { userId: string; email: string; name: string; lastActiveAt: string | null }
interface Run { id: string; trigger: string; action: Action; startedAt: string; changedCount: number; warnedCount: number; changed: P[]; warned: P[]; notes: string; startedBy: string | null }
interface Group { id: string; name: string; kind: string }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const ACTIONS: Record<Action, string> = {
  'remove-access': 'Take them out of users-access (they get it back when they next sign in)',
  'remove-groups': 'Take them out of chosen groups',
  deactivate: 'Deactivate them (sign-in refused until an admin reactivates them)',
}
const last = (p: P) => (p.lastActiveAt ? timeAgo(Date.parse(p.lastActiveAt)) : 'never')

export default function LicenseCleanup() {
  const { toast } = useApp()
  const [rule, setRule] = useState<Rule | null>(null)
  const [saved, setSaved] = useState<Rule | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [info, setInfo] = useState<{ seats: { total: number; active30: number; active90: number; never: number }; runs: Run[] } | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [pv, setPv] = useState<{ change: P[]; warn: P[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = () => {
    api<{ value: Rule }[]>('GET', '/api/admin/settings').then(all => { const r = (all as any[]).find(s => s.key === 'licenseCleanup')!.value; setRule(r); setSaved(r) }, e => toast(message(e), { tone: 'warn' }))
    api<typeof info>('GET', '/api/admin/license-cleanup').then(setInfo, e => toast(message(e), { tone: 'warn' }))
  }
  useEffect(() => { load(); api<Group[]>('GET', '/api/groups').then(g => setGroups(g.filter(x => x.kind !== 'system' || x.name !== 'system-administrators')), () => {}) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!rule || !info) return <p className="muted" role="status">Loading…</p>
  const dirty = JSON.stringify(rule) !== JSON.stringify(saved)
  const set = (p: Partial<Rule>) => { setRule({ ...rule, ...p }); setPv(null) }
  const save = () => api<{ value: Rule }>('PUT', '/api/admin/settings/licenseCleanup', rule)
    .then(r => { setSaved(r.value); setRule(r.value); setErrors({}); toast(rule.enabled ? 'Saved: it runs every day at 02:00 UTC' : 'Saved') },
      e => { setErrors(e instanceof ApiError ? e.errors ?? {} : {}); toast(message(e), { tone: 'warn' }) })
  const preview = () => { setBusy(true); api<{ change: P[]; warn: P[] }>('POST', '/api/admin/license-cleanup/preview', { rule }).then(setPv, e => toast(message(e), { tone: 'warn' })).finally(() => setBusy(false)) }
  const runNow = () => {
    if (dirty) { toast('Save the rule first: “Run now” uses the saved rule', { tone: 'warn' }); return }
    if (!window.confirm('Run the cleanup now with the saved rule? The people in the preview will be changed.')) return
    setBusy(true)
    api<{ changed: number; warned: number; notes: string }>('POST', '/api/admin/license-cleanup/run')
      .then(r => { toast(`Changed ${r.changed}, warned ${r.warned}${r.notes ? ` (${r.notes.split('\n')[0]})` : ''}`); setPv(null); load() }, e => toast(message(e), { tone: 'warn' }))
      .finally(() => setBusy(false))
  }
  const pick = (field: 'groupIds' | 'excludedGroupIds', label: string) => (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <select className="input" multiple size={Math.min(6, Math.max(3, groups.length))} style={{ width: 320 }} aria-label={label} value={rule[field]}
        onChange={e => set({ [field]: [...e.target.selectedOptions].map(o => o.value) })}>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      {errors[field] && <span className="hint error">{errors[field]}</span>}
    </label>
  )
  const s = info.seats

  return (
    <section aria-label="License cleanup">
      <div className="panel">
        <h2 className="panel-title">Seats</h2>
        <p className="muted">Everyone in users-access holds a seat, as in Jira’s application access.</p>
        <div className="seat-cards">
          <div><b>{s.total}</b><span className="muted sm">seats in use</span></div>
          <div><b>{s.active30}</b><span className="muted sm">active in the last 30 days</span></div>
          <div><b>{s.active90}</b><span className="muted sm">active in the last 90 days</span></div>
          <div><b>{s.never}</b><span className="muted sm">never used Strand</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title-row">
          <div>
            <h2 className="panel-title">Rule</h2>
            <p className="muted">People who haven’t used Strand for a while lose their seat, or more, once a day. System administrators are never changed.</p>
          </div>
          <Toggle on={rule.enabled} label="Run every day" onChange={enabled => set({ enabled })} />
        </div>
        <div className="settings-grid">
          <label className="settings-row">
            <span className="settings-label">Inactive for (days)</span>
            <input className="input" type="number" min={7} max={3650} style={{ width: 120 }} aria-label="Inactive for (days)" value={rule.inactiveDays} onChange={e => set({ inactiveDays: Number(e.target.value) })} />
            {errors.inactiveDays && <span className="hint error">{errors.inactiveDays}</span>}
          </label>
          <label className="settings-row">
            <span className="settings-label">Then</span>
            <select className="input" style={{ width: 460 }} aria-label="Action" value={rule.action} onChange={e => set({ action: e.target.value as Action })}>
              {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {rule.action === 'remove-groups' && pick('groupIds', 'Groups to take them out of')}
          <label className="settings-row">
            <span className="settings-label">Warn by email (days before)</span>
            <input className="input" type="number" min={0} max={60} style={{ width: 120 }} aria-label="Warn days before" value={rule.warnDays} onChange={e => set({ warnDays: Number(e.target.value) })} />
            <span className="muted sm">0: no warning</span>
            {errors.warnDays && <span className="hint error">{errors.warnDays}</span>}
          </label>
          {pick('excludedGroupIds', 'Never change members of')}
          <label className="settings-row">
            <span className="settings-label">Leave project and component leads alone</span>
            <Toggle on={rule.protectLeads} label="Leave project and component leads alone" onChange={protectLeads => set({ protectLeads })} />
          </label>
          <label className="settings-row">
            <span className="settings-label">Send a report to</span>
            <input className="input" style={{ width: 460 }} aria-label="Send a report to" placeholder="it-admins@example.com, …" defaultValue={rule.reportTo.join(', ')}
              onBlur={e => set({ reportTo: e.target.value.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean) })} />
            {Object.keys(errors).some(k => k.startsWith('reportTo')) && <span className="hint error">Check the email addresses</span>}
          </label>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" disabled={!dirty} onClick={save}><Save size={14} />Save</button>
          <button className="btn btn-secondary" disabled={busy} onClick={preview}><Eye size={14} />Preview</button>
          <button className="btn btn-secondary" disabled={busy} onClick={runNow}><Play size={14} />Run now</button>
        </div>
        {pv && (
          <div className="cleanup-preview" role="region" aria-label="Preview">
            <p><b>{pv.change.length}</b> {pv.change.length === 1 ? 'person' : 'people'} would be changed now; <b>{pv.warn.length}</b> would be warned. Nothing has changed.</p>
            {pv.change.length > 0 && <table className="table"><thead><tr><th>Would be changed</th><th>Email</th><th>Last active</th></tr></thead>
              <tbody>{pv.change.map(p => <tr key={p.userId}><td>{p.name}</td><td className="muted">{p.email}</td><td className="muted">{last(p)}</td></tr>)}</tbody></table>}
            {pv.warn.length > 0 && <table className="table" style={{ marginTop: 8 }}><thead><tr><th>Would be warned</th><th>Email</th><th>Last active</th></tr></thead>
              <tbody>{pv.warn.map(p => <tr key={p.userId}><td>{p.name}</td><td className="muted">{p.email}</td><td className="muted">{last(p)}</td></tr>)}</tbody></table>}
          </div>
        )}
      </div>

      <div className="panel">
        <h2 className="panel-title">Runs</h2>
        {info.runs.length === 0 ? <p className="muted sm">No runs yet.</p> : (
          <table className="table">
            <thead><tr><th>When</th><th>How</th><th>Action</th><th className="col-num">Changed</th><th className="col-num">Warned</th><th>Notes</th></tr></thead>
            <tbody>{info.runs.map(r => <Fragment key={r.id}>
              <tr onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                <td>{timeAgo(Date.parse(r.startedAt))}</td><td className="muted">{r.trigger === 'manual' ? `Run now${r.startedBy ? ` by ${r.startedBy}` : ''}` : 'Daily'}</td>
                <td className="muted">{r.action}</td><td className="col-num">{r.changedCount}</td><td className="col-num">{r.warnedCount}</td><td className="muted sm">{r.notes}</td>
              </tr>
              {open === r.id && <tr><td colSpan={6} className="muted sm">
                {r.changed.length ? <>Changed: {r.changed.map(p => p.email).join(', ')}. </> : null}{r.warned.length ? <>Warned: {r.warned.map(p => p.email).join(', ')}.</> : null}
              </td></tr>}
            </Fragment>)}</tbody>
          </table>
        )}
      </div>
    </section>
  )
}
