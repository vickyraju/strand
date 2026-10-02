import { useState } from 'react'
import { Columns2, ListChecks, Check } from 'lucide-react'
import { useStore, uid, suggestKey, isValidKey, PROJECT_COLORS, type Template } from '../data/store'

const TEMPLATES: { id: Template; name: string; desc: string; Icon: typeof Columns2 }[] = [
  { id: 'kanban', name: 'Kanban', desc: 'Visualize work on a board and keep it flowing.',         Icon: Columns2   },
  { id: 'scrum',  name: 'Scrum',  desc: 'Plan work in sprints from a prioritized backlog.',       Icon: ListChecks },
]

export default function CreateProjectModal({ onClose, onCreated }: {
  onClose:   () => void
  onCreated: (projectId: string) => void
}) {
  const { state, dispatch } = useStore()
  const [name, setName]         = useState('')
  const [key, setKey]           = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [template, setTemplate] = useState<Template>('kanban')
  const [color, setColor]       = useState(PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length])

  const keyTaken = state.projects.some(p => p.key === key)
  const keyError = !key ? null
    : !isValidKey(key) ? 'Use 2–10 letters, A–Z only.'
    : keyTaken ? `${key} is already used by another project.`
    : null
  const canCreate = name.trim().length > 0 && isValidKey(key) && !keyTaken

  const onNameChange = (v: string) => {
    setName(v)
    if (!keyEdited) setKey(suggestKey(v))
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canCreate) return
    const id = uid()
    dispatch({ type: 'createProject', project: { id, name: name.trim(), key, color, template } })
    onCreated(id)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="save-modal cp-modal"
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={e => e.key === 'Escape' && onClose()}
      >
        <div className="modal-hdr">
          <div className="modal-title">Create project</div>
          <div className="cp-sub">You can change these details anytime in project settings.</div>
        </div>

        <div className="modal-body">
          <div className="cp-row">
            <div style={{ flex: 1 }}>
              <label className="form-lbl" htmlFor="cp-name">Name</label>
              <input
                id="cp-name"
                className="form-input"
                value={name}
                onChange={e => onNameChange(e.target.value)}
                placeholder="e.g. Payments Platform"
                autoFocus
              />
            </div>
            <div style={{ width: 120 }}>
              <label className="form-lbl" htmlFor="cp-key">Key</label>
              <input
                id="cp-key"
                className="form-input cp-key-input"
                value={key}
                onChange={e => { setKey(e.target.value.toUpperCase()); setKeyEdited(true) }}
                maxLength={10}
                aria-invalid={!!keyError}
              />
            </div>
          </div>
          <div className={`cp-hint${keyError ? ' error' : ''}`}>
            {keyError ?? (key ? `Work items will be numbered ${key}-1, ${key}-2, …` : 'The key prefixes every work item in this project.')}
          </div>

          <label className="form-lbl" style={{ marginTop: 16 }}>Template</label>
          <div className="cp-templates" role="radiogroup">
            {TEMPLATES.map(({ id, name: tName, desc, Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={template === id}
                className={`cp-template${template === id ? ' selected' : ''}`}
                onClick={() => setTemplate(id)}
              >
                <Icon size={16} strokeWidth={1.5} />
                <span className="cp-template-name">{tName}</span>
                <span className="cp-template-desc">{desc}</span>
              </button>
            ))}
          </div>

          <label className="form-lbl" style={{ marginTop: 16 }}>Color</label>
          <div className="cp-colors" role="radiogroup">
            {PROJECT_COLORS.map(c => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className="cp-swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              >
                {color === c && <Check size={12} strokeWidth={2.5} color="#FFFFFF" />}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-ftr">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!canCreate}>Create project</button>
        </div>
      </form>
    </div>
  )
}
