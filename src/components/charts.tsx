// A small SVG chart kit for Summary and Reports. No dependencies; sized to its container.
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface Series { label: string; color: string; values: number[]; dashed?: boolean }

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return { ref, w }
}

/** "Nice" upper bound and ticks for a y axis. */
function ticks(max: number, count = 4) {
  if (max <= 0) return { top: 4, step: 1 }
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw
  return { top: Math.ceil(max / step) * step, step }
}

const PAD = { l: 36, r: 12, t: 12, b: 26 }

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map(i => (
        <span key={i.label} className="legend-item">
          <span className={`legend-swatch${i.dashed ? ' dashed' : ''}`} style={{ background: i.dashed ? 'none' : i.color, borderColor: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

function Tooltip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 0), w - 170)
  return <div className="chart-tip" style={{ left, top: Math.max(0, y - 10) }}>{children}</div>
}

function Axes({ w, h, top, step, labels, every }: { w: number; h: number; top: number; step: number; labels: string[]; every: number }) {
  const ih = h - PAD.t - PAD.b
  const n = labels.length
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - PAD.l - PAD.r))
  const lines = []
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = PAD.t + ih - (v / top) * ih
    lines.push(
      <g key={v}>
        <line x1={PAD.l} x2={w - PAD.r} y1={y} y2={y} className="grid-line" />
        <text x={PAD.l - 6} y={y + 3} textAnchor="end" className="axis-text">{Math.round(v * 10) / 10}</text>
      </g>,
    )
  }
  return (
    <>
      {lines}
      {labels.map((l, i) => i % every === 0 || i === n - 1 ? (
        <text key={i} x={x(i)} y={h - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis-text">{l}</text>
      ) : null)}
    </>
  )
}

/** Line chart; `stacked` draws filled stacked areas (cumulative flow). */
export function LineChart({ labels, series, height = 240, stacked = false, ariaLabel }: {
  labels: string[]; series: Series[]; height?: number; stacked?: boolean; ariaLabel: string
}) {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const n = labels.length
  const sums = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0))
  const max = stacked ? Math.max(...sums, 0) : Math.max(0, ...series.flatMap(s => s.values.filter(v => !Number.isNaN(v))))
  const { top, step } = ticks(max)
  const ih = height - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - PAD.l - PAD.r))
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const every = Math.max(1, Math.ceil(n / Math.floor((w - PAD.l) / 64)))

  const base = labels.map(() => 0)
  const paths = series.map(s => {
    // NaN = no data yet (e.g. future sprint days): break the line there
    if (!stacked) return { s, d: s.values.map((v, i) => Number.isNaN(v) ? '' : `${i && !Number.isNaN(s.values[i - 1]) ? 'L' : 'M'}${x(i)},${y(v)}`).join('') }
    const lower = [...base]
    const upper = s.values.map((v, i) => (base[i] += v))
    const d = upper.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('') +
      lower.map((_, i) => `L${x(n - 1 - i)},${y(lower[n - 1 - i])}`).join('') + 'Z'
    return { s, d }
  })

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={ariaLabel}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGElement).getBoundingClientRect()
          const i = Math.round(((e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r)) * (n - 1))
          setHover(i >= 0 && i < n ? i : null)
        }}>
        <Axes w={w} h={height} top={top} step={step} labels={labels} every={every} />
        {(stacked ? [...paths].reverse() : paths).map(({ s, d }) => stacked
          ? <path key={s.label} d={d} fill={s.color} fillOpacity={0.75} stroke={s.color} strokeWidth={1} />
          : <path key={s.label} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" />)}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="hover-line" />
            {!stacked && series.filter(s => !Number.isNaN(s.values[hover])).map(s => <circle key={s.label} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={3.5} fill={s.color} />)}
          </>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={PAD.t} w={w}>
          <div className="chart-tip-title">{labels[hover]}</div>
          {series.filter(s => !Number.isNaN(s.values[hover])).map(s => <div key={s.label} className="chart-tip-row"><span className="legend-swatch" style={{ background: s.color }} />{s.label}<b>{Math.round((s.values[hover] ?? 0) * 10) / 10}</b></div>)}
        </Tooltip>
      )}
    </div>
  )
}

/** Vertical grouped columns (velocity, created vs resolved). */
export function ColumnChart({ labels, series, height = 240, ariaLabel }: {
  labels: string[]; series: Series[]; height?: number; ariaLabel: string
}) {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const n = labels.length
  const { top, step } = ticks(Math.max(0, ...series.flatMap(s => s.values)))
  const ih = height - PAD.t - PAD.b
  const slot = (w - PAD.l - PAD.r) / Math.max(1, n)
  const bw = Math.min(28, (slot * 0.7) / series.length)
  const every = Math.max(1, Math.ceil(n / Math.floor((w - PAD.l) / 56)))
  const lines = []
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = PAD.t + ih - (v / top) * ih
    lines.push(<g key={v}><line x1={PAD.l} x2={w - PAD.r} y1={yy} y2={yy} className="grid-line" /><text x={PAD.l - 6} y={yy + 3} textAnchor="end" className="axis-text">{v}</text></g>)
  }

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={ariaLabel}>
        {lines}
        {labels.map((l, i) => {
          const cx = PAD.l + slot * i + slot / 2
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} fill={hover === i ? 'var(--hover)' : 'transparent'} />
              {series.map((s, k) => {
                const v = s.values[i] ?? 0
                const bh = (v / top) * ih
                return <rect key={s.label} x={cx - (bw * series.length) / 2 + k * bw} y={PAD.t + ih - bh} width={bw - 2} height={bh} rx={2} fill={s.color} />
              })}
              {(i % every === 0) && <text x={cx} y={height - 8} textAnchor="middle" className="axis-text">{l}</text>}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={PAD.l + slot * hover + slot / 2} y={PAD.t} w={w}>
          <div className="chart-tip-title">{labels[hover]}</div>
          {series.map(s => <div key={s.label} className="chart-tip-row"><span className="legend-swatch" style={{ background: s.color }} />{s.label}<b>{s.values[hover] ?? 0}</b></div>)}
        </Tooltip>
      )}
    </div>
  )
}

export function Donut({ data, size = 168, center, ariaLabel }: {
  data: { label: string; value: number; color: string }[]; size?: number; center: { value: string; label: string }; ariaLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = size / 2 - 12
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} role="img" aria-label={ariaLabel}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hover)" strokeWidth={18} />
        {total > 0 && data.map((d, i) => {
          const len = (d.value / total) * c
          const el = (
            <circle key={d.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color}
              strokeWidth={hover === i ? 22 : 18} strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          )
          offset += len
          return el
        })}
        <text x="50%" y="47%" textAnchor="middle" className="donut-value">{hover !== null ? data[hover].value : center.value}</text>
        <text x="50%" y="60%" textAnchor="middle" className="donut-label">{hover !== null ? data[hover].label : center.label}</text>
      </svg>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={d.label} className={`donut-legend-row${hover === i ? ' hover' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="legend-swatch" style={{ background: d.color }} />
            <span className="donut-legend-label">{d.label}</span>
            <b>{d.value}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Horizontal bars with labels (priority breakdown, workload). */
export function HBars({ data, unit = '' }: { data: { label: ReactNode; value: number; color: string; key: string }[]; unit?: string }) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div className="hbars">
      {data.map(d => (
        <div key={d.key} className="hbar-row">
          <span className="hbar-label">{d.label}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(d.value / max) * 100}%`, background: d.color }} /></span>
          <span className="hbar-value">{d.value}{unit}</span>
        </div>
      ))}
    </div>
  )
}

/** Dots over time (cycle time per item) with an optional horizontal reference line. */
export function Scatter({ points, height = 240, reference, ariaLabel, xLabel }: {
  points: { t: number; v: number; label: string; color: string }[]; height?: number
  reference?: { v: number; label: string }; ariaLabel: string; xLabel: (t: number) => string
}) {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const t0 = Math.min(...points.map(p => p.t)), t1 = Math.max(...points.map(p => p.t))
  const { top, step } = ticks(Math.max(1, ...points.map(p => p.v)))
  const ih = height - PAD.t - PAD.b
  const x = (t: number) => PAD.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const xl = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4)

  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={ariaLabel}>
        <Axes w={w} h={height} top={top} step={step} labels={xl.map(xLabel)} every={1} />
        {reference && (
          <g>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(reference.v)} y2={y(reference.v)} stroke="var(--brand)" strokeDasharray="5 4" strokeWidth={1.5} />
            <text x={w - PAD.r} y={y(reference.v) - 5} textAnchor="end" className="axis-text strong">{reference.label}</text>
          </g>
        )}
        {points.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={hover === i ? 6 : 4.5} fill={p.color} fillOpacity={0.8}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={x(points[hover].t)} y={y(points[hover].v)} w={w}>
          <div className="chart-tip-title">{points[hover].label}</div>
          <div className="chart-tip-row">{Math.round(points[hover].v * 10) / 10} days · {xLabel(points[hover].t)}</div>
        </Tooltip>
      )}
    </div>
  )
}
