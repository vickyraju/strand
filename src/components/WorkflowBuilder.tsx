import { useMemo, useRef, useState } from 'react'
import { Plus, ArrowLeft, Trash2, AlertTriangle, Workflow, List as ListIcon, MousePointerClick } from 'lucide-react'
import { useStore, uid, CATEGORY_COLOR, type Project, type Status, type Transition, type Category } from '../data/store'
import { useApp } from '../appContext'
import { Checkbox, Toggle, Modal, plural } from './ui'

const NODE_W = 156
const NODE_H = 40
const CATS: { id: Category; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'in-progress', label: 'In progress' }, { id: 'done', label: 'Done' }]

type Selection = { kind: 'status'; id: string } | { kind: 'transition'; id: string } | null

export default function WorkflowBuilder({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject, toast } = useApp()
  const [statuses, setStatuses]       = useState<Status[]>(project.statuses)
  const [transitions, setTransitions] = useState<Transition[]>(project.transitions)
  const [layout, setLayout]           = useState(project.layout)
  const [selected, setSelected]       = useState<Selection>(null)
  const [view, setView]               = useState<'diagram' | 'list'>('diagram')
  const [remap, setRemap]             = useState<Record<string, string>>({})
  const [errors, setErrors]           = useState<string[]>([])
  const [leaving, setLeaving]         = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  const dirty = JSON.stringify([statuses, transitions, layout]) !== JSON.stringify([project.statuses, project.transitions, project.layout])
  const usage = (id: string) => state.issues.filter(i => i.projectId === project.id && i.status === id).length

  // Default positions: left to right in workflow order, staggered so arrows stay readable
  const pos = (s: Status, i: number) => layout[s.id] ?? { x: 120 + i * 240, y: 200 }
  const positions = Object.fromEntries(statuses.map((s, i) => [s.id, pos(s, i)]))
  const width  = Math.max(900, ...Object.values(positions).map(p => p.x + NODE_W + 80))
  const height = Math.max(420, ...Object.values(positions).map(p => p.y + NODE_H + 120))

  const toSvg = (e: React.PointerEvent) => {
    const pt = svgRef.current!.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    return pt.matrixTransform(svgRef.current!.getScreenCTM()!.inverse())
  }

  // ── Editing helpers ──────────────────────────────────────
  const updateStatus = (id: string, patch: Partial<Status>) => setStatuses(xs => xs.map(s => s.id === id ? { ...s, ...patch } : s))
  const updateTransition = (id: string, patch: Partial<Transition>) => setTransitions(xs => xs.map(t => t.id === id ? { ...t, ...patch } : t))
  const anyInto = (statusId: string) => transitions.find(t => t.to === statusId && t.from === 'any')

  const addStatus = () => {
    const id = uid()
    const name = `New status ${statuses.length + 1}`
    // New statuses go before the done columns
    setStatuses(xs => {
      const at = xs.findIndex(x => x.category === 'done')
      const st: Status = { id, name, color: '#78716C', category: 'in-progress' }
      return at < 0 ? [...xs, st] : [...xs.slice(0, at), st, ...xs.slice(at)]
    })
    // Usable straight away: anything can move in, and it can move on to the first in-progress status
    const next = statuses.find(s => s.category === 'in-progress') ?? statuses[0]
    setTransitions(xs => [...xs, { id: uid(), name, from: 'any', to: id }, { id: uid(), name: `Move to ${next.name}`, from: [id], to: next.id }])
    setSelected({ kind: 'status', id })
  }
  const addTransition = () => {
    const id = uid()
    setTransitions(xs => [...xs, { id, name: 'New transition', from: [statuses[0].id], to: statuses[Math.min(1, statuses.length - 1)].id }])
    setSelected({ kind: 'transition', id })
  }
  const deleteStatus = (id: string) => {
    if (statuses.length <= 1) return
    if (usage(id) && !remap[id]) setRemap(r => ({ ...r, [id]: statuses.find(s => s.id !== id)!.id }))
    setStatuses(xs => xs.filter(s => s.id !== id))
    setTransitions(xs => xs.filter(t => t.to !== id).map(t => t.from === 'any' ? t : { ...t, from: t.from.filter(f => f !== id) }).filter(t => t.from === 'any' || t.from.length))
    setSelected(null)
  }

  const validate = () => {
    const errs: string[] = []
    if (!statuses.some(s => s.category === 'done')) errs.push('Add at least one status in the Done category so work can be finished.')
    for (const s of statuses.slice(1)) {
      if (!transitions.some(t => t.to === s.id)) errs.push(`“${s.name}” can’t be reached. Add a transition into it.`)
    }
    for (const s of statuses) {
      if (s.category !== 'done' && !transitions.some(t => t.to !== s.id && (t.from === 'any' || t.from.includes(s.id)))) {
        errs.push(`Work can’t leave “${s.name}”. Add a transition out of it.`)
      }
    }
    if (statuses.some(s => !s.name.trim())) errs.push('Every status needs a name.')
    return errs
  }

  const save = () => {
    const errs = validate()
    setErrors(errs)
    if (errs.length) return
    // Remap items on deleted statuses first, while both statuses still exist
    const removed = project.statuses.filter(s => !statuses.some(x => x.id === s.id) && usage(s.id))
    if (removed.length) {
      dispatch({ type: 'updateProject', id: project.id, patch: { statuses: [...statuses, ...removed] } })
      for (const s of removed) dispatch({ type: 'remapStatus', projectId: project.id, from: s.id, to: remap[s.id] ?? statuses[0].id })
    }
    dispatch({ type: 'updateProject', id: project.id, patch: { statuses, transitions, layout } })
    setRemap({})
    toast('Workflow updated')
  }
  const discard = () => { setStatuses(project.statuses); setTransitions(project.transitions); setLayout(project.layout); setRemap({}); setErrors([]); setSelected(null) }

  // ── Edge geometry ────────────────────────────────────────
  const edges = useMemo(() => transitions.flatMap(t => {
    if (t.from === 'any') return []
    return t.from.filter(f => positions[f] && positions[t.to]).map(f => ({ t, from: f }))
  }), [transitions, positions]) // eslint-disable-line react-hooks/exhaustive-deps

  const edgePath = (from: string, to: string) => {
    const a = positions[from], b = positions[to]
    const forward = a.x <= b.x
    const x1 = forward ? a.x + NODE_W : a.x, y1 = a.y + NODE_H / 2 + (forward ? -6 : 6)
    const x2 = forward ? b.x : b.x + NODE_W, y2 = b.y + NODE_H / 2 + (forward ? -6 : 6)
    // Longer jumps curve further so labels on parallel edges don't collide
    const dist = Math.abs(x2 - x1)
    const bend = forward ? -30 - dist * 0.08 : 40 + dist * 0.14
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2 + bend
    return { d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, mx: (x1 + 2 * cx + x2) / 4, my: (y1 + 2 * cy + y2) / 4 }
  }

  const sel = selected
  const selStatus = sel?.kind === 'status' ? statuses.find(s => s.id === sel.id) : undefined
  const selTransition = sel?.kind === 'transition' ? transitions.find(t => t.id === sel.id) : undefined
  const pendingRemaps = Object.entries(remap).filter(([id]) => !statuses.some(s => s.id === id))

  return (
    <div className="wf">
      <div className="wf-bar">
        <button className="btn btn-ghost" onClick={() => dirty ? setLeaving(true) : openProject(project.id, 'settings')}><ArrowLeft size={15} />Settings</button>
        <h2 className="wf-title">Workflow</h2>
        {dirty && <span className="lozenge lozenge-in-progress">Unsaved changes</span>}
        <div style={{ flex: 1 }} />
        <div className="segmented" role="tablist" aria-label="Workflow view">
          <button role="tab" aria-selected={view === 'diagram'} className={view === 'diagram' ? 'on' : ''} onClick={() => setView('diagram')}><Workflow size={14} />Diagram</button>
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}><ListIcon size={14} />List</button>
        </div>
        <button className="btn btn-secondary" onClick={addStatus}><Plus size={15} />Add status</button>
        <button className="btn btn-secondary" onClick={addTransition} disabled={statuses.length < 2}><Plus size={15} />Add transition</button>
        <button className="btn btn-secondary" onClick={discard} disabled={!dirty}>Discard changes</button>
        <button className="btn btn-primary" onClick={save} disabled={!dirty}>Update workflow</button>
      </div>

      {errors.length > 0 && (
        <div className="callout callout-danger wf-errors" role="alert">
          <AlertTriangle size={16} />
          <div><b>Fix these before saving:</b><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>
        </div>
      )}

      <div className="wf-body">
        <div className="wf-canvas">
          {view === 'diagram' ? (
            <svg ref={svgRef} width={width} height={height} className="wf-svg"
              onPointerMove={e => {
                if (!drag.current) return
                const p = toSvg(e)
                const id = drag.current.id
                setLayout(l => ({ ...l, [id]: { x: Math.max(10, Math.round((p.x - drag.current!.dx) / 10) * 10), y: Math.max(10, Math.round((p.y - drag.current!.dy) / 10) * 10) } }))
              }}
              onPointerUp={() => { drag.current = null }}
              onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
                </marker>
                <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--brand)" />
                </marker>
              </defs>

              {/* Start → first status */}
              {statuses[0] && (
                <g>
                  <circle cx={44} cy={positions[statuses[0].id].y + NODE_H / 2} r={18} fill="var(--text-1)" />
                  <text x={44} y={positions[statuses[0].id].y + NODE_H / 2 + 3} textAnchor="middle" className="wf-start">START</text>
                  <path d={`M62,${positions[statuses[0].id].y + NODE_H / 2} L${positions[statuses[0].id].x},${positions[statuses[0].id].y + NODE_H / 2}`}
                    stroke="var(--text-3)" strokeWidth={1.5} markerEnd="url(#arrow)" fill="none" />
                </g>
              )}

              {edges.map(({ t, from }) => {
                const { d, mx, my } = edgePath(from, t.to)
                const on = sel?.kind === 'transition' && sel.id === t.id
                const target = statuses.find(s => s.id === t.to)
                return (
                  <g key={`${t.id}-${from}`} className="wf-edge" onClick={() => setSelected({ kind: 'transition', id: t.id })}>
                    <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
                    <path d={d} stroke={on ? 'var(--brand)' : 'var(--text-3)'} strokeWidth={on ? 2.25 : 1.5} fill="none" markerEnd={`url(#${on ? 'arrow-sel' : 'arrow'})`} />
                    {t.name !== target?.name && (
                      <g transform={`translate(${mx},${my})`}>
                        <rect x={-t.name.length * 3.3 - 8} y={-10} width={t.name.length * 6.6 + 16} height={20} rx={10} className={`wf-label${on ? ' on' : ''}`} />
                        <text textAnchor="middle" y={4} className="wf-label-text">{t.name}</text>
                      </g>
                    )}
                  </g>
                )
              })}

              {statuses.map(s => {
                const p = positions[s.id]
                const any = anyInto(s.id)
                const on = sel?.kind === 'status' && sel.id === s.id
                return (
                  <g key={s.id}>
                    {any && (
                      <g className="wf-edge" onClick={() => setSelected({ kind: 'transition', id: any.id })}>
                        <path d={`M${p.x + NODE_W / 2},${p.y - 30} L${p.x + NODE_W / 2},${p.y}`} stroke="var(--text-3)" strokeWidth={1.5} markerEnd="url(#arrow)" />
                        <rect x={p.x + NODE_W / 2 - 18} y={p.y - 46} width={36} height={18} rx={9} className={`wf-any${sel?.kind === 'transition' && sel.id === any.id ? ' on' : ''}`} />
                        <text x={p.x + NODE_W / 2} y={p.y - 33} textAnchor="middle" className="wf-any-text">Any</text>
                      </g>
                    )}
                    <g className={`wf-node${on ? ' on' : ''}`} transform={`translate(${p.x},${p.y})`}
                      onPointerDown={e => {
                        const q = toSvg(e)
                        drag.current = { id: s.id, dx: q.x - p.x, dy: q.y - p.y }
                        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
                        setSelected({ kind: 'status', id: s.id })
                      }}
                      tabIndex={0} role="button" aria-label={`Status ${s.name}`}
                      onKeyDown={e => { if (e.key === 'Enter') setSelected({ kind: 'status', id: s.id }) }}>
                      <rect width={NODE_W} height={NODE_H} rx={6} className="wf-node-box" style={{ ['--cat' as string]: CATEGORY_COLOR[s.category] }} />
                      <rect width={4} height={NODE_H} rx={2} fill={s.color} />
                      <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" className="wf-node-text">
                        {s.name.length > 20 ? s.name.slice(0, 19) + '…' : s.name.toUpperCase()}
                      </text>
                      {s.wipLimit != null && <text x={NODE_W - 8} y={12} textAnchor="end" className="wf-wip">max {s.wipLimit}</text>}
                    </g>
                  </g>
                )
              })}
            </svg>
          ) : (
            <div className="wf-list">
              <h3 className="section-label">Statuses</h3>
              <div className="card-table">
                <table className="table">
                  <thead><tr><th>Status</th><th>Category</th><th className="col-num">Items</th><th>Incoming</th></tr></thead>
                  <tbody>
                    {statuses.map(s => (
                      <tr key={s.id} tabIndex={0} onClick={() => setSelected({ kind: 'status', id: s.id })} className={sel?.kind === 'status' && sel.id === s.id ? 'selected' : ''}>
                        <td><span className="cell-flex"><span className="status-dot" style={{ background: s.color }} />{s.name}</span></td>
                        <td><span className={`lozenge lozenge-${s.category}`}>{CATS.find(c => c.id === s.category)!.label}</span></td>
                        <td className="col-num">{usage(s.id)}</td>
                        <td className="muted">{anyInto(s.id) ? 'From any status' : plural(transitions.filter(t => t.to === s.id).length, 'transition')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="section-label" style={{ marginTop: 20 }}>Transitions</h3>
              <div className="card-table">
                <table className="table">
                  <thead><tr><th>Name</th><th>From</th><th>To</th></tr></thead>
                  <tbody>
                    {transitions.map(t => (
                      <tr key={t.id} tabIndex={0} onClick={() => setSelected({ kind: 'transition', id: t.id })} className={sel?.kind === 'transition' && sel.id === t.id ? 'selected' : ''}>
                        <td>{t.name}</td>
                        <td>{t.from === 'any' ? <span className="muted">Any status</span> : t.from.map(f => statuses.find(s => s.id === f)?.name).join(', ')}</td>
                        <td>{statuses.find(s => s.id === t.to)?.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <aside className="wf-panel" aria-label="Properties">
          {selStatus ? (
            <>
              <div className="wf-panel-kind">Status</div>
              <label className="label" htmlFor="wf-name">Name</label>
              <input id="wf-name" className="input" value={selStatus.name} onChange={e => {
                const name = e.target.value
                // Keep the auto "any" transition named after its status
                setTransitions(xs => xs.map(t => t.to === selStatus.id && t.name === selStatus.name ? { ...t, name } : t))
                updateStatus(selStatus.id, { name })
              }} />
              <label className="label" style={{ marginTop: 12 }}>Category</label>
              <div className="segmented full">
                {CATS.map(c => (
                  <button key={c.id} className={selStatus.category === c.id ? 'on' : ''} onClick={() => updateStatus(selStatus.id, { category: c.id })}>{c.label}</button>
                ))}
              </div>
              <p className="hint">Categories drive reports and decide when work counts as finished.</p>
              <div className="form-row" style={{ marginTop: 12 }}>
                <div>
                  <label className="label" htmlFor="wf-color">Color</label>
                  <input id="wf-color" type="color" className="color-input" value={selStatus.color} onChange={e => updateStatus(selStatus.id, { color: e.target.value })} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="label" htmlFor="wf-wip">WIP limit</label>
                  <input id="wf-wip" className="input" type="number" min={1} placeholder="No limit" value={selStatus.wipLimit ?? ''}
                    onChange={e => updateStatus(selStatus.id, { wipLimit: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })} />
                </div>
              </div>
              <label className="toggle-row" style={{ marginTop: 14 }}>
                <span>Allow all statuses to move here</span>
                <Toggle on={!!anyInto(selStatus.id)} label="Allow all statuses to move here" onChange={on => setTransitions(xs => on
                  ? [...xs, { id: uid(), name: selStatus.name, from: 'any', to: selStatus.id }]
                  : xs.filter(t => !(t.to === selStatus.id && t.from === 'any')))} />
              </label>
              <div className="wf-panel-foot">
                <span className="muted sm">{plural(usage(selStatus.id), 'work item')} in this status</span>
                <button className="btn btn-secondary text-danger" disabled={statuses.length <= 1} onClick={() => deleteStatus(selStatus.id)}><Trash2 size={14} />Delete status</button>
              </div>
            </>
          ) : selTransition ? (
            <>
              <div className="wf-panel-kind">Transition</div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>Transitions are the moves people can make. Only these appear in status menus and on the board.</p>
              <label className="label" htmlFor="wf-tname">Name</label>
              <input id="wf-tname" className="input" value={selTransition.name} onChange={e => updateTransition(selTransition.id, { name: e.target.value })} />
              <label className="label" style={{ marginTop: 12 }}>From statuses</label>
              <label className="check-row">
                <Checkbox checked={selTransition.from === 'any'} label="Any status"
                  onChange={on => updateTransition(selTransition.id, { from: on ? 'any' : statuses.filter(s => s.id !== selTransition.to).slice(0, 1).map(s => s.id) })} />
                Any status
              </label>
              {selTransition.from !== 'any' && statuses.filter(s => s.id !== selTransition.to).map(s => {
                const from = selTransition.from as string[]
                return (
                  <label key={s.id} className="check-row">
                    <Checkbox checked={from.includes(s.id)} label={s.name}
                      onChange={on => updateTransition(selTransition.id, { from: on ? [...from, s.id] : from.filter(f => f !== s.id) })} />
                    <span className="status-dot" style={{ background: s.color }} />{s.name}
                  </label>
                )
              })}
              <label className="label" htmlFor="wf-to" style={{ marginTop: 12 }}>To status</label>
              <select id="wf-to" className="input" value={selTransition.to} onChange={e => updateTransition(selTransition.id, {
                to: e.target.value, from: selTransition.from === 'any' ? 'any' : selTransition.from.filter(f => f !== e.target.value),
              })}>
                {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div className="wf-panel-foot">
                <span />
                <button className="btn btn-secondary text-danger" onClick={() => { setTransitions(xs => xs.filter(t => t.id !== selTransition.id)); setSelected(null) }}>
                  <Trash2 size={14} />Delete transition
                </button>
              </div>
            </>
          ) : (
            <div className="wf-panel-empty">
              <MousePointerClick size={22} strokeWidth={1.5} />
              <p>Select a status or transition to edit it. Drag statuses to rearrange the diagram.</p>
              <ul className="wf-legend">
                <li><span className="wf-any-pill">Any</span> every status can move here</li>
                <li><span className="wf-arrow" /> an allowed move between two statuses</li>
              </ul>
            </div>
          )}

          {pendingRemaps.length > 0 && (
            <div className="callout callout-warn" style={{ marginTop: 16 }}>
              <AlertTriangle size={15} />
              <div>
                {pendingRemaps.map(([id, to]) => {
                  const old = project.statuses.find(s => s.id === id)
                  return (
                    <div key={id}>
                      <b>{plural(usage(id), 'item')}</b> in “{old?.name}” will move to{' '}
                      <select className="input inline" value={to} onChange={e => setRemap(r => ({ ...r, [id]: e.target.value }))} aria-label={`New status for items in ${old?.name}`}>
                        {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </aside>
      </div>

      {leaving && (
        <Modal title="Discard unsaved changes?" onClose={() => setLeaving(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setLeaving(false)}>Keep editing</button>
            <button className="btn btn-danger" onClick={() => openProject(project.id, 'settings')}>Discard and leave</button>
          </>}>
          <p>Your workflow changes haven’t been saved.</p>
        </Modal>
      )}
    </div>
  )
}
