import { useRef, useState } from 'react'
import { Download, Upload, Sun, Moon, Monitor } from 'lucide-react'
import { useThemePref, setThemePref, type ThemePref } from '../theme'
import { useStore, migrate } from '../data/store'
import { useApp } from '../appContext'
import { Avatar, Modal, plural } from './ui'
import AccessTokens from './AccessTokens'
import { apiEnabled } from '../api/client'

const SECTIONS = [['profile', 'Profile'], ...(apiEnabled ? [['tokens', 'Access tokens']] : []), ['appearance', 'Appearance'], ['workspace', 'Workspace'], ['data', 'Data']] as const

export default function SettingsView() {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const owner = state.owner!
  const [name, setName]         = useState(owner.name)
  const [workspace, setWorkspace] = useState(state.workspaceName)
  const [confirm, setConfirm]   = useState<'reset' | { importData: ReturnType<typeof migrate> } | null>(null)
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

          {apiEnabled && <AccessTokens />}

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
          </section>

          <section className="panel panel-danger">
            <h2 className="panel-title">Reset workspace</h2>
            <p className="muted">Permanently deletes every project, work item and person in this browser.</p>
            <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={() => setConfirm('reset')}>Reset workspace</button>
          </section>
        </div>
      </div>

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
