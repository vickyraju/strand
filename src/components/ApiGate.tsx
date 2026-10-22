import { useEffect, useState, type ReactNode } from 'react'
import { api, apiEnabled } from '../api/client'
import { authConfigured, completeSignIn, hasSession, signIn } from '../api/auth'
import { Logomark } from './NavRail'

type Phase = 'checking' | 'signed-out' | 'ready'

/** With an API configured, nothing renders until the user has signed in with Microsoft and the API accepts the token. */
export default function ApiGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(apiEnabled ? 'checking' : 'ready')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!apiEnabled || !authConfigured) return
    let live = true
    completeSignIn()
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Sign-in failed') })
      .then(() => (hasSession() ? api('GET', '/api/me').then(() => 'ready' as const, () => 'signed-out' as const) : 'signed-out' as const))
      .then(p => { if (live) setPhase(p) })
    const out = () => setPhase('signed-out')                                       // the API refused the token mid-session
    window.addEventListener('jira-build:signed-out', out)
    return () => { live = false; window.removeEventListener('jira-build:signed-out', out) }
  }, [])

  // A production build without these settings would silently fall back to a local demo store: refuse instead.
  if ((import.meta.env.PROD && !apiEnabled) || (apiEnabled && !authConfigured))
    return <Card title="Not configured" text="This build is missing VITE_API_URL, VITE_ENTRA_TENANT_ID or VITE_ENTRA_CLIENT_ID." />
  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return null

  return (
    <Card title="Sign in" text="Use your company Microsoft account.">
      {error && <p role="alert" className="text-danger" style={{ marginTop: 12 }}>{error}</p>}
      <button type="button" className="btn btn-primary btn-lg welcome-btn" onClick={() => void signIn()}>Sign in with Microsoft</button>
    </Card>
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
