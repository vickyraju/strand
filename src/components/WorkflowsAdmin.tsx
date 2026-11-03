import { useEffect, useState } from 'react'
import { Copy, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { useApp } from '../appContext'
import { BUILTIN_TYPES, type Category } from '../data/store'
import { href, navigate } from '../router'
import { AdminLink, PageAction } from './admin/AdminShell'
import { ConfirmDialog, Empty, Loading, LoadError, Modal, openRow, plural } from './ui'
import { SummaryView, type Summary } from './workflow/Versions'
import { CountLink, ProjectsUsing, useApplying } from './admin/scale'

// Administration › Workflows (Jira's workflows, statuses and workflow schemes), for system administrators. A change to
// a workflow or a scheme applies to every project using it; a project only chooses its scheme.

interface Wf { id: string; name: string; description: string; version: number; statuses: number; transitions: number; schemes: number; projects: number }
interface St { id: string; name: string; description: string; color: string; category: Category; workflows: string[] }
interface Scheme { id: string; name: string; description: string; defaultWorkflowId: string; defaultWorkflow: string; mappings: Record<string, string>; projects: number }
const CATS: { id: Category; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'in-progress', label: 'In progress' }, { id: 'done', label: 'Done' }]
/** The work types every project has (a project's own types use the default workflow). */
/** "A, B, C and 7 more" */
const someOf = (xs: string[], n = 3) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`)
const TYPES = [...BUILTIN_TYPES.map(t => ({ key: t.key, name: t.name })), { key: 'test', name: 'Test' }, { key: 'precondition', name: 'Pre-Condition' },
  { key: 'test_set', name: 'Test Set' }, { key: 'test_plan', name: 'Test Plan' }, { key: 'test_execution', name: 'Test Execution' }]

type Tab = 'workflows' | 'statuses' | 'schemes'
const TABS: { id: Tab; label: string }[] = [{ id: 'workflows', label: 'Workflows' }, { id: 'statuses', label: 'Statuses' }, { id: 'schemes', label: 'Schemes' }]

/** Each part has its own address: /admin/workflows, /admin/workflows/statuses, /admin/workflows/schemes. */
export default function WorkflowsAdmin({ tab }: { tab: Tab }) {
  return (
    <section>
      <nav className="segmented" aria-label="Workflows" style={{ marginBottom: 12 }}>
        {TABS.map(t => (
          <AdminLink key={t.id} to={href({ name: 'admin', section: 'workflows', ...(t.id === 'workflows' ? {} : { item: t.id }) })} current={tab === t.id} className={tab === t.id ? 'on' : ''}>{t.label}</AdminLink>
        ))}
      </nav>
      {tab === 'workflows' && <Workflows />}
      {tab === 'statuses' && <Statuses />}
      {tab === 'schemes' && <Schemes />}
    </section>
  )
}

function useList<T>(path: string) {
  const [rows, setRows] = useState<T[] | null>(null)
  const [error, setError] = useState('')
  const load = () => { setError(''); return api<T[]>('GET', path).then(setRows, e => setError(errorMessage(e))) }
  useEffect(() => { void load() }, [path])   // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, error, load }
}

function Workflows() {
  const { toast } = useApp()
  const { rows, error, load } = useList<Wf>('/api/workflows')
  const [adding, setAdding] = useState<{ copyFrom?: Wf } | null>(null)
  const [removing, setRemoving] = useState<Wf | null>(null)
  const [listing, setListing] = useState<Wf | null>(null)
  const applying = useApplying(() => void load())
  const open = (id: string) => navigate(href({ name: 'admin', section: 'workflows', item: id }))
  if (error) return <LoadError error={error} onRetry={load} />
  if (!rows) return <Loading />
  return <>
    {applying.bar}
    <div className="card-table" style={{ marginInline: 0 }}>
      <table className="table">
        <thead><tr><th>Workflow</th><th className="col-num">Statuses</th><th className="col-num">Transitions</th><th className="col-num">Schemes</th><th className="col-num">Projects</th><th className="col-num">Version</th><th /></tr></thead>
        <tbody>{rows.map(w => (
          <tr key={w.id} {...openRow(() => open(w.id), `Edit ${w.name}`)}>
            <td><b>{w.name}</b>{w.description && <div className="muted sm">{w.description}</div>}</td>
            <td className="col-num">{w.statuses}</td><td className="col-num">{w.transitions}</td><td className="col-num">{w.schemes}</td><td className="col-num"><CountLink count={w.projects} one="project" many="projects" onOpen={() => setListing(w)} /></td><td className="col-num">{w.version}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
              <button className="icon-btn sm" aria-label={`Edit ${w.name}`} title="Edit" onClick={() => open(w.id)}><Pencil size={14} /></button>
              <button className="icon-btn sm" aria-label={`Copy ${w.name}`} title="Copy" onClick={() => setAdding({ copyFrom: w })}><Copy size={14} /></button>
              {!w.schemes && <button className="icon-btn sm" aria-label={`Remove ${w.name}`} title="Remove" onClick={() => setRemoving(w)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    {!rows.length && <Empty icon={<GitBranch size={22} strokeWidth={1.5} />} title="No workflows" body="Add one, or copy one to start from." />}
    <PageAction><button className="btn btn-primary" onClick={() => setAdding({})}><Plus size={14} />Add workflow</button></PageAction>
    {listing && <ProjectsUsing what="workflow" id={listing.id} name={listing.name} onClose={() => setListing(null)} />}
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} action="Remove workflow" onClose={() => setRemoving(null)}
      onConfirm={() => api('DELETE', `/api/admin/workflows/${removing.id}`).then(() => { toast(`${removing.name} removed`); void load() })}>
      <p>No scheme uses it, so no project changes. Its published versions go with it.</p>
    </ConfirmDialog>}
    {adding && <NameDialog title={adding.copyFrom ? `Copy ${adding.copyFrom.name}` : 'Add workflow'} initial={adding.copyFrom ? `${adding.copyFrom.name} (copy)` : ''}
      hint={adding.copyFrom ? undefined : 'It starts with a To do and a Done status; add the rest in the editor.'} onClose={() => setAdding(null)}
      onSave={name => api<{ id: string }>('POST', '/api/admin/workflows', { name, ...(adding.copyFrom ? { copyFrom: adding.copyFrom.id } : {}) }).then(w => open(w.id))} />}
  </>
}

function NameDialog({ title, initial, hint, onSave, onClose }: { title: string; initial: string; hint?: string; onSave: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState('')
  const save = () => name.trim() && onSave(name.trim()).catch(e => setError(errorMessage(e)))
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
  const [removing, setRemoving] = useState<St | null>(null)
  if (error) return <LoadError error={error} onRetry={load} />
  if (!rows) return <Loading />
  return <>
    <p className="muted sm" style={{ marginBottom: 8 }}>Statuses are shared by every workflow. A new name, colour or category shows in every workflow and project that has the status.</p>
    <div className="card-table" style={{ marginInline: 0 }}>
      <table className="table">
        <thead><tr><th>Status</th><th>Category</th><th>Used in</th><th /></tr></thead>
        <tbody>{rows.map(s => (
          <tr key={s.id} style={{ cursor: 'default' }}>
            <td><span className="status-dot" style={{ background: s.color }} /> <b>{s.name}</b>{s.description && <div className="muted sm">{s.description}</div>}</td>
            <td><span className={`lozenge lozenge-${s.category}`}>{CATS.find(c => c.id === s.category)!.label}</span></td>
            <td className="muted sm">{s.workflows.length ? someOf(s.workflows) : 'No workflow'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="icon-btn sm" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}><Pencil size={14} /></button>
              {!s.workflows.length && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => setRemoving(s)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    <PageAction><button className="btn btn-primary" onClick={() => setEditing({ category: 'in-progress', color: '#3b82f6' })}><Plus size={14} />Add status</button></PageAction>
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} action="Remove status" onClose={() => setRemoving(null)}
      onConfirm={() => api('DELETE', `/api/admin/statuses/${removing.id}`).then(() => { toast(`${removing.name} removed`); void load() })}>
      <p>No workflow uses it. It can be added again later.</p>
    </ConfirmDialog>}
    {editing && <StatusDialog status={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); void sprintDeps.reloadAll() }} />}
  </>
}

function StatusDialog({ status, onSaved, onClose }: { status: Partial<St>; onSaved: () => void; onClose: () => void }) {
  const [s, setS] = useState(status)
  const [error, setError] = useState('')
  const save = () => api(status.id ? 'PATCH' : 'POST', status.id ? `/api/admin/statuses/${status.id}` : '/api/admin/statuses',
    { name: s.name?.trim(), description: s.description ?? '', color: s.color, category: s.category }).then(onSaved, e => setError(errorMessage(e)))
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
  const [removing, setRemoving] = useState<Scheme | null>(null)
  const [listing, setListing] = useState<Scheme | null>(null)
  const applying = useApplying(() => void load())
  const wfName = (id: string) => workflows.rows?.find(w => w.id === id)?.name ?? '…'
  if (error || workflows.error) return <LoadError error={error || workflows.error} onRetry={() => { void load(); void workflows.load() }} />
  if (!rows || !workflows.rows) return <Loading />
  return <>
    {applying.bar}
    <div className="card-table" style={{ marginInline: 0 }}>
      <table className="table">
        <thead><tr><th>Scheme</th><th>Workflows</th><th className="col-num">Projects</th><th /></tr></thead>
        <tbody>{rows.map(s => (
          <tr key={s.id} style={{ cursor: 'default' }}>
            <td><b>{s.name}</b>{s.description && <div className="muted sm">{s.description}</div>}</td>
            <td className="muted sm">{s.defaultWorkflow}{Object.entries(s.mappings).map(([k, w]) => <div key={k}>{TYPES.find(t => t.key === k)?.name ?? k}: {wfName(w)}</div>)}</td>
            <td className="col-num"><CountLink count={s.projects} one="project" many="projects" onOpen={() => setListing(s)} /></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="icon-btn sm" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}><Pencil size={14} /></button>
              {!s.projects && <button className="icon-btn sm" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => setRemoving(s)}><Trash2 size={14} /></button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    <PageAction><button className="btn btn-primary" onClick={() => setEditing({ defaultWorkflowId: workflows.rows![0]?.id, mappings: {} })}><Plus size={14} />Add scheme</button></PageAction>
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} action="Remove scheme" onClose={() => setRemoving(null)}
      onConfirm={() => api('DELETE', `/api/admin/workflow-schemes/${removing.id}`).then(() => { toast(`${removing.name} removed`); void load() })}>
      <p>No project uses it. Its workflows stay.</p>
    </ConfirmDialog>}
    {listing && <ProjectsUsing what="scheme" id={listing.id} name={listing.name} onClose={() => setListing(null)} />}
    {editing && <SchemeDialog scheme={editing} workflows={workflows.rows} busy={applying.busy} onClose={() => setEditing(null)}
      onSaved={jobId => { setEditing(null); void load(); if (jobId) applying.follow(jobId) }} onList={() => editing.id && setListing(editing as Scheme)} />}
  </>
}

/** A scheme: its default workflow and the work types with one of their own. Saving one projects use shows what it does
 *  to them first; then it applies in the background. */
function SchemeDialog({ scheme, workflows, busy, onSaved, onClose, onList }: { scheme: Partial<Scheme>; workflows: Wf[]; busy: boolean; onSaved: (jobId: string | null) => void; onClose: () => void; onList: () => void }) {
  const { toast } = useApp()
  const [s, setS] = useState(scheme)
  const [impact, setImpact] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const body = { name: s.name?.trim(), description: s.description ?? '', defaultWorkflowId: s.defaultWorkflowId, mappings: s.mappings ?? {} }
  const save = async (confirmed: boolean) => {
    try {
      if (!scheme.id) { await api('POST', '/api/admin/workflow-schemes', body); toast(`${body.name} added`); onSaved(null); return }
      const path = `/api/admin/workflow-schemes/${scheme.id}`
      if (!confirmed && scheme.projects) {
        const preview = await api<{ summary: Summary }>('PATCH', path, { ...body, dryRun: true })
        if (preview.summary.projects) { setImpact(preview.summary); return }
      }
      const r = await api<{ summary: Summary; jobId: string | null }>('PATCH', path, body)
      toast(`${body.name} saved${r.jobId ? `. Applying it to ${plural(r.summary.projects, 'project')}…` : ''}`)
      onSaved(r.jobId)
    } catch (e) { setError(errorMessage(e)) }
  }
  return (
    <Modal title={scheme.id ? `Edit ${scheme.name}` : 'Add workflow scheme'} onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!s.name?.trim() || !s.defaultWorkflowId || (busy && !!scheme.projects)} title={busy ? 'Wait for the last change to finish applying' : undefined}
        onClick={() => void save(!!impact)}>{impact ? `Apply to ${plural(impact.projects, 'project')}` : 'Save'}</button>
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
          <SummaryView s={impact}>{impact.projects > 1 ? <CountLink count={impact.projects} one="project" many="projects" label="see them all" onOpen={onList} /> : null}</SummaryView>
        </div>
      )}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}
