import { useEffect, useState } from 'react'
import { Columns2, ListChecks, Check, Code, ListTodo, FolderKanban, Workflow } from 'lucide-react'
import { useStore, uid, suggestKey, PROJECT_COLORS, type Template } from '../data/store'
import { describeKeyRule, keyFits } from '../../server/src/shared/projectKeys.ts'
import { TEMPLATES, TEMPLATE_IDS } from '../../server/src/shared/templates.ts'
import { usePublicSettings } from '../api/settings-public'
import { Modal } from './ui'
import { api, apiEnabled } from '../api/client'
import { mapProject } from '../api/map'
import { adoptProject } from '../api/settings'
import { searchProjects, type ProjectOption } from '../api/work'
import { Picker } from './ui'

const ICONS: Record<Template, typeof Columns2> = { kanban: Columns2, scrum: ListChecks, basic: Code, task: ListTodo, project: FolderKanban, process: Workflow }
// Jira's Software and Business templates (spec 0310); the browser-only demo has Kanban and Scrum
const offered = (apiEnabled ? TEMPLATE_IDS : ['kanban', 'scrum'] as Template[]).map(id => ({ id, ...TEMPLATES[id], Icon: ICONS[id] }))

export default function CreateProjectModal({ onClose, onCreated }: {
  onClose:   () => void
  /** Called with the new project's key (the store may not hold it yet when this runs) */
  onCreated: (projectKey: string) => void
}) {
  const { state, dispatch } = useStore()
  const [name, setName]           = useState('')
  const [key, setKey]             = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [template, setTemplate]   = useState<Template>('kanban')
  // Jira's Create with shared configuration (spec 0310 R4): another project's settings instead of a template
  const [sharing, setSharing]     = useState(false)
  const [shared, setShared]       = useState<ProjectOption | null>(null)
  const [query, setQuery]         = useState('')
  const [found, setFound]         = useState<ProjectOption[]>([])
  useEffect(() => { if (!sharing) return; const t = setTimeout(() => searchProjects(query).then(setFound, () => {}), 200); return () => clearTimeout(t) }, [sharing, query])
  const [color, setColor]         = useState(PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length])
  // Its workflow scheme (Administration › Workflows): by default the one named after the template
  const [schemes, setSchemes]     = useState<{ id: string; name: string; description: string }[]>([])
  const [schemeId, setSchemeId]   = useState('')
  useEffect(() => { if (apiEnabled) api<typeof schemes>('GET', '/api/workflow-schemes').then(setSchemes, () => {}) }, [])
  const scheme = schemes.find(s => s.id === schemeId) ?? schemes.find(s => s.name.toLowerCase() === TEMPLATES[template].scheme.toLowerCase()) ?? schemes[0]

  // the projects loaded here are only some of them: the server has the final word (and says so when the key is taken)
  const keyTaken = state.projects.some(p => p.key === key)
  const keyRule = usePublicSettings().projectKeys          // System settings › Project keys (spec 0308)
  const keyError = !key ? null
    : !keyFits(key, keyRule) ? `Use ${describeKeyRule(keyRule).replace(/^./, c => c.toLowerCase())}.`
    : keyTaken ? `${key} is already used by another project.`
    : null
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState('')
  const canCreate = name.trim().length > 0 && keyFits(key, keyRule) && !keyTaken && !busy && (!sharing || !!shared)

  const submit = async () => {
    if (!canCreate) return
    if (apiEnabled) {
      // The server owns the project's workflow (status ids), so wait for it instead of creating a local stand-in
      setBusy(true); setError('')
      try {
        const created = mapProject(await api('POST', '/api/projects', { name: name.trim(), key, color, template,
          ...(sharing && shared ? { sharedWith: shared.key } : scheme ? { workflowSchemeId: scheme.id } : {}) }))
        adoptProject(created)          // its default workflow is already on the server: do not send it back
        dispatch({ type: 'upsertProject', project: created })
        onCreated(created.key)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the project')
        setBusy(false)
      }
      return
    }
    const id = uid()
    dispatch({ type: 'createProject', project: { id, name: name.trim(), key, color, template } })
    onCreated(key)
  }

  return (
    <Modal
      title="Create project"
      onClose={onClose}
      width={560}
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="create-project" className="btn btn-primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create project'}</button>
      </>}
    >
      <form id="create-project" onSubmit={e => { e.preventDefault(); void submit() }}>
        <p className="muted" style={{ marginBottom: 16 }}>You can change these details anytime in project settings.</p>
        <div className="form-row">
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="cp-name">Name</label>
            <input id="cp-name" className="input" value={name} placeholder="e.g. Payments Platform" autoFocus
              onChange={e => { setName(e.target.value); if (!keyEdited) setKey(suggestKey(e.target.value)) }} />
          </div>
          <div style={{ width: 130 }}>
            <label className="label" htmlFor="cp-key">Key</label>
            <input id="cp-key" className="input mono" value={key} maxLength={10} aria-invalid={!!keyError} aria-describedby="cp-key-hint"
              onChange={e => { setKey(e.target.value.toUpperCase()); setKeyEdited(true) }} />
          </div>
        </div>
        <div id="cp-key-hint" className={`hint${keyError ? ' error' : ''}`}>
          {keyError ?? (key ? `Work items will be numbered ${key}-1, ${key}-2, …` : 'The key prefixes every work item in this project.')}
        </div>
        {error && <p role="alert" className="text-danger" style={{ marginTop: 8 }}>{error}</p>}

        {apiEnabled && (
          <label className="check-row" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={sharing} onChange={e => setSharing(e.target.checked)} />Share settings with an existing project
          </label>
        )}
        {sharing && <>
          <Picker value={shared?.id} search remote={{ onSearch: setQuery, searching: false }} className="btn btn-secondary" title="Project to share with"
            options={found.map(p => ({ value: p.id as string | undefined, label: `${p.name} (${p.key})` }))}
            onChange={id => setShared(found.find(p => p.id === id) ?? null)}
            trigger={shared ? `${shared.name} (${shared.key})` : 'Choose a project…'} />
          <div className="hint">The new project uses its workflows, fields, screens and notifications (changes reach both) and copies its work types. Its members, versions and work aren’t carried over.</div>
        </>}
        {!sharing && <>
        <label className="label" style={{ marginTop: 18 }}>Template</label>
        <div role="radiogroup" aria-label="Template">
          {(['Software', 'Business'] as const).filter(g => offered.some(t => t.group === g)).map(g => (
            <div key={g}>
              <div className="muted sm" style={{ margin: '8px 0 6px' }}>{g}</div>
              <div className="template-grid">
                {offered.filter(t => t.group === g).map(({ id, name: tName, desc, statuses, Icon }) => (
                  <button key={id} type="button" role="radio" aria-checked={template === id}
                    className={`template-card${template === id ? ' selected' : ''}`} onClick={() => setTemplate(id)}>
                    <span className="template-icon"><Icon size={18} strokeWidth={1.75} /></span>
                    <span className="template-name">{tName}</span>
                    <span className="template-desc">{desc}</span>
                    <span className="template-desc muted">{statuses}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        </>}
        {!sharing && scheme && <>
          <label className="label" htmlFor="cp-scheme" style={{ marginTop: 18 }}>Workflow</label>
          <select id="cp-scheme" className="input" value={scheme.id} onChange={e => setSchemeId(e.target.value)}>
            {schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="hint">{scheme.description || 'Workflows are kept by system administrators; a project admin can switch to another later.'}</div>
        </>}

        <label className="label" style={{ marginTop: 18 }}>Color</label>
        <div className="swatches" role="radiogroup" aria-label="Color">
          {PROJECT_COLORS.map(c => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c}
              className="swatch" style={{ background: c }} onClick={() => setColor(c)}>
              {color === c && <Check size={13} strokeWidth={3} color="#FFFFFF" />}
            </button>
          ))}
        </div>
      </form>
    </Modal>
  )
}
