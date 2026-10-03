import { useState } from 'react'
import { Columns2, ListChecks, Check } from 'lucide-react'
import { useStore, uid, suggestKey, isValidKey, PROJECT_COLORS, type Template } from '../data/store'
import { Modal } from './ui'

const TEMPLATES: { id: Template; name: string; desc: string; Icon: typeof Columns2 }[] = [
  { id: 'kanban', name: 'Kanban', desc: 'Visualize work on a board and keep it flowing. Good for support, ops and continuous delivery.', Icon: Columns2 },
  { id: 'scrum',  name: 'Scrum',  desc: 'Plan work in sprints from a prioritized backlog, with burndown and velocity reports.', Icon: ListChecks },
]

export default function CreateProjectModal({ onClose, onCreated }: {
  onClose:   () => void
  onCreated: (projectId: string) => void
}) {
  const { state, dispatch } = useStore()
  const [name, setName]           = useState('')
  const [key, setKey]             = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [template, setTemplate]   = useState<Template>('kanban')
  const [color, setColor]         = useState(PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length])

  const keyTaken = state.projects.some(p => p.key === key)
  const keyError = !key ? null
    : !isValidKey(key) ? 'Use 2–10 letters, A–Z only.'
    : keyTaken ? `${key} is already used by another project.`
    : null
  const canCreate = name.trim().length > 0 && isValidKey(key) && !keyTaken

  const submit = () => {
    if (!canCreate) return
    const id = uid()
    dispatch({ type: 'createProject', project: { id, name: name.trim(), key, color, template } })
    onCreated(id)
  }

  return (
    <Modal
      title="Create project"
      onClose={onClose}
      width={560}
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="create-project" className="btn btn-primary" disabled={!canCreate}>Create project</button>
      </>}
    >
      <form id="create-project" onSubmit={e => { e.preventDefault(); submit() }}>
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

        <label className="label" style={{ marginTop: 18 }}>Template</label>
        <div className="template-grid" role="radiogroup" aria-label="Template">
          {TEMPLATES.map(({ id, name: tName, desc, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={template === id}
              className={`template-card${template === id ? ' selected' : ''}`} onClick={() => setTemplate(id)}>
              <span className="template-icon"><Icon size={18} strokeWidth={1.75} /></span>
              <span className="template-name">{tName}</span>
              <span className="template-desc">{desc}</span>
            </button>
          ))}
        </div>

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
