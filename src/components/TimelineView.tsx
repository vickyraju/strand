import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, GanttChart, Plus } from 'lucide-react'
import { useStore, userOf, isDone, type Issue, type Project } from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import { Avatar, Empty, TypeIcon, StatusLozenge, plural } from './ui'

const DAY = 86_400_000
type Scale = 'weeks' | 'months'
const DAY_PX: Record<Scale, number> = { weeks: 36, months: 12 }

/** Local-midnight timestamp for a YYYY-MM-DD string, and back. */
export const parseDay = (s: string) => new Date(s + 'T00:00').getTime()
export const toDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const today = () => parseDay(toDay(Date.now()))

/** An item's span in days. Items with only one date get a one-day bar. */
function span(i: Issue): [number, number] | null {
  if (!i.startDate && !i.dueDate) return null
  const start = parseDay(i.startDate ?? i.dueDate!)
  const end = parseDay(i.dueDate ?? i.startDate!)
  return [Math.min(start, end), Math.max(start, end)]
}

interface Row { issue: Issue; depth: 0 | 1; derived?: [number, number] | null; childCount?: number }

export default function TimelineView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openIssue, createIssue } = useApp()
  const [scale, setScale] = useState<Scale>('weeks')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'start' | 'end'; x0: number; s0: number; e0: number; dx: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const all = state.issues.filter(i => i.projectId === project.id)
  const people = [...new Set(all.map(i => i.assigneeId).filter((x): x is string => !!x))].map(id => userOf(state, id)!).filter(Boolean)
  const filters = useFilters(people)
  const visible = new Set(filters.apply(all).map(i => i.id))

  // Rows: each epic followed by its items, then items without an epic. Sub-items stay inside their parent.
  const byRank = (a: Issue, b: Issue) => a.rank - b.rank
  const epics = all.filter(i => i.type === 'epic').sort(byRank)
  const topLevel = all.filter(i => i.type !== 'epic' && (!i.parentId || all.find(p => p.id === i.parentId)?.type === 'epic')).sort(byRank)
  const rows: Row[] = []
  for (const e of epics) {
    const kids = topLevel.filter(i => i.parentId === e.id && visible.has(i.id))
    if (!visible.has(e.id) && kids.length === 0) continue
    const spans = kids.map(span).filter((x): x is [number, number] => !!x)
    rows.push({ issue: e, depth: 0, childCount: kids.length,
      derived: spans.length ? [Math.min(...spans.map(s => s[0])), Math.max(...spans.map(s => s[1]))] : null })
    if (!collapsed.has(e.id)) kids.forEach(k => rows.push({ issue: k, depth: 1 }))
  }
  const loose = topLevel.filter(i => !i.parentId && visible.has(i.id))
  const scheduledLoose = loose.filter(i => span(i))
  const unscheduled = loose.filter(i => !span(i))
  scheduledLoose.forEach(i => rows.push({ issue: i, depth: 0 }))
  useNavList(rows.map(r => r.issue.id))

  // Visible date range: everything scheduled, today, and some padding
  const spans = rows.map(r => span(r.issue) ?? r.derived).filter((x): x is [number, number] => !!x)
  const t0 = Math.min(today(), ...spans.map(s => s[0])) - 14 * DAY
  const t1 = Math.max(today(), ...spans.map(s => s[1])) + 28 * DAY
  const px = DAY_PX[scale]
  const days = Math.round((t1 - t0) / DAY) + 1
  const x = (t: number) => Math.round((t - t0) / DAY) * px

  const scrollToToday = () => scrollRef.current?.scrollTo({ left: Math.max(0, x(today()) - 240), behavior: 'smooth' })
  useEffect(() => { scrollToToday() }, [scale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Header: months, plus weeks or days underneath
  const months: { label: string; left: number; width: number }[] = []
  for (let t = t0; t <= t1;) {
    const d = new Date(t)
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    const end = Math.min(next, t1 + DAY)
    months.push({ label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), left: x(t), width: x(end) - x(t) })
    t = next
  }
  const ticks: { label: string; left: number }[] = []
  for (let t = t0; t <= t1; t += DAY) {
    const d = new Date(t)
    if (scale === 'weeks' ? d.getDay() === 1 : d.getDate() === 1 || d.getDate() === 15) ticks.push({ label: String(d.getDate()), left: x(t) })
  }

  // Dragging a bar: move both dates, or resize from either end. Snaps to whole days.
  const onPointerMove = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }) }
  const onPointerUp = () => {
    if (!drag) return
    const shift = Math.round(drag.dx / px) * DAY
    if (shift) {
      const start = drag.mode === 'end' ? drag.s0 : drag.s0 + shift
      const end = drag.mode === 'start' ? drag.e0 : drag.e0 + shift
      if (start <= end) dispatch({ type: 'updateIssues', ids: [drag.id], patch: { startDate: toDay(start), dueDate: toDay(end) } })
    } else if (drag.mode === 'move') openIssue(drag.id)
    setDrag(null)
  }
  const preview = (i: Issue, s: [number, number]): [number, number] => {
    if (drag?.id !== i.id) return s
    const shift = Math.round(drag.dx / px) * DAY
    const start = drag.mode === 'end' ? s[0] : s[0] + shift
    const end = drag.mode === 'start' ? s[1] : s[1] + shift
    return start <= end ? [start, end] : s
  }

  if (all.length === 0) {
    return <Empty icon={<GanttChart size={22} strokeWidth={1.5} />} title="Plan work over time"
      body="Add work items with start and due dates to see them on the timeline. Epics roll up the dates of their items."
      action={<button className="btn btn-primary" onClick={() => createIssue({ projectId: project.id, type: 'epic' })}><Plus size={15} />Create epic</button>} />
  }

  return (
    <div className="page-col">
      <div className="toolbar">
        {filters.toolbar}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={scrollToToday}>Today</button>
        <div className="segmented" role="tablist" aria-label="Scale">
          {(['weeks', 'months'] as const).map(s => (
            <button key={s} role="tab" aria-selected={scale === s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>{s === 'weeks' ? 'Weeks' : 'Months'}</button>
          ))}
        </div>
      </div>

      <div className="tl" ref={scrollRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <div className="tl-grid" style={{ width: 320 + days * px }}>
          <div className="tl-head">
            <div className="tl-corner">Work</div>
            <div className="tl-scale" style={{ width: days * px }}>
              {months.map(m => <div key={m.left} className="tl-month" style={{ left: m.left, width: m.width }}>{m.label}</div>)}
              {ticks.map(t => <div key={t.left} className="tl-tick" style={{ left: t.left }}>{t.label}</div>)}
            </div>
          </div>

          <div className="tl-body">
            <div className="tl-today" style={{ left: 320 + x(today()) + px / 2 }} title="Today" />
            {rows.map(({ issue: i, depth, derived, childCount }) => {
              const own = span(i)
              const s = own ? preview(i, own) : derived
              const done = isDone(project, i)
              const status = project.statuses.find(st => st.id === i.status)
              const isEpic = i.type === 'epic'
              return (
                <div key={i.id} className={`tl-row${isEpic ? ' epic' : ''}`}>
                  <div className={`tl-label depth-${depth}`}>
                    {isEpic ? (
                      <button className="icon-btn sm" onClick={() => setCollapsed(c => { const n = new Set(c); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n })}
                        aria-label={collapsed.has(i.id) ? `Expand ${i.key}` : `Collapse ${i.key}`} aria-expanded={!collapsed.has(i.id)}>
                        {collapsed.has(i.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </button>
                    ) : <span style={{ width: 26 }} />}
                    <TypeIcon type={i.type} size={14} />
                    <button className="tl-title" onClick={() => openIssue(i.id)} title={`${i.key} ${i.title}`}>
                      <span className={`mono muted${done ? ' done' : ''}`}>{i.key}</span>
                      <span className={`cell-ellipsis${done ? ' done-text' : ''}`}>{i.title}</span>
                    </button>
                    {isEpic && <span className="muted sm nowrap">{childCount}</span>}
                  </div>
                  <div className="tl-track" style={{ width: days * px }}>
                    {s ? (
                      <div
                        className={`tl-bar${isEpic ? ' epic' : ''}${!own ? ' derived' : ''}${done ? ' done' : ''}${drag?.id === i.id ? ' dragging' : ''}`}
                        style={{ left: x(s[0]), width: x(s[1]) - x(s[0]) + px, ['--bar' as string]: isEpic ? '#7C3AED' : status?.color }}
                        title={`${i.key}: ${new Date(s[0]).toLocaleDateString()} – ${new Date(s[1]).toLocaleDateString()}${!own ? ' (from its items)' : ''}`}
                        onPointerDown={own ? e => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ id: i.id, mode: 'move', x0: e.clientX, s0: own[0], e0: own[1], dx: 0 }) } : undefined}
                        onClick={!own ? () => openIssue(i.id) : undefined}
                      >
                        {own && <span className="tl-handle start" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); setDrag({ id: i.id, mode: 'start', x0: e.clientX, s0: own[0], e0: own[1], dx: 0 }) }} />}
                        <span className="tl-bar-label">{x(s[1]) - x(s[0]) + px > 90 ? i.title : ''}</span>
                        {own && i.assigneeId && x(s[1]) - x(s[0]) + px > 60 && <Avatar user={userOf(state, i.assigneeId)} size={18} />}
                        {own && <span className="tl-handle end" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); setDrag({ id: i.id, mode: 'end', x0: e.clientX, s0: own[0], e0: own[1], dx: 0 }) }} />}
                      </div>
                    ) : (
                      <button className="tl-schedule" style={{ left: x(today()) }} onClick={() => dispatch({ type: 'updateIssues', ids: [i.id], patch: { startDate: toDay(today()), dueDate: toDay(today() + 13 * DAY) } })}>
                        <Plus size={12} />Schedule
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <details className="tl-unscheduled">
          <summary>{plural(unscheduled.length, 'item')} without dates</summary>
          <div className="tl-unscheduled-list">
            {unscheduled.map(i => (
              <div key={i.id} className="tl-unscheduled-row">
                <TypeIcon type={i.type} size={13} />
                <button className="link-target" onClick={() => openIssue(i.id)}><span className="mono muted">{i.key}</span><span className="cell-ellipsis">{i.title}</span></button>
                <StatusLozenge status={project.statuses.find(s => s.id === i.status)} />
                <button className="btn btn-secondary btn-sm" onClick={() => dispatch({ type: 'updateIssues', ids: [i.id], patch: { startDate: toDay(today()), dueDate: toDay(today() + 13 * DAY) } })}>Schedule</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
