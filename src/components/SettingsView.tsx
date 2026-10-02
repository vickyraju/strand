import { useState } from 'react'
import { Plus, Download } from 'lucide-react'
import { useStore } from '../data/store'
import { Avatar } from './ui'

export default function SettingsView() {
  const { state, dispatch } = useStore()
  const me = state.me!
  const [name, setName]       = useState(me.name)
  const [member, setMember]   = useState('')
  const [confirm, setConfirm] = useState('')

  const exportData = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `forge-export-${new Date().toISOString().slice(0, 10)}.json` })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="pv-root">
      <div className="pv-header"><h1 className="pv-title">Settings</h1></div>
      <div className="ps-root" style={{ paddingTop: 0 }}>
        <section className="ps-section">
          <h2 className="ps-h">Your profile</h2>
          <label className="form-lbl" htmlFor="st-name">Full name</label>
          <div className="ps-add" style={{ marginTop: 0 }}>
            <Avatar user={me} size={32} />
            <input id="st-name" className="form-input" value={name} onChange={e => setName(e.target.value)}
              onBlur={() => name.trim() ? dispatch({ type: 'renameUser', id: me.id, name }) : setName(me.name)} />
          </div>
        </section>

        <section className="ps-section">
          <h2 className="ps-h">People</h2>
          <p className="ps-sub">Add the people on your team so you can assign work to them.</p>
          {state.users.map(u => (
            <div key={u.id} className="st-person">
              <Avatar user={u} size={26} />
              <span style={{ flex: 1 }}>{u.name}{u.id === me.id && <span className="ir-group-count"> (you)</span>}</span>
              <span className="ir-group-count">
                {state.issues.filter(i => i.assigneeId === u.id).length} assigned
              </span>
            </div>
          ))}
          <form className="ps-add" onSubmit={e => {
            e.preventDefault()
            if (!member.trim()) return
            dispatch({ type: 'addUser', name: member })
            setMember('')
          }}>
            <input className="form-input" value={member} onChange={e => setMember(e.target.value)} placeholder="Full name" aria-label="New member name" />
            <button type="submit" className="btn-secondary" disabled={!member.trim()}><Plus size={13} />Add person</button>
          </form>
        </section>

        <section className="ps-section">
          <h2 className="ps-h">Data</h2>
          <p className="ps-sub">Your workspace is saved in this browser. Export a copy to back it up.</p>
          <button className="btn-secondary" onClick={exportData}><Download size={13} />Export as JSON</button>
        </section>

        <section className="ps-section ps-danger">
          <h2 className="ps-h">Reset workspace</h2>
          <p className="ps-sub">Permanently deletes every project, work item and person in this browser. Type <b>RESET</b> to confirm.</p>
          <div className="ps-add">
            <input className="form-input" value={confirm} onChange={e => setConfirm(e.target.value.toUpperCase())} aria-label="Type RESET to confirm" />
            <button className="btn-danger" disabled={confirm !== 'RESET'} onClick={() => dispatch({ type: 'reset' })}>Reset workspace</button>
          </div>
        </section>
      </div>
    </div>
  )
}
