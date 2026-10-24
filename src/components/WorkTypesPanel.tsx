import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore, typesOf, isBuiltinType, type Project, type WorkType } from '../data/store'
import { api, apiEnabled, ApiError } from '../api/client'
import { issueSync } from '../api/sync'
import { sprintDeps } from '../api/sprints'
import { useApp } from '../appContext'
import { Modal, TYPE_ICONS, TypeIcon, plural } from './ui'

// Project settings › Work types (Jira's issue types): the built-in four (renamed or recoloured for this project) and any
// the project adds. Removing one moves its work items to another type. Each type can have its own workflow: limit
// transitions to it in the workflow editor.

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

export default function WorkTypesPanel({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [editing, setEditing] = useState<WorkType | 'new' | null>(null)
  const [removing, setRemoving] = useState<WorkType | null>(null)
  const types = typesOf(project)
  const count = (k: string) => state.issues.filter(i => i.projectId === project.id && i.type === k).length

  /** Server first (it checks names and moves items), then the app's copy. */
  const save = async (t: WorkType, isNew: boolean) => {
    let saved = t
    if (apiEnabled) {
      try {
        const body = { name: t.name, color: t.color, icon: t.icon }
        const row = await api<WorkType>(isNew ? 'POST' : 'PATCH', isNew ? `/api/projects/${project.key}/types` : `/api/projects/${project.key}/types/${t.key}`, body)
        saved = { key: row.key, name: row.name, color: row.color, icon: row.icon }
      } catch (e) { toast(message(e), { tone: 'warn' }); return false }
    } else if (types.some(x => x.key !== t.key && x.name.toLowerCase() === t.name.toLowerCase())) { toast('A work type with that name already exists', { tone: 'warn' }); return false }
    dispatch({ type: 'updateProject', id: project.id, patch: { types: isNew ? [...types, saved] : types.map(x => (x.key === t.key ? saved : x)) } })
    toast(`${saved.name} saved`)
    return true
  }
  const remove = async (t: WorkType, moveTo: string) => {
    if (apiEnabled) {
      try {
        await issueSync.idle()
        await api('DELETE', `/api/projects/${project.key}/types/${t.key}?moveTo=${encodeURIComponent(moveTo)}`)
        await sprintDeps.reloadProject(project.id)   // its items now have another type
      } catch (e) { toast(message(e), { tone: 'warn' }); return }
    } else {
      const ids = state.issues.filter(i => i.projectId === project.id && i.type === t.key).map(i => i.id)
      if (ids.length) dispatch({ type: 'updateIssues', ids, patch: { type: moveTo } })
    }
    const transitions = project.transitions.map(x => (x.types?.includes(t.key) ? { ...x, types: x.types.filter(k => k !== t.key).length ? x.types.filter(k => k !== t.key) : undefined } : x))
    dispatch({ type: 'updateProject', id: project.id, patch: { types: types.filter(x => x.key !== t.key), transitions } })
    setRemoving(null)
    toast(`${t.name} removed`)
  }

  return (
    <section className="panel" aria-label="Work types">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Work types</h2>
          <p className="muted">The kinds of work in this project. Each can follow its own workflow: in the workflow editor, limit a transition to some types.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setEditing('new')}><Plus size={14} />Add work type</button>
      </div>
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table">
          <thead><tr><th>Type</th><th className="col-num">Work items</th><th /></tr></thead>
          <tbody>
            {types.map(t => (
              <tr key={t.key} style={{ cursor: 'pointer' }} onClick={() => setEditing(t)}>
                <td><span className="cell-flex"><TypeIcon type={t.key} project={project} />{t.name}{isBuiltinType(t.key) && <span className="muted sm">built in</span>}</span></td>
                <td className="col-num">{count(t.key)}</td>
                <td style={{ textAlign: 'right' }}>
                  {!isBuiltinType(t.key) && <button className="icon-btn sm" aria-label={`Remove ${t.name}`} title="Remove" onClick={e => { e.stopPropagation(); setRemoving(t) }}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <TypeDialog type={editing === 'new' ? { key: `t-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, name: '', color: '#0EA5E9', icon: 'flag' } : editing}
        isNew={editing === 'new'} onClose={() => setEditing(null)} onSave={async (t, isNew) => { if (await save(t, isNew)) setEditing(null) }} />}
      {removing && <RemoveDialog type={removing} count={count(removing.key)} others={types.filter(x => x.key !== removing.key)}
        onClose={() => setRemoving(null)} onRemove={moveTo => remove(removing, moveTo)} />}
    </section>
  )
}

function TypeDialog({ type, isNew, onClose, onSave }: { type: WorkType; isNew: boolean; onClose: () => void; onSave: (t: WorkType, isNew: boolean) => void }) {
  const [t, setT] = useState(type)
  const valid = !!t.name.trim()
  const submit = () => { if (valid) onSave({ ...t, name: t.name.trim() }, isNew) }
  return (
    <Modal title={isNew ? 'Add work type' : `Edit ${type.name}`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!valid} onClick={submit}>{isNew ? 'Add' : 'Save'}</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); submit() }}>
        <label className="label" htmlFor="wt-name">Name</label>
        <input id="wt-name" className="input" autoFocus value={t.name} placeholder="e.g. Incident" onChange={e => setT({ ...t, name: e.target.value })} />
        <div className="form-row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div>
            <label className="label" htmlFor="wt-color">Colour</label>
            <input id="wt-color" type="color" className="color-input" value={t.color} onChange={e => setT({ ...t, color: e.target.value })} />
          </div>
          <fieldset className="wf-fieldset" style={{ flex: 1 }}>
            <legend className="label">Icon</legend>
            <div className="icon-choices" role="radiogroup" aria-label="Icon">
              {Object.entries(TYPE_ICONS).map(([k, Icon]) => (
                <button type="button" key={k} role="radio" aria-checked={t.icon === k} aria-label={k} className={`icon-choice${t.icon === k ? ' on' : ''}`}
                  style={{ background: t.icon === k ? t.color : undefined }} onClick={() => setT({ ...t, icon: k })}>
                  <Icon size={13} strokeWidth={2.5} color={t.icon === k ? '#FFFFFF' : 'currentColor'} />
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </form>
    </Modal>
  )
}

function RemoveDialog({ type, count, others, onClose, onRemove }: { type: WorkType; count: number; others: WorkType[]; onClose: () => void; onRemove: (moveTo: string) => void }) {
  const [moveTo, setMoveTo] = useState(others.find(o => o.key === 'task')?.key ?? others[0]!.key)
  return (
    <Modal title={`Remove “${type.name}”?`} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" onClick={() => onRemove(moveTo)}>Remove</button>
    </>}>
      <p>{count ? `${plural(count, 'work item')} ${count === 1 ? 'is' : 'are'} ${type.name}. Change ${count === 1 ? 'it' : 'them'} to:` : 'Its templates, if any, change to:'}</p>
      <select className="input" style={{ marginTop: 8 }} aria-label="Change them to" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
        {others.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
      </select>
      <p className="hint">Transitions limited to {type.name} stop naming it; one left for no type applies to every type again.</p>
    </Modal>
  )
}
