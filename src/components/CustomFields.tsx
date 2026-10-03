import { useState } from 'react'
import { Plus, Trash2, X, Type, Hash, ListChecks, CalendarDays } from 'lucide-react'
import { useStore, uid, type FieldDef, type Issue, type Project } from '../data/store'
import { useApp } from '../appContext'
import { Modal, Picker, plural, formatDate } from './ui'

export const FIELD_KIND: Record<FieldDef['kind'], { label: string; Icon: typeof Type }> = {
  text:   { label: 'Text',     Icon: Type },
  number: { label: 'Number',   Icon: Hash },
  select: { label: 'Dropdown', Icon: ListChecks },
  date:   { label: 'Date',     Icon: CalendarDays },
}

/** Read-only display of a custom field value (tables, cards). */
export function fieldText(f: FieldDef, v: string | number | undefined) {
  if (v === undefined || v === '') return ''
  if (f.kind === 'date') return formatDate(String(v))
  if (f.kind === 'number') return Number(v).toLocaleString()
  return String(v)
}

/** Editable value for one custom field on a work item. */
export function CustomFieldInput({ field, issue }: { field: FieldDef; issue: Issue }) {
  const { dispatch } = useStore()
  const value = issue.custom[field.id]
  const [draft, setDraft] = useState(value ?? '')
  const save = (v: string | number | undefined) => {
    const custom = { ...issue.custom }
    if (v === undefined || v === '') delete custom[field.id]; else custom[field.id] = v
    dispatch({ type: 'updateIssues', ids: [issue.id], patch: { custom } })
  }

  if (field.kind === 'select') {
    return (
      <Picker value={value as string | undefined} className="field-btn" title={field.name}
        options={[{ value: undefined as string | undefined, label: 'None' }, ...(field.options ?? []).map(o => ({ value: o as string | undefined, label: o }))]}
        onChange={save} trigger={value ? <>{value}</> : <span className="muted">None</span>} />
    )
  }
  return (
    <input className="field-input" aria-label={field.name} placeholder="None"
      type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
      value={draft} onChange={e => { setDraft(e.target.value); if (field.kind === 'date') save(e.target.value || undefined) }}
      onBlur={() => field.kind !== 'date' && draft !== (value ?? '') && save(field.kind === 'number' && draft !== '' ? Number(draft) : String(draft).trim() || undefined)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

/** Project Settings section: define custom fields. */
export function FieldsPanel({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [editing, setEditing] = useState<FieldDef | null>(null)
  const [deleting, setDeleting] = useState<FieldDef | null>(null)
  const setFields = (fields: FieldDef[]) => dispatch({ type: 'updateProject', id: project.id, patch: { fields } })
  const usage = (id: string) => state.issues.filter(i => i.projectId === project.id && i.custom[id] !== undefined).length

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Fields</h2>
          <p className="muted">Extra fields on every work item in {project.name}. They show in the details panel and can be added as list columns.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setEditing({ id: uid(), name: '', kind: 'text' })}><Plus size={14} />Add field</button>
      </div>
      {project.fields.length === 0 ? <p className="muted sm">No custom fields yet.</p> : (
        <div className="people">
          {project.fields.map(f => {
            const Icon = FIELD_KIND[f.kind].Icon
            return (
              <div key={f.id} className="person">
                <span className="rule-icon" style={{ width: 30, height: 30 }}><Icon size={15} /></span>
                <div className="person-text">
                  <span className="strong">{f.name}</span>
                  <span className="muted sm">{FIELD_KIND[f.kind].label}{f.kind === 'select' ? `: ${(f.options ?? []).join(', ')}` : ''} · set on {plural(usage(f.id), 'item')}</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(f)}>Edit</button>
                <button className="icon-btn" onClick={() => setDeleting(f)} aria-label={`Delete ${f.name}`} title="Delete"><Trash2 size={14} /></button>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <FieldDialog field={editing} isNew={!project.fields.some(f => f.id === editing.id)} onClose={() => setEditing(null)}
          onSave={f => {
            setFields(project.fields.some(x => x.id === f.id) ? project.fields.map(x => x.id === f.id ? f : x) : [...project.fields, f])
            toast(`Saved ${f.name}`); setEditing(null)
          }} />
      )}
      {deleting && (
        <Modal title={`Delete “${deleting.name}”?`} onClose={() => setDeleting(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => {
              const ids = state.issues.filter(i => i.projectId === project.id && i.custom[deleting.id] !== undefined)
              for (const i of ids) { const custom = { ...i.custom }; delete custom[deleting.id]; dispatch({ type: 'updateIssues', ids: [i.id], patch: { custom } }) }
              setFields(project.fields.filter(x => x.id !== deleting.id)); setDeleting(null)
            }}>Delete field</button>
          </>}>
          <p>The field and its values on {plural(usage(deleting.id), 'work item')} are removed.</p>
        </Modal>
      )}
    </section>
  )
}

function FieldDialog({ field, isNew, onClose, onSave }: { field: FieldDef; isNew: boolean; onClose: () => void; onSave: (f: FieldDef) => void }) {
  const [f, setF] = useState<FieldDef>(field)
  const [option, setOption] = useState('')
  const options = f.options ?? []
  const valid = f.name.trim() && (f.kind !== 'select' || options.length > 0)
  const addOption = () => {
    const o = option.trim()
    if (o && !options.includes(o)) setF({ ...f, options: [...options, o] })
    setOption('')
  }

  return (
    <Modal title={isNew ? 'Add field' : 'Edit field'} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...f, name: f.name.trim(), options: f.kind === 'select' ? options : undefined })}>Save field</button>
      </>}>
      <label className="label" htmlFor="fd-name">Name</label>
      <input id="fd-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Customer, Environment, Severity" autoFocus />
      <label className="label" style={{ marginTop: 14 }}>Type</label>
      <div className="segmented full" role="radiogroup" aria-label="Field type">
        {(Object.keys(FIELD_KIND) as FieldDef['kind'][]).map(k => (
          <button key={k} role="radio" aria-checked={f.kind === k} disabled={!isNew && f.kind !== k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{FIELD_KIND[k].label}</button>
        ))}
      </div>
      {!isNew && <p className="hint">The type can’t change after the field is created.</p>}
      {f.kind === 'select' && (
        <>
          <label className="label" htmlFor="fd-opt" style={{ marginTop: 14 }}>Options</label>
          <div className="option-chips">
            {options.map(o => (
              <span key={o} className="tag">{o}<button className="icon-btn sm" onClick={() => setF({ ...f, options: options.filter(x => x !== o) })} aria-label={`Remove ${o}`}><X size={11} /></button></span>
            ))}
          </div>
          <form className="form-row" onSubmit={e => { e.preventDefault(); addOption() }}>
            <input id="fd-opt" className="input" style={{ flex: 1 }} value={option} onChange={e => setOption(e.target.value)} placeholder="Add an option and press Enter" />
            <button className="btn btn-secondary" type="submit" disabled={!option.trim()}>Add</button>
          </form>
        </>
      )}
    </Modal>
  )
}
