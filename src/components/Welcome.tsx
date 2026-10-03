import { useState } from 'react'
import { useStore } from '../data/store'
import { Logomark } from './NavRail'

export default function Welcome() {
  const { dispatch } = useStore()
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')

  return (
    <div className="welcome">
      <form
        className="welcome-card"
        onSubmit={e => { e.preventDefault(); if (name.trim()) dispatch({ type: 'setOwner', name, workspaceName: workspace }) }}
      >
        <Logomark size={40} />
        <h1 className="welcome-title">Welcome to Forge</h1>
        <p className="welcome-sub">Plan, track and ship work with your team. Tell us who you are to set up your workspace.</p>
        <label className="label" htmlFor="welcome-name">Your full name</label>
        <input id="welcome-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alex Morgan" autoFocus autoComplete="name" />
        <label className="label" htmlFor="welcome-ws" style={{ marginTop: 14 }}>Workspace name <span className="muted">(optional)</span></label>
        <input id="welcome-ws" className="input" value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="e.g. Acme Engineering" autoComplete="organization" />
        <button type="submit" className="btn btn-primary btn-lg welcome-btn" disabled={!name.trim()}>Continue</button>
      </form>
    </div>
  )
}
