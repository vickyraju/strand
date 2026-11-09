import { useEffect, useState, type ReactNode } from 'react'
import { api, apiEnabled, errorMessage, getLogin, setLogin, ApiError } from '../api/client'
import { completeSignIn, hasSession, passwordSignedIn, showsLoginForm, signIn, type AuthConfig } from '../api/auth'
import { Logomark } from './NavRail'

type Phase = 'checking' | 'signed-out' | 'ready'

/** With an API configured, nothing renders until the user has signed in and the API accepts the token. How they sign in
 *  is the server's Authentication methods (spec 0711): Microsoft Entra, the login form, or both; on a development server,
 *  the dev login (R13), with the login form still at `?auth_fallback`. */
export default function ApiGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(apiEnabled ? 'checking' : 'ready')
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [error, setError] = useState('')

  const check = () => (hasSession() || getLogin() ? api('GET', '/api/me').then(() => 'ready' as const, () => 'signed-out' as const) : Promise.resolve('signed-out' as const))
  useEffect(() => {
    if (!apiEnabled) return
    let live = true
    api<AuthConfig>('GET', '/api/auth/config').then(c => {
      if (!live) return
      setConfig(c)
      let failed = false
      return completeSignIn()
        .catch(e => { failed = true; if (live) setError(e instanceof Error ? e.message : 'Sign-in failed') })
        .then(check)
        .then(p => {
          if (!live) return
          // only Microsoft is on: go straight there, unless a sign-in just failed (R7)
          if (p === 'signed-out' && c.entra && !c.dev && !failed && !showsLoginForm(c, location.search)) void signIn(c.entra)
          else setPhase(p)
        })
    }, e => { if (live) { setError(errorMessage(e)); setPhase('signed-out') } })
    const out = () => setPhase('signed-out')                                       // the API refused the token mid-session
    window.addEventListener('jira-build:signed-out', out)
    return () => { live = false; window.removeEventListener('jira-build:signed-out', out) }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // A production build without an API would silently fall back to a local demo store: refuse instead.
  if (import.meta.env.PROD && !apiEnabled) return <Card title="Not configured" text="This build is missing VITE_API_URL." />
  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return null
  if (!config) return <Card title="Sign in" text="Strand can’t reach its server right now."><p role="alert" className="text-danger">{error}</p></Card>

  if (config.dev && !new URLSearchParams(location.search).has('auth_fallback'))
    return <Card title="Sign in" text="This is a development server. Use your work email and the shared dev secret."><DevLoginForm onSignedIn={() => setPhase('ready')} /></Card>
  const form = showsLoginForm(config, location.search)
  return (
    <Card title="Sign in" text={form ? 'Use your company username and password.' : 'Use your company Microsoft account.'}>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {form && <LoginForm onSignedIn={() => { setError(''); void check().then(setPhase) }} />}
      {config.entra && (
        <button type="button" className={`btn btn-lg welcome-btn${form ? '' : ' btn-primary'}`} onClick={() => void signIn(config.entra!)}>Continue with {config.entra.name}</button>
      )}
    </Card>
  )
}

/** Jira's login form: Username, Password, “Remember my login on this computer”. */
function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const fallback = new URLSearchParams(location.search).has('auth_fallback')
      const r = await api<{ token: string; expiresAt: string }>('POST', '/api/auth/login', { username, password, remember, fallback })
      passwordSignedIn(r.token, r.expiresAt, remember)
      onSignedIn()
    } catch (err) { setError(errorMessage(err)); setPassword('') } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit}>
      {error && <p role="alert" className="text-danger" style={{ marginBottom: 12 }}>{error}</p>}
      <label className="label" htmlFor="login-username">Username</label>
      <input id="login-username" className="input" autoComplete="username" autoFocus value={username} onChange={e => setUsername(e.target.value)} required />
      <label className="label" htmlFor="login-password" style={{ marginTop: 14 }}>Password</label>
      <input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
      <label className="check-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember my login on this computer
      </label>
      <button type="submit" className="btn btn-primary btn-lg welcome-btn" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
    </form>
  )
}

/** Strand's dev login (AUTH_DEV): a work email and the shared dev secret, sent as x-dev-* headers. */
function DevLoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const submit = async () => {
    setError('')
    setLogin({ email: email.trim().toLowerCase(), secret })
    try {
      await api('GET', '/api/me')
      onSignedIn()
    } catch (e) {
      setLogin(null)
      setError(e instanceof ApiError && e.status === 401 ? 'That email or secret was not accepted.' : 'Could not reach the server.')
    }
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void submit() }}>
      <label className="label" htmlFor="login-email">Work email</label>
      <input id="login-email" className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoFocus autoComplete="email" required />
      <label className="label" htmlFor="login-secret" style={{ marginTop: 14 }}>Dev secret</label>
      <input id="login-secret" className="input" type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" required />
      {error && <p role="alert" className="text-danger" style={{ marginTop: 12 }}>{error}</p>}
      <button type="submit" className="btn btn-primary btn-lg welcome-btn" disabled={!email || !secret}>Sign in</button>
    </form>
  )
}

function Card({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logomark size={40} />
        <h1 className="welcome-title">{title}</h1>
        <p className="welcome-sub">{text}</p>
        {children}
      </div>
    </div>
  )
}
