import { useEffect, useState } from 'react'
import { Plus, Trash2, X, Type, Hash, ListChecks, CalendarDays, ArrowDown, ArrowUp, ArrowDownAZ } from 'lucide-react'
import { useStore, uid, type FieldDef, type FieldOption, type Issue, type Project } from '../data/store'
import { api, apiEnabled } from '../api/client'
import { useApp } from '../appContext'
import { ConfirmDialog, Modal, Picker, plural, formatDate } from './ui'

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
        options={[{ value: undefined as string | undefined, label: 'None' },
          // a disabled option isn't offered; an item that has it keeps showing it (spec 0105 R4)
          ...(field.options ?? []).filter(o => !o.disabled || o.name === value).map(o => ({ value: o.name as string | undefined, label: o.name }))]}
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
                  <span className="muted sm">{FIELD_KIND[f.kind].label}{f.kind === 'select' ? `: ${(f.options ?? []).filter(o => !o.disabled).map(o => o.name).join(', ')}` : ''} · set on {plural(usage(f.id), 'item')}</span>
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
            // renamed and deleted options carry to the items that have them: the server does it (and the project is
            // reloaded); a local workspace does it here
            const before = project.fields.find(x => x.id === f.id)
            if (!apiEnabled && before?.options) {
              const next = new Map((f.options ?? []).map(o => [o.id, o.name]))
              for (const i of state.issues.filter(i => i.projectId === project.id && typeof i.custom[f.id] === 'string')) {
                const was = before.options.find(o => o.name === i.custom[f.id])
                if (!was || next.get(was.id) === was.name) continue
                const custom = { ...i.custom }
                const to = next.get(was.id)
                if (to === undefined) delete custom[f.id]; else custom[f.id] = to
                dispatch({ type: 'updateIssues', ids: [i.id], patch: { custom } })
              }
            }
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
  const { state } = useStore()
  const [f, setF] = useState<FieldDef>(field)
  const [option, setOption] = useState('')
  const [removing, setRemoving] = useState<FieldOption | null>(null)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const options = f.options ?? []
  const project = state.projects.find(p => p.fields.some(x => x.id === field.id))
  // how many items have each option, for the delete confirmation (spec 0105 R5)
  useEffect(() => {
    if (isNew || field.kind !== 'select') return
    if (apiEnabled && project) api<{ options: Record<string, number> }>('GET', `/api/projects/${encodeURIComponent(project.key)}/fields/${field.id}/usage`).then(r => setCounts(r.options), () => setCounts({}))
    else setCounts(Object.fromEntries((field.options ?? []).map(o => [o.id, state.issues.filter(i => i.projectId === project?.id && i.custom[field.id] === o.name).length])))
  }, [field.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const taken = (name: string, except?: string) => options.some(o => o.id !== except && o.name.trim().toLowerCase() === name.trim().toLowerCase())
  const names = options.map(o => o.name.trim())
  const valid = f.name.trim() && (f.kind !== 'select' || (options.length > 0 && names.every(n => n) && new Set(names.map(n => n.toLowerCase())).size === names.length))
  const set = (next: FieldOption[]) => setF({ ...f, options: next })
  const addOption = () => {
    const o = option.trim()
    if (o && !taken(o)) set([...options, { id: uid(), name: o }])
    setOption('')
  }
  const move = (i: number, by: number) => { const next = [...options]; const [o] = next.splice(i, 1); next.splice(i + by, 0, o!); set(next) }
  const used = (o: FieldOption) => counts?.[o.id] ?? 0

  return (
    <Modal title={isNew ? 'Add field' : 'Edit field'} onClose={onClose} width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...f, name: f.name.trim(), options: f.kind === 'select' ? options.map(o => ({ ...o, name: o.name.trim() })) : undefined })}>Save field</button>
      </>}>
      <label className="label" htmlFor="fd-name">Name</label>
      <input id="fd-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Customer, Environment, Severity" autoFocus />
      <label className="label" style={{ marginTop: 14 }}>Type</label>
      <div className="segmented full" role="radiogroup" aria-label="Field type">
        {(Object.keys(FIELD_KIND) as FieldDef['kind'][]).map(k => (
          <button key={k} role="radio" aria-checked={f.kind === k} disabled={!isNew && f.kind !== k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{FIELD_KIND[k].label}</button>
        ))}
      </div>
      {!isNew && <p className="hint">The type can’t change once the field is made. Make a new field for another type.</p>}
      {f.kind === 'select' && (
        <>
          <div className="section-title-row" style={{ marginTop: 14 }}>
            <label className="label" htmlFor="fd-opt" style={{ margin: 0 }}>Options</label>
            {options.length > 1 && <button className="btn btn-ghost btn-sm" onClick={() => set([...options].sort((a, b) => a.name.localeCompare(b.name)))}><ArrowDownAZ size={14} />Sort A–Z</button>}
          </div>
          <ul className="option-list">
            {options.map((o, i) => (
              <li key={o.id} className={o.disabled ? 'disabled' : ''}>
                <input className="input" value={o.name} maxLength={100} aria-label={`Option ${i + 1}`} aria-invalid={!o.name.trim() || taken(o.name, o.id)}
                  onChange={e => set(options.map(x => (x.id === o.id ? { ...x, name: e.target.value } : x)))} />
                {o.disabled && <span className="lozenge lozenge-todo" title="Not offered when choosing a value; items keep it">Disabled</span>}
                <button className="btn btn-ghost btn-sm" onClick={() => set(options.map(x => (x.id === o.id ? { ...x, disabled: !x.disabled } : x)))}>{o.disabled ? 'Enable' : 'Disable'}</button>
                <button className="icon-btn sm" disabled={i === 0} aria-label={`Move ${o.name} up`} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button className="icon-btn sm" disabled={i === options.length - 1} aria-label={`Move ${o.name} down`} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                <button className="icon-btn sm" aria-label={`Delete ${o.name}`} onClick={() => (used(o) ? setRemoving(o) : set(options.filter(x => x.id !== o.id)))}><X size={13} /></button>
              </li>
            ))}
          </ul>
          {options.some(o => !o.name.trim() || taken(o.name, o.id)) && <p className="hint error" role="alert">Each option needs a name, and names can’t repeat.</p>}
          <form className="form-row" onSubmit={e => { e.preventDefault(); addOption() }}>
            <input id="fd-opt" className="input" style={{ flex: 1 }} value={option} onChange={e => setOption(e.target.value)} placeholder="Add an option and press Enter" />
            <button className="btn btn-secondary" type="submit" disabled={!option.trim() || taken(option)}>Add</button>
          </form>
          <p className="hint">Renaming an option changes it on every work item that has it. A disabled option isn’t offered any more, but items keep it.</p>
        </>
      )}
      {removing && (
        <ConfirmDialog title={`Delete “${removing.name}”?`} action="Delete option" onClose={() => setRemoving(null)}
          onConfirm={() => set(options.filter(x => x.id !== removing.id))}>
          <p>{plural(used(removing), 'work item')} {used(removing) === 1 ? 'has' : 'have'} {removing.name}. Deleting it clears their {f.name || 'field'} when you save. To keep it on them but stop offering it, disable it instead.</p>
        </ConfirmDialog>
      )}
    </Modal>
  )
}
