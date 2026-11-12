// Reports › Control chart (spec 0410), as Jira's: each item that left the chosen columns in the timeframe, at when it left
// and how long it spent in them; the average, the rolling average with its standard deviation band, clusters, and a table.
import { useEffect, useMemo, useState } from 'react'
import { Kanban, ChevronDown } from 'lucide-react'
import { api, errorMessage } from '../api/client'
import { useBoard, useBoards } from '../api/boards'
import { useApp } from '../appContext'
import { clusters, controlStats, defaultColumns, yScale } from '../data/control'
import { dayLabel, DAY } from '../data/analytics'
import type { Project } from '../data/store'
import { useWidth } from './charts'
import { Empty, Picker, plural, typeMeta } from './ui'

interface Item { id: string; key: string; title: string; type: string; leftAt: string; minutes: number }
const TIMEFRAMES = [{ value: 7, label: 'Past week' }, { value: 14, label: 'Past 2 weeks' }, { value: 30, label: 'Past month' }, { value: 90, label: 'Past 3 months' },
  { value: 180, label: 'Past 6 months' }, { value: 365, label: 'Past year' }, { value: 0, label: 'All time' }]
const PAD = { l: 44, r: 12, t: 12, b: 26 }
/** Days as Jira shows elapsed time: "2d 4h", "5h", "40m". */
const elapsed = (days: number) => {
  const m = Math.round(days * 1440), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return d ? `${d}d${h ? ` ${h}h` : ''}` : h ? `${h}h` : `${m}m`
}

export default function ControlChart({ project }: { project: Project }) {
  const { openIssue } = useApp()
  const boards = useBoards(project)
  const [boardId, setBoardId] = useState<string | undefined>()
  const id = boardId ?? boards[0]?.id
  const { board } = useBoard(id)
  const [days, setDays] = useState(90)
  const [columns, setColumns] = useState<string[] | null>(null)              // column ids; null: Jira's default
  const [quick, setQuick] = useState<string[]>([])
  const [data, setData] = useState<{ items: Item[]; truncated: boolean } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { setColumns(null); setQuick([]) }, [id])
  const chosen = board ? (columns ? board.columns.filter(c => columns.includes(c.id)) : defaultColumns(board.columns)) : []
  const statuses = chosen.flatMap(c => c.statusIds)
  useEffect(() => {
    if (!board || !statuses.length) return
    let live = true
    setError(''); setData(null)
    const q = new URLSearchParams({ statuses: statuses.join(','), ...(days ? { days: String(days) } : {}), ...(quick.length ? { quick: quick.join(',') } : {}) })
    api<{ items: Item[]; truncated: boolean }>('GET', `/api/boards/${encodeURIComponent(board.id)}/reports/control?${q}`).then(d => { if (live) setData(d) }, e => { if (live) setError(errorMessage(e)) })
    return () => { live = false }
  }, [board?.id, statuses.join(','), days, quick.join(',')])   // eslint-disable-line react-hooks/exhaustive-deps

  const points = useMemo(() => (data?.items ?? []).map(i => ({ t: Date.parse(i.leftAt), v: i.minutes / 1440, item: i })), [data])
  const stats = useMemo(() => controlStats(points), [points])
  if (!boards.length) return <Empty icon={<Kanban size={22} />} title="No board" body="The control chart is drawn for a board." />

  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter(y => y !== x) : [...list, x])
  return (
    <>
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {boards.length > 1 && <Picker value={id!} title="Board" className="btn btn-secondary" options={boards.map(b => ({ value: b.id, label: b.name }))}
          onChange={setBoardId} trigger={<><Kanban size={15} /><b>{boards.find(b => b.id === id)?.name}</b><ChevronDown size={14} /></>} />}
        <select className="input" style={{ width: 'auto' }} aria-label="Timeframe" value={days} onChange={e => setDays(Number(e.target.value))}>
          {TIMEFRAMES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      {board && (
        <div className="control-refine" aria-label="Refine report">
          <span className="muted sm">Columns</span>
          {board.columns.map(c => (
            <label key={c.id} className="check-row inline"><input type="checkbox" checked={chosen.some(x => x.id === c.id)}
              onChange={() => setColumns(toggle(chosen.map(x => x.id), c.id))} />{c.name}</label>
          ))}
          {board.quickFilters.length > 0 && <span className="muted sm" style={{ marginLeft: 12 }}>Quick filters</span>}
          {board.quickFilters.map(f => (
            <label key={f.id} className="check-row inline"><input type="checkbox" checked={quick.includes(f.id)} onChange={() => setQuick(toggle(quick, f.id))} />{f.name}</label>
          ))}
        </div>
      )}
      {!statuses.length ? <p className="muted">Choose at least one column.</p>
        : error ? <p className="hint error" role="alert">{error}</p>
        : !data ? <p className="muted" role="status">Working out cycle times…</p>
        : !points.length ? <Empty icon={<Kanban size={22} />} title="Nothing to show yet" body="Items appear once they have left the chosen columns within the timeframe." />
        : <>
          <div className="kpis">
            <div><b>{elapsed(stats.average)}</b><span>average</span></div>
            <div><b>{elapsed(stats.median)}</b><span>median</span></div>
            <div><b>{elapsed(stats.min)}</b><span>min</span></div>
            <div><b>{elapsed(stats.max)}</b><span>max</span></div>
            <div><b>{stats.count}</b><span>{stats.count === 1 ? 'item' : 'items'}</span></div>
          </div>
          {data.truncated && <p className="hint">Showing the most recent 5,000 items: choose a shorter timeframe to see them all.</p>}
          <Plot points={points} stats={stats} onOpen={openIssue} project={project} />
          <div className="card-table" style={{ marginTop: 16 }}>
            <table className="table" aria-label="Control chart items">
              <thead><tr><th>Key</th><th>Summary</th><th className="col-num">Cycle time</th><th>Left the columns</th></tr></thead>
              <tbody>
                {[...points].sort((a, b) => b.v - a.v).slice(0, 200).map(p => (
                  <tr key={p.item.id} onClick={() => openIssue(p.item.id)}>
                    <td className="mono">{p.item.key}</td><td>{p.item.title}</td><td className="col-num">{elapsed(p.v)}</td><td className="muted">{new Date(p.t).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {points.length > 200 && <p className="muted sm" style={{ padding: 8 }}>The 200 longest of {plural(points.length, 'item')}.</p>}
          </div>
        </>}
    </>
  )
}

function Plot({ points, stats, onOpen, project }: { points: { t: number; v: number; item: Item }[]; stats: ReturnType<typeof controlStats>; onOpen: (id: string) => void; project: Project }) {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = 320, ih = h - PAD.t - PAD.b
  const t0 = Math.min(...points.map(p => p.t)), t1 = Math.max(...points.map(p => p.t))
  const scale = yScale(Math.max(...points.map(p => p.v), ...stats.rolling.map(r => r.mean + r.sd)))
  const x = (t: number) => PAD.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ih - scale.at(Math.max(0, v)) * ih
  const dots = clusters(points, (t1 - t0) / 120 || DAY, Math.max(stats.max, 1) / 60)
  const line = (f: (r: typeof stats.rolling[number]) => number) => stats.rolling.map((r, i) => `${i ? 'L' : 'M'}${x(r.t)},${y(f(r))}`).join(' ')
  const band = `${line(r => r.mean + r.sd)} ${[...stats.rolling].reverse().map(r => `L${x(r.t)},${y(Math.max(0, r.mean - r.sd))}`).join(' ')} Z`
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const top = Math.max(...points.map(p => p.v), ...stats.rolling.map(r => r.mean + r.sd), 1)
    return scale.kind === 'linear' ? f * top : (f * Math.cbrt(top)) ** 3
  })
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={h} role="img" aria-label="Control chart: cycle time per item">
        {yTicks.map(v => <g key={v}><line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border)" /><text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="axis-text">{elapsed(v)}</text></g>)}
        {[0, 0.25, 0.5, 0.75, 1].map(f => <text key={f} x={PAD.l + f * (w - PAD.l - PAD.r)} y={h - 6} textAnchor="middle" className="axis-text">{dayLabel(t0 + f * (t1 - t0))}</text>)}
        <path d={band} fill="var(--info)" fillOpacity={0.12} stroke="none" />
        <path d={line(r => r.mean)} fill="none" stroke="var(--info)" strokeWidth={2} />
        <line x1={PAD.l} x2={w - PAD.r} y1={y(stats.average)} y2={y(stats.average)} stroke="var(--danger)" strokeDasharray="5 4" strokeWidth={1.5} />
        {dots.map((d, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => d.items.length === 1 && onOpen(d.items[0]!.item.id)} style={{ cursor: d.items.length === 1 ? 'pointer' : 'default' }}>
            <circle cx={x(d.t)} cy={y(d.v)} r={d.items.length > 1 ? 7 : hover === i ? 6 : 4.5} fill={d.items.length > 1 ? 'var(--text-2)' : typeMeta(d.items[0]!.item.type, project).color} fillOpacity={0.85} />
            {d.items.length > 1 && <text x={x(d.t)} y={y(d.v) + 3.5} textAnchor="middle" className="axis-text" fill="#fff">{d.items.length}</text>}
          </g>
        ))}
      </svg>
      {hover !== null && dots[hover] && (
        <div className="chart-tip" style={{ left: Math.min(x(dots[hover]!.t) + 10, w - 220), top: y(dots[hover]!.v) }}>
          {dots[hover]!.items.length > 1
            ? <><div className="chart-tip-title">{dots[hover]!.items.length} items</div><div className="chart-tip-row">average {elapsed(dots[hover]!.v)}</div></>
            : <><div className="chart-tip-title">{dots[hover]!.items[0]!.item.key} {dots[hover]!.items[0]!.item.title}</div><div className="chart-tip-row">{elapsed(dots[hover]!.v)} · left {dayLabel(dots[hover]!.t)}</div></>}
        </div>
      )}
      <div className="legend">
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--info)' }} />Rolling average</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--info)', opacity: 0.25 }} />Standard deviation</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--danger)' }} />Average</span>
      </div>
    </div>
  )
}
