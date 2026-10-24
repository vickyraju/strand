import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { reloadPublicSettings } from '../api/settings-public'
import { searchUsers } from '../api/users'
import { useApp } from '../appContext'
import { timeAgo, type User } from '../data/store'
import { Avatar, Toggle } from './ui'

// Administration › System settings: the policies a workspace admin controls (like Jira's Administration › System).
// Each section edits one setting as a whole and saves it in one go; the server checks it and records the change in the audit log.

interface Setting<V = any> { key: string; label: string; description: string; value: V; default: V }
type Mode = 'limit' | 'unlimited' | 'block'
interface RateLimiting { enabled: boolean; mode: Mode; requests: number; intervalSeconds: number; burst: number; exemptions: Exemption[] }
interface Exemption { userId: string; mode: Mode; requests?: number; intervalSeconds?: number; burst?: number }

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'limit', label: 'Limit requests', hint: 'Each person’s tokens get the numbers below.' },
  { id: 'unlimited', label: 'Allow unlimited requests', hint: 'Count nothing, refuse nothing.' },
  { id: 'block', label: 'Block all requests', hint: 'Refuse every request made with a token.' },
]
const INTERVALS = [{ s: 1, label: 'second' }, { s: 60, label: 'minute' }, { s: 3600, label: 'hour' }]

export default function SystemSettings() {
  const { toast } = useApp()
  const [settings, setSettings] = useState<Setting[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api<Setting[]>('GET', '/api/admin/settings').then(setSettings, e => setError(message(e))) }, [])

  /** Saves one setting; field errors come back keyed by field and are shown next to it. */
  const save = async (key: string, value: object): Promise<Record<string, string> | null> => {
    try {
      const saved = await api<Setting>('PUT', `/api/admin/settings/${key}`, value)
      setSettings(all => all!.map(s => (s.key === key ? saved : s)))
      void reloadPublicSettings()
      toast(`${saved.label} saved`)
      return null
    } catch (e) {
      toast(message(e), { tone: 'warn' })
      return (e instanceof ApiError && e.errors) || {}
    }
  }

  if (error) return <p className="hint error" role="alert">{error}</p>
  if (!settings) return <p className="muted" role="status">Loading…</p>
  const of = <V,>(key: string) => settings.find(s => s.key === key) as Setting<V>
  return (
    <section>
      <p className="muted">Changes apply within seconds on every server, without a restart, and are recorded in the Audit log.</p>
      <RateLimitingSection setting={of<RateLimiting>('rateLimiting')} save={v => save('rateLimiting', v)} />
      <SimpleSection setting={of('attachments')} save={v => save('attachments', v)} fields={[
        { key: 'enabled', label: 'Allow attachments', type: 'toggle' },
        { key: 'maxSizeMb', label: 'Largest file (MB)', type: 'number', min: 1, max: 2048 },
      ]} />
      <SimpleSection setting={of('accessTokens')} save={v => save('accessTokens', v)} fields={[
        { key: 'enabled', label: 'Allow personal access tokens', type: 'toggle', hint: 'Off: no one can create one, and existing tokens stop working until this is on again.' },
        { key: 'maxPerUser', label: 'Active tokens per person', type: 'number', min: 1, max: 100 },
        { key: 'maxExpiryDays', label: 'Longest lifetime (days)', type: 'number', min: 1, max: 3650 },
        { key: 'defaultExpiryDays', label: 'Lifetime offered by default (days)', type: 'number', min: 1, max: 3650 },
      ]} />
      <SimpleSection setting={of('searchAndBulk')} save={v => save('searchAndBulk', v)} fields={[
        { key: 'exportMaxRows', label: 'Most work items in one CSV export', type: 'number', min: 100, max: 1_000_000 },
        { key: 'bulkMaxItems', label: 'Most work items in one bulk change', type: 'number', min: 1, max: 5000 },
        { key: 'importMaxRows', label: 'Most rows in one CSV import', type: 'number', min: 10, max: 100_000 },
      ]} />
      <SimpleSection setting={of('dueReminders')} save={v => save('dueReminders', v)} fields={[
        { key: 'enabled', label: 'Send “due” notifications', type: 'toggle' },
        { key: 'daysAhead', label: 'Remind this many days before the due date', type: 'number', min: 0, max: 30, hint: '0: on the day it is due' },
        { key: 'daysLate', label: 'Keep reminding for this many days after it is late', type: 'number', min: 0, max: 90 },
        { key: 'dueSoonDays', label: '“Due soon” on Your work: within this many days', type: 'number', min: 1, max: 30 },
      ]} />
    </section>
  )
}

interface Field { key: string; label: string; type: 'toggle' | 'number'; min?: number; max?: number; hint?: string }

/** A setting made of switches and numbers: edit, then Save (or Reset to the saved value). */
function SimpleSection({ setting, fields, save }: { setting: Setting; fields: Field[]; save: (v: object) => Promise<Record<string, string> | null> }) {
  const [draft, setDraft] = useState(setting.value)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => { setDraft(setting.value) }, [setting.value])
  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value)
  return (
    <section className="panel" aria-label={setting.label}>
      <h2 className="panel-title">{setting.label}</h2>
      <p className="muted">{setting.description}</p>
      <div className="settings-grid">
        {fields.map(f => (
          <label key={f.key} className="settings-row">
            <span className="settings-label">{f.label}{f.hint && <span className="muted sm">{f.hint}</span>}</span>
            {f.type === 'toggle'
              ? <Toggle on={!!draft[f.key]} onChange={on => setDraft({ ...draft, [f.key]: on })} label={f.label} />
              : <input className="input" type="number" style={{ width: 120 }} min={f.min} max={f.max} value={draft[f.key] ?? ''}
                  onChange={e => setDraft({ ...draft, [f.key]: e.target.value === '' ? '' : Number(e.target.value) })} aria-invalid={!!errors[f.key]} />}
            {errors[f.key] && <span className="hint error">{errors[f.key]}</span>}
          </label>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={!dirty} onClick={async () => setErrors((await save(draft)) ?? {})}>Save</button>
        {dirty && <button className="btn btn-ghost" onClick={() => { setDraft(setting.value); setErrors({}) }}>Discard changes</button>}
      </div>
    </section>
  )
}

/** Rate limiting as in Jira: status, mode, requests per interval with a burst, per-person exemptions, and who was limited. */
function RateLimitingSection({ setting, save }: { setting: Setting<RateLimiting>; save: (v: object) => Promise<Record<string, string> | null> }) {
  const [draft, setDraft] = useState(setting.value)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<Map<string, User>>(new Map())
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<User[]>([])
  const [limited, setLimited] = useState<{ userId: string; name: string; email: string; lastAt: string; times: number }[] | null>(null)
  useEffect(() => { setDraft(setting.value) }, [setting.value])
  useEffect(() => { api<any[]>('GET', '/api/admin/rate-limits/limited').then(setLimited, () => setLimited([])) }, [setting.value])
  useEffect(() => {   // names for the people already exempted
    if (!draft.exemptions.length) return
    searchUsers('', 100).then(p => setPeople(m => new Map([...m, ...p.items.map(u => [u.id, u] as const)])), () => {})
  }, [draft.exemptions.length])
  useEffect(() => {
    if (!query.trim()) { setFound([]); return }
    const t = setTimeout(() => searchUsers(query, 8).then(p => { setFound(p.items); setPeople(m => new Map([...m, ...p.items.map(u => [u.id, u] as const)])) }, () => {}), 200)
    return () => clearTimeout(t)
  }, [query])

  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value)
  const set = (patch: Partial<RateLimiting>) => setDraft({ ...draft, ...patch })
  const setEx = (i: number, patch: Partial<Exemption>) => set({ exemptions: draft.exemptions.map((e, k) => (k === i ? { ...e, ...patch } : e)) })
  const unit = [...INTERVALS].reverse().find(u => draft.intervalSeconds % u.s === 0)!   // the largest unit that fits: 3600 s → 1 hour
  return (
    <section className="panel" aria-label="Rate limiting">
      <h2 className="panel-title">Rate limiting</h2>
      <p className="muted">{setting.description}</p>
      <div className="settings-grid">
        <label className="settings-row">
          <span className="settings-label">Status</span>
          <Toggle on={draft.enabled} onChange={enabled => set({ enabled })} label="Rate limiting on" />
          <span className="muted sm">{draft.enabled ? 'On' : 'Off: no limits at all'}</span>
        </label>
        {draft.enabled && <>
          <div className="settings-row" role="radiogroup" aria-label="Mode">
            <span className="settings-label">For everyone</span>
            <div className="segmented">
              {MODES.map(m => <button key={m.id} type="button" role="radio" aria-checked={draft.mode === m.id} className={draft.mode === m.id ? 'on' : ''} onClick={() => set({ mode: m.id })}>{m.label}</button>)}
            </div>
            <span className="muted sm">{MODES.find(m => m.id === draft.mode)!.hint}</span>
          </div>
          {draft.mode === 'limit' && <>
            <label className="settings-row">
              <span className="settings-label">Requests allowed</span>
              <input className="input" type="number" min={1} style={{ width: 110 }} value={draft.requests} onChange={e => set({ requests: Number(e.target.value) })} aria-invalid={!!errors.requests} />
              <span>every</span>
              <input className="input" type="number" min={1} style={{ width: 80 }} aria-label="Interval" value={draft.intervalSeconds / unit.s}
                onChange={e => set({ intervalSeconds: Math.max(1, Number(e.target.value)) * unit.s })} />
              <select className="input" style={{ width: 110 }} aria-label="Interval unit" value={unit.s} onChange={e => set({ intervalSeconds: (draft.intervalSeconds / unit.s) * Number(e.target.value) })}>
                {INTERVALS.map(u => <option key={u.s} value={u.s}>{u.label}{draft.intervalSeconds / unit.s === 1 ? '' : 's'}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Max requests<span className="muted sm">Unused requests build up to this. Same as “requests allowed”: no build-up.</span></span>
              <input className="input" type="number" min={1} style={{ width: 110 }} value={draft.burst} onChange={e => set({ burst: Number(e.target.value) })} aria-invalid={!!errors.burst} />
              {errors.burst && <span className="hint error">{errors.burst}</span>}
            </label>
          </>}

          <div className="settings-row" style={{ alignItems: 'flex-start' }}>
            <span className="settings-label">Exemptions<span className="muted sm">People whose tokens follow their own rule instead.</span></span>
            <div style={{ flex: 1 }}>
              {draft.exemptions.map((ex, i) => {
                const u = people.get(ex.userId)
                return (
                  <div key={ex.userId} className="form-row" style={{ alignItems: 'center', marginBottom: 6 }}>
                    <span className="admin-person" style={{ minWidth: 180 }}><Avatar user={u} size={20} />{u?.name ?? 'Someone'}</span>
                    <select className="input" style={{ width: 200 }} aria-label={`Rule for ${u?.name ?? 'person'}`} value={ex.mode} onChange={e => setEx(i, { mode: e.target.value as Mode })}>
                      {MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    {ex.mode === 'limit' && <>
                      <input className="input" type="number" min={1} style={{ width: 90 }} aria-label="Requests allowed" placeholder={String(draft.requests)} value={ex.requests ?? ''}
                        onChange={e => setEx(i, { requests: e.target.value ? Number(e.target.value) : undefined })} />
                      <span className="muted sm">per {draft.intervalSeconds / unit.s} {unit.label}{draft.intervalSeconds / unit.s === 1 ? '' : 's'}, max</span>
                      <input className="input" type="number" min={1} style={{ width: 90 }} aria-label="Max requests" placeholder={String(draft.burst)} value={ex.burst ?? ''}
                        onChange={e => setEx(i, { burst: e.target.value ? Number(e.target.value) : undefined })} />
                    </>}
                    <button className="icon-btn" aria-label={`Remove exemption for ${u?.name ?? 'person'}`} onClick={() => set({ exemptions: draft.exemptions.filter((_, k) => k !== i) })}><Trash2 size={14} /></button>
                  </div>
                )
              })}
              <div style={{ position: 'relative', maxWidth: 320 }}>
                <input className="input" placeholder="Add a person…" aria-label="Add an exemption" value={query} onChange={e => setQuery(e.target.value)} />
                {found.length > 0 && (
                  <ul className="picker-menu" style={{ position: 'absolute', zIndex: 5, listStyle: 'none', margin: 0, padding: 4, width: '100%' }}>
                    {found.filter(u => !draft.exemptions.some(e => e.userId === u.id)).map(u => (
                      <li key={u.id}><button className="picker-item" onClick={() => { set({ exemptions: [...draft.exemptions, { userId: u.id, mode: 'unlimited' }] }); setQuery('') }}>
                        <Plus size={14} /><Avatar user={u} size={18} />{u.name}</button></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={!dirty} onClick={async () => setErrors((await save(draft)) ?? {})}>Save</button>
        {dirty && <button className="btn btn-ghost" onClick={() => { setDraft(setting.value); setErrors({}) }}>Discard changes</button>}
      </div>

      <h3 className="subhead" style={{ marginTop: 18 }}>Limited accounts</h3>
      {!limited ? <p className="muted" role="status">Loading…</p>
        : !limited.length ? <p className="muted">Nobody was limited in the last 24 hours.</p>
        : <div className="card-table" style={{ marginInline: 0 }}>
            <table className="table">
              <thead><tr><th>Person</th><th>Last limited</th><th>Minutes limited (24 h)</th></tr></thead>
              <tbody>{limited.map(l => (
                <tr key={l.userId} style={{ cursor: 'default' }}><td>{l.name} <span className="muted sm">{l.email}</span></td><td>{timeAgo(Date.parse(l.lastAt))}</td><td>{l.times}</td></tr>
              ))}</tbody>
            </table>
          </div>}
    </section>
  )
}
