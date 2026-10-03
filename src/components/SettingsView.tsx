import { useRef, useState } from 'react'
import { Plus, Download, Upload, Trash2, UserRoundCog, Sparkles, Pencil, Check, X, Sun, Moon, Monitor } from 'lucide-react'
import { useThemePref, setThemePref, type ThemePref } from '../theme'
import { useStore, migrate, type User } from '../data/store'
import { useApp } from '../appContext'
import { Avatar, Modal, plural } from './ui'
import { LoadSampleButton } from './ProjectView'

const SECTIONS = [['profile', 'Profile'], ['appearance', 'Appearance'], ['people', 'People'], ['workspace', 'Workspace'], ['data', 'Data']] as const

export default function SettingsView() {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const owner = state.owner!
  const [name, setName]         = useState(owner.name)
  const [member, setMember]     = useState('')
  const [memberTitle, setMemberTitle] = useState('')
  const [workspace, setWorkspace] = useState(state.workspaceName)
  const [removing, setRemoving] = useState<User | null>(null)
  const [editing, setEditing]   = useState<{ id: string; name: string; title: string } | null>(null)
  const [confirm, setConfirm]   = useState<'reset' | 'sample' | { importData: ReturnType<typeof migrate> } | null>(null)
  const [resetText, setResetText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const theme = useThemePref()

  const exportData = () => {
    const { me: _me, owner: _owner, ...data } = state
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `${state.workspaceName.toLowerCase().replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json` })
    a.click()
    URL.revokeObjectURL(url)
    toast('Workspace exported')
  }

  const importFile = async (file: File) => {
    try {
      const data = migrate(JSON.parse(await file.text()))
      if (!data.ownerId || !data.users.length) throw new Error('missing owner')
      setConfirm({ importData: data })
    } catch {
      toast('That file isn’t a Forge export', { tone: 'warn' })
    }
  }

  const assignedTo = (id: string) => state.issues.filter(i => i.assigneeId === id).length

  return (
    <div className="page">
      <div className="page-hdr"><h1 className="page-title">Settings</h1></div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="settings-nav-item">{label}</a>)}
        </nav>

        <div className="settings">
          <section className="panel" id="profile">
            <h2 className="panel-title">Your profile</h2>
            <div className="form-row" style={{ alignItems: 'center' }}>
              <Avatar user={owner} size={48} />
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor="st-name">Full name</label>
                <input id="st-name" className="input" value={name} onChange={e => setName(e.target.value)}
                  onBlur={() => name.trim() && name.trim() !== owner.name ? (dispatch({ type: 'updateUser', id: owner.id, name }), toast('Profile updated')) : setName(owner.name)} />
              </div>
            </div>
          </section>

          <section className="panel" id="appearance">
            <h2 className="panel-title">Appearance</h2>
            <p className="muted" style={{ marginBottom: 12 }}>Saved for this browser.</p>
            <div className="theme-picker" role="radiogroup" aria-label="Theme">
              {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Match system', Monitor]] as [ThemePref, string, typeof Sun][]).map(([v, label, Icon]) => (
                <button key={v} role="radio" aria-checked={theme === v} className={`theme-option${theme === v ? ' selected' : ''}`} onClick={() => setThemePref(v)}>
                  <span className={`theme-swatch ${v}`} />
                  <span className="cell-flex"><Icon size={14} />{label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel" id="people">
            <div className="panel-title-row">
              <div>
                <h2 className="panel-title">People</h2>
                <p className="muted">Everyone who can be assigned work. Use <b>Act as</b> to work as a teammate, for example to hand work over or test notifications.</p>
              </div>
            </div>
            <div className="people">
              {state.users.map(u => (
                <div key={u.id} className="person">
                  <Avatar user={u} size={34} />
                  {editing?.id === u.id ? (
                    <form className="person-edit" onSubmit={e => {
                      e.preventDefault()
                      dispatch({ type: 'updateUser', id: u.id, name: editing.name, title: editing.title }); setEditing(null)
                    }}>
                      <input className="input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} aria-label="Name" autoFocus />
                      <input className="input" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="Job title" aria-label="Job title" />
                      <button className="icon-btn" type="submit" aria-label="Save"><Check size={15} /></button>
                      <button className="icon-btn" type="button" onClick={() => setEditing(null)} aria-label="Cancel"><X size={15} /></button>
                    </form>
                  ) : (
                    <div className="person-text">
                      <span className="strong">{u.name}{u.id === owner.id && <span className="muted"> · you, workspace owner</span>}</span>
                      <span className="muted sm">{u.title ?? 'No title'} · {plural(assignedTo(u.id), 'assigned item')}</span>
                    </div>
                  )}
                  {editing?.id !== u.id && (
                    <div className="person-actions">
                      {u.id !== owner.id && (state.me?.id === u.id
                        ? <span className="lozenge lozenge-in-progress">Acting as</span>
                        : <button className="btn btn-secondary btn-sm" onClick={() => { dispatch({ type: 'actAs', userId: u.id }); toast(`You are now acting as ${u.name}`) }}><UserRoundCog size={14} />Act as</button>)}
                      {u.id === owner.id && state.actingAsId && <button className="btn btn-secondary btn-sm" onClick={() => dispatch({ type: 'actAs', userId: null })}>Switch back to me</button>}
                      <button className="icon-btn" onClick={() => setEditing({ id: u.id, name: u.name, title: u.title ?? '' })} aria-label={`Edit ${u.name}`} title="Edit"><Pencil size={14} /></button>
                      {u.id !== owner.id && <button className="icon-btn" onClick={() => setRemoving(u)} aria-label={`Remove ${u.name}`} title="Remove"><Trash2 size={14} /></button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <form className="form-row" style={{ marginTop: 14 }} onSubmit={e => {
              e.preventDefault()
              if (!member.trim()) return
              dispatch({ type: 'addUser', name: member, title: memberTitle.trim() || undefined })
              toast(`Added ${member.trim()}`)
              setMember(''); setMemberTitle('')
            }}>
              <input className="input" value={member} onChange={e => setMember(e.target.value)} placeholder="Full name" aria-label="New person’s name" />
              <input className="input" value={memberTitle} onChange={e => setMemberTitle(e.target.value)} placeholder="Job title (optional)" aria-label="New person’s job title" />
              <button type="submit" className="btn btn-primary" disabled={!member.trim()}><Plus size={15} />Add person</button>
            </form>
          </section>

          <section className="panel" id="workspace">
            <h2 className="panel-title">Workspace</h2>
            <label className="label" htmlFor="st-ws">Workspace name</label>
            <input id="st-ws" className="input" value={workspace} onChange={e => setWorkspace(e.target.value)}
              onBlur={() => workspace.trim() && workspace !== state.workspaceName ? (dispatch({ type: 'setWorkspaceName', name: workspace }), toast('Workspace renamed')) : setWorkspace(state.workspaceName)} />
            <p className="hint">Shown at the top of the sidebar and in the browser tab.</p>
          </section>

          <section className="panel" id="data">
            <h2 className="panel-title">Data</h2>
            <p className="muted">Your workspace is stored in this browser. Export a copy to back it up or move it to another browser.</p>
            <div className="btn-row">
              <button className="btn btn-secondary" onClick={exportData}><Download size={15} />Export JSON</button>
              <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}><Upload size={15} />Import JSON</button>
              <input ref={fileRef} type="file" accept="application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' }} />
            </div>
            <div className="divider" />
            <h3 className="subhead">Sample workspace</h3>
            {state.sampleIds.length > 0 ? (
              <>
                <p className="muted">Sample projects, people and history are loaded. Removing them keeps everything you created yourself.</p>
                <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setConfirm('sample')}><Sparkles size={15} />Remove sample data</button>
              </>
            ) : (
              <>
                <p className="muted">Load three realistic projects with a team, sprints and history to explore boards, the inbox and reports.</p>
                <div style={{ marginTop: 8 }}><LoadSampleButton /></div>
              </>
            )}
          </section>

          <section className="panel panel-danger">
            <h2 className="panel-title">Reset workspace</h2>
            <p className="muted">Permanently deletes every project, work item and person in this browser.</p>
            <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={() => setConfirm('reset')}>Reset workspace</button>
          </section>
        </div>
      </div>

      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { dispatch({ type: 'removeUser', id: removing.id }); toast(`Removed ${removing.name}`); setRemoving(null) }}>Remove</button>
          </>}>
          <p>{plural(assignedTo(removing.id), 'work item')} assigned to {removing.name} will become unassigned. Their comments and history stay.</p>
        </Modal>
      )}
      {confirm === 'sample' && (
        <Modal title="Remove sample data?" onClose={() => setConfirm(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { dispatch({ type: 'removeSample' }); toast('Sample data removed'); setConfirm(null) }}>Remove sample data</button>
          </>}>
          <p>Deletes the sample projects, their work items and the sample people. Projects and items you created stay.</p>
        </Modal>
      )}
      {confirm === 'reset' && (
        <Modal title="Reset workspace?" onClose={() => setConfirm(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={resetText !== 'RESET'} onClick={() => dispatch({ type: 'reset' })}>Reset workspace</button>
          </>}>
          <p>This deletes everything and can’t be undone. Export first if you want a backup.</p>
          <label className="label" htmlFor="reset-confirm" style={{ marginTop: 12 }}>Type <b>RESET</b> to confirm</label>
          <input id="reset-confirm" className="input" value={resetText} onChange={e => setResetText(e.target.value.toUpperCase())} autoFocus />
        </Modal>
      )}
      {confirm && typeof confirm === 'object' && (
        <Modal title="Replace this workspace?" onClose={() => setConfirm(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { dispatch({ type: 'replace', state: confirm.importData }); toast('Workspace imported'); setConfirm(null) }}>Replace</button>
          </>}>
          <p>The file has {plural(confirm.importData.projects.length, 'project')} and {plural(confirm.importData.issues.length, 'work item')}. Importing replaces everything currently in this browser.</p>
        </Modal>
      )}
    </div>
  )
}
