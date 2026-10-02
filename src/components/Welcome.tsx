import { useState } from 'react'
import { useStore } from '../data/store'
import { Logomark } from './NavRail'

export default function Welcome() {
  const { dispatch } = useStore()
  const [name, setName] = useState('')

  return (
    <div className="welcome">
      <form
        className="welcome-card"
        onSubmit={e => { e.preventDefault(); if (name.trim()) dispatch({ type: 'setMe', name }) }}
      >
        <Logomark size={36} />
        <h1 className="welcome-title">Welcome to Forge</h1>
        <p className="welcome-sub">Plan, track and ship work with your team. First, what should we call you?</p>
        <label className="form-lbl" htmlFor="welcome-name">Full name</label>
        <input
          id="welcome-name"
          className="form-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Alex Morgan"
          autoFocus
        />
        <button type="submit" className="btn-primary welcome-btn" disabled={!name.trim()}>Continue</button>
      </form>
    </div>
  )
}
