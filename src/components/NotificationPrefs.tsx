import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useApp } from '../appContext'
import { Checkbox } from './ui'

// Settings › Notifications (Jira's notification settings): for each kind of notification, whether it reaches me in the
// Inbox and by email. Email appears once a workspace admin turns it on.

type Kind = 'assigned' | 'mentioned' | 'commented' | 'status' | 'updated' | 'due' | 'automation'
interface Pref { kind: Kind; inbox: boolean; email: boolean }
interface Mine { autowatch: boolean | null; notifyOwnChanges: boolean | null; defaults: { autowatch: boolean; notifyOwnChanges: boolean } }
const LABEL: Record<Kind, string> = {
  assigned: 'Someone assigns me a work item', mentioned: 'Someone @mentions me', commented: 'Someone comments on work I hear about',
  status: 'Work I hear about changes status', updated: 'Other changes to work I hear about (its project’s notification scheme)', due: 'Work assigned to me is due', automation: 'An automation rule I own fails',
}

export default function NotificationPrefs() {
  const { toast } = useApp()
  const [prefs, setPrefs] = useState<Pref[] | null>(null)
  const [email, setEmail] = useState(false)
  const [error, setError] = useState('')
  const [mine, setMine] = useState<Mine | null>(null)
  useEffect(() => {
    api<{ prefs: Pref[]; emailEnabled: boolean } & Mine>('GET', '/api/me/notification-prefs')
      .then(r => { setPrefs(r.prefs); setEmail(r.emailEnabled); setMine(r) }, e => setError(e instanceof ApiError ? e.message : 'Could not reach the server.'))
  }, [])
  // Autowatch and My changes (spec 0606): mine, or the workspace's default until I choose
  const choose = (key: 'autowatch' | 'notifyOwnChanges', on: boolean) =>
    api<Mine>('PUT', '/api/me/notification-prefs', { [key]: on }).then(r => { setMine(r); toast('Notification settings saved') }, e => toast(e instanceof ApiError ? e.message : 'Could not save', { tone: 'warn' }))
  const change = (kind: Kind, patch: Partial<Pref>) => {
    const next = prefs!.map(p => (p.kind === kind ? { ...p, ...patch } : p))
    setPrefs(next)
    api('PUT', '/api/me/notification-prefs', { prefs: next.filter(p => p.kind === kind) })
      .then(() => toast('Notification settings saved'), e => { toast(e instanceof ApiError ? e.message : 'Could not save', { tone: 'warn' }); setPrefs(prefs) })
  }

  return (
    <section className="panel" id="notifications">
      <h2 className="panel-title">Notifications</h2>
      <p className="muted">What you hear about, and where.{email ? '' : ' Email isn’t turned on for this workspace; an admin can turn it on.'}</p>
      {error && <p className="hint error" role="alert">{error}</p>}
      {mine && <div style={{ marginTop: 12 }}>
        <Checkbox checked={mine.autowatch ?? mine.defaults.autowatch} label="Watch work I create or comment on" onChange={on => choose('autowatch', on)} /> <span className="sm">Watch work I create or comment on</span>
        <br />
        <Checkbox checked={mine.notifyOwnChanges ?? mine.defaults.notifyOwnChanges} label="Notify me about my own changes" onChange={on => choose('notifyOwnChanges', on)} /> <span className="sm">Notify me about my own changes</span>
      </div>}
      {prefs && (
        <div className="card-table" style={{ marginInline: 0, marginTop: 12 }}>
          <table className="table">
            <thead><tr><th>When</th><th className="col-num">Inbox</th>{email && <th className="col-num">Email</th>}</tr></thead>
            <tbody>
              {prefs.map(p => (
                <tr key={p.kind} style={{ cursor: 'default' }}>
                  <td>{LABEL[p.kind]}</td>
                  <td className="col-num"><Checkbox checked={p.inbox} label={`${LABEL[p.kind]}: Inbox`} onChange={inbox => change(p.kind, { inbox })} /></td>
                  {email && <td className="col-num"><Checkbox checked={p.email} label={`${LABEL[p.kind]}: email`} onChange={on => change(p.kind, { email: on })} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
