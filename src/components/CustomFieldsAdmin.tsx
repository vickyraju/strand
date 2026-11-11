import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { ConfirmDialog, LoadError, Loading, Modal, plural } from './ui'
import { PageAction } from './admin/AdminShell'
import { FIELD_KIND } from './CustomFields'
import { FIELD_KINDS, KIND_LIST, hasOptions, isMulti, type FieldKind, type FieldValue } from '../../server/src/shared/customFields.ts'

// Administration › Custom fields (spec 0503), as Jira's: every field of the workspace and its contexts. A context says where
// the field applies (projects, or global) and for which work types, with its own options and default value.

interface Opt { id: string; name: string; disabled?: boolean; parentId?: string }
interface Context { id: string; name: string; description: string; projectKeys: string[] | null; typeKeys: string[] | null; options: Opt[] | null; defaultValue: FieldValue | null }
interface Field { id: string; name: string; kind: FieldKind; description: string; contexts: Context[]; items?: number }

const where = (c: Context) => `${c.projectKeys ? c.projectKeys.join(', ') : 'Global (all projects)'}${c.typeKeys ? ` · ${c.typeKeys.join(', ')}` : ''}`
const errorOf = (e: unknown) => (e instanceof ApiError ? Object.values(e.errors ?? {})[0] ?? e.message : errorMessage(e))

export default function CustomFieldsAdmin() {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Field[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = (cursor?: string) => api<{ items: Field[]; next: string | null }>('GET', `/api/admin/custom-fields?query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    .then(r => { setRows(cursor ? [...(rows ?? []), ...r.items] : r.items); setNext(r.next) }, e => setError(errorMessage(e)))
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t) }, [query])   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} />Create custom field</button></PageAction>
      <input className="input" style={{ maxWidth: 320, marginBottom: 12 }} placeholder="Search fields" aria-label="Search fields" value={query} onChange={e => setQuery(e.target.value)} />
      {!rows ? <Loading /> : !rows.length ? <p className="muted">No custom fields{query ? ' match' : ' yet'}.</p> : (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Contexts</th></tr></thead>
            <tbody>{rows.map(f => (
              <tr key={f.id} onClick={() => setOpen(f.id)}>
                <td className="strong">{f.name}{f.description && <div className="muted sm">{f.description}</div>}</td>
                <td className="sm">{FIELD_KIND[f.kind]?.label ?? f.kind}</td>
                <td className="sm">{f.contexts.map(c => <div key={c.id}>{where(c)}</div>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {next && <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => void load(next)}>Load more</button>}
      {creating && <CreateField onClose={() => setCreating(false)} onMade={id => { setCreating(false); void load(); setOpen(id) }} />}
      {open && <FieldPage id={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </section>
  )
}

/** The parts of a context people fill in, shared by Create custom field and the context editor. */
function ContextFields({ kind, c, set }: { kind: FieldKind; c: Draft; set: (c: Draft) => void }) {
  return <>
    <div className="settings-row" role="radiogroup" aria-label="Where it applies" style={{ marginTop: 10 }}>
      <label className="check-row"><input type="radio" checked={c.global} onChange={() => set({ ...c, global: true })} />Global: every project</label>
      <label className="check-row"><input type="radio" checked={!c.global} onChange={() => set({ ...c, global: false })} />These projects</label>
    </div>
    {!c.global && <input className="input" aria-label="Project keys" placeholder="Project keys, e.g. PAY, OPS" value={c.projects} onChange={e => set({ ...c, projects: e.target.value })} />}
    <label className="label" htmlFor="cx-types" style={{ marginTop: 10 }}>Work types</label>
    <input id="cx-types" className="input" placeholder="Every work type (or keys, e.g. bug, story)" value={c.types} onChange={e => set({ ...c, types: e.target.value })} />
    {hasOptions(kind) && <>
      <label className="label" htmlFor="cx-options" style={{ marginTop: 10 }}>Options</label>
      <textarea id="cx-options" className="input" rows={5} value={c.options} onChange={e => set({ ...c, options: e.target.value })}
        placeholder={kind === 'cascading' ? 'One per line; a child option under its parent: Europe > Germany' : 'One per line'} />
    </>}
    <label className="label" htmlFor="cx-default" style={{ marginTop: 10 }}>Default value</label>
    <input id="cx-default" className="input" value={c.defaultValue} onChange={e => set({ ...c, defaultValue: e.target.value })}
      placeholder={isMulti(kind) ? 'None (several: separate with commas)' : 'None'} />
  </>
}
interface Draft { name: string; global: boolean; projects: string; types: string; options: string; defaultValue: string }
const list = (s: string) => s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean)
/** The draft as the API takes it; option ids are kept for names that stay, so renames by id still carry. */
function toContext(kind: FieldKind, d: Draft, was?: Opt[] | null) {
  let options: Opt[] | null = null
  if (hasOptions(kind)) {
    options = []
    const keep = (name: string, parentId?: string) => was?.find(o => o.name === name && (o.parentId ?? undefined) === parentId)?.id ?? crypto.randomUUID()
    for (const line of d.options.split('\n').map(l => l.trim()).filter(Boolean)) {
      const [p, ch] = kind === 'cascading' ? line.split(/\s*>\s*/) : [line]
      let parent = options.find(o => o.name === p && !o.parentId)
      if (!parent) { parent = { id: keep(p!), name: p! }; options.push(parent) }
      if (ch && !options.some(o => o.name === ch && o.parentId === parent!.id)) options.push({ id: keep(ch, parent.id), name: ch, parentId: parent.id })
    }
  }
  const dv = d.defaultValue.trim()
  const defaultValue = !dv ? null : kind === 'number' ? Number(dv) : kind === 'cascading' ? dv.split(/\s*>\s*/) : isMulti(kind) ? dv.split(',').map(x => x.trim()).filter(Boolean) : dv
  return { name: d.name, projectKeys: d.global ? null : list(d.projects), typeKeys: d.types.trim() ? list(d.types) : null, options, defaultValue }
}
const fromContext = (c: Context): Draft => ({
  name: c.name, global: c.projectKeys === null, projects: (c.projectKeys ?? []).join(', '), types: (c.typeKeys ?? []).join(', '),
  options: (c.options ?? []).filter(o => !o.parentId).flatMap(o => [o.name, ...(c.options ?? []).filter(x => x.parentId === o.id).map(x => `${o.name} > ${x.name}`)]).join('\n'),
  defaultValue: Array.isArray(c.defaultValue) ? c.defaultValue.join(', ') : c.defaultValue == null ? '' : String(c.defaultValue),
})

function CreateField({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldKind>('select')
  const [description, setDescription] = useState('')
  const [c, setC] = useState<Draft>({ name: '', global: true, projects: '', types: '', options: '', defaultValue: '' })
  const [error, setError] = useState('')
  const save = () => api<Field>('POST', '/api/admin/custom-fields', { name, kind, description, context: toContext(kind, { ...c, name: `Default context for ${name}` }) })
    .then(f => onMade(f.id), e => setError(errorOf(e)))
  return (
    <Modal title="Create custom field" onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void save()}>Create</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="cf-name">Name</label>
      <input id="cf-name" className="input" value={name} autoFocus onChange={e => setName(e.target.value)} />
      <label className="label" htmlFor="cf-kind" style={{ marginTop: 10 }}>Type</label>
      <select id="cf-kind" className="input" value={kind} onChange={e => setKind(e.target.value as FieldKind)}>
        <optgroup label="Standard">{KIND_LIST.filter(k => !FIELD_KINDS[k].advanced).map(k => <option key={k} value={k}>{FIELD_KINDS[k].jira}</option>)}</optgroup>
        <optgroup label="Advanced">{KIND_LIST.filter(k => FIELD_KINDS[k].advanced).map(k => <option key={k} value={k}>{FIELD_KINDS[k].jira}</option>)}</optgroup>
      </select>
      <label className="label" htmlFor="cf-desc" style={{ marginTop: 10 }}>Description</label>
      <input id="cf-desc" className="input" value={description} onChange={e => setDescription(e.target.value)} />
      <h3 className="dir-section">Its first context</h3>
      <ContextFields kind={kind} c={c} set={setC} />
    </Modal>
  )
}

function FieldPage({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState<Field | null>(null)
  const [editing, setEditing] = useState<Context | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Context | 'field' | null>(null)
  const [error, setError] = useState('')
  const load = () => api<Field>('GET', `/api/admin/custom-fields/${id}`).then(setF, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg: string) => { toast(msg); void load(); onChanged() }
  return (
    <Modal title={f ? f.name : 'Custom field'} onClose={onClose} width={680} footer={<>
      <button className="btn btn-ghost text-danger" style={{ marginRight: 'auto' }} disabled={!f} onClick={() => setDeleting('field')}>Delete field</button>
      <button className="btn btn-secondary" onClick={onClose}>Close</button>
      <button className="btn btn-primary" disabled={!f} onClick={() => setEditing('new')}><Plus size={14} />Add context</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      {!f ? <Loading /> : <>
        <p className="muted" style={{ marginTop: 0 }}>{FIELD_KIND[f.kind]?.label} · {plural(f.items ?? 0, 'work item')} with a value{f.description ? ` · ${f.description}` : ''}</p>
        <div aria-label="Contexts">{f.contexts.map(c => (
          <div key={c.id} className="panel" style={{ padding: '8px 12px', marginBottom: 8 }}>
            <div className="cell-flex"><b>{c.name}</b><span style={{ flex: 1 }} />
              <button className="link sm" onClick={() => setEditing(c)}>Edit</button>
              <button className="link sm text-danger" onClick={() => setDeleting(c)}>Delete</button></div>
            <div className="sm">{where(c)}</div>
            {c.options && <div className="muted sm">Options: {c.options.filter(o => !o.parentId && !o.disabled).map(o => o.name).join(', ')}</div>}
            {c.defaultValue != null && <div className="muted sm">Default: {Array.isArray(c.defaultValue) ? c.defaultValue.join(', ') : String(c.defaultValue)}</div>}
          </div>
        ))}</div>
      </>}
      {f && editing && <ContextEditor field={f} context={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); done('Context saved') }} />}
      {f && deleting && <ConfirmDialog title={deleting === 'field' ? `Delete ${f.name}?` : `Delete the context ${deleting.name}?`} action="Delete" onClose={() => setDeleting(null)}
        onConfirm={() => (deleting === 'field'
          ? api('DELETE', `/api/admin/custom-fields/${f.id}`).then(() => { toast(`${f.name} deleted`); onChanged(); onClose() })
          : api('DELETE', `/api/admin/custom-fields/${f.id}/contexts/${deleting.id}`).then(() => { setDeleting(null); done('Context deleted') }))}>
        {deleting === 'field'
          ? <>Every value it has goes, on {plural(f.items ?? 0, 'work item')}. This can’t be undone.</>
          : <>The work items it covers lose their value, unless another context of the field covers them.</>}
      </ConfirmDialog>}
    </Modal>
  )
}

function ContextEditor({ field, context, onClose, onSaved }: { field: Field; context: Context | null; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState<Draft>(context ? fromContext(context) : { name: '', global: false, projects: '', types: '', options: '', defaultValue: '' })
  const [error, setError] = useState('')
  const save = () => {
    const body = toContext(field.kind, c, context?.options)
    ;(context ? api('PATCH', `/api/admin/custom-fields/${field.id}/contexts/${context.id}`, body) : api('POST', `/api/admin/custom-fields/${field.id}/contexts`, body))
      .then(onSaved, e => setError(errorOf(e)))
  }
  return (
    <Modal title={context ? `Edit ${context.name}` : 'Add context'} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!c.name.trim()} onClick={save}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="cx-name">Name</label>
      <input id="cx-name" className="input" value={c.name} autoFocus onChange={e => setC({ ...c, name: e.target.value })} />
      <ContextFields kind={field.kind} c={c} set={setC} />
      <p className="hint">A project is in one context of a field; its own context wins over the global one. Projects this context leaves lose their values.</p>
    </Modal>
  )
}
