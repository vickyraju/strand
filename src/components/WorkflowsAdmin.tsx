import { useEffect, useState } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { useApp } from '../appContext'
import { BUILTIN_TYPES, type Category } from '../data/store'
import { href, navigate } from '../router'
import { Modal, plural } from './ui'
import { impactLine, type Impact } from './workflow/Versions'

// Administration › Workflows (Jira's workflows, statuses and workflow schemes), for system administrators. A change to
// a workflow or a scheme applies to every project using it; a project only chooses its scheme.

interface Wf { id: string; name: string; description: string; version: number; statuses: number; transitions: number; schemes: number; projects: number }
interface St { id: string; name: string; description: string; color: string; category: Category; workflows: string[] }
interface Scheme { id: string; name: string; description: string; defaultWorkflowId: string; defaultWorkflow: string; mappings: Record<string, string>; projects: number }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
const CATS: { id: Category; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'in-progress', label: 'In progress' }, { id: 'done', label: 'Done' }]
/** The work types every project has (a project's own types use the default workflow). */
const TYPES = [...BUILTIN_TYPES.map(t => ({ key: t.key, name: t.name })), { key: 'test', name: 'Test' }, { key: 'precondition', name: 'Pre-Condition' },
  { key: 'test_set', name: 'Test Set' }, { key: 'test_plan', name: 'Test Plan' }, { key: 'test_execution', name: 'Test Execution' }]

export default function WorkflowsAdmin() {
  const [tab, setTab] = useState<'workflows' | 'statuses' | 'schemes'>('workflows')
  return (
    <section>
      <p className="muted">Workflows are shared: a workflow scheme says which workflow each work type uses, and each project uses one scheme. Changing a workflow or a scheme changes every project using it. Project admins choose their project’s scheme; they don’t edit workflows.</p>
      <div className="segmented" role="tablist" aria-label="Workflows" style={{ margin: '12px 0' }}>
        {(['workflows', 'statuses', 'schemes'] as const).map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'workflows' ? 'Workflows' : t === 'statuses' ? 'Statuses' : 'Schemes'}</button>
        ))}
      </div>
      {tab === 'workflows' && <Workflows />}
      {tab === 'statuses' && <Statuses />}
      {tab === 'schemes' && <Schemes />}
    </section>
  )
}

function useList<T>(path: string) {
  const [rows, setRows] = useState<T[] | null>(null)
  const [error, setError] = useState('')
  const load = () => api<T[]>('GET', path).then(setRows, e => setError(message(e)))
  useEffect(() => { void load() }, [path])   // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, error, load }
}

function Workflows() {
  const { toast } = useApp()
  const { rows, error, load } = useList<Wf>('/api/workflows')
  const [adding, setAdding] = useState<{ copyFrom?: Wf } | null>(null)
  const open = (id: string) => navigate(href({ name: 'admin', section: 'workflows', item: id }))
  const remove = (w: Wf) => window.confirm(`Remove the workflow “${w.name}”?`) &&
    api('DELETE', `/api/admin/workflows/${w.id}`).then(() => { toast(`${w.name} removed`); void load() }, e => toast(message(e), { tone: 'warn' }))
  if (error) return <p className="hint error" role="alert">{error}</p>
  if (!rows) return <p className="muted" role="status">Loading…</p>
  return <>
    <div className="card-table" style={{ marginInline: 0 }}>
      <table className="table">
        <thead><tr><th>Workflow</th><th className="col-num">Statuses</th><th className="col-num">Transitions</th><th className="col-num">Schemes</th><th className="col-num">Projects</th><th className="col-num">Version</th><th /></tr></thead>
        <tbody>{rows.map(w => (
          <tr key={w.id} tabIndex={0} onClick={() => open(w.id)} onKeyDown={e => e.key === 'Enter' && open(w.id)}>
            <td><b>{w.name}</b>{w.description && <div className="muted sm">{w.description}</div>}</td>
            <td className="col-num">{w.statuses}</td><td className="col-num">{w.transitions}</td><td className="col-num">{w.schemes}</td><td className="col-num">{w.projects}</td><td className="col-num">{w.version}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
              <button className="icon-btn sm" aria-label={`Edit ${w.name}`} title="Edit" onClick={() => open(w.id)}><Pencil size={14} /></button>
              <button className="icon-btn sm" aria-label={`Copy ${w.name}`} title="Copy" onClick={() => setAdding({ copyFrom: w })}><Copy size={14} /></button>
              {!w.schemes && <button className="icon-btn sm" aria-label={`Remove ${w.name}`} title="Remove" onClick={() => remove(w)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setAdding({})}><Plus size={14} />Add workflow</button>
    {adding && <NameDialog title={adding.copyFrom ? `Copy ${adding.copyFrom.name}` : 'Add workflow'} initial={adding.copyFrom ? `${adding.copyFrom.name} (copy)` : ''}
      hint={adding.copyFrom ? undefined : 'It starts with a To do and a Done status; add the rest in the editor.'} onClose={() => setAdding(null)}
      onSave={name => api<{ id: string }>('POST', '/api/admin/workflows', { name, ...(adding.copyFrom ? { copyFrom: adding.copyFrom.id } : {}) }).then(w => open(w.id))} />}
  </>
}

function NameDialog({ title, initial, hint, onSave, onClose }: { title: string; initial: string; hint?: string; onSave: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState('')
  const save = () => name.trim() && onSave(name.trim()).catch(e => setError(message(e)))
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void save()}>Save</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        <label className="label" htmlFor="wfa-name">Name</label>
        <input id="wfa-name" className="input" value={name} autoFocus maxLength={60} onChange={e => setName(e.target.value)} />
        {hint && <p className="hint">{hint}</p>}
        {error && <p className="hint error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

function Statuses() {
  const { toast } = useApp()
  const { rows, error, load } = useList<St>('/api/admin/statuses')
  const [editing, setEditing] = useState<Partial<St> | null>(null)
  const remove = (s: St) => api('DELETE', `/api/admin/statuses/${s.id}`).then(() => { toast(`${s.name} removed`); void load() }, e => toast(message(e), { tone: 'warn' }))
  if (error) return <p className="hint error" role="alert">{error}</p>
  if (!rows) return <p className="muted" role="status">Loading…</p>
  return <>
    <p className="muted sm">Statuses are shared by every workflow. A new name, colour or category shows in every workflow and project that has the status.</p>
    <div className="card-table" style={{ marginInline: 0, marginTop: 8 }}>
      <table className="table">
        <thead><tr><th>Status</th><th>Category</th><th>Used in</th><th /></tr></thead>
        <tbody>{rows.map(s => (
          <tr key={s.id} style={{ cursor: 'default' }}>
            <td><span className="status-dot" style={{ background: s.color }} /> <b>{s.name}</b>{s.description && <div className="muted sm">{s.description}</div>}</td>
            <td><span className={`lozenge lozenge-${s.category}`}>{CATS.find(c => c.id === s.category)!.label}</span></td>
            <td className="muted sm">{s.workflows.join(', ') || 'No workflow'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="icon-btn sm" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}><Pencil size={14} /></button>
              {!s.workflows.length && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => remove(s)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setEditing({ category: 'in-progress', color: '#3b82f6' })}><Plus size={14} />Add status</button>
    {editing && <StatusDialog status={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); void sprintDeps.reloadAll() }} />}
  </>
}

function StatusDialog({ status, onSaved, onClose }: { status: Partial<St>; onSaved: () => void; onClose: () => void }) {
  const [s, setS] = useState(status)
  const [error, setError] = useState('')
  const save = () => api(status.id ? 'PATCH' : 'POST', status.id ? `/api/admin/statuses/${status.id}` : '/api/admin/statuses',
    { name: s.name?.trim(), description: s.description ?? '', color: s.color, category: s.category }).then(onSaved, e => setError(message(e)))
  return (
    <Modal title={status.id ? `Edit ${status.name}` : 'Add status'} onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!s.name?.trim()} onClick={() => void save()}>Save</button>
    </>}>
      <label className="label" htmlFor="wst-name">Name</label>
      <input id="wst-name" className="input" value={s.name ?? ''} autoFocus maxLength={60} onChange={e => setS({ ...s, name: e.target.value })} />
      <label className="label" htmlFor="wst-desc" style={{ marginTop: 12 }}>Description</label>
      <textarea id="wst-desc" className="input" rows={2} maxLength={500} value={s.description ?? ''} onChange={e => setS({ ...s, description: e.target.value })} />
      <label className="label" style={{ marginTop: 12 }}>Category</label>
      <div className="segmented full" role="radiogroup" aria-label="Category">
        {CATS.map(c => <button type="button" key={c.id} role="radio" aria-checked={s.category === c.id} className={s.category === c.id ? 'on' : ''} onClick={() => setS({ ...s, category: c.id })}>{c.label}</button>)}
      </div>
      <label className="label" htmlFor="wst-color" style={{ marginTop: 12 }}>Color</label>
      <input id="wst-color" type="color" className="color-input" value={s.color ?? '#3b82f6'} onChange={e => setS({ ...s, color: e.target.value })} />
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

function Schemes() {
  const { toast } = useApp()
  const { rows, error, load } = useList<Scheme>('/api/workflow-schemes')
  const workflows = useList<Wf>('/api/workflows')
  const [editing, setEditing] = useState<Partial<Scheme> | null>(null)
  const remove = (s: Scheme) => api('DELETE', `/api/admin/workflow-schemes/${s.id}`).then(() => { toast(`${s.name} removed`); void load() }, e => toast(message(e), { tone: 'warn' }))
  const wfName = (id: string) => workflows.rows?.find(w => w.id === id)?.name ?? '…'
  if (error) return <p className="hint error" role="alert">{error}</p>
  if (!rows || !workflows.rows) return <p className="muted" role="status">Loading…</p>
  return <>
    <div className="card-table" style={{ marginInline: 0 }}>
      <table className="table">
        <thead><tr><th>Scheme</th><th>Workflows</th><th className="col-num">Projects</th><th /></tr></thead>
        <tbody>{rows.map(s => (
          <tr key={s.id} style={{ cursor: 'default' }}>
            <td><b>{s.name}</b>{s.description && <div className="muted sm">{s.description}</div>}</td>
            <td className="muted sm">{s.defaultWorkflow}{Object.entries(s.mappings).map(([k, w]) => <div key={k}>{TYPES.find(t => t.key === k)?.name ?? k}: {wfName(w)}</div>)}</td>
            <td className="col-num">{s.projects}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="icon-btn sm" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}><Pencil size={14} /></button>
              {!s.projects && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => remove(s)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setEditing({ defaultWorkflowId: workflows.rows![0]?.id, mappings: {} })}><Plus size={14} />Add scheme</button>
    {editing && <SchemeDialog scheme={editing} workflows={workflows.rows} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />}
  </>
}

/** A scheme: its default workflow and the work types with one of their own. Saving one projects use shows them what changes first. */
function SchemeDialog({ scheme, workflows, onSaved, onClose }: { scheme: Partial<Scheme>; workflows: Wf[]; onSaved: () => void; onClose: () => void }) {
  const { toast } = useApp()
  const [s, setS] = useState(scheme)
  const [impact, setImpact] = useState<Impact[] | null>(null)
  const [error, setError] = useState('')
  const body = { name: s.name?.trim(), description: s.description ?? '', defaultWorkflowId: s.defaultWorkflowId, mappings: s.mappings ?? {} }
  const save = async (confirmed: boolean) => {
    try {
      if (!scheme.id) { await api('POST', '/api/admin/workflow-schemes', body); toast(`${body.name} added`); onSaved(); return }
      const path = `/api/admin/workflow-schemes/${scheme.id}`
      if (!confirmed && scheme.projects) {
        const preview = await api<{ projects: Impact[] }>('PATCH', path, { ...body, dryRun: true })
        if (preview.projects.length) { setImpact(preview.projects); return }
      }
      const r = await api<{ projects: Impact[] }>('PATCH', path, body)
      toast(`${body.name} saved${r.projects.length ? `, in ${plural(r.projects.length, 'project')}` : ''}`)
      if (r.projects.length) { await sprintDeps.reloadAll(); for (const i of r.projects) await sprintDeps.reloadProject(i.project.id) }
      onSaved()
    } catch (e) { setError(message(e)) }
  }
  return (
    <Modal title={scheme.id ? `Edit ${scheme.name}` : 'Add workflow scheme'} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!s.name?.trim() || !s.defaultWorkflowId} onClick={() => void save(!!impact)}>{impact ? 'Apply to these projects' : 'Save'}</button>
    </>}>
      <label className="label" htmlFor="wsc-name">Name</label>
      <input id="wsc-name" className="input" value={s.name ?? ''} autoFocus maxLength={100} onChange={e => { setS({ ...s, name: e.target.value }); setImpact(null) }} />
      <label className="label" htmlFor="wsc-desc" style={{ marginTop: 12 }}>Description</label>
      <input id="wsc-desc" className="input" value={s.description ?? ''} maxLength={500} onChange={e => setS({ ...s, description: e.target.value })} />
      <label className="label" htmlFor="wsc-default" style={{ marginTop: 12 }}>Default workflow</label>
      <select id="wsc-default" className="input" value={s.defaultWorkflowId ?? ''} onChange={e => { setS({ ...s, defaultWorkflowId: e.target.value }); setImpact(null) }}>
        {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <p className="hint">Every work type uses it, unless chosen below (a project’s own work types always do).</p>
      <div className="wip-grid" style={{ marginTop: 8 }}>
        {TYPES.map(t => (
          <label key={t.key} className="settings-row">
            <span className="settings-label">{t.name}</span>
            <select className="input" aria-label={`Workflow for ${t.name}`} value={s.mappings?.[t.key] ?? ''}
              onChange={e => { const { [t.key]: _, ...rest } = s.mappings ?? {}; setS({ ...s, mappings: e.target.value ? { ...rest, [t.key]: e.target.value } : rest }); setImpact(null) }}>
              <option value="">Default</option>
              {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      {impact && (
        <div className="wf-impact" role="region" aria-label="What changes">
          <p><b>Applies to {plural(impact.length, 'project')}</b> straight away:</p>
          <ul className="change-list">{impact.map(i => <li key={i.project.id}><b>{i.project.key}</b> {i.project.name}: {impactLine(i)}</li>)}</ul>
          <p className="hint">Items in statuses their new workflow lacks go to its first status of the same kind. Each moved item’s history says so.</p>
        </div>
      )}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}
