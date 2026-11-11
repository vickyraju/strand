import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { ConfirmDialog, LoadError, Loading, Modal } from './ui'
import { PageAction } from './admin/AdminShell'
import { SYSTEM_FIELDS, type FieldRules } from '../../server/src/shared/fieldRules.ts'

// Administration › Field configurations (spec 0504), as Jira's: configurations say, per field, its description and whether
// it is hidden or required; schemes give each work type a configuration; a project uses one scheme.

interface Config { id: string; name: string; description: string; items: FieldRules; isDefault: boolean; schemes: string[] }
interface Scheme { id: string; name: string; description: string; defaultConfigId: string; mappings: Record<string, string>; projectKeys: string[]; projects: number }
const errorOf = (e: unknown) => (e instanceof ApiError ? Object.values(e.errors ?? {})[0] ?? e.message : errorMessage(e))

export default function FieldConfigsAdmin() {
  const [configs, setConfigs] = useState<Config[] | null>(null)
  const [schemes, setSchemes] = useState<Scheme[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Config | 'new' | null>(null)
  const [scheme, setScheme] = useState<Scheme | 'new' | null>(null)
  const [deleting, setDeleting] = useState<{ kind: 'config' | 'scheme'; id: string; name: string } | null>(null)
  const { toast } = useApp()
  const load = () => Promise.all([api<Config[]>('GET', '/api/admin/field-configurations').then(setConfigs), api<Scheme[]>('GET', '/api/admin/field-config-schemes').then(setSchemes)]).catch(e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!configs || !schemes) return <Loading />
  const nameOf = (id: string) => configs.find(c => c.id === id)?.name ?? 'A removed configuration'
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} />Add field configuration</button></PageAction>
      <h2 className="panel-title">Field configurations</h2>
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table" aria-label="Field configurations">
          <thead><tr><th>Name</th><th>Hidden</th><th>Required</th><th>Used by</th><th /></tr></thead>
          <tbody>{configs.map(c => {
            const vals = Object.values(c.items)
            return (
              <tr key={c.id} onClick={() => setEditing(c)}>
                <td className="strong">{c.name}{c.isDefault && <span className="lozenge lozenge-todo" style={{ marginLeft: 6 }}>Default</span>}{c.description && <div className="muted sm">{c.description}</div>}</td>
                <td className="sm">{vals.filter(r => r.hidden).length}</td><td className="sm">{vals.filter(r => r.required).length}</td>
                <td className="sm">{c.isDefault ? 'Projects without a scheme' : c.schemes.join(', ') || <span className="muted">No scheme</span>}</td>
                <td>{!c.isDefault && !c.schemes.length && <button className="link sm text-danger" onClick={e => { e.stopPropagation(); setDeleting({ kind: 'config', id: c.id, name: c.name }) }}>Delete</button>}</td>
              </tr>
            )
          })}</tbody>
        </table>
      </div>
      <div className="cell-flex" style={{ marginTop: 20 }}>
        <h2 className="panel-title" style={{ margin: 0 }}>Field configuration schemes</h2><span style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={() => setScheme('new')}><Plus size={14} />Add scheme</button>
      </div>
      {!schemes.length ? <p className="muted">No schemes yet: every project uses the Default Field Configuration.</p> : (
        <div className="card-table" style={{ marginInline: 0, marginTop: 8 }}>
          <table className="table" aria-label="Field configuration schemes">
            <thead><tr><th>Name</th><th>Configurations</th><th>Projects</th><th /></tr></thead>
            <tbody>{schemes.map(s => (
              <tr key={s.id} onClick={() => setScheme(s)}>
                <td className="strong">{s.name}</td>
                <td className="sm">Default: {nameOf(s.defaultConfigId)}{Object.entries(s.mappings).map(([t, c]) => <div key={t}>{t}: {nameOf(c)}</div>)}</td>
                <td className="sm">{s.projects ? s.projectKeys.join(', ') + (s.projects > s.projectKeys.length ? '…' : '') : <span className="muted">None</span>}</td>
                <td><button className="link sm text-danger" onClick={e => { e.stopPropagation(); setDeleting({ kind: 'scheme', id: s.id, name: s.name }) }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="hint">A project’s scheme is chosen in its settings (Fields) by a system administrator.</p>
      {editing && <ConfigEditor config={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast('Field configuration saved'); void load() }} />}
      {scheme && <SchemeEditor scheme={scheme === 'new' ? null : scheme} configs={configs} onClose={() => setScheme(null)} onSaved={() => { setScheme(null); toast('Scheme saved'); void load() }} />}
      {deleting && <ConfirmDialog title={`Delete ${deleting.name}?`} action="Delete" onClose={() => setDeleting(null)}
        onConfirm={() => api('DELETE', `/api/admin/${deleting.kind === 'config' ? 'field-configurations' : 'field-config-schemes'}/${deleting.id}`).then(() => { setDeleting(null); void load() })}>
        {deleting.kind === 'scheme' ? 'Its projects go back to the Default Field Configuration.' : 'No scheme uses it.'}
      </ConfirmDialog>}
    </section>
  )
}

/** The field table: every system field Strand has and every custom field, each with its description, Hidden and Required. */
function ConfigEditor({ config, onClose, onSaved }: { config: Config | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(config?.name ?? '')
  const [description, setDescription] = useState(config?.description ?? '')
  const [items, setItems] = useState<FieldRules>(config?.items ?? {})
  const [custom, setCustom] = useState<{ id: string; name: string }[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const t = setTimeout(() => api<{ items: { id: string; name: string }[] }>('GET', `/api/admin/custom-fields?limit=200&query=${encodeURIComponent(query)}`).then(r => setCustom(r.items), () => {}), 200)
    return () => clearTimeout(t)
  }, [query])
  const rows = [...Object.entries(SYSTEM_FIELDS).filter(([, n]) => n.toLowerCase().includes(query.toLowerCase())).map(([k, n]) => ({ key: k, name: n })),
    ...custom.map(f => ({ key: `custom.${f.id}`, name: f.name }))]
  const set = (k: string, patch: Partial<FieldRules[string]>) => setItems(i => {
    const next = { ...i[k], ...patch }
    if (patch.hidden) next.required = false             // a hidden field can't be required (Jira's rule)
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== false && v !== '' && v !== undefined))
    const out = { ...i }; if (Object.keys(clean).length) out[k] = clean; else delete out[k]
    return out
  })
  const save = () => (config ? api('PATCH', `/api/admin/field-configurations/${config.id}`, { name, description, items }) : api('POST', '/api/admin/field-configurations', { name, description, items }))
    .then(onSaved, e => setError(errorOf(e)))
  return (
    <Modal title={config ? config.name : 'Add field configuration'} onClose={onClose} width={760} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void save()}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <div className="form-row" style={{ gap: 10 }}>
        <label className="label" style={{ flex: 1 }}>Name<input className="input" value={name} onChange={e => setName(e.target.value)} disabled={config?.isDefault} /></label>
        <label className="label" style={{ flex: 2 }}>Description<input className="input" value={description} onChange={e => setDescription(e.target.value)} /></label>
      </div>
      <input className="input" style={{ margin: '10px 0' }} placeholder="Find a field" aria-label="Find a field" value={query} onChange={e => setQuery(e.target.value)} />
      <p className="hint" style={{ marginTop: 0 }}>Summary and the work type are always shown and required.</p>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="table" aria-label="Fields">
          <thead><tr><th>Field</th><th>Hidden</th><th>Required</th><th>Description</th></tr></thead>
          <tbody>{rows.map(r => {
            const it = items[r.key] ?? {}
            return (
              <tr key={r.key} style={{ cursor: 'default' }}>
                <td className="sm">{r.name}</td>
                <td><input type="checkbox" aria-label={`Hide ${r.name}`} checked={!!it.hidden} onChange={e => set(r.key, { hidden: e.target.checked })} /></td>
                <td><input type="checkbox" aria-label={`Require ${r.name}`} checked={!!it.required} disabled={!!it.hidden} onChange={e => set(r.key, { required: e.target.checked })} /></td>
                <td><input className="input input-sm" aria-label={`Describe ${r.name}`} value={it.description ?? ''} onChange={e => set(r.key, { description: e.target.value })} /></td>
              </tr>
            )
          })}</tbody>
        </table>
      </div>
    </Modal>
  )
}

function SchemeEditor({ scheme, configs, onClose, onSaved }: { scheme: Scheme | null; configs: Config[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scheme?.name ?? '')
  const [defaultConfigId, setDefault] = useState(scheme?.defaultConfigId ?? configs.find(c => c.isDefault)?.id ?? '')
  const [rows, setRows] = useState<[string, string][]>(Object.entries(scheme?.mappings ?? {}))
  const [error, setError] = useState('')
  const save = () => {
    const body = { name, defaultConfigId, mappings: Object.fromEntries(rows.filter(([t, c]) => t.trim() && c).map(([t, c]) => [t.trim().toLowerCase(), c])) }
    ;(scheme ? api('PATCH', `/api/admin/field-config-schemes/${scheme.id}`, body) : api('POST', '/api/admin/field-config-schemes', body)).then(onSaved, e => setError(errorOf(e)))
  }
  const select = (value: string, onChange: (v: string) => void, label: string) =>
    <select className="input" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
  return (
    <Modal title={scheme ? scheme.name : 'Add scheme'} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || !defaultConfigId} onClick={save}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="fcs-name">Name</label>
      <input id="fcs-name" className="input" value={name} onChange={e => setName(e.target.value)} />
      <label className="label" style={{ marginTop: 10 }}>Default (every other work type)</label>
      {select(defaultConfigId, setDefault, 'Default configuration')}
      <label className="label" style={{ marginTop: 10 }}>Work types with their own</label>
      {rows.map(([t, c], i) => (
        <div key={i} className="form-row" style={{ marginBottom: 6 }}>
          <input className="input" style={{ width: 160 }} aria-label="Work type key" placeholder="e.g. bug" value={t} onChange={e => setRows(rows.map((r, k) => (k === i ? [e.target.value, r[1]] : r)))} />
          {select(c, v => setRows(rows.map((r, k) => (k === i ? [r[0], v] : r))), `Configuration for ${t || 'this type'}`)}
          <button className="link sm" onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, ['', configs[0]?.id ?? '']])}><Plus size={14} />Add a work type</button>
    </Modal>
  )
}
