import { useEffect, useState } from 'react'
import { ArrowLeft, Repeat } from 'lucide-react'
import { useStore, typesOf, type Project } from '../data/store'
import { useApp } from '../appContext'
import { canAdmin, isGlobalAdmin } from '../data/access'
import { href, navigate } from '../router'
import { api, apiEnabled, errorMessage } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { Modal, plural } from './ui'
import { impactLine, type Impact } from './workflow/Versions'

// Project settings › Workflow: what this project's workflow scheme gives each work type, read-only. System
// administrators keep workflows (Administration › Workflows); a project admin may switch to another scheme, and sets
// the board's WIP limits.

interface Scheme { id: string; name: string; description: string; defaultWorkflowId: string; defaultWorkflow: string; mappings: Record<string, string> }

/** The project's workflows, one per workflow its types use: who uses it, its statuses, its moves. */
function Workflows({ project }: { project: Project }) {
  const name = (id: string | null) => (id ? project.statuses.find(s => s.id === id)?.name ?? '?' : 'stays')
  const typeName = (k: string) => typesOf(project).find(t => t.key === k)?.name ?? k
  const groups = project.workflows?.length
    ? [...new Map(project.workflows.map(w => [w.workflowId, w])).values()].map(w => ({
      id: w.workflowId, name: w.workflow, types: project.workflows!.filter(x => x.workflowId === w.workflowId).map(x => x.typeKey), statusIds: w.statusIds,
    }))
    : [{ id: 'all', name: 'Workflow', types: [], statusIds: project.statuses.map(s => s.id) }]
  return <>{groups.map(g => {
    const moves = project.transitions.filter(t => !t.types?.length || g.types.some(k => t.types!.includes(k)))
    return (
      <section key={g.id} className="panel" aria-label={g.name}>
        <h2 className="panel-title">{g.name}</h2>
        {g.types.length > 0 && <p className="muted">For {groups.length === 1 ? 'every work type' : g.types.map(typeName).join(', ')}. New work starts in {name(g.statusIds[0] ?? null)}.</p>}
        <div className="workflow-strip">{g.statusIds.map(id => project.statuses.find(s => s.id === id)).filter(Boolean).map(s => <span key={s!.id} className={`lozenge lozenge-${s!.category}`}>{s!.name}</span>)}</div>
        {moves.length ? (
          <table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Transition</th><th>From</th><th>To</th></tr></thead>
            <tbody>{moves.map(t => <tr key={t.id}><td>{t.name}</td><td className="muted">{t.from === 'any' ? 'Any status' : t.from.map(name).join(', ')}</td><td className="muted">{name(t.to)}</td></tr>)}</tbody>
          </table>
        ) : <p className="muted sm" style={{ marginTop: 8 }}>No transitions: any move is allowed.</p>}
      </section>
    )
  })}</>
}

/** Settings › Workflow, the page. */
export default function ProjectWorkflow({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject } = useApp()
  const sysAdmin = isGlobalAdmin(state)
  const [changing, setChanging] = useState(false)
  const admin = canAdmin(project)
  const [scheme, setScheme] = useState<string>('')
  useEffect(() => {
    if (apiEnabled) api<{ scheme: { name: string } }>('GET', `/api/projects/${encodeURIComponent(project.key)}/workflow`).then(r => setScheme(r.scheme.name), () => {})
  }, [project.key, project.workflowSchemeId])
  const setWip = (id: string, v: string) => dispatch({ type: 'updateProject', id: project.id, patch: {
    statuses: project.statuses.map(s => (s.id === id ? { ...s, wipLimit: v === '' ? undefined : Math.max(1, Number(v)) } : s)) } })
  return (
    <div className="settings">
      <div className="panel-title-row">
        <div>
          <button className="btn btn-ghost" onClick={() => openProject(project.id, 'settings')}><ArrowLeft size={15} />Settings</button>
          <h1 className="page-title">Workflow{scheme ? `: ${scheme}` : ''}</h1>
          <p className="muted">Workflows are shared and kept by system administrators, so every project using one works the same way.{admin && apiEnabled ? ' You can switch this project to another workflow scheme.' : ''}</p>
        </div>
        <div className="btn-row">
          {sysAdmin && project.workflows?.[0] && <button className="btn btn-ghost" onClick={() => navigate(href({ name: 'admin', section: 'workflows', item: project.workflows![0]!.workflowId }))}>Edit in Administration</button>}
          {admin && apiEnabled && <button className="btn btn-secondary" onClick={() => setChanging(true)}><Repeat size={14} />Change workflow</button>}
        </div>
      </div>
      <Workflows project={project} />
      <section className="panel">
        <h2 className="panel-title">WIP limits</h2>
        <p className="muted">How many work items each board column should hold at most (the board warns above it).</p>
        <div className="wip-grid">
          {project.statuses.map(s => (
            <label key={s.id} className="settings-row">
              <span className="settings-label">{s.name}</span>
              <input className="input" type="number" min={1} placeholder="No limit" style={{ width: 120 }} aria-label={`WIP limit for ${s.name}`} disabled={!admin}
                defaultValue={s.wipLimit ?? ''} onBlur={e => e.target.value !== String(s.wipLimit ?? '') && setWip(s.id, e.target.value)} />
            </label>
          ))}
        </div>
      </section>
      {changing && <ChangeScheme project={project} onClose={() => setChanging(false)} />}
    </div>
  )
}

/** Settings, the panel: the scheme in a line, the statuses, and the way to the page. */
export function WorkflowPanel({ project }: { project: Project }) {
  const { openProject } = useApp()
  const used = [...new Set((project.workflows ?? []).map(w => w.workflow))]
  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Workflow</h2>
          <p className="muted">{used.length ? `${used.join(', ')}. ` : ''}{plural(project.statuses.length, 'status')} · {plural(project.transitions.length, 'transition')}. The workflow decides the board columns and which moves are allowed.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => openProject(project.id, 'settings', 'workflow')}>View workflow</button>
      </div>
      <div className="workflow-strip">
        {project.statuses.map(s => <span key={s.id} className={`lozenge lozenge-${s.category}`}>{s.name}</span>)}
      </div>
    </section>
  )
}

/** Switch to another scheme: choose it, see what changes (nothing does until Apply), say where moved items go. */
function ChangeScheme({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast } = useApp()
  const [schemes, setSchemes] = useState<Scheme[] | null>(null)
  const [schemeId, setSchemeId] = useState(project.workflowSchemeId ?? '')
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([])      // the statuses the chosen scheme's workflows have
  const [map, setMap] = useState<Record<string, string>>({})                      // project status id → global status id
  const [impact, setImpact] = useState<Impact | null>(null)
  const [busy, setBusy] = useState(false)
  const path = `/api/projects/${encodeURIComponent(project.key)}/workflow-scheme`
  useEffect(() => { api<Scheme[]>('GET', '/api/workflow-schemes').then(setSchemes, e => toast(errorMessage(e), { tone: 'warn' })) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const scheme = schemes?.find(s => s.id === schemeId)
  useEffect(() => {
    setImpact(null)
    if (!scheme) return
    const ids = [...new Set([scheme.defaultWorkflowId, ...Object.values(scheme.mappings)])]
    Promise.all(ids.map(id => api<{ statuses: { id: string; name: string }[] }>('GET', `/api/workflows/${id}`)))
      .then(ws => setTargets([...new Map(ws.flatMap(w => w.statuses).map(s => [s.id, s])).values()]), () => setTargets([]))
  }, [schemeId, schemes])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!scheme) return
    let live = true
    const t = setTimeout(() => api<Impact>('PUT', path, { schemeId, statusMap: map, dryRun: true }).then(r => live && setImpact(r), e => live && toast(errorMessage(e), { tone: 'warn' })), 250)
    return () => { live = false; clearTimeout(t) }
  }, [schemeId, schemes, map])   // eslint-disable-line react-hooks/exhaustive-deps
  const leaving = [...new Set((impact?.moves ?? []).map(m => m.from))].map(n => project.statuses.find(s => s.name === n)!).filter(Boolean)
  const apply = () => {
    setBusy(true)
    api<Impact>('PUT', path, { schemeId, statusMap: map })
      .then(async r => {
        toast(`${project.key} now uses ${scheme!.name}${r.moves.length ? `: ${impactLine(r)}` : ''}`)
        await sprintDeps.reloadAll(); await sprintDeps.reloadProject(project.id)
        onClose()
      }, e => toast(errorMessage(e), { tone: 'warn' }))
      .finally(() => setBusy(false))
  }
  return (
    <Modal title="Change workflow" onClose={onClose} width={560} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!impact || busy || schemeId === project.workflowSchemeId} onClick={apply}>Apply</button>
    </>}>
      <label className="label" htmlFor="cw-scheme">Workflow scheme</label>
      <select id="cw-scheme" className="input" value={schemeId} onChange={e => { setSchemeId(e.target.value); setMap({}) }}>
        {(schemes ?? []).map(s => <option key={s.id} value={s.id}>{s.name}{s.id === project.workflowSchemeId ? ' (current)' : ''}</option>)}
      </select>
      {scheme && <p className="hint">{scheme.description || `Uses ${scheme.defaultWorkflow}`}{Object.keys(scheme.mappings).length ? `; ${plural(Object.keys(scheme.mappings).length, 'work type')} with a workflow of its own` : ''}.</p>}
      {schemeId !== project.workflowSchemeId && (!impact ? <p className="muted" role="status">Working out what changes…</p> : (
        <div className="wf-impact" role="region" aria-label="What changes">
          <p>{impactLine(impact).replace(/^./, c => c.toUpperCase())}.</p>
          {leaving.map(s => (
            <label key={s.id} className="settings-row">
              <span className="settings-label">Items in {s.name} go to</span>
              <select className="input" aria-label={`Items in ${s.name} go to`} value={map[s.id] ?? ''} onChange={e => setMap({ ...map, [s.id]: e.target.value })}>
                <option value="">The first status of its kind</option>
                {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          ))}
          <p className="hint">Nothing changes until you choose Apply. Each moved item’s history says so.</p>
        </div>
      ))}
    </Modal>
  )
}
