import { useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'

/** Settings › Password (spec 0714 R8): only for people whose password the app keeps (the internal directory). */
export default function PasswordSettings() {
  const { toast } = useApp()
  const [has, setHas] = useState(false)
  const [f, setF] = useState({ current: '', password: '', again: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => { api<{ hasPassword?: boolean; directory?: string | null }>('GET', '/api/me').then(m => setHas(!!m.hasPassword && !m.directory), () => {}) }, [])
  if (!has) return null
  const save = async () => {
    if (f.password !== f.again) { setErrors({ again: 'The two passwords are different' }); return }
    setErrors({})
    try {
      await api('PUT', '/api/me/password', { current: f.current, password: f.password })
      setF({ current: '', password: '', again: '' }); toast('Password changed: your other sign-ins ended')
    } catch (e) { setErrors(e instanceof ApiError ? { ...e.errors, '': e.message } : { '': errorMessage(e) }) }
  }
  const field = (k: keyof typeof f, label: string, auto: string) => (
    <div style={{ flex: 1, minWidth: 180 }}>
      <label className="label" htmlFor={`pw-${k}`}>{label}</label>
      <input id={`pw-${k}`} className="input" type="password" autoComplete={auto} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} aria-invalid={!!errors[k]} />
      {errors[k] && <p className="hint error">{errors[k]}</p>}
    </div>
  )
  return (
    <section className="panel" id="password">
      <h2 className="panel-title">Password</h2>
      <p className="muted" style={{ marginBottom: 12 }}>The password you use on the login form.</p>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        {errors[''] && !Object.keys(errors).some(k => k && errors[k]) && <p role="alert" className="text-danger" style={{ marginBottom: 10 }}>{errors['']}</p>}
        <div className="form-row">{field('current', 'Current password', 'current-password')}{field('password', 'New password', 'new-password')}{field('again', 'Type it again', 'new-password')}</div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!f.current || !f.password}>Change password</button>
      </form>
    </section>
  )
}
