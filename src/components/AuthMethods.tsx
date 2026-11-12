import { useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { LoadError, Loading, Modal, Toggle } from './ui'

// Administration › Authentication methods (spec 0711), as Jira's: whether the login form shows, the authentication
// fallback, and Microsoft Entra, each turned on or off here. At least one way in always stays on.

interface Entra { enabled: boolean; name: string; tenantId: string; apiClientId: string; webClientId: string; authority: string }
interface Methods { loginForm: boolean; fallback: boolean; entra: Entra | null; recovery: boolean }

export default function AuthMethods() {
  const { toast } = useApp()
  const [m, setM] = useState<Methods | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const load = () => { setError(''); api<Methods>('GET', '/api/admin/authentication').then(setM, e => setError(errorMessage(e))) }
  useEffect(load, [])

  const put = (path: string, body: object, done: string) =>
    api<Methods>('PUT', path, body).then(r => { setM(r); toast(done) }, e => toast(errorMessage(e), { tone: 'warn' }))

  if (error) return <LoadError error={error} onRetry={load} />
  if (!m) return <Loading rows={3} />
  const fallbackUrl = `${location.origin}/?auth_fallback`
  return (
    <section>
      {m.recovery && <div className="apply-banner warn" role="status"><span>Recovery mode is on: <b>recovery_admin</b> can sign in with the server’s recovery password through the login form, whatever is set here.</span></div>}
      <section className="panel" aria-label="Login form">
        <h2 className="panel-title">Login form</h2>
        <p className="muted">The username and password form, checked against your user directories.</p>
        <div className="settings-grid">
          <div className="settings-row">
            <span className="settings-label">Show on the login page<span className="muted sm">Off: people go straight to Microsoft when it is on</span></span>
            <Toggle on={m.loginForm} label="Show the login form on the login page" onChange={v => void put('/api/admin/authentication', { loginForm: v, fallback: m.fallback }, v ? 'Login form shown' : 'Login form hidden')} />
          </div>
          <div className="settings-row">
            <span className="settings-label">Authentication fallback<span className="muted sm">While the form is hidden, it still opens at <span className="mono">{fallbackUrl}</span></span></span>
            <Toggle on={m.fallback} label="Authentication fallback" onChange={v => void put('/api/admin/authentication', { loginForm: m.loginForm, fallback: v }, v ? 'Fallback turned on' : 'Fallback turned off')} />
          </div>
        </div>
      </section>
      <section className="panel" aria-label="Microsoft Entra ID" style={{ marginTop: 16 }}>
        <h2 className="panel-title">Microsoft Entra ID (single sign-on)</h2>
        <p className="muted">{m.entra ? `The login page offers “Continue with ${m.entra.name}”.` : 'Not configured yet.'}</p>
        <div className="settings-grid">
          {m.entra && <>
            <div className="settings-row"><span className="settings-label">Tenant ID</span><span className="mono">{m.entra.tenantId}</span></div>
            <div className="settings-row"><span className="settings-label">API client ID</span><span className="mono">{m.entra.apiClientId}</span></div>
            <div className="settings-row"><span className="settings-label">Web client ID</span><span className="mono">{m.entra.webClientId}</span></div>
            <div className="settings-row"><span className="settings-label">Authority</span><span className="mono">{m.entra.authority}</span></div>
            <div className="settings-row">
              <span className="settings-label">Enabled<span className="muted sm">Off: Microsoft sign-ins are refused at once</span></span>
              <Toggle on={m.entra.enabled} label="Enable Microsoft Entra" onChange={v => void put('/api/admin/authentication/entra', { ...m.entra, enabled: v }, v ? 'Microsoft Entra turned on' : 'Microsoft Entra turned off')} />
            </div>
          </>}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={() => setEditing(true)}>{m.entra ? 'Edit' : 'Configure'}</button>
        </div>
      </section>
      {editing && <EntraDialog entra={m.entra} onClose={() => setEditing(false)} onSaved={r => { setM(r); setEditing(false); toast('Microsoft Entra saved') }} />}
    </section>
  )
}

const FIELDS = [
  ['name', 'Button name', 'The button says “Continue with …”'],
  ['tenantId', 'Directory (tenant) ID', ''],
  ['apiClientId', 'API client ID', 'The API app registration: the audience of the tokens'],
  ['webClientId', 'Web client ID', 'The single-page app registration the browser signs in with'],
  ['authority', 'Authority', 'https://login.microsoftonline.com, or a sovereign cloud'],
] as const

/** Entra's settings. Saving them enabled first checks that Entra answers for the tenant. */
function EntraDialog({ entra, onClose, onSaved }: { entra: Entra | null; onClose: () => void; onSaved: (m: Methods) => void }) {
  const [f, setF] = useState<Entra>(entra ?? { enabled: true, name: 'Microsoft', tenantId: '', apiClientId: '', webClientId: '', authority: 'https://login.microsoftonline.com' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setErrors({})
    try { onSaved(await api<Methods>('PUT', '/api/admin/authentication/entra', f)) }
    catch (e) { setErrors(e instanceof ApiError ? { ...e.errors, '': e.message } : { '': errorMessage(e) }) }
    finally { setBusy(false) }
  }
  return (
    <Modal title="Microsoft Entra ID" onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Checking…' : 'Save'}</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        {errors[''] && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        {FIELDS.map(([k, l, hint]) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <label className="label" htmlFor={`entra-${k}`}>{l}</label>
            <input id={`entra-${k}`} className="input" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} aria-invalid={!!errors[k]} />
            {errors[k] ? <p className="hint error">{errors[k]}</p> : hint && <p className="hint">{hint}</p>}
          </div>
        ))}
        <label className="check-row"><input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} />Enabled</label>
      </form>
    </Modal>
  )
}
