import { useEffect, useState } from 'react'
import { Plus, Trash2, X, Type, Hash, ListChecks, CalendarDays, ArrowDown, ArrowUp, ArrowDownAZ, Clock, Link as LinkIcon, User, Users, UsersRound, FolderKanban, Tag, Tags,
  CheckSquare, CircleDot, ListTree, AlignLeft, Lock } from 'lucide-react'
import { useStore, uid, type FieldDef, type FieldOption, type FieldValue, type Issue, type Project } from '../data/store'
import { api, apiEnabled } from '../api/client'
import { searchProjects, type ProjectOption } from '../api/work'
import { useApp } from '../appContext'
import { ConfirmDialog, Modal, MultiSelect, Picker, plural, formatDate } from './ui'
import { UserPicker } from './UserPicker'
import { FIELD_KINDS, KIND_LIST, hasOptions, valueText } from '../../server/src/shared/customFields.ts'

export const FIELD_KIND: Record<FieldDef['kind'], { label: string; Icon: typeof Type }> = Object.fromEntries(KIND_LIST.map(k => [k, {
  label: FIELD_KINDS[k].jira,
  Icon: ({ number: Hash, date: CalendarDays, datetime: Clock, url: LinkIcon, user: User, users: Users, group: UsersRound, groups: UsersRound, project: FolderKanban,
    version: Tag, versions: Tag, labels: Tags, checkboxes: CheckSquare, radio: CircleDot, cascading: ListTree, multiselect: ListChecks, select: ListChecks,
    textarea: AlignLeft, readonly: Lock } as Partial<Record<FieldDef['kind'], typeof Type>>)[k] ?? Type,
}])) as Record<FieldDef['kind'], { label: string; Icon: typeof Type }>

// group names for showing group fields (the store has people, versions and projects already)
const groupNames = new Map<string, string>()
let groupsLoaded: Promise<void> | null = null
const loadGroups = () => (groupsLoaded ??= apiEnabled ? api<{ id: string; name: string }[]>('GET', '/api/groups/search').then(gs => { for (const g of gs) groupNames.set(g.id, g.name) }, () => {}) : Promise.resolve())

/** Read-only display of a custom field value (tables, cards), with names for the people, groups, projects and versions it names. */
export function fieldText(f: FieldDef, v: FieldValue | undefined, state?: { users: { id: string; name: string }[]; projects: { id: string; key: string; name: string; releases: { id: string; name: string }[] }[] }) {
  if (v === undefined || v === '') return ''
  if (f.kind === 'date') return formatDate(String(v))
  if (f.kind === 'datetime') return new Date(String(v)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return valueText(f.kind, v, id => state?.users.find(u => u.id === id)?.name ?? groupNames.get(id) ?? state?.projects.find(p => p.id === id)?.key
    ?? state?.projects.flatMap(p => p.releases).find(r => r.id === id)?.name)
}

/** Editable value for one custom field on a work item: each of Jira's types has its editor (spec 0502 R3). */
export function CustomFieldInput({ field, issue }: { field: FieldDef; issue: Issue }) {
  const { state, dispatch } = useStore()
  const value = issue.custom[field.id]
  const [draft, setDraft] = useState(Array.isArray(value) ? '' : value ?? '')
  const [, setTick] = useState(0)
  useEffect(() => { if (field.kind === 'group' || field.kind === 'groups') void loadGroups().then(() => setTick(t => t + 1)) }, [field.kind])
  const save = (v: FieldValue | undefined) => {
    const custom = { ...issue.custom }
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete custom[field.id]; else custom[field.id] = v
    dispatch({ type: 'updateIssues', ids: [issue.id], patch: { custom } })
  }
  const list = Array.isArray(value) ? value : []
  const live = (field.options ?? []).filter(o => !o.parentId && (!o.disabled || o.name === value || list.includes(o.name)))
  const project = state.projects.find(p => p.id === issue.projectId)

  switch (field.kind) {
    case 'readonly':
      return <span className="field-static" title="Set by scripts through the API">{value ? String(value) : <span className="muted">None</span>}</span>
    case 'select':
      return (
        <Picker value={value as string | undefined} className="field-btn" title={field.name}
          options={[{ value: undefined as string | undefined, label: 'None' },
            // a disabled option isn't offered; an item that has it keeps showing it (spec 0105 R4)
            ...live.map(o => ({ value: o.name as string | undefined, label: o.name }))]}
          onChange={save} trigger={value ? <>{value}</> : <span className="muted">None</span>} />
      )
    case 'radio':
      return (
        <span className="field-choices" role="radiogroup" aria-label={field.name}>
          {live.map(o => <label key={o.id} className="check-row"><input type="radio" name={`${issue.id}-${field.id}`} checked={value === o.name} onChange={() => save(o.name)} />{o.name}</label>)}
          {value !== undefined && <button className="link sm" onClick={() => save(undefined)}>Clear</button>}
        </span>
      )
    case 'checkboxes':
      return (
        <span className="field-choices" aria-label={field.name}>
          {live.map(o => <label key={o.id} className="check-row"><input type="checkbox" checked={list.includes(o.name)}
            onChange={e => save(e.target.checked ? [...list, o.name] : list.filter(x => x !== o.name))} />{o.name}</label>)}
        </span>
      )
    case 'multiselect':
      return <MultiSelect label={field.name} all={live.map(o => ({ key: o.name, name: o.name }))} value={list} onChange={save} />
    case 'cascading': {
      const parent = live.find(o => o.name === list[0])
      const children = parent ? (field.options ?? []).filter(o => o.parentId === parent.id && (!o.disabled || o.name === list[1])) : []
      return (
        <span className="field-choices">
          <select className="field-input" aria-label={field.name} value={list[0] ?? ''} onChange={e => save(e.target.value ? [e.target.value] : undefined)}>
            <option value="">None</option>
            {live.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
          </select>
          {parent && children.length > 0 && (
            <select className="field-input" aria-label={`${field.name}: ${parent.name}`} value={list[1] ?? ''} onChange={e => save(e.target.value ? [parent.name, e.target.value] : [parent.name])}>
              <option value="">None</option>
              {children.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
            </select>
          )}
        </span>
      )
    }
    case 'labels':
      return <input className="field-input" aria-label={field.name} placeholder="None" defaultValue={list.join(' ')} key={list.join(' ')}
        onBlur={e => { const next = [...new Set(e.target.value.split(/\s+/).filter(Boolean))]; if (next.join(' ') !== list.join(' ')) save(next) }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    case 'user':
      return <UserPicker value={value as string | undefined} onChange={id => save(id)} className="field-btn" title={field.name} placeholder="None"
        trigger={value ? <>{state.users.find(u => u.id === value)?.name ?? 'Someone'}</> : <span className="muted">None</span>} />
    case 'users':
      return (
        <span className="rule-chips">
          {list.map(id => <span key={id} className="chip-static">{state.users.find(u => u.id === id)?.name ?? 'Someone'}
            <button className="chip-x" aria-label={`Remove ${state.users.find(u => u.id === id)?.name ?? 'person'}`} onClick={() => save(list.filter(x => x !== id))}>×</button></span>)}
          <UserPicker value={undefined} onChange={id => id && !list.includes(id) && save([...list, id])} className="btn btn-ghost btn-sm" title={`Add to ${field.name}`} allowUnassigned={false} trigger={<>+ Add</>} />
        </span>
      )
    case 'group': case 'groups': {
      const all = [...groupNames].map(([key, name]) => ({ key, name }))
      if (field.kind === 'groups') return <MultiSelect label={field.name} all={all} value={list} onChange={save} />
      return (
        <select className="field-input" aria-label={field.name} value={String(value ?? '')} onChange={e => save(e.target.value || undefined)}>
          <option value="">None</option>{all.map(g => <option key={g.key} value={g.key}>{g.name}</option>)}
        </select>
      )
    }
    case 'project':
      return <ProjectField value={value as string | undefined} onChange={save} label={field.name} />
    case 'version': case 'versions': {
      const all = (project?.releases ?? []).filter(r => !r.archived || r.id === value || list.includes(r.id)).map(r => ({ key: r.id, name: r.name }))
      if (field.kind === 'versions') return <MultiSelect label={field.name} all={all} value={list} onChange={save} />
      return (
        <select className="field-input" aria-label={field.name} value={String(value ?? '')} onChange={e => save(e.target.value || undefined)}>
          <option value="">None</option>{all.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      )
    }
    case 'textarea':
      return <textarea className="field-input" aria-label={field.name} placeholder="None" rows={3} value={String(draft)}
        onChange={e => setDraft(e.target.value)} onBlur={() => draft !== (value ?? '') && save(String(draft).trim() || undefined)} />
  }
  const type = field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : field.kind === 'datetime' ? 'datetime-local' : field.kind === 'url' ? 'url' : 'text'
  const shown = field.kind === 'datetime' && draft ? toLocalInput(String(draft)) : draft
  return (
    <input className="field-input" aria-label={field.name} placeholder="None" type={type} maxLength={field.kind === 'text' ? 255 : undefined}
      value={shown} onChange={e => { setDraft(field.kind === 'datetime' && e.target.value ? new Date(e.target.value).toISOString() : e.target.value); if (field.kind === 'date' || field.kind === 'datetime') save(e.target.value ? (field.kind === 'datetime' ? new Date(e.target.value).toISOString() : e.target.value) : undefined) }}
      onBlur={() => field.kind !== 'date' && field.kind !== 'datetime' && draft !== (value ?? '') && save(field.kind === 'number' && draft !== '' ? Number(draft) : String(draft).trim() || undefined)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

/** 2026-11-11T09:30:00.000Z as the browser's datetime-local value, in local time. */
const toLocalInput = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }

/** A project picker that searches the server (there can be thousands of projects). */
function ProjectField({ value, onChange, label }: { value: string | undefined; onChange: (v: string | undefined) => void; label: string }) {
  const { state } = useStore()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<ProjectOption[]>([])
  useEffect(() => { if (!apiEnabled) return; const t = setTimeout(() => searchProjects(query).then(setFound, () => {}), 200); return () => clearTimeout(t) }, [query])
  const known = [...found, ...state.projects.map(p => ({ id: p.id, key: p.key, name: p.name, color: p.color }))]
  const current = known.find(p => p.id === value)
  const pick = (text: string) => { const p = known.find(x => `${x.name} (${x.key})` === text || x.key === text.toUpperCase()); if (p) onChange(p.id) }
  return (
    <span className="field-choices">
      <input className="field-input" aria-label={label} list={`pf-${label}`} placeholder={current ? `${current.name} (${current.key})` : 'None'} value={query}
        onChange={e => { setQuery(e.target.value); pick(e.target.value) }} />
      <datalist id={`pf-${label}`}>{found.map(p => <option key={p.id} value={`${p.name} (${p.key})`} />)}</datalist>
      {value && <button className="link sm" onClick={() => { onChange(undefined); setQuery('') }}>Clear</button>}
    </span>
  )
}

/** Project Settings section: define custom fields. */
export function FieldsPanel({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [editing, setEditing] = useState<FieldDef | null>(null)
  const [deleting, setDeleting] = useState<FieldDef | null>(null)
  const setFields = (fields: FieldDef[]) => dispatch({ type: 'updateProject', id: project.id, patch: { fields } })
  const usage = (id: string) => state.issues.filter(i => !i.archivedAt && i.projectId === project.id && i.custom[id] !== undefined).length

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Fields</h2>
          <p className="muted">Extra fields on work items in {project.name}. A field you add here is for this project alone; shared fields come from Administration › Custom fields.</p>
          <FieldScheme project={project} />
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
                  <span className="muted sm">{FIELD_KIND[f.kind].label}{hasOptions(f.kind) ? `: ${(f.options ?? []).filter(o => !o.disabled && !o.parentId).map(o => o.name).join(', ')}` : ''} · set on {plural(usage(f.id), 'item')}</span>
                </div>
                {f.shared
                  ? <span className="muted sm" title="Shared with other projects: a system administrator changes it in Administration › Custom fields">Shared</span>
                  : <>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(f)}>Edit</button>
                    <button className="icon-btn" onClick={() => setDeleting(f)} aria-label={`Delete ${f.name}`} title="Delete"><Trash2 size={14} /></button>
                  </>}
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
              for (const i of state.issues.filter(i => !i.archivedAt && i.projectId === project.id && typeof i.custom[f.id] === 'string')) {
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
              const ids = state.issues.filter(i => !i.archivedAt && i.projectId === project.id && i.custom[deleting.id] !== undefined)
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
    if (isNew || !hasOptions(field.kind)) return
    if (apiEnabled && project) api<{ options: Record<string, number> }>('GET', `/api/projects/${encodeURIComponent(project.key)}/fields/${field.id}/usage`).then(r => setCounts(r.options), () => setCounts({}))
    else setCounts(Object.fromEntries((field.options ?? []).map(o => [o.id, state.issues.filter(i => !i.archivedAt && i.projectId === project?.id && i.custom[field.id] === o.name).length])))
  }, [field.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const taken = (name: string, except?: string, parentId?: string) => options.some(o => o.id !== except && (o.parentId ?? undefined) === parentId && o.name.trim().toLowerCase() === name.trim().toLowerCase())
  const names = options.map(o => o.name.trim())
  const top = options.filter(o => !o.parentId)
  const unique = (list: FieldOption[]) => new Set(list.map(o => o.name.trim().toLowerCase())).size === list.length
  const valid = f.name.trim() && (!hasOptions(f.kind) || (top.length > 0 && names.every(n => n) && unique(top) && top.every(p => unique(options.filter(o => o.parentId === p.id)))))
  const [childOf, setChildOf] = useState<string | null>(null)
  const [child, setChild] = useState('')
  const set = (next: FieldOption[]) => setF({ ...f, options: next })
  const addOption = () => {
    const o = option.trim()
    if (o && !taken(o)) set([...options, { id: uid(), name: o }])   // a top-level option
    setOption('')
  }
  const move = (i: number, by: number) => { const next = [...options]; const [o] = next.splice(i, 1); next.splice(i + by, 0, o!); set(next) }
  const used = (o: FieldOption) => counts?.[o.id] ?? 0

  return (
    <Modal title={isNew ? 'Add field' : 'Edit field'} onClose={onClose} width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...f, name: f.name.trim(), options: hasOptions(f.kind) ? options.filter(o => f.kind === 'cascading' || !o.parentId).map(o => ({ ...o, name: o.name.trim() })) : undefined })}>Save field</button>
      </>}>
      <label className="label" htmlFor="fd-name">Name</label>
      <input id="fd-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Customer, Environment, Severity" autoFocus />
      <label className="label" style={{ marginTop: 14 }}>Type</label>
      <select className="input" aria-label="Field type" value={f.kind} disabled={!isNew} onChange={e => setF({ ...f, kind: e.target.value as FieldDef['kind'] })}>
        <optgroup label="Standard">{KIND_LIST.filter(k => !FIELD_KINDS[k].advanced).map(k => <option key={k} value={k}>{FIELD_KIND[k].label}</option>)}</optgroup>
        <optgroup label="Advanced">{KIND_LIST.filter(k => FIELD_KINDS[k].advanced).map(k => <option key={k} value={k}>{FIELD_KIND[k].label}</option>)}</optgroup>
      </select>
      {f.kind === 'readonly' && <p className="hint">People can’t edit it in Strand: scripts set it through the API, as in Jira.</p>}
      {!isNew && <p className="hint">The type can’t change once the field is made. Make a new field for another type.</p>}
      {hasOptions(f.kind) && (
        <>
          <div className="section-title-row" style={{ marginTop: 14 }}>
            <label className="label" htmlFor="fd-opt" style={{ margin: 0 }}>Options</label>
            {options.length > 1 && <button className="btn btn-ghost btn-sm" onClick={() => set([...options].sort((a, b) => a.name.localeCompare(b.name)))}><ArrowDownAZ size={14} />Sort A–Z</button>}
          </div>
          <ul className="option-list">
            {options.map((o, i) => o.parentId ? null : (
              <li key={o.id} className={o.disabled ? 'disabled' : ''}>
                <input className="input" value={o.name} maxLength={100} aria-label={`Option ${i + 1}`} aria-invalid={!o.name.trim() || taken(o.name, o.id)}
                  onChange={e => set(options.map(x => (x.id === o.id ? { ...x, name: e.target.value } : x)))} />
                {o.disabled && <span className="lozenge lozenge-todo" title="Not offered when choosing a value; items keep it">Disabled</span>}
                <button className="btn btn-ghost btn-sm" onClick={() => set(options.map(x => (x.id === o.id ? { ...x, disabled: !x.disabled } : x)))}>{o.disabled ? 'Enable' : 'Disable'}</button>
                <button className="icon-btn sm" disabled={i === 0} aria-label={`Move ${o.name} up`} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button className="icon-btn sm" disabled={i === options.length - 1} aria-label={`Move ${o.name} down`} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                <button className="icon-btn sm" aria-label={`Delete ${o.name}`} onClick={() => (used(o) ? setRemoving(o) : set(options.filter(x => x.id !== o.id && x.parentId !== o.id)))}><X size={13} /></button>
                {f.kind === 'cascading' && <div className="option-children">
                  {options.filter(c => c.parentId === o.id).map(c => (
                    <span key={c.id} className="chip-static">{c.name}<button className="chip-x" aria-label={`Delete ${c.name} under ${o.name}`} onClick={() => (used(c) ? setRemoving(c) : set(options.filter(x => x.id !== c.id)))}>×</button></span>
                  ))}
                  {childOf === o.id
                    ? <form className="form-row" onSubmit={e => { e.preventDefault(); if (child.trim() && !taken(child, undefined, o.id)) set([...options, { id: uid(), name: child.trim(), parentId: o.id }]); setChild('') }}>
                        <input className="input input-sm" autoFocus aria-label={`Add an option under ${o.name}`} value={child} onChange={e => setChild(e.target.value)} placeholder="Add and press Enter" />
                      </form>
                    : <button className="link sm" onClick={() => { setChildOf(o.id); setChild('') }}>+ Child option</button>}
                </div>}
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
          onConfirm={() => set(options.filter(x => x.id !== removing.id && x.parentId !== removing.id))}>
          <p>{plural(used(removing), 'work item')} {used(removing) === 1 ? 'has' : 'have'} {removing.name}. Deleting it clears their {f.name || 'field'} when you save. To keep it on them but stop offering it, disable it instead.</p>
        </ConfirmDialog>
      )}
    </Modal>
  )
}

/** Which field configuration scheme the project uses (spec 0504), and the hidden and required fields per work type;
 *  system administrators choose the scheme. */
function FieldScheme({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [schemes, setSchemes] = useState<{ id: string; name: string }[] | null>(null)
  const [screenSchemes, setScreenSchemes] = useState<{ id: string; name: string }[] | null>(null)
  const admin = state.isAdmin === true
  useEffect(() => {
    if (!apiEnabled || !admin) return
    api<{ id: string; name: string }[]>('GET', '/api/admin/field-config-schemes').then(setSchemes, () => {})
    api<{ id: string; name: string }[]>('GET', '/api/admin/issue-type-screen-schemes').then(setScreenSchemes, () => {})
  }, [admin])
  if (!apiEnabled) return null
  const choose = (patch: object) => api('PATCH', `/api/projects/${encodeURIComponent(project.key)}`, patch)
    .then(() => api<any>('GET', `/api/projects/${encodeURIComponent(project.key)}`)).then(p => {
      dispatch({ type: 'loadProject', project: { ...project, fieldRules: p.fieldRules, fieldConfigScheme: p.fieldConfigScheme, screens: p.screens, issueTypeScreenScheme: p.issueTypeScreenScheme }, sprints: state.sprints.filter(s => s.projectId === project.id) })
      toast('Scheme changed')
    }, () => toast('Couldn’t change the scheme', { tone: 'warn' }))
  const screenNote = Object.entries(project.screens ?? {}).filter(([, s]) => s.create || s.edit || s.view)
    .map(([t, s]) => `${t}: ${[s.create && 'create', s.edit && 'edit', s.view && 'view'].filter(Boolean).join(', ')} screens of their own`)
  const counts = Object.entries(project.fieldRules ?? {}).map(([t, r]) => [t, Object.values(r).filter(x => x.required && !x.hidden).length, Object.values(r).filter(x => x.hidden).length] as const).filter(([, a, b]) => a || b)
  return (
    <div className="sm" style={{ marginTop: 6 }}>
      Field configuration: {admin && schemes
        ? <select className="input input-sm" aria-label="Field configuration scheme" value={project.fieldConfigScheme?.id ?? ''} onChange={e => void choose({ fieldConfigSchemeId: e.target.value || null })}>
            <option value="">Default Field Configuration</option>{schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        : <b>{project.fieldConfigScheme?.name ?? 'Default Field Configuration'}</b>}
      {counts.map(([t, req, hid]) => <span key={t} className="muted"> · {t}: {req} required, {hid} hidden</span>)}
      <div style={{ marginTop: 4 }}>Screens: {admin && screenSchemes
        ? <select className="input input-sm" aria-label="Issue type screen scheme" value={project.issueTypeScreenScheme?.id ?? ''} onChange={e => void choose({ issueTypeScreenSchemeId: e.target.value || null })}>
            <option value="">Default Screen Scheme</option>{screenSchemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        : <b>{project.issueTypeScreenScheme?.name ?? 'Default Screen Scheme'}</b>}
        {screenNote.map(n => <span key={n} className="muted"> · {n}</span>)}</div>
    </div>
  )
}

