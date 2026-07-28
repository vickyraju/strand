import { useState } from 'react'
import {
  MoreHorizontal, Bell, Download, Plus, Sparkles,
  ChevronDown, X, TrendingUp, TrendingDown, Timer, Activity,
  BarChart2 as BarChartIcon, ShieldAlert, Layers, Users, Code2,
  Mail, FileText, Image as ImgIcon, Link as LinkIcon,
  AlertTriangle, Minimize2, Maximize2, RefreshCw,
} from 'lucide-react'
import { useForge } from '../App'

// ══════════════════════════════════════════════════════════
// DATA
// ══════════════════════════════════════════════════════════

const BLOCKED_ITEMS = [
  { key: 'PAY-393',   title: 'Settlement webhook retries exhausted after 3rd-party timeout',  days: 8, av: { i: 'DO', c: '#0891B2' } },
  { key: 'PLAT-4825', title: 'Memory leak in reconciliation job under high-cardinality load',  days: 5, av: { i: 'MC', c: '#EA580C' } },
  { key: 'RISK-1204', title: 'SOC 2 audit trail quarterly review — scope unclear',             days: 3, av: { i: 'PR', c: '#006044' } },
  { key: 'PAY-416',   title: 'Webhook delivery log retention: enforce 90-day default policy',  days: 1, av: { i: 'SM', c: '#16A34A' } },
]

const SCOPE_CHANGES = [
  { key: 'PAY-419',  action: 'added',   delta: '+5', time: '2d ago',  deltaPos: true  },
  { key: 'PAY-427',  action: 'removed', delta: '−3', time: '4d ago',  deltaPos: false },
  { key: 'PLAT-4829',action: 'added',   delta: '+8', time: '5d ago',  deltaPos: true  },
  { key: 'PAY-418',  action: 'changed', delta: '+2', time: '7d ago',  deltaPos: true  },
]

const WIP_COLS = [
  { name: 'Todo',        count: 12, limit: null, color: '#A8A29E' },
  { name: 'In progress', count: 6,  limit: 6,    color: '#F59E0B' }, // at limit
  { name: 'In review',   count: 3,  limit: 5,    color: '#006044' },
  { name: 'Done',        count: 24, limit: null, color: '#16A34A' },
]

const THROUGHPUT_WEEKS = [
  { label: 'Jul 1',  pts: 18, partial: false },
  { label: 'Jul 8',  pts: 22, partial: false },
  { label: 'Jul 14', pts: 15, partial: false },
  { label: 'This',   pts: 9,  partial: true  },
]

const SPARKLINE_DATA = [4.2, 3.8, 4.5, 3.9, 4.1, 3.6, 4.0, 3.4]

// Burnup chart data
const CHART_W = 460, CHART_H = 170
const PAD = { l: 36, r: 16, t: 14, b: 30 }
const PLOT_W = CHART_W - PAD.l - PAD.r
const PLOT_H = CHART_H - PAD.t - PAD.b
const MAX_PTS = 60

const COMPLETED = [0,1,2,4,6,8,10,12,13,15,17,18,20,21,22,24,25,27,28,30,32,33,34,35,37,38,39,40,41,42]
const SCOPE_STEPS: [number, number][] = [
  [0,48],[10,48],[11,52],[20,52],[21,55],[29,55]
]

function px(day: number) { return PAD.l + (day / 29) * PLOT_W }
function py(val: number) { return PAD.t + PLOT_H - (val / MAX_PTS) * PLOT_H }

function stepsPath(pts: [number, number][]): string {
  return pts.map(([d, v], i) => `${i === 0 ? 'M' : 'L'}${px(d).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
}
function linePath(vals: number[]): string {
  return vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
}
function areaPath(vals: number[]): string {
  const line = vals.map((v, i) => `L${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  return `M${px(0)},${py(0)} ${line} L${px(29)},${py(0)} Z`
}

// ══════════════════════════════════════════════════════════
// MINI SPARKLINE
// ══════════════════════════════════════════════════════════
function Sparkline() {
  const W = 80, H = 30
  const max = Math.max(...SPARKLINE_DATA) + 0.2
  const min = Math.min(...SPARKLINE_DATA) - 0.2
  const pts = SPARKLINE_DATA.map((v, i) => {
    const x = (i / (SPARKLINE_DATA.length - 1)) * W
    const y = H - ((v - min) / (max - min)) * (H - 4) - 2
    return [x.toFixed(1), y.toFixed(1)]
  })
  const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
  const areaD = `M0,${H} ${lineD} L${W},${H} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      <path d={areaD} fill="#76A923" fillOpacity={0.15} />
      <path d={lineD} fill="none" stroke="#76A923" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ══════════════════════════════════════════════════════════
// BURNUP CHART
// ══════════════════════════════════════════════════════════
function BurnupChart({ compact = false }: { compact?: boolean }) {
  const yTicks = [0, 20, 40, 60]
  const xTicks = [0, 5, 10, 15, 20, 25, 29]
  const fontSize = compact ? 9 : 10
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      style={{ width: '100%', height: '100%' }}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y grid + labels */}
      {yTicks.map(v => (
        <g key={v}>
          <line x1={PAD.l} y1={py(v)} x2={CHART_W - PAD.r} y2={py(v)}
            stroke="#F0F0EE" strokeWidth="1" />
          <text x={PAD.l - 5} y={py(v)} textAnchor="end" dominantBaseline="middle"
            fill="#A8A29E" fontSize={fontSize}>{v}</text>
        </g>
      ))}
      {/* X labels */}
      {xTicks.map(d => (
        <text key={d} x={px(d)} y={CHART_H - 6} textAnchor="middle"
          fill="#A8A29E" fontSize={fontSize}>
          {d === 0 ? 'D1' : d === 29 ? 'D30' : `D${d}`}
        </text>
      ))}
      {/* Ideal (dotted) */}
      <line x1={px(0)} y1={py(0)} x2={px(29)} y2={py(55)}
        stroke="#D4D0CE" strokeWidth="1.5" strokeDasharray="4 3" />
      {/* Scope line (gray steps) */}
      <path d={stepsPath(SCOPE_STEPS)} fill="none"
        stroke="#C8C4C0" strokeWidth="2" strokeLinejoin="round" />
      {/* Completed area */}
      <path d={areaPath(COMPLETED)} fill="#006044" fillOpacity="0.07" />
      {/* Completed line */}
      <path d={linePath(COMPLETED)} fill="none"
        stroke="#006044" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* Today marker */}
      <line x1={px(29)} y1={PAD.t} x2={px(29)} y2={PAD.t + PLOT_H}
        stroke="#006044" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.4" />
      {/* Legend */}
      {!compact && (
        <g transform={`translate(${PAD.l + 8},${PAD.t + 6})`}>
          <line x1={0} y1={5} x2={14} y2={5} stroke="#C8C4C0" strokeWidth="2" />
          <text x={18} y={8} fill="#78716C" fontSize={10}>Scope</text>
          <line x1={52} y1={5} x2={66} y2={5} stroke="#006044" strokeWidth="2.5" />
          <text x={70} y={8} fill="#78716C" fontSize={10}>Completed</text>
          <line x1={128} y1={5} x2={142} y2={5} stroke="#D4D0CE" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x={146} y={8} fill="#78716C" fontSize={10}>Ideal</text>
        </g>
      )}
    </svg>
  )
}

// ══════════════════════════════════════════════════════════
// TILE SHELL
// ══════════════════════════════════════════════════════════
interface TileProps {
  title?: string
  colSpan?: number
  rowSpan?: number
  children?: React.ReactNode
  isDragging?: boolean
  isError?: boolean
  isDropSlot?: boolean
  gridArea?: string
}

function Tile({ title, colSpan = 3, rowSpan = 2, children, isDragging, isError, isDropSlot, gridArea }: TileProps) {
  const gridStyle: React.CSSProperties = gridArea
    ? { gridArea }
    : { gridColumn: `span ${colSpan}`, gridRow: `span ${rowSpan}` }

  if (isDropSlot) {
    return (
      <div className="dash-drop-slot" style={gridStyle}>
        <div className="dash-drop-label">Drop here</div>
      </div>
    )
  }

  return (
    <div className={`dash-tile${isDragging ? ' is-dragging' : ''}`} style={gridStyle}>
      <div className="dash-tile-hdr">
        <span className="dash-tile-title">{title}</span>
        {isError && (
          <span className="dash-tile-err">
            <AlertTriangle size={11} strokeWidth={2} />
            Data delayed 22m
          </span>
        )}
        {isDragging && (
          <span className="dash-tile-drag-badge">dragging</span>
        )}
        <button className="dash-tile-menu-btn">
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="dash-tile-body" style={{ opacity: isError ? 0.3 : 1 }}>
        {children}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// TILE BODIES
// ══════════════════════════════════════════════════════════

function CycleTimeTileBody() {
  return (
    <div className="dash-kpi-body">
      <div className="dash-kpi-number">
        3.4<span className="dash-kpi-unit">d</span>
      </div>
      <div className="dash-kpi-delta">▼ 0.6d vs last sprint</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', paddingTop: 8 }}>
        <Sparkline />
      </div>
      <div className="dash-kpi-sub">avg. story · last 8 sprints</div>
    </div>
  )
}

function WipTileBody() {
  const maxCount = 24
  return (
    <div className="dash-wip-body">
      {WIP_COLS.map(col => {
        const atLimit = col.limit !== null && col.count >= col.limit
        const pct = Math.min(100, (col.count / maxCount) * 100)
        return (
          <div key={col.name} className="dash-wip-row">
            <div className="dash-wip-row-hdr">
              <span className="dash-wip-label">{col.name}</span>
              <span className={`dash-wip-count${atLimit ? ' at-limit' : ''}`}>
                {col.count}{col.limit ? `/${col.limit}` : ''}
                {atLimit && <span className="dash-wip-flag"> · at limit</span>}
              </span>
            </div>
            <div className="dash-wip-bar-track">
              <div className="dash-wip-bar-fill" style={{
                width: `${pct}%`,
                background: atLimit ? '#F59E0B' : col.color,
              }} />
              {col.limit && (
                <div className="dash-wip-limit-line"
                  style={{ left: `${(col.limit / maxCount) * 100}%` }} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BlockedTileBody() {
  return (
    <div className="dash-blocked-body">
      <div className="dash-blocked-hdr">
        <span style={{ width: 80 }}>Key</span>
        <span style={{ flex: 1 }}>Title</span>
        <span style={{ width: 56, textAlign: 'center' }}>Blocked</span>
        <span style={{ width: 28 }} />
      </div>
      {BLOCKED_ITEMS.map(row => (
        <div key={row.key} className="dash-blocked-row">
          <span className="dash-blocked-key">{row.key}</span>
          <span className="dash-blocked-title">{row.title}</span>
          <span className={`dash-blocked-days${row.days >= 5 ? ' critical' : ''}`}>{row.days}d</span>
          <div className="dash-av-sm" style={{ background: row.av.c }}>{row.av.i}</div>
        </div>
      ))}
    </div>
  )
}

function ThroughputTileBody({ compact = false }: { compact?: boolean }) {
  const maxPts = 24
  return (
    <div className={`dash-tp-body${compact ? ' compact' : ''}`}>
      <div className="dash-tp-bars">
        {THROUGHPUT_WEEKS.map(({ label, pts, partial }) => (
          <div key={label} className="dash-tp-bar-col">
            <span className="dash-tp-val">{pts}</span>
            <div className="dash-tp-bar-wrap">
              <div className="dash-tp-bar-fill"
                style={{
                  height: `${(pts / maxPts) * 100}%`,
                  opacity: partial ? 0.5 : 1,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="dash-tp-xlabels">
        {THROUGHPUT_WEEKS.map(({ label }) => (
          <span key={label} className="dash-tp-xlabel">{label}</span>
        ))}
      </div>
    </div>
  )
}

function ScopeChangeTileBody() {
  return (
    <div className="dash-scope-body">
      {SCOPE_CHANGES.map(sc => (
        <div key={sc.key} className="dash-scope-row">
          <span className="dash-scope-key">{sc.key}</span>
          <span className="dash-scope-action">{sc.action}</span>
          <span className={`dash-scope-delta${sc.deltaPos ? ' pos' : ' neg'}`}>
            {sc.delta} pts
          </span>
          <span className="dash-scope-time">{sc.time}</span>
        </div>
      ))}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// AI SUMMARY CARD
// ══════════════════════════════════════════════════════════
function AiSummaryCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="dash-ai-card">
      <div className="dash-ai-card-stripe" />
      <div className="dash-ai-card-inner">
        <div className="dash-ai-card-hdr">
          <Sparkles size={12} strokeWidth={1.5} color="#76A923" />
          <span className="dash-ai-label">Assist</span>
          <button className="dash-ai-dismiss" onClick={onDismiss}><X size={12} strokeWidth={1.5} /></button>
        </div>
        {[
          'Velocity stable at 40–42 pts/sprint for 3 consecutive cycles.',
          'WIP at limit 4 of last 5 days — In Progress is the bottleneck.',
          '2 items blocked >5d: PAY-393 (8d) and PLAT-4825 (5d) need unblocking.',
        ].map((b, i) => (
          <div key={i} className="dash-ai-bullet">
            <span className="dash-ai-dot">·</span>
            <span>{b}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// REPORT CATALOG MODAL
// ══════════════════════════════════════════════════════════
const REPORT_TYPES = [
  { id: 'burnup',     Icon: TrendingUp,   name: 'Burnup',               desc: 'Scope and completed work over a sprint.' },
  { id: 'burndown',   Icon: TrendingDown, name: 'Burndown',             desc: 'Remaining work to sprint end.' },
  { id: 'cycletime',  Icon: Timer,        name: 'Cycle time',           desc: 'Days from start to done by item type.' },
  { id: 'cfd',        Icon: Activity,     name: 'Cumulative flow',      desc: 'Work distribution across columns over time.' },
  { id: 'throughput', Icon: BarChartIcon, name: 'Throughput',           desc: 'Items or points completed per time period.' },
  { id: 'blocked',    Icon: ShieldAlert,  name: 'Blocked items',        desc: 'Active blockers with age and owner.' },
  { id: 'scope',      Icon: Layers,       name: 'Scope change',         desc: 'Additions and removals from sprint scope.' },
  { id: 'workload',   Icon: Users,        name: 'Workload by assignee', desc: 'WIP and capacity per person.' },
  { id: 'fql',        Icon: Code2,        name: 'Custom query (FQL)',    desc: 'Write Forge Query Language for any metric.' },
]

function ReportCatalog({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState('cycletime')
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rcat-modal" onClick={e => e.stopPropagation()}>
        <div className="rcat-hdr">
          <span className="rcat-title">Add a report</span>
          <button className="rcat-close" onClick={onClose}><X size={16} strokeWidth={1.5} /></button>
        </div>
        <div className="rcat-grid">
          {REPORT_TYPES.map(({ id, Icon, name, desc }) => (
            <button
              key={id}
              className={`rcat-card${selected === id ? ' selected' : ''}`}
              onClick={() => setSelected(id)}
            >
              <Icon size={18} strokeWidth={1.5} color={selected === id ? '#006044' : '#78716C'} />
              <div className="rcat-card-name">{name}</div>
              <div className="rcat-card-desc">{desc}</div>
            </button>
          ))}
        </div>
        <div className="rcat-footer">
          <span className="rcat-notice">
            All reports are permission-aware: viewers only see items they can access.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="rcat-cancel" onClick={onClose}>Cancel</button>
            <button className="rcat-add">Add tile</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// SUBSCRIBE POPOVER
// ══════════════════════════════════════════════════════════
function SubscribePopover({ onClose }: { onClose: () => void }) {
  const [freq, setFreq] = useState<'Weekly' | 'Daily' | 'Monthly'>('Weekly')
  return (
    <div className="sub-popover">
      <div className="sub-title">Email me this dashboard</div>
      <div className="sub-freq-row">
        {(['Weekly', 'Daily', 'Monthly'] as const).map(f => (
          <button key={f} className={`sub-freq-btn${freq === f ? ' active' : ''}`}
            onClick={() => setFreq(f)}>{f}</button>
        ))}
      </div>
      <div className="sub-row-two">
        <select className="sub-select">
          <option>Monday</option><option>Tuesday</option><option>Friday</option>
        </select>
        <select className="sub-select">
          <option>8:00 AM</option><option>9:00 AM</option><option>12:00 PM</option>
        </select>
      </div>
      <div className="sub-format-label">Format</div>
      {['PDF snapshot', 'Inline HTML'].map(fmt => (
        <label key={fmt} className="sub-radio">
          <input type="radio" name="subfmt" defaultChecked={fmt === 'PDF snapshot'}
            style={{ accentColor: '#006044' }} />
          {fmt}
        </label>
      ))}
      <div className="sub-actions">
        <button className="sub-cancel" onClick={onClose}>Cancel</button>
        <button className="sub-save" onClick={onClose}>Save</button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// EMPTY STATE
// ══════════════════════════════════════════════════════════
const TEMPLATES = [
  { id: 'sprint', name: 'Sprint health',  desc: 'Burnup · WIP · cycle time · blocked items' },
  { id: 'exec',   name: 'Exec summary',   desc: 'Throughput · velocity · scope change · delivery date' },
  { id: 'flow',   name: 'Flow',           desc: 'Cumulative flow · cycle time distribution · WIP age' },
]

function EmptyDashboard({ onCatalog }: { onCatalog: () => void }) {
  return (
    <div className="dash-empty">
      <BarChartIcon size={36} strokeWidth={1} color="#D4D0CE" />
      <div className="dash-empty-msg">No tiles yet. Add a report or start from a template.</div>
      <div className="dash-empty-templates">
        {TEMPLATES.map(t => (
          <button key={t.id} className="dash-template-card" onClick={onCatalog}>
            <div className="dash-template-name">{t.name}</div>
            <div className="dash-template-desc">{t.desc}</div>
          </button>
        ))}
      </div>
      <button className="dash-add-btn" onClick={onCatalog}>
        <Plus size={14} strokeWidth={2} /> Add a report
      </button>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// EXEC / PRESENT MODE
// ══════════════════════════════════════════════════════════
function ExecView({ onExit }: { onExit: () => void }) {
  const [exportOpen, setExportOpen] = useState(true)
  return (
    <div className="exec-overlay">
      {/* Exec header */}
      <div className="exec-hdr">
        <div className="exec-hdr-left">
          <div className="exec-dash-title">Payments — Delivery health</div>
          <div className="exec-dash-sub">Last 30 days · Meridian Capital · Updated 4m ago</div>
        </div>
        <div className="exec-hdr-right">
          {/* Export button + open dropdown */}
          <div style={{ position: 'relative' }}>
            <button className="dash-ghost-btn" onClick={() => setExportOpen(v => !v)}>
              <Download size={13} strokeWidth={1.5} />
              Export
              <ChevronDown size={11} strokeWidth={1.5} />
            </button>
            {exportOpen && (
              <div className="exec-export-menu">
                {[
                  { Icon: FileText, label: 'PDF snapshot',    sub: 'Full page, print-ready' },
                  { Icon: ImgIcon,  label: 'PNG',             sub: '2× resolution' },
                  { Icon: Mail,     label: 'Schedule email',  sub: 'Weekly Mon 8:00 AM' },
                  { Icon: LinkIcon, label: 'Copy link',       sub: 'Shared view, same filters' },
                ].map(({ Icon, label, sub }) => (
                  <button key={label} className="exec-export-item">
                    <Icon size={14} strokeWidth={1.5} color="#78716C" />
                    <div>
                      <div className="exec-export-label">{label}</div>
                      <div className="exec-export-sub">{sub}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="dash-ghost-btn" onClick={onExit}>
            <Minimize2 size={13} strokeWidth={1.5} />
            Exit
          </button>
        </div>
      </div>

      {/* Exec grid — larger rows */}
      <div className="exec-grid">
        <Tile title="Sprint burnup"    colSpan={6} rowSpan={2}><BurnupChart compact /></Tile>
        <Tile title="Cycle time"       colSpan={3} rowSpan={2}><CycleTimeTileBody /></Tile>
        <Tile title="WIP by column"    colSpan={3} rowSpan={2}><WipTileBody /></Tile>
        <Tile title="Blocked items"    colSpan={6} rowSpan={2}><BlockedTileBody /></Tile>
        <Tile title="Throughput"       colSpan={3} rowSpan={2}><ThroughputTileBody compact /></Tile>
        <Tile title="Scope change log" colSpan={3} rowSpan={2}><ScopeChangeTileBody /></Tile>
      </div>

      {/* Exec footer */}
      <div className="exec-footer">
        Forge &nbsp;·&nbsp; Payments delivery &nbsp;·&nbsp; 14 Jul 2026
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════
export default function ReportsView() {
  const { aiOn } = useForge()

  const [showCatalog,   setShowCatalog]   = useState(false)
  const [showSubscribe, setShowSubscribe] = useState(false)
  const [showAiCard,    setShowAiCard]    = useState(false)
  const [emptyDash,     setEmptyDash]     = useState(false)
  const [execMode,      setExecMode]      = useState(false)

  if (execMode) return <ExecView onExit={() => setExecMode(false)} />

  return (
    <div className="dash-root">

      {/* ── Dashboard header ──────────────────────────────── */}
      <div className="dash-hdr">
        <div className="dash-hdr-left">
          <h1 className="dash-title">Payments — Delivery health</h1>
          <div className="dash-meta-row">
            <div className="dash-owner-av">PR</div>
            <span className="dash-shared-chip">Shared with Payments team</span>
          </div>
        </div>

        <div className="dash-hdr-right">
          {/* AI explain button */}
          {aiOn && (
            <button className="dash-ai-btn" onClick={() => setShowAiCard(v => !v)}>
              <Sparkles size={12} strokeWidth={1.5} color="#76A923" />
              <span>Explain this dashboard</span>
            </button>
          )}

          {/* Date range */}
          <button className="dash-ctrl-btn">
            Last 30 days <ChevronDown size={11} strokeWidth={1.5} />
          </button>

          <span className="dash-updated">
            <RefreshCw size={11} strokeWidth={1.5} />
            Updated 4m ago
          </span>

          {/* Present mode */}
          <button className="dash-ghost-btn" onClick={() => setExecMode(true)}>
            <Maximize2 size={13} strokeWidth={1.5} />
            Present
          </button>

          {/* Subscribe */}
          <div style={{ position: 'relative' }}>
            <button className="dash-ghost-btn" onClick={() => setShowSubscribe(v => !v)}>
              <Bell size={13} strokeWidth={1.5} />
              Subscribe
            </button>
            {showSubscribe && <SubscribePopover onClose={() => setShowSubscribe(false)} />}
          </div>

          <button className="dash-ghost-btn">
            <Download size={13} strokeWidth={1.5} />
            Export
          </button>

          <button className="dash-add-btn" onClick={() => setShowCatalog(true)}>
            <Plus size={13} strokeWidth={2} />
            Add tile
          </button>

          {/* Edge-state demo toggle */}
          <button className="dash-demo-toggle"
            onClick={() => setEmptyDash(v => !v)}
            title="Toggle empty state demo">
            {emptyDash ? '← Fill' : '∅'}
          </button>
        </div>
      </div>

      {/* ── AI summary card ──────────────────────────────── */}
      {aiOn && showAiCard && (
        <div className="dash-ai-strip">
          <AiSummaryCard onDismiss={() => setShowAiCard(false)} />
        </div>
      )}

      {/* ── Content ──────────────────────────────────────── */}
      <div className="dash-scroll">
        {emptyDash ? (
          <EmptyDashboard onCatalog={() => { setEmptyDash(false); setShowCatalog(true) }} />
        ) : (
          <div className="dash-grid">
            {/* Row 1-2 */}
            <Tile title="Sprint burnup"  colSpan={6} rowSpan={2}><BurnupChart /></Tile>
            <Tile title="Cycle time"     colSpan={3} rowSpan={2}><CycleTimeTileBody /></Tile>
            <Tile title="WIP by column"  colSpan={3} rowSpan={2} isDragging><WipTileBody /></Tile>

            {/* Row 3-4 */}
            <Tile title="Blocked items"  colSpan={6} rowSpan={2}><BlockedTileBody /></Tile>
            <Tile isDropSlot             colSpan={3} rowSpan={2} />
            <Tile title="Throughput"     colSpan={3} rowSpan={2} isError><ThroughputTileBody /></Tile>

            {/* Row 5-6: Scope Change (full width of used cols) */}
            <Tile title="Scope change log" colSpan={6} rowSpan={2}><ScopeChangeTileBody /></Tile>
          </div>
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────── */}
      {showCatalog && <ReportCatalog onClose={() => setShowCatalog(false)} />}
    </div>
  )
}
