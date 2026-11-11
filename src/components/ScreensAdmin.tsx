import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { ConfirmDialog, LoadError, Loading, Modal } from './ui'
import { PageAction } from './admin/AdminShell'
import { SYSTEM_FIELDS } from '../../server/src/shared/fieldRules.ts'

// Administration › Screens (spec 0505), as Jira's: screens (tabs and their fields), screen schemes (a screen for Create,
// Edit and View) and issue type screen schemes (a screen scheme per work type). The Default Screen shows every field until
// it is given tabs.

interface Tab { name: string; fields: string[] }
interface Screen { id: string; name: string; description: string; tabs: Tab[] | null; isDefault: boolean; schemes: string[] }
interface SScheme { id: string; name: string; description: string; defaultScreenId: string; createScreenId: string | null; editScreenId: string | null; viewScreenId: string | null; isDefault: boolean; usedBy: string[] }
interface Its { id: string; name: string; description: string; defaultSchemeId: string; mappings: Record<string, string>; projectKeys: string[]; projects: number }
const errorOf = (e: unknown) => (e instanceof ApiError ? Object.values(e.errors ?? {})[0] ?? e.message : errorMessage(e))
type Kind = 'screens' | 'screen-schemes' | 'issue-type-screen-schemes'

export default function ScreensAdmin() {
  const [screens, setScreens] = useState<Screen[] | null>(null)
  const [schemes, setSchemes] = useState<SScheme[] | null>(null)
  const [its, setIts] = useState<Its[] | null>(null)
  const [error, setError] = useState('')
  const [screen, setScreen] = useState<Screen | 'new' | null>(null)
  const [scheme, setScheme] = useState<SScheme | 'new' | null>(null)
  const [typeScheme, setTypeScheme] = useState<Its | 'new' | null>(null)
  const [deleting, setDeleting] = useState<{ kind: Kind; id: string; name: string } | null>(null)
  const { toast } = useApp()
  const load = () => Promise.all([
    api<Screen[]>('GET', '/api/admin/screens').then(setScreens), api<SScheme[]>('GET', '/api/admin/screen-schemes').then(setSchemes),
    api<Its[]>('GET', '/api/admin/issue-type-screen-schemes').then(setIts),
  ]).catch(e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!screens || !schemes || !its) return <Loading />
  const screenName = (id: string | null) => (id ? screens.find(s => s.id === id)?.name ?? 'A removed screen' : '—')
  const schemeName = (id: string) => schemes.find(s => s.id === id)?.name ?? 'A removed scheme'
  const saved = (what: string) => { toast(`${what} saved`); setScreen(null); setScheme(null); setTypeScheme(null); void load() }
  const del = (kind: Kind, id: string, name: string) => (e: React.MouseEvent) => { e.stopPropagation(); setDeleting({ kind, id, name }) }
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setScreen('new')}><Plus size={14} />Add screen</button></PageAction>
      <h2 className="panel-title">Screens</h2>
      <div className="card-table" style={{ marginInline: 0 }}>
        <table className="table" aria-label="Screens">
          <thead><tr><th>Name</th><th>Tabs</th><th>Used by</th><th /></tr></thead>
          <tbody>{screens.map(s => (
            <tr key={s.id} onClick={() => setScreen(s)}>
              <td className="strong">{s.name}{s.isDefault && <span className="lozenge lozenge-todo" style={{ marginLeft: 6 }}>Default</span>}</td>
              <td className="sm">{s.tabs ? s.tabs.map(t => `${t.name} (${t.fields.length})`).join(', ') : <span className="muted">Every field</span>}</td>
              <td className="sm">{s.schemes.join(', ') || <span className="muted">No scheme</span>}</td>
              <td>{!s.isDefault && !s.schemes.length && <button className="link sm text-danger" onClick={del('screens', s.id, s.name)}>Delete</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="cell-flex" style={{ marginTop: 20 }}><h2 className="panel-title" style={{ margin: 0 }}>Screen schemes</h2><span style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={() => setScheme('new')}><Plus size={14} />Add screen scheme</button></div>
      <div className="card-table" style={{ marginInline: 0, marginTop: 8 }}>
        <table className="table" aria-label="Screen schemes">
          <thead><tr><th>Name</th><th>Default</th><th>Create</th><th>Edit</th><th>View</th><th /></tr></thead>
          <tbody>{schemes.map(s => (
            <tr key={s.id} onClick={() => setScheme(s)}>
              <td className="strong">{s.name}</td><td className="sm">{screenName(s.defaultScreenId)}</td><td className="sm">{screenName(s.createScreenId)}</td>
              <td className="sm">{screenName(s.editScreenId)}</td><td className="sm">{screenName(s.viewScreenId)}</td>
              <td>{!s.isDefault && !s.usedBy.length && <button className="link sm text-danger" onClick={del('screen-schemes', s.id, s.name)}>Delete</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="cell-flex" style={{ marginTop: 20 }}><h2 className="panel-title" style={{ margin: 0 }}>Issue type screen schemes</h2><span style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={() => setTypeScheme('new')}><Plus size={14} />Add issue type screen scheme</button></div>
      {!its.length ? <p className="muted">None yet: every project uses the Default Screen Scheme.</p> : (
        <div className="card-table" style={{ marginInline: 0, marginTop: 8 }}>
          <table className="table" aria-label="Issue type screen schemes">
            <thead><tr><th>Name</th><th>Screen schemes</th><th>Projects</th><th /></tr></thead>
            <tbody>{its.map(s => (
              <tr key={s.id} onClick={() => setTypeScheme(s)}>
                <td className="strong">{s.name}</td>
                <td className="sm">Default: {schemeName(s.defaultSchemeId)}{Object.entries(s.mappings).map(([t, x]) => <div key={t}>{t}: {schemeName(x)}</div>)}</td>
                <td className="sm">{s.projects ? s.projectKeys.join(', ') : <span className="muted">None</span>}</td>
                <td><button className="link sm text-danger" onClick={del('issue-type-screen-schemes', s.id, s.name)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="hint">A project’s issue type screen scheme is chosen in its settings (Fields) by a system administrator.</p>
      {screen && <ScreenEditor screen={screen === 'new' ? null : screen} onClose={() => setScreen(null)} onSaved={() => saved('Screen')} />}
      {scheme && <SchemeEditor scheme={scheme === 'new' ? null : scheme} screens={screens} onClose={() => setScheme(null)} onSaved={() => saved('Screen scheme')} />}
      {typeScheme && <TypeSchemeEditor its={typeScheme === 'new' ? null : typeScheme} schemes={schemes} onClose={() => setTypeScheme(null)} onSaved={() => saved('Issue type screen scheme')} />}
      {deleting && <ConfirmDialog title={`Delete ${deleting.name}?`} action="Delete" onClose={() => setDeleting(null)}
        onConfirm={() => api('DELETE', `/api/admin/${deleting.kind}/${deleting.id}`).then(() => { setDeleting(null); void load() })}>
        {deleting.kind === 'issue-type-screen-schemes' ? 'Its projects go back to the Default Screen Scheme.' : 'Nothing uses it.'}
      </ConfirmDialog>}
    </section>
  )
}

/** Tabs and their fields, in order. */
function ScreenEditor({ screen, onClose, onSaved }: { screen: Screen | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(screen?.name ?? '')
  const [tabs, setTabs] = useState<Tab[] | null>(screen ? screen.tabs : [{ name: 'Field tab', fields: [] }])
  const [custom, setCustom] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => { api<{ items: { id: string; name: string }[] }>('GET', '/api/admin/custom-fields?limit=200').then(r => setCustom(r.items), () => {}) }, [])
  const all = [...Object.entries(SYSTEM_FIELDS).map(([k, n]) => ({ key: k, name: n })), ...custom.map(f => ({ key: `custom.${f.id}`, name: f.name }))]
  const nameOf = (k: string) => all.find(f => f.key === k)?.name ?? 'A removed field'
  const used = new Set((tabs ?? []).flatMap(t => t.fields))
  const setTab = (i: number, t: Tab) => setTabs((tabs ?? []).map((x, k) => (k === i ? t : x)))
  const move = (list: string[], i: number, by: number) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n }
  const save = () => (screen ? api('PATCH', `/api/admin/screens/${screen.id}`, { name, tabs }) : api('POST', '/api/admin/screens', { name, tabs })).then(onSaved, e => setError(errorOf(e)))
  return (
    <Modal title={screen ? screen.name : 'Add screen'} onClose={onClose} width={640} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || (tabs !== null && !tabs.length)} onClick={() => void save()}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="sc-name">Name</label>
      <input id="sc-name" className="input" value={name} onChange={e => setName(e.target.value)} disabled={screen?.isDefault} />
      <p className="hint">Summary and the work type are always on a screen.</p>
      {tabs === null ? <>
        <p>This screen shows <b>every field</b>, including fields added later.</p>
        <button className="btn btn-secondary btn-sm" onClick={() => setTabs([{ name: 'Field tab', fields: Object.keys(SYSTEM_FIELDS) }])}>List its fields instead</button>
      </> : <>
        {tabs.map((t, i) => (
          <div key={i} className="panel" style={{ padding: '8px 12px', marginTop: 10 }}>
            <div className="cell-flex">
              <input className="input input-sm" aria-label={`Tab ${i + 1} name`} value={t.name} onChange={e => setTab(i, { ...t, name: e.target.value })} />
              <span style={{ flex: 1 }} />
              {tabs.length > 1 && <button className="link sm text-danger" onClick={() => setTabs(tabs.filter((_, k) => k !== i))}>Remove tab</button>}
            </div>
            <ul className="option-list">{t.fields.map((f, n) => (
              <li key={f}>{nameOf(f)}<span style={{ flex: 1 }} />
                <button className="icon-btn sm" disabled={n === 0} aria-label={`Move ${nameOf(f)} up`} onClick={() => setTab(i, { ...t, fields: move(t.fields, n, -1) })}><ArrowUp size={13} /></button>
                <button className="icon-btn sm" disabled={n === t.fields.length - 1} aria-label={`Move ${nameOf(f)} down`} onClick={() => setTab(i, { ...t, fields: move(t.fields, n, 1) })}><ArrowDown size={13} /></button>
                <button className="icon-btn sm" aria-label={`Remove ${nameOf(f)}`} onClick={() => setTab(i, { ...t, fields: t.fields.filter(x => x !== f) })}><X size={13} /></button>
              </li>
            ))}</ul>
            <select className="input input-sm" aria-label={`Add a field to ${t.name}`} value="" onChange={e => e.target.value && setTab(i, { ...t, fields: [...t.fields, e.target.value] })}>
              <option value="">+ Add a field</option>{all.filter(f => !used.has(f.key)).map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
            </select>
          </div>
        ))}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setTabs([...tabs, { name: `Tab ${tabs.length + 1}`, fields: [] }])}><Plus size={14} />Add tab</button>
          {screen?.isDefault && <button className="btn btn-ghost btn-sm" onClick={() => setTabs(null)}>Show every field again</button>}
        </div>
      </>}
    </Modal>
  )
}

function SchemeEditor({ scheme, screens, onClose, onSaved }: { scheme: SScheme | null; screens: Screen[]; onClose: () => void; onSaved: () => void }) {
  const def = screens.find(s => s.isDefault)!
  const [s, setS] = useState({ name: scheme?.name ?? '', defaultScreenId: scheme?.defaultScreenId ?? def.id, createScreenId: scheme?.createScreenId ?? null, editScreenId: scheme?.editScreenId ?? null, viewScreenId: scheme?.viewScreenId ?? null })
  const [error, setError] = useState('')
  const pick = (k: 'defaultScreenId' | 'createScreenId' | 'editScreenId' | 'viewScreenId', label: string, optional: boolean) => (
    <label className="label" style={{ marginTop: 10 }}>{label}
      <select className="input" aria-label={label} value={s[k] ?? ''} onChange={e => setS({ ...s, [k]: e.target.value || null })}>
        {optional && <option value="">The default screen</option>}
        {screens.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </label>
  )
  const save = () => (scheme ? api('PATCH', `/api/admin/screen-schemes/${scheme.id}`, s) : api('POST', '/api/admin/screen-schemes', s)).then(onSaved, e => setError(errorOf(e)))
  return (
    <Modal title={scheme ? scheme.name : 'Add screen scheme'} onClose={onClose} width={520} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!s.name.trim()} onClick={() => void save()}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="ss-name">Name</label>
      <input id="ss-name" className="input" value={s.name} onChange={e => setS({ ...s, name: e.target.value })} disabled={scheme?.isDefault} />
      {pick('defaultScreenId', 'Default screen', false)}{pick('createScreenId', 'Create issue', true)}{pick('editScreenId', 'Edit issue', true)}{pick('viewScreenId', 'View issue', true)}
    </Modal>
  )
}

function TypeSchemeEditor({ its, schemes, onClose, onSaved }: { its: Its | null; schemes: SScheme[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(its?.name ?? '')
  const [defaultSchemeId, setDefault] = useState(its?.defaultSchemeId ?? schemes.find(s => s.isDefault)?.id ?? '')
  const [rows, setRows] = useState<[string, string][]>(Object.entries(its?.mappings ?? {}))
  const [error, setError] = useState('')
  const save = () => {
    const body = { name, defaultSchemeId, mappings: Object.fromEntries(rows.filter(([t, c]) => t.trim() && c).map(([t, c]) => [t.trim().toLowerCase(), c])) }
    ;(its ? api('PATCH', `/api/admin/issue-type-screen-schemes/${its.id}`, body) : api('POST', '/api/admin/issue-type-screen-schemes', body)).then(onSaved, e => setError(errorOf(e)))
  }
  const select = (value: string, onChange: (v: string) => void, label: string) =>
    <select className="input" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{schemes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
  return (
    <Modal title={its ? its.name : 'Add issue type screen scheme'} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || !defaultSchemeId} onClick={save}>Save</button>
    </>}>
      {error && <p className="hint error" role="alert">{error}</p>}
      <label className="label" htmlFor="its-name">Name</label>
      <input id="its-name" className="input" value={name} onChange={e => setName(e.target.value)} />
      <label className="label" style={{ marginTop: 10 }}>Default (every other work type)</label>
      {select(defaultSchemeId, setDefault, 'Default screen scheme')}
      <label className="label" style={{ marginTop: 10 }}>Work types with their own</label>
      {rows.map(([t, c], i) => (
        <div key={i} className="form-row" style={{ marginBottom: 6 }}>
          <input className="input" style={{ width: 160 }} aria-label="Work type key" placeholder="e.g. bug" value={t} onChange={e => setRows(rows.map((r, k) => (k === i ? [e.target.value, r[1]] : r)))} />
          {select(c, v => setRows(rows.map((r, k) => (k === i ? [r[0], v] : r))), `Screen scheme for ${t || 'this type'}`)}
          <button className="link sm" onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, ['', schemes[0]?.id ?? '']])}><Plus size={14} />Add a work type</button>
    </Modal>
  )
}
