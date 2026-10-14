import { useEffect, useState, type ReactNode } from 'react'
import { api, apiEnabled, getLogin, setLogin, ApiError } from '../api/client'
import { Logomark } from './NavRail'

/** With an API configured, nothing renders until the dev login is accepted by the server. */
export default function ApiGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(!apiEnabled)
  const [checking, setChecking] = useState(apiEnabled && !!getLogin())
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!checking) return
    api('GET', '/api/me').then(() => setOk(true), () => setLogin(null)).finally(() => setChecking(false))
  }, [checking])

  if (ok) return <>{children}</>
  if (checking) return null

  const submit = async () => {
    setError('')
    setLogin({ email: email.trim().toLowerCase(), secret })
    try {
      await api('GET', '/api/me')
      setOk(true)
    } catch (e) {
      setLogin(null)
      setError(e instanceof ApiError && e.status === 401 ? 'That email or secret was not accepted.' : 'Could not reach the server.')
    }
  }

  return (
    <div className="welcome">
      <form className="welcome-card" onSubmit={e => { e.preventDefault(); void submit() }}>
        <Logomark size={40} />
        <h1 className="welcome-title">Sign in</h1>
        <p className="welcome-sub">This is a development server. Use your work email and the shared dev secret.</p>
        <label className="label" htmlFor="login-email">Work email</label>
        <input id="login-email" className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoFocus autoComplete="email" required />
        <label className="label" htmlFor="login-secret" style={{ marginTop: 14 }}>Dev secret</label>
        <input id="login-secret" className="input" type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" required />
        {error && <p role="alert" className="text-danger" style={{ marginTop: 12 }}>{error}</p>}
        <button type="submit" className="btn btn-primary btn-lg welcome-btn" disabled={!email || !secret}>Sign in</button>
      </form>
    </div>
  )
}
