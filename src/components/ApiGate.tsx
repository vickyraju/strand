import { useEffect, useState, type ReactNode } from 'react'
import { api, apiEnabled, errorMessage } from '../api/client'
import { completeSignIn, hasSession, passwordSignedIn, showsLoginForm, signIn, type AuthConfig } from '../api/auth'
import { Logomark } from './NavRail'
import { Modal } from './ui'
import AnnouncementBanner from './AnnouncementBanner'

type Phase = 'checking' | 'signed-out' | 'ready'

/** With an API configured, nothing renders until the user has signed in and the API accepts the token. How they sign in
 *  is the server's Authentication methods (spec 0711): Microsoft Entra, the login form, or both. */
export default function ApiGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(apiEnabled ? 'checking' : 'ready')
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [error, setError] = useState('')
  const [reset, setReset] = useState(() => new URLSearchParams(location.search).get('reset'))

  const check = () => (hasSession() ? api('GET', '/api/me').then(() => 'ready' as const, () => 'signed-out' as const) : Promise.resolve('signed-out' as const))
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
          if (p === 'signed-out' && c.entra && !failed && !showsLoginForm(c, location.search)) void signIn(c.entra)
          else setPhase(p)
        })
    }, e => { if (live) { setError(errorMessage(e)); setPhase('signed-out') } })
    const out = () => setPhase('signed-out')                                       // the API refused the token mid-session
    window.addEventListener('jira-build:signed-out', out)
    return () => { live = false; window.removeEventListener('jira-build:signed-out', out) }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // A production build without an API would silently fall back to a local demo store: refuse instead.
  if (import.meta.env.PROD && !apiEnabled) return <Card title="Not configured" text="This build is missing VITE_API_URL." />
  // a link from a password email (spec 0714): set the password first, then sign in
  if (reset && phase !== 'checking') return <Card title="Set your password" text="Choose a new password for Strand."><ResetForm token={reset} onDone={() => {
    const q = new URLSearchParams(location.search); q.delete('reset')
    history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : ''))
    setReset(null)
  }} /></Card>
  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return null
  if (!config) return <Card title="Sign in" text="Strand can’t reach its server right now."><p role="alert" className="text-danger">{error}</p></Card>

  const form = showsLoginForm(config, location.search)
  return (
    <Card announcement={config.announcement ?? ''} title="Sign in" text={form ? 'Use your company username and password.' : 'Use your company Microsoft account.'}>
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
  const [forgot, setForgot] = useState(false)
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
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setForgot(true)}>Can’t access your account?</button>
      {forgot && <Forgot onClose={() => setForgot(false)} />}
    </form>
  )
}

/** Jira's "Can't access your account?": a username or email; the same answer whether or not the account exists (spec 0714 R6). */
function Forgot({ onClose }: { onClose: () => void }) {
  const [who, setWho] = useState('')
  const [sent, setSent] = useState('')
  const [error, setError] = useState('')
  const submit = async () => {
    setError('')
    try { setSent((await api<{ message: string }>('POST', '/api/auth/forgot', { username: who })).message) } catch (e) { setError(errorMessage(e)) }
  }
  return (
    <Modal title="Can’t access your account?" onClose={onClose} footer={sent
      ? <button className="btn btn-primary" onClick={onClose}>Done</button>
      : <><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!who.trim()} onClick={() => void submit()}>Send</button></>}>
      {sent ? <p role="status">{sent}</p> : <form onSubmit={e => { e.preventDefault(); if (who.trim()) void submit() }}>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>We’ll email you a link to set a new password. If you sign in with your company account, your company sets your password, not Strand.</p>
        <label className="label" htmlFor="forgot-who">Username or email</label>
        <input id="forgot-who" className="input" autoFocus value={who} onChange={e => setWho(e.target.value)} />
        {error && <p role="alert" className="text-danger" style={{ marginTop: 10 }}>{error}</p>}
      </form>}
    </Modal>
  )
}

/** The link from a password email: a new password, typed twice. */
function ResetForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (password !== again) { setError('The two passwords are different'); return }
    setBusy(true); setError('')
    try { await api('POST', '/api/auth/reset', { token, password }); setDone(true) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  if (done) return <><p role="status">Your password is set. Sign in with it now.</p><button className="btn btn-primary btn-lg welcome-btn" onClick={onDone}>Go to sign in</button></>
  return (
    <form onSubmit={e => { e.preventDefault(); void submit() }}>
      {error && <p role="alert" className="text-danger" style={{ marginBottom: 12 }}>{error}</p>}
      <label className="label" htmlFor="reset-password">New password</label>
      <input id="reset-password" className="input" type="password" autoComplete="new-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} required />
      <label className="label" htmlFor="reset-again" style={{ marginTop: 14 }}>Type it again</label>
      <input id="reset-again" className="input" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required />
      <button type="submit" className="btn btn-primary btn-lg welcome-btn" disabled={busy || !password}>Set password</button>
    </form>
  )
}

function Card({ title, text, children, announcement = '' }: { title: string; text: string; children?: ReactNode; announcement?: string }) {
  return (
    <div className="welcome">
      <AnnouncementBanner text={announcement} />
      <div className="welcome-card">
        <Logomark size={40} />
        <h1 className="welcome-title">{title}</h1>
        <p className="welcome-sub">{text}</p>
        {children}
      </div>
    </div>
  )
}
