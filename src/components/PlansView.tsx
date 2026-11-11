import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, GanttChart, Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '../api/client'
import { searchProjects, type ProjectOption } from '../api/work'
import { useApp } from '../appContext'
import { useStore } from '../data/store'
import { href, navigate } from '../router'
import { broken, day, health, progress, range, spans, tree, type Health, type PlanItem } from '../../server/src/shared/plans.ts'
import { Empty, Modal, TypeIcon, plural } from './ui'

// Plans (spec 0803, option B of Advanced Roadmaps): timelines across projects, with initiatives, dependencies, releases
// and sprints. Edits are live: dragging a bar changes the item's dates for everyone.

interface Plan { id: string; name: string; ownerId: string; ownerName: string; projectIds: string[] | null; viewId: string | null; viewName: string | null; doneDays: number; projects: { id: string; key: string; name: string }[] }
interface Timeline {
  items: (PlanItem & { assigneeId: string | null; rank: number })[]; dependencies: { fromId: string; toId: string }[]
  releases: { id: string; name: string; projectKey: string; releaseDate: string; released: boolean }[]
  sprints: { id: string; name: string; projectKey: string; state: string; startedAt: string | null; endsAt: string | null; completedAt: string | null }[]
  truncated: boolean; maxItems: number
}

export default function PlansView({ id }: { id?: string }) {
  return id ? <PlanTimeline id={id} /> : <PlanList />
}

function PlanList() {
  const { state } = useStore()
  const { toast } = useApp()
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [making, setMaking] = useState(false)
  const load = () => api<Plan[]>('GET', '/api/plans').then(setPlans, e => toast(errorMessage(e), { tone: 'warn' }))
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!plans) return <div className="loading" role="status">Loading plans…</div>
  return (
    <div className="page-col">
      <div className="page-hdr">
        <GanttChart size={20} />
        <h1 className="page-title">Plans</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setMaking(true)}><Plus size={15} />Create plan</button>
      </div>
      {plans.length === 0 ? (
        <Empty icon={<GanttChart size={22} strokeWidth={1.5} />} title="Plan across projects"
          body="A plan shows initiatives, epics and their work from several projects on one timeline, with dependencies, releases and sprints."
          action={<button className="btn btn-primary" onClick={() => setMaking(true)}><Plus size={15} />Create plan</button>} />
      ) : (
        <div className="card-table">
          <table className="table">
            <thead><tr><th>Plan</th><th>Source</th><th>Owner</th><th /></tr></thead>
            <tbody>{plans.map(p => (
              <tr key={p.id} onClick={() => navigate(href({ name: 'plans', id: p.id }))}>
                <td><b>{p.name}</b></td>
                <td className="sm">{p.viewId ? `View: ${p.viewName ?? '(deleted)'}` : p.projects.map(x => x.key).join(', ')}</td>
                <td className="sm">{p.ownerName}</td>
                <td className="nowrap" onClick={e => e.stopPropagation()}>
                  {(p.ownerId === state.me?.id || state.isAdmin) && <button className="icon-btn sm" aria-label={`Delete ${p.name}`} title="Delete"
                    onClick={() => api('DELETE', `/api/plans/${p.id}`).then(load, e => toast(errorMessage(e), { tone: 'warn' }))}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {making && <PlanDialog onClose={() => setMaking(false)} onSaved={p => navigate(href({ name: 'plans', id: p.id }))} />}
    </div>
  )
}

/** A new plan, or a plan's settings: its name, its source (projects or a saved view), how long finished work stays. */
function PlanDialog({ plan, onClose, onSaved }: { plan?: Plan; onClose: () => void; onSaved: (p: Plan) => void }) {
  const { state } = useStore()
  const [name, setName] = useState(plan?.name ?? '')
  const [kind, setKind] = useState<'projects' | 'view'>(plan?.viewId ? 'view' : 'projects')
  const [chosen, setChosen] = useState<{ key: string; name: string }[]>(plan?.projects.map(p => ({ key: p.key, name: p.name })) ?? [])
  const [viewId, setViewId] = useState(plan?.viewId ?? '')
  const [doneDays, setDoneDays] = useState(plan?.doneDays ?? 30)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<ProjectOption[]>([])
  const [error, setError] = useState('')
  useEffect(() => { const t = setTimeout(() => searchProjects(query).then(setFound, () => {}), 200); return () => clearTimeout(t) }, [query])
  const save = async () => {
    try {
      const body = { name: name.trim(), projectKeys: kind === 'projects' ? chosen.map(c => c.key) : null, viewId: kind === 'view' ? viewId || null : null, doneDays }
      onSaved(await api<Plan>(plan ? 'PATCH' : 'POST', plan ? `/api/plans/${plan.id}` : '/api/plans', body))
      onClose()
    } catch (e) { setError(errorMessage(e)) }
  }
  const add = (p: ProjectOption) => { if (!chosen.some(c => c.key === p.key)) setChosen([...chosen, { key: p.key, name: p.name }]); setQuery('') }
  return (
    <Modal title={plan ? `${plan.name}: settings` : 'Create plan'} onClose={onClose} width={520} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || (kind === 'projects' ? !chosen.length : !viewId)} onClick={() => void save()}>{plan ? 'Save' : 'Create'}</button>
    </>}>
      <label className="label" htmlFor="pl-name">Name</label>
      <input id="pl-name" className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
      <div className="segmented" role="tablist" aria-label="Source" style={{ marginTop: 12 }}>
        <button role="tab" aria-selected={kind === 'projects'} className={kind === 'projects' ? 'on' : ''} onClick={() => setKind('projects')}>Projects</button>
        <button role="tab" aria-selected={kind === 'view'} className={kind === 'view' ? 'on' : ''} onClick={() => setKind('view')}>A saved view</button>
      </div>
      {kind === 'projects' ? <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          {chosen.map(c => <span key={c.key} className="chip">{c.key} {c.name}<button className="icon-btn sm" aria-label={`Remove ${c.key}`} onClick={() => setChosen(chosen.filter(x => x.key !== c.key))}>×</button></span>)}
        </div>
        <input className="input" aria-label="Add a project" placeholder="Add a project: type its name or key" value={query} onChange={e => setQuery(e.target.value)} />
        {query && <div className="picker-menu" style={{ position: 'static', marginTop: 4 }}>{found.filter(p => !chosen.some(c => c.key === p.key)).slice(0, 8).map(p => (
          <button key={p.id} className="picker-item" onClick={() => add(p)}>{p.key} {p.name}</button>
        ))}</div>}
      </> : (
        <select className="input" aria-label="Saved view" style={{ marginTop: 10 }} value={viewId} onChange={e => setViewId(e.target.value)}>
          <option value="">Choose a saved view…</option>
          {state.views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      )}
      <label className="label" htmlFor="pl-done" style={{ marginTop: 12 }}>Keep finished work for (days)</label>
      <input id="pl-done" className="input" type="number" min={0} max={3650} value={doneDays} onChange={e => setDoneDays(Number(e.target.value))} />
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

const DAY = 86_400_000
const PX = { weeks: 18, months: 6, quarters: 2.2 } as const
const LABEL = 320, ROW = 40
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)
const HEALTH: Record<Exclude<Health, null>, [string, string]> = { 'on-track': ['On track', 'done'], 'at-risk': ['At risk', 'in-progress'], 'off-track': ['Off track', 'danger'] }

function PlanTimeline({ id }: { id: string }) {
  const { state } = useStore()
  const { toast, openIssue } = useApp()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [data, setData] = useState<Timeline | null>(null)
  const [error, setError] = useState('')
  const [scale, setScale] = useState<keyof typeof PX>('months')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<{ id: string; key: string; mode: 'move' | 'start' | 'end'; x0: number; s0: number; e0: number; dx: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const load = () => Promise.all([api<Plan>('GET', `/api/plans/${id}`), api<Timeline>('GET', `/api/plans/${id}/timeline`)])
    .then(([p, t]) => { setPlan(p); setData(t) }, e => setError(errorMessage(e)))
  useEffect(() => { load() }, [id])   // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Empty icon={<GanttChart size={22} strokeWidth={1.5} />} title="Couldn’t open this plan" body={error} />
  if (!plan || !data) return <div className="loading" role="status">Loading plan…</div>

  const items = data.items
  const bars = spans(items, data.sprints)
  const t = tree(items)
  const today = day(new Date().toISOString())
  const { from, to } = range(bars.values(), [...data.releases.map(r => day(r.releaseDate)), ...data.sprints.flatMap(s => [s.startedAt, s.endsAt].filter((x): x is string => !!x).map(day))], today)
  const px = PX[scale], days = Math.round((to - from) / DAY) + 1
  const x = (t0: number) => Math.round((t0 - from) / DAY) * px
  // rows: initiative › epic › item, collapsible
  const rows: { item: Timeline['items'][number]; depth: number; kids: number }[] = []
  const walk = (i: Timeline['items'][number], depth: number) => {
    const kids = t.children(i.id) as Timeline['items']
    rows.push({ item: i, depth, kids: kids.length })
    if (!collapsed.has(i.id)) kids.forEach(k => walk(k, depth + 1))
  }
  ;(t.roots as Timeline['items']).forEach(r => walk(r, 0))
  const rowOf = new Map(rows.map((r, n) => [r.item.id, n]))
  const months: { label: string; left: number; width: number }[] = []
  for (let m = from; m <= to;) {
    const d = new Date(m), next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    if (scale !== 'quarters' || d.getUTCMonth() % 3 === 0 || m === from)
      months.push({ label: d.toLocaleDateString(undefined, { month: scale === 'quarters' ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' }), left: x(m), width: x(Math.min(next, to + DAY)) - x(m) })
    m = next
  }
  const preview = (i: { id: string }, s: { start: number; end: number }) => {
    if (drag?.id !== i.id) return s
    const shift = Math.round(drag.dx / px) * DAY
    const start = drag.mode === 'end' ? s.start : s.start + shift, end = drag.mode === 'start' ? s.end : s.end + shift
    return start <= end ? { start, end } : s
  }
  const onUp = async () => {
    if (!drag) return
    const shift = Math.round(drag.dx / px) * DAY, d0 = drag
    setDrag(null)
    if (!shift) { openIssue(d0.id); return }
    const start = d0.mode === 'end' ? d0.s0 : d0.s0 + shift, end = d0.mode === 'start' ? d0.e0 : d0.e0 + shift
    if (start > end) return
    try { await api('PATCH', `/api/issues/${encodeURIComponent(d0.key)}`, { startDate: toDay(start), dueDate: toDay(end) }); await load() }
    catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
  }
  const canChange = plan.ownerId === state.me?.id || !!state.isAdmin
  const sprintBar = (s: Timeline['sprints'][number]) => (s.startedAt && (s.completedAt ?? s.endsAt) ? { start: day(s.startedAt), end: day((s.completedAt ?? s.endsAt)!) } : null)

  return (
    <div className="page-col">
      <div className="page-hdr">
        <GanttChart size={20} />
        <h1 className="page-title">{plan.name}</h1>
        <span className="muted sm">{plan.viewId ? `View: ${plan.viewName}` : plan.projects.map(p => p.key).join(', ')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={() => scrollRef.current?.scrollTo({ left: Math.max(0, x(today) - 240), behavior: 'smooth' })}>Today</button>
        <div className="segmented" role="tablist" aria-label="Scale">
          {(['weeks', 'months', 'quarters'] as const).map(s => <button key={s} role="tab" aria-selected={scale === s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}
        </div>
        {canChange && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Settings</button>}
      </div>
      {data.truncated && <div className="apply-banner warn" role="status"><span>This plan shows its first {data.maxItems.toLocaleString()} work items: narrow its source to see the rest.</span></div>}

      <div className="tl" ref={scrollRef} onPointerMove={e => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }) }} onPointerUp={() => void onUp()} onPointerLeave={() => void onUp()}>
        <div className="tl-grid" style={{ width: LABEL + days * px }}>
          <div className="tl-head">
            <div className="tl-corner">{plural(items.length, 'work item')}</div>
            <div className="tl-scale" style={{ width: days * px }}>
              {months.map(m => <div key={m.left} className="tl-month" style={{ left: m.left, width: m.width }}>{m.label}</div>)}
            </div>
          </div>
          <div className="tl-body">
            <div className="tl-today" style={{ left: LABEL + x(today) }} title="Today" />
            <div className="tl-row plan-lane" aria-label="Releases">
              <div className="tl-label"><span className="muted sm">Releases</span></div>
              <div className="tl-track" style={{ width: days * px }}>
                {data.releases.map(r => <span key={r.id} className={`plan-release${r.released ? ' released' : ''}`} style={{ left: x(day(r.releaseDate)) }} title={`${r.projectKey} ${r.name}: ${r.releaseDate}`}>◆ {r.name}</span>)}
              </div>
            </div>
            <div className="tl-row plan-lane" aria-label="Sprints">
              <div className="tl-label"><span className="muted sm">Sprints</span></div>
              <div className="tl-track" style={{ width: days * px }}>
                {data.sprints.map(s => { const b = sprintBar(s); return b && <span key={s.id} className="plan-sprint" style={{ left: x(b.start), width: x(b.end) - x(b.start) + px }} title={`${s.projectKey} ${s.name}`}>{s.name}</span> })}
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              {rows.map(({ item: i, depth, kids }) => {
                const own = bars.get(i.id) && !bars.get(i.id)!.derived ? bars.get(i.id)! : null
                const b = bars.get(i.id) ? preview(i, bars.get(i.id)!) : null
                const top = i.type === 'initiative' || i.type === 'epic'
                const prog = top ? progress(i.id, items) : null
                const h = top ? health(i.id, items, bars, data.dependencies, today) : null
                const done = i.category === 'done'
                return (
                  <div key={i.id} className={`tl-row${top ? ' epic' : ''}`} data-key={i.key}>
                    <div className={`tl-label`} style={{ paddingLeft: 6 + depth * 18 }}>
                      {kids ? (
                        <button className="icon-btn sm" onClick={() => setCollapsed(c => { const n = new Set(c); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n })}
                          aria-label={collapsed.has(i.id) ? `Expand ${i.key}` : `Collapse ${i.key}`} aria-expanded={!collapsed.has(i.id)}>
                          {collapsed.has(i.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                      ) : <span style={{ width: 26 }} />}
                      <TypeIcon type={i.type} size={14} />
                      <button className="tl-title" onClick={() => openIssue(i.id)} title={`${i.key} ${i.title}`}>
                        <span className={`mono muted${done ? ' done' : ''}`}>{i.key}</span><span className="cell-ellipsis">{i.title}</span>
                      </button>
                      {prog && prog.total > 0 && <span className="muted sm nowrap" title={`${prog.done} of ${prog.total} done`}>{prog.done}/{prog.total}</span>}
                      {h && <span className={`lozenge lozenge-${HEALTH[h][1]}`} title="Health">{HEALTH[h][0]}</span>}
                    </div>
                    <div className="tl-track" style={{ width: days * px }}>
                      {b && (
                        <div className={`tl-bar${top ? ' epic' : ''}${!own ? ' derived' : ''}${done ? ' done' : ''}${drag?.id === i.id ? ' dragging' : ''}`}
                          style={{ left: x(b.start), width: x(b.end) - x(b.start) + px, ['--bar' as string]: i.type === 'initiative' ? '#EA580C' : i.type === 'epic' ? '#7C3AED' : '#2563EB' }}
                          title={`${i.key}: ${toDay(b.start)} – ${toDay(b.end)}${!own ? ' (from its work or sprint)' : ''}`}
                          onPointerDown={own ? e => { e.preventDefault(); setDrag({ id: i.id, key: i.key, mode: 'move', x0: e.clientX, s0: own.start, e0: own.end, dx: 0 }) } : undefined}
                          onClick={!own ? () => openIssue(i.id) : undefined}>
                          {own && <span className="tl-handle start" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); setDrag({ id: i.id, key: i.key, mode: 'start', x0: e.clientX, s0: own.start, e0: own.end, dx: 0 }) }} />}
                          <span className="tl-bar-label">{x(b.end) - x(b.start) + px > 90 ? i.title : ''}</span>
                          {own && <span className="tl-handle end" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); setDrag({ id: i.id, key: i.key, mode: 'end', x0: e.clientX, s0: own.start, e0: own.end, dx: 0 }) }} />}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* R4: dependencies, from the blocker's end to the blocked item's start; red when broken */}
              <svg className="plan-deps" width={LABEL + days * px} height={rows.length * ROW} aria-hidden>
                {data.dependencies.map(dp => {
                  const a = rowOf.get(dp.fromId), c = rowOf.get(dp.toId), ba = bars.get(dp.fromId), bb = bars.get(dp.toId)
                  if (a == null || c == null || !ba || !bb) return null
                  const x1 = LABEL + x(ba.end) + px, y1 = a * ROW + ROW / 2, x2 = LABEL + x(bb.start), y2 = c * ROW + ROW / 2
                  const bad = broken(dp, bars)
                  return <path key={`${dp.fromId}-${dp.toId}`} className={`plan-dep${bad ? ' broken' : ''}`} d={`M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`} />
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
      {editing && <PlanDialog plan={plan} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    </div>
  )
}
