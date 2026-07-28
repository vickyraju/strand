import { useState } from 'react'
import {
  BookOpen, Bug, CheckSquare, ShieldAlert,
  Eye, UserPlus,
} from 'lucide-react'
import { useForge } from '../App'

// ── Types ──────────────────────────────────────────────────

type IStatus = 'blocked' | 'in-progress' | 'in-review' | 'todo' | 'done'
type IType = 'story' | 'bug' | 'task'

interface WorkItem {
  id: string
  key: string
  type: IType
  title: string
  status: IStatus
  sprint: string
  updated: string
  blocked?: boolean
}

// ── Data ───────────────────────────────────────────────────

const TYPE_META: Record<IType, { color: string; Icon: typeof BookOpen }> = {
  story: { color: '#4F46E5', Icon: BookOpen    },
  bug:   { color: '#DC2626', Icon: Bug         },
  task:  { color: '#78716C', Icon: CheckSquare },
}

const STATUS_LABEL: Record<IStatus, { label: string; bg: string; color: string }> = {
  'blocked':    { label: 'Blocked',     bg: '#FEE2E2', color: '#DC2626' },
  'in-progress':{ label: 'In progress', bg: '#FEF3C7', color: '#B45309' },
  'in-review':  { label: 'In review',   bg: '#EEF2FF', color: '#4F46E5' },
  'todo':       { label: 'Todo',        bg: '#F5F5F4', color: '#78716C' },
  'done':       { label: 'Done',        bg: '#DCFCE7', color: '#16A34A' },
}

const ASSIGNED: WorkItem[] = [
  { id: '1', key: 'PAY-393',   type: 'story', title: 'Settlement webhook retries exhausted after 3rd-party timeout',  status: 'blocked',     sprint: 'Sprint 42', updated: '1h ago',  blocked: true },
  { id: '2', key: 'RISK-1205', type: 'task',  title: 'KYC batch job: alert on >100 document expiries in rolling 24h',  status: 'blocked',     sprint: 'Sprint 42', updated: '3h ago',  blocked: true },
  { id: '3', key: 'PAY-421',   type: 'story', title: 'Configure HMAC verification for v3 webhook endpoints',           status: 'in-review',   sprint: 'Sprint 42', updated: '2h ago'  },
  { id: '4', key: 'PAY-422',   type: 'task',  title: 'Structured retry logging: add correlation IDs to all attempts',  status: 'in-progress', sprint: 'Sprint 42', updated: '4h ago'  },
  { id: '5', key: 'PAY-417',   type: 'story', title: 'FX rate fallback strategy when primary provider is unreachable', status: 'in-progress', sprint: 'Sprint 42', updated: 'Yesterday'},
  { id: '6', key: 'PAY-419',   type: 'story', title: 'Dead letter queue for failed settlement events past retry budget',status: 'in-progress', sprint: 'Sprint 42', updated: 'Yesterday'},
  { id: '7', key: 'PAY-423',   type: 'story', title: 'FX rate circuit breaker: configurable threshold per currency pair',status:'todo',        sprint: 'Sprint 43', updated: '2d ago'  },
  { id: '8', key: 'PAY-424',   type: 'story', title: 'Dead letter queue visual status in operations admin dashboard',   status: 'todo',        sprint: 'Sprint 43', updated: '2d ago'  },
]

const RECENT_VIEWED = [
  { key: 'PLAT-4821', title: 'Reconciliation job exceeds 4h window' },
  { key: 'PAY-393',   title: 'Settlement webhook retries exhausted' },
  { key: 'PAY-416',   title: 'Webhook delivery log retention policy' },
  { key: 'RISK-1204', title: 'SOC 2 audit trail review' },
]

// ── Sub-components ─────────────────────────────────────────

function StatCard({ children, hovered }: { children: React.ReactNode; hovered?: boolean }) {
  return (
    <div className={`yw-stat-card${hovered ? ' hovered' : ''}`}>
      {children}
    </div>
  )
}

function WorkRow({ item }: { item: WorkItem }) {
  const { Icon, color } = TYPE_META[item.type]
  const st = STATUS_LABEL[item.status]
  const [hover, setHover] = useState(false)

  return (
    <div
      className={`yw-row${item.blocked ? ' yw-row-blocked' : ''}${hover ? ' yw-row-hover' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon size={13} strokeWidth={1.5} color={color} style={{ flexShrink: 0 }} />
      <span className="yw-key">{item.key}</span>
      <span className="yw-row-title">{item.title}</span>
      {item.key === 'RISK-1205' && (
        <span className="pii-badge-sm"><ShieldAlert size={9} strokeWidth={2} />PII</span>
      )}
      <span className="yw-status-chip" style={{ background: st.bg, color: st.color }}>{st.label}</span>
      <span className="yw-sprint">{item.sprint}</span>
      <span className="yw-updated">{item.updated}</span>
      {hover && (
        <div className="yw-quick-actions">
          <button className="rqa-btn" title="Open peek"><Eye size={13} strokeWidth={1.5} /></button>
          <button className="rqa-btn" title="Assign"><UserPlus size={13} strokeWidth={1.5} /></button>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// YourWork root
// ════════════════════════════════════════════════════════════

const TABS = ['Assigned (8)', 'Created', 'Watching', 'Recently viewed']

export default function YourWork() {
  const { } = useForge()
  const [activeTab, setActiveTab] = useState(0)
  const [hoveredCard, setHoveredCard] = useState<number | null>(null)

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="yw-root">
      {/* ── Header ──────────────────────────────────────── */}
      <div className="yw-header">
        <div>
          <h1 className="yw-greeting">Good morning, Priya.</h1>
          <div className="yw-date">{today}</div>
        </div>
      </div>

      {/* ── Focus strip ─────────────────────────────────── */}
      <div className="yw-focus-strip">
        <StatCard hovered={hoveredCard === 0}>
          <div
            className="yw-stat-inner"
            onMouseEnter={() => setHoveredCard(0)}
            onMouseLeave={() => setHoveredCard(null)}
          >
            <div className="yw-stat-label">Assigned to you</div>
            <div className="yw-stat-val">
              8
              <span className="yw-stat-blocked">
                &thinsp;·&thinsp;<span style={{ color: '#DC2626', fontWeight: 600 }}>2 blocked</span>
              </span>
            </div>
            <div className="yw-stat-sub">across 2 sprints</div>
          </div>
        </StatCard>

        <StatCard hovered={hoveredCard === 1}>
          <div
            className="yw-stat-inner"
            onMouseEnter={() => setHoveredCard(1)}
            onMouseLeave={() => setHoveredCard(null)}
          >
            <div className="yw-stat-label">In review awaiting you</div>
            <div className="yw-stat-val">3</div>
            <div className="yw-stat-sub">oldest opened 4h ago</div>
          </div>
        </StatCard>

        <StatCard hovered={hoveredCard === 2}>
          <div
            className="yw-stat-inner"
            onMouseEnter={() => setHoveredCard(2)}
            onMouseLeave={() => setHoveredCard(null)}
          >
            <div className="yw-stat-label">Due this sprint</div>
            <div className="yw-stat-val">
              <span style={{ color: '#368727' }}>5</span>
              <span style={{ color: '#A8A29E', fontWeight: 400, fontSize: 14 }}> / 8 done</span>
            </div>
            <div className="yw-cap-bar-wrap">
              <div className="yw-cap-bar">
                <div className="yw-cap-fill" style={{ width: '62.5%' }} />
              </div>
            </div>
          </div>
        </StatCard>
      </div>

      {/* ── Main area ───────────────────────────────────── */}
      <div className="yw-body">
        {/* Left: tabbed list */}
        <div className="yw-main">
          {/* Tabs */}
          <div className="yw-tabs">
            {TABS.map((t, i) => (
              <button
                key={t}
                className={`yw-tab${activeTab === i ? ' active' : ''}`}
                onClick={() => setActiveTab(i)}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Column headers */}
          {activeTab !== 3 && (
            <div className="yw-col-hdr">
              <span style={{ width: 13, flexShrink: 0 }} />
              <span style={{ width: 72, flexShrink: 0 }}>Key</span>
              <span style={{ flex: 1 }}>Title</span>
              <span style={{ width: 96, flexShrink: 0 }}>Status</span>
              <span style={{ width: 80, flexShrink: 0 }}>Sprint</span>
              <span style={{ width: 72, flexShrink: 0, textAlign: 'right' }}>Updated</span>
            </div>
          )}

          {/* Rows */}
          <div className="yw-list">
            {activeTab === 0 && ASSIGNED.map(item => (
              <WorkRow key={item.id} item={item} />
            ))}
            {activeTab === 3 && RECENT_VIEWED.map(item => (
              <button key={item.key} className="yw-recent-row">
                <span className="yw-recent-key">{item.key}</span>
                <span className="yw-recent-title">{item.title}</span>
              </button>
            ))}
            {activeTab !== 0 && activeTab !== 3 && (
              <div className="yw-empty-tab">No items to show.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
