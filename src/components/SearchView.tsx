import { useState } from 'react'
import {
  Search, X, ChevronDown, ChevronRight, Plus, Sparkles,
  MoreHorizontal, BookOpen, Bug, CheckSquare,
  Eye, User as UserIcon, SortDesc,
  Users, SlidersHorizontal, Code, AlertCircle,
} from 'lucide-react'
import { useForge } from '../App'

// ── Members ───────────────────────────────────────────────────
const PR = { initials: 'PR', color: '#4F46E5', name: 'Priya Raman' }
const DO = { initials: 'DO', color: '#0891B2', name: 'Daniel Okafor' }
const SM = { initials: 'SM', color: '#16A34A', name: 'Sofia Marek' }
const LF = { initials: 'LF', color: '#0369A1', name: 'Luca Ferreira' }
const MC = { initials: 'MC', color: '#EA580C', name: 'Marcus Chen' }
const NO = { initials: 'NO', color: '#DB2777', name: 'Nadia Osei' }

type IT = 'story' | 'bug' | 'task'
type IStatus = 'in-progress' | 'in-review' | 'done' | 'blocked' | 'todo'

interface ResultRow {
  id: string; key: string; type: IT
  title: string; status: IStatus
  assignee: typeof PR
  sprint: string; pts: number; upd: string
}

const TYPE_META: Record<IT, { color: string; Icon: typeof BookOpen }> = {
  story: { color: '#4F46E5', Icon: BookOpen    },
  bug:   { color: '#DC2626', Icon: Bug         },
  task:  { color: '#78716C', Icon: CheckSquare },
}

const STATUS_STYLE: Record<IStatus, { bg: string; color: string; dot: string; label: string }> = {
  'in-progress': { bg: '#FEF3C7', color: '#B45309', dot: '#D97706', label: 'In progress' },
  'in-review':   { bg: '#EEF2FF', color: '#4338CA', dot: '#4F46E5', label: 'In review'   },
  'done':        { bg: '#F0FDF4', color: '#15803D', dot: '#16A34A', label: 'Done'         },
  'blocked':     { bg: '#FEF2F2', color: '#DC2626', dot: '#DC2626', label: 'Blocked'      },
  'todo':        { bg: '#F5F5F4', color: '#78716C', dot: '#A8A29E', label: 'To do'        },
}

const RESULTS: ResultRow[] = [
  { id: 'r1',  key: 'PAY-393',   type: 'story', title: 'Settlement webhook retries exhausted after 5 attempts',               status: 'in-progress', assignee: PR, sprint: 'Sprint 42', pts: 8, upd: '2h ago'  },
  { id: 'r2',  key: 'PAY-397',   type: 'bug',   title: 'Backpressure not applied to FX rate streaming endpoint',              status: 'in-progress', assignee: LF, sprint: 'Sprint 42', pts: 5, upd: '3h ago'  },
  { id: 'r3',  key: 'PAY-401',   type: 'task',  title: 'Retry budget configuration for partial settlement failures',           status: 'in-progress', assignee: SM, sprint: 'Sprint 42', pts: 3, upd: '4h ago'  },
  { id: 'r4',  key: 'PLAT-4821', type: 'bug',   title: 'Reconciliation job exceeds 4h window on month-end cutoff',            status: 'in-progress', assignee: DO, sprint: 'Sprint 42', pts: 8, upd: '5h ago'  },
  { id: 'r5',  key: 'PAY-388',   type: 'bug',   title: 'SEPA callback signature validation fails on event replay',            status: 'in-progress', assignee: MC, sprint: 'Sprint 42', pts: 5, upd: '6h ago'  },
  { id: 'r6',  key: 'RISK-1204', type: 'task',  title: 'KYC document expiry alerts: 90-day window not triggering in prod',   status: 'in-progress', assignee: DO, sprint: 'Sprint 42', pts: 3, upd: '7h ago'  },
  { id: 'r7',  key: 'PAY-412',   type: 'task',  title: 'Add idempotency headers to all outbound webhook calls',               status: 'in-progress', assignee: NO, sprint: 'Sprint 42', pts: 2, upd: '8h ago'  },
  { id: 'r8',  key: 'PLAT-4819', type: 'story', title: 'Migrate auth middleware to FAPI 2.0 compliant token flow',           status: 'in-review',   assignee: PR, sprint: 'Sprint 42', pts: 8, upd: '1d ago'  },
  { id: 'r9',  key: 'PAY-395',   type: 'task',  title: 'Circuit breaker configuration for payment gateway calls',             status: 'in-review',   assignee: SM, sprint: 'Sprint 42', pts: 3, upd: '1d ago'  },
  { id: 'r10', key: 'PAY-381',   type: 'story', title: 'Normalize webhook error codes to RFC 7807 problem format',            status: 'in-review',   assignee: LF, sprint: 'Sprint 42', pts: 5, upd: '2d ago'  },
]

interface Token { id: string; key: string; val: string; highlight?: boolean }
const DEFAULT_TOKENS: Token[] = [
  { id: 't1', key: 'project',  val: 'Payments'     },
  { id: 't2', key: 'status',   val: 'In progress'  },
  { id: 't3', key: 'assignee', val: 'Priya Raman'  },
  { id: 't4', key: 'updated',  val: 'last 7 days'  },
]

const SAVED_VIEWS = {
  mine: [
    { id: 'my-month-end', label: 'My month-end view'    },
    { id: 'regulatory',   label: 'Regulatory items'     },
    { id: 'pay-stale',    label: 'Team PAY — stale >14d'},
  ],
  shared: [
    { id: 'platform-blocked',  label: 'Platform blocked items', shared: true },
    { id: 'high-priority',     label: 'High priority this sprint', shared: true },
    { id: 'compliance-review', label: 'Compliance review queue', shared: true },
    { id: 'unassigned-bugs',   label: 'Unassigned bugs', shared: true },
    { id: 'team-review',       label: "My team's in-review", shared: true },
  ],
}

const AC_FIELDS = [
  { name: 'status',  type: 'string',    desc: 'Issue workflow status'     },
  { name: 'sprint',  type: 'reference', desc: 'Sprint name or ID'         },
  { name: 'label',   type: 'list',      desc: 'One or more label values'  },
  { name: 'epic',    type: 'reference', desc: 'Epic key or name'          },
  { name: 'project', type: 'string',    desc: 'Project key'               },
]

// ── Mini status chip ──────────────────────────────────────────
function StatusChip({ s }: { s: IStatus }) {
  const st = STATUS_STYLE[s]
  return (
    <span className="status-chip-sm" style={{ background: st.bg, color: st.color }}>
      <span className="sc-dot" style={{ background: st.dot }} />
      {st.label}
    </span>
  )
}

// ── Mini avatar ───────────────────────────────────────────────
function Av({ m, size = 20 }: { m: typeof PR; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: m.color, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: size * 0.38, fontWeight: 600,
      color: 'white', flexShrink: 0,
    }}>{m.initials}</div>
  )
}

// ── Q token chip ──────────────────────────────────────────────
function QToken({ t, onRemove }: { t: Token; onRemove: () => void }) {
  return (
    <span className={`q-token${t.highlight ? ' highlighted' : ''}`}>
      <span className="q-token-lbl">{t.key}</span>
      <span style={{ color: '#A8A29E', fontSize: 10 }}>:</span>
      <span className="q-token-val">{t.val}</span>
      <button className="q-token-rm" onClick={e => { e.stopPropagation(); onRemove() }}>
        <X size={9} strokeWidth={2.5} />
      </button>
    </span>
  )
}

// ════════════════════════════════════════════════════════════
// SearchView root
// ════════════════════════════════════════════════════════════

export default function SearchView() {
  const { aiOn } = useForge()

  const [queryMode,     setQueryMode]     = useState<'builder' | 'syntax' | 'ask'>('builder')
  const [tokens,        setTokens]        = useState<Token[]>(DEFAULT_TOKENS)
  const [syntaxVal,     setSyntaxVal]     = useState('project = PAY AND statsu = "In progress" AND assignee = priya')
  const [showCompCard,  setShowCompCard]  = useState(true)
  const [groupBy,       setGroupBy]       = useState<'none' | 'status'>('none')
  const [loading,       setLoading]       = useState(false)
  const [emptyState,    setEmptyState]    = useState(false)
  const [acFocused,     setAcFocused]     = useState(1)
  const [activeViewId,  setActiveViewId]  = useState('my-month-end')
  const [groupCollapsed,setGroupCollapsed]= useState<Set<string>>(new Set())
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  // Modal state
  const [viewName,  setViewName]  = useState('My month-end view')
  const [shareOn,   setShareOn]   = useState(false)
  const [alertFreq, setAlertFreq] = useState<'never' | 'daily' | 'instant'>('never')

  const hasSyntaxError = syntaxVal.includes('statsu')

  const removeToken = (id: string) => setTokens(ts => ts.filter(t => t.id !== id))
  const toggleGroupCollapse = (key: string) =>
    setGroupCollapsed(prev => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  // Group results by status
  const grouped: Record<string, ResultRow[]> = {}
  RESULTS.forEach(r => {
    if (!grouped[r.status]) grouped[r.status] = []
    grouped[r.status].push(r)
  })
  const statusOrder: IStatus[] = ['in-progress', 'in-review', 'blocked', 'done', 'todo']
  const orderedGroups = statusOrder.filter(s => grouped[s])

  // ── Saved views sidebar ─────────────────────────────────────
  const sidebar = (
    <div className="search-sidebar">
      <div style={{ padding: '10px 6px 0', flexShrink: 0 }}>
        <div className="sv-section-lbl">Mine (3)</div>
        {SAVED_VIEWS.mine.map(v => (
          <div
            key={v.id}
            className={`sv-item${activeViewId === v.id ? ' active' : ''}`}
            onClick={() => setActiveViewId(v.id)}
          >
            <BookOpen size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.label}
            </span>
            <button className="sv-overflow" onClick={e => e.stopPropagation()}>
              <MoreHorizontal size={11} strokeWidth={1.5} />
            </button>
          </div>
        ))}

        <div className="sv-section-lbl" style={{ marginTop: 8 }}>Shared with team (5)</div>
        {SAVED_VIEWS.shared.map(v => (
          <div
            key={v.id}
            className={`sv-item${activeViewId === v.id ? ' active' : ''}`}
            onClick={() => setActiveViewId(v.id)}
          >
            <Users size={12} strokeWidth={1.5} style={{ flexShrink: 0, color: '#A8A29E' }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.label}
            </span>
            <button className="sv-overflow" onClick={e => e.stopPropagation()}>
              <MoreHorizontal size={11} strokeWidth={1.5} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ padding: '8px 6px 12px', borderTop: '1px solid #E7E5E4', marginTop: 8 }}>
        <button className="sv-new-btn">
          <Plus size={12} strokeWidth={2} />
          New view
        </button>
      </div>
    </div>
  )

  // ── Query bar ───────────────────────────────────────────────
  const modeSwitch = (
    <div className="mode-switch">
      <button
        className={`mode-btn${queryMode === 'builder' ? ' active' : ''}`}
        title="Builder"
        onClick={() => setQueryMode('builder')}
      >
        <SlidersHorizontal size={13} strokeWidth={1.5} />
      </button>
      <button
        className={`mode-btn${queryMode === 'syntax' ? ' active' : ''}`}
        title="Syntax"
        onClick={() => setQueryMode('syntax')}
      >
        <Code size={13} strokeWidth={1.5} />
      </button>
      {aiOn && (
        <button
          className={`mode-btn ai-btn${queryMode === 'ask' ? ' active' : ''}`}
          title="Ask (AI)"
          onClick={() => setQueryMode('ask')}
        >
          <Sparkles size={13} strokeWidth={1.5} />
        </button>
      )}
    </div>
  )

  // Builder mode
  const builderBar = (
    <>
      <Search size={16} strokeWidth={1.5} color="#A8A29E" style={{ flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, flexWrap: 'nowrap', overflow: 'hidden', minWidth: 0 }}>
        {tokens.map(t => (
          <QToken key={t.id} t={t} onRemove={() => removeToken(t.id)} />
        ))}
        {tokens.length > 0 && (
          <button className="q-and-ghost">
            <Plus size={9} strokeWidth={2} />
            AND
          </button>
        )}
      </div>
      {modeSwitch}
    </>
  )

  // Syntax mode — static demo showing error state
  const syntaxBar = (
    <>
      <Search size={16} strokeWidth={1.5} color="#A8A29E" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', fontFamily: "'JetBrains Mono','Menlo',monospace", fontSize: 13, color: '#1C1917', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, gap: 0 }}>
        <span style={{ color: '#60A5FA' }}>project</span>
        <span style={{ color: '#A8A29E' }}>&nbsp;=&nbsp;</span>
        <span style={{ color: '#86EFAC' }}>PAY</span>
        <span style={{ color: '#A8A29E' }}>&nbsp;AND&nbsp;</span>
        {/* Error token */}
        <span
          className="syntax-error-marker"
          style={{ position: 'relative' }}
          title="Unknown field 'statsu' — did you mean status?"
        >
          <span style={{ color: '#FCA5A5' }}>statsu</span>
          <span
            className="syntax-tooltip"
            style={{ display: 'none' }}
          >
            Unknown field 'statsu' — did you mean status?
          </span>
        </span>
        <span style={{ color: '#A8A29E' }}>&nbsp;=&nbsp;</span>
        <span style={{ color: '#86EFAC' }}>"In progress"</span>
        <span style={{ color: '#A8A29E' }}>&nbsp;AND&nbsp;</span>
        <span style={{ color: '#60A5FA' }}>assignee</span>
        <span style={{ color: '#A8A29E' }}>&nbsp;=&nbsp;</span>
        <span style={{ color: '#86EFAC' }}>priya</span>
        <span style={{
          display: 'inline-block', width: 2, height: 16, background: '#006044',
          marginLeft: 2, verticalAlign: 'middle',
          animation: 'fade-in 0.8s step-end infinite alternate',
        }} />
      </div>
      {modeSwitch}
    </>
  )

  // Ask mode
  const askBar = (
    <>
      <Sparkles size={16} strokeWidth={1.5} color="#76A923" style={{ flexShrink: 0 }} />
      <input
        className="ask-input"
        placeholder="Ask in plain English…"
        defaultValue="payments bugs priya is fixing this sprint"
      />
      {modeSwitch}
    </>
  )

  const queryBar = (
    <div className="query-bar-wrap">
      <div className="query-bar">
        {queryMode === 'builder' && builderBar}
        {queryMode === 'syntax'  && syntaxBar}
        {queryMode === 'ask'     && askBar}
      </div>

      {/* Autocomplete dropdown — syntax mode */}
      {queryMode === 'syntax' && (
        <div className="autocomplete-dd" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 20, right: 20, zIndex: 50 }}>
          {AC_FIELDS.slice(0, 4).map((f, i) => (
            <div
              key={f.name}
              className={`ac-item${i === acFocused ? ' focused' : ''}`}
              onMouseEnter={() => setAcFocused(i)}
            >
              <span className="ac-name">{f.name}</span>
              <span className="ac-type">{f.type}</span>
              <span className="ac-desc">{f.desc}</span>
            </div>
          ))}
          <div className="ac-kbds">
            <span className="ac-kbd-hint">
              <kbd className="bulk-kbd">↑↓</kbd> Navigate
            </span>
            <span className="ac-kbd-hint">
              <kbd className="bulk-kbd">↵</kbd> Insert
            </span>
            <span className="ac-kbd-hint">
              <kbd className="bulk-kbd">Esc</kbd> Dismiss
            </span>
          </div>
        </div>
      )}
    </div>
  )

  // Syntax error row
  const syntaxErrorRow = queryMode === 'syntax' && hasSyntaxError && (
    <div className="syntax-error-row">
      <AlertCircle size={11} strokeWidth={2} />
      Unknown field <code style={{ fontFamily: 'monospace', background: '#FEF2F2', padding: '0 4px', borderRadius: 3 }}>statsu</code>
      — did you mean <button
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#006044', fontSize: 11, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}
        onClick={() => setSyntaxVal(syntaxVal.replace('statsu', 'status'))}
      >status</button>?
    </div>
  )

  // Compilation preview (ask mode)
  const compilationCard = queryMode === 'ask' && showCompCard && (
    <div className="compilation-card">
      <div className="compilation-corner">
        <Sparkles size={14} strokeWidth={1.5} />
      </div>
      <div className="compilation-lbl">Interpreted as</div>
      <div className="compilation-tokens">
        {[
          { key: 'project', val: 'Payments'    },
          { key: 'type',    val: 'bug'          },
          { key: 'assignee',val: 'Priya Raman' },
          { key: 'sprint',  val: 'Sprint 42'   },
        ].map(t => (
          <span key={t.key} className="q-token" style={{ cursor: 'default' }}>
            <span className="q-token-lbl">{t.key}</span>
            <span style={{ color: '#A8A29E', fontSize: 10 }}>:</span>
            <span className="q-token-val">{t.val}</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{
          padding: '5px 14px', borderRadius: 6, border: 'none',
          background: '#006044', color: 'white', fontSize: 13,
          fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        }}>Run</button>
        <button style={{
          padding: '5px 12px', borderRadius: 6,
          border: '1px solid #C6D9A0', background: 'transparent',
          color: '#4A7A1A', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
        }}>Edit tokens</button>
        <button
          onClick={() => setShowCompCard(false)}
          style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#A8A29E', display: 'flex', padding: 4 }}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )

  // Helper row
  const helperRow = (
    <div className="query-helper">
      <span>{emptyState ? '0 results' : '247 results'}</span>
      <span>·</span>
      <span>sorted by <span className="helper-link">updated</span></span>
      <span>·</span>
      <button
        className="helper-link"
        style={{ border: 'none', background: 'none', fontFamily: 'inherit', fontSize: 11, padding: 0 }}
        onClick={() => setSaveModalOpen(true)}
      >Save view</button>
      <div style={{ flex: 1 }} />
      {/* Demo toggles */}
      <button
        onClick={() => setLoading(v => !v)}
        style={{ fontSize: 10, color: '#A8A29E', border: '1px solid #E7E5E4', background: 'none', borderRadius: 4, padding: '1px 5px', cursor: 'pointer', fontFamily: 'inherit' }}
      >{loading ? 'loaded' : 'skeleton'}</button>
      <button
        onClick={() => setEmptyState(v => !v)}
        style={{ fontSize: 10, color: '#A8A29E', border: '1px solid #E7E5E4', background: 'none', borderRadius: 4, padding: '1px 5px', cursor: 'pointer', fontFamily: 'inherit' }}
      >{emptyState ? 'results' : 'empty'}</button>
    </div>
  )

  // Results control row (count + group-by)
  const resultsCtrl = (
    <div className="results-ctrl">
      <span className="results-count">{emptyState ? 0 : RESULTS.length} issues</span>
      <button
        className={`groupby-btn${groupBy !== 'none' ? ' active' : ''}`}
        onClick={() => setGroupBy(v => v === 'none' ? 'status' : 'none')}
      >
        Group by: {groupBy === 'none' ? 'None' : 'Status'}
        <ChevronDown size={11} strokeWidth={1.5} />
      </button>
    </div>
  )

  // Column headers
  const colHeaders = (
    <div className="results-hdr">
      <div className="rh-cell rc-type" style={{ width: 34 }} />
      <div className="rh-cell rc-key" style={{ width: 82 }}>Key</div>
      <div className="rh-cell" style={{ flex: 1 }}>Title</div>
      <div className="rh-cell rc-status" style={{ width: 116 }}>Status</div>
      <div className="rh-cell rc-assign" style={{ width: 148 }}>Assignee</div>
      <div className="rh-cell rc-sprint" style={{ width: 96 }}>Sprint</div>
      <div className="rh-cell rc-pts" style={{ width: 44, justifyContent: 'center' }}>Pts</div>
      <div className="rh-cell sorted" style={{ width: 86, display: 'flex', alignItems: 'center', gap: 3 }}>
        Updated
        <SortDesc size={10} strokeWidth={2} />
      </div>
    </div>
  )

  // Single result row
  const ResultRowEl = ({ row }: { row: ResultRow }) => {
    const { Icon, color } = TYPE_META[row.type]
    return (
      <div className="results-row">
        <div className="rc rc-type" style={{ width: 34, justifyContent: 'center' }}>
          <Icon size={13} strokeWidth={1.5} color={color} />
        </div>
        <div className="rc rc-key" style={{ width: 82 }}>{row.key}</div>
        <div className="rc rc-title" style={{ flex: 1, minWidth: 0 }}>{row.title}</div>
        <div className="rc rc-status" style={{ width: 116 }}>
          <StatusChip s={row.status} />
        </div>
        <div className="rc rc-assign" style={{ width: 148 }}>
          <Av m={row.assignee} size={18} />
          <span style={{ fontSize: 12, color: '#1C1917', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.assignee.name}
          </span>
        </div>
        <div className="rc rc-sprint" style={{ width: 96, fontSize: 12, color: '#78716C' }}>{row.sprint}</div>
        <div className="rc rc-pts" style={{ width: 44, justifyContent: 'center', fontSize: 12, color: '#78716C' }}>{row.pts}</div>
        <div className="rc rc-upd" style={{ width: 86, fontSize: 12, color: '#A8A29E' }}>{row.upd}</div>
        {/* Quick actions (shown on hover via CSS) */}
        <div className="row-quick-actions">
          <button className="rqa-btn" title="Open peek">
            <Eye size={11} strokeWidth={1.5} />
          </button>
          <button className="rqa-btn" title="Assign">
            <UserIcon size={11} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    )
  }

  // Skeleton rows
  const skeletonRows = Array.from({ length: 8 }, (_, i) => (
    <div key={i} className="results-row" style={{ cursor: 'default' }}>
      <div className="rc" style={{ width: 34, justifyContent: 'center' }}>
        <div className="skeleton-cell" style={{ width: 14, height: 14, borderRadius: '50%' }} />
      </div>
      <div className="rc" style={{ width: 82 }}>
        <div className="skeleton-cell" style={{ width: 60, height: 12 }} />
      </div>
      <div className="rc" style={{ flex: 1 }}>
        <div className="skeleton-cell" style={{ width: `${60 + (i * 7) % 30}%`, height: 12 }} />
      </div>
      <div className="rc" style={{ width: 116 }}>
        <div className="skeleton-cell" style={{ width: 80, height: 20, borderRadius: 4 }} />
      </div>
      <div className="rc" style={{ width: 148, gap: 6 }}>
        <div className="skeleton-cell" style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0 }} />
        <div className="skeleton-cell" style={{ width: 80, height: 12 }} />
      </div>
      <div className="rc" style={{ width: 96 }}>
        <div className="skeleton-cell" style={{ width: 60, height: 12 }} />
      </div>
      <div className="rc" style={{ width: 44, justifyContent: 'center' }}>
        <div className="skeleton-cell" style={{ width: 20, height: 12 }} />
      </div>
      <div className="rc" style={{ width: 86 }}>
        <div className="skeleton-cell" style={{ width: 46, height: 12 }} />
      </div>
    </div>
  ))

  // Empty state
  const emptyEl = (
    <div className="search-empty">
      <Search size={28} strokeWidth={1} color="#E7E5E4" />
      <span style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>Nothing matches</span>
      <span style={{ fontSize: 13, color: '#78716C' }}>
        Loosen a filter?{' '}
        <button
          onClick={() => {
            setTokens(ts => ts.map(t => t.key === 'status' ? { ...t, highlight: true } : t))
            setTimeout(() => setTokens(ts => ts.map(t => ({ ...t, highlight: false }))), 2200)
            setEmptyState(false)
          }}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#006044', fontSize: 13, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}
        >Remove status filter</button>
      </span>
    </div>
  )

  // Grouped results
  const groupedResults = orderedGroups.map(statusKey => {
    const rows = grouped[statusKey]
    const collapsed = groupCollapsed.has(statusKey)
    const st = STATUS_STYLE[statusKey]
    return (
      <div key={statusKey}>
        <div className="group-hdr" onClick={() => toggleGroupCollapse(statusKey)}>
          {collapsed
            ? <ChevronRight size={13} strokeWidth={1.5} color="#A8A29E" />
            : <ChevronDown  size={13} strokeWidth={1.5} color="#A8A29E" />
          }
          <span className="sc-dot" style={{ background: st.dot }} />
          <span>{st.label}</span>
          <span style={{ fontWeight: 400, color: '#A8A29E' }}>({rows.length})</span>
        </div>
        {!collapsed && rows.map(r => <ResultRowEl key={r.id} row={r} />)}
      </div>
    )
  })

  // ── Results area ────────────────────────────────────────────
  const resultsArea = (
    <div className="results-table">
      {resultsCtrl}
      {colHeaders}
      {loading   ? skeletonRows : null}
      {!loading && emptyState   ? emptyEl : null}
      {!loading && !emptyState  ? (
        groupBy === 'status' ? groupedResults : RESULTS.map(r => <ResultRowEl key={r.id} row={r} />)
      ) : null}
    </div>
  )

  // ── Save view modal ─────────────────────────────────────────
  const saveModal = saveModalOpen && (
    <div className="modal-backdrop" onClick={() => setSaveModalOpen(false)}>
      <div className="save-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div className="modal-title">Save view</div>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 14 }}>
            <label className="form-lbl">View name</label>
            <input
              className="form-input"
              value={viewName}
              onChange={e => setViewName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="toggle-row">
            <span className="toggle-label">Share with team</span>
            <div
              className={`toggle-track${shareOn ? ' on' : ''}`}
              onClick={() => setShareOn(v => !v)}
            >
              <div className={`toggle-thumb${shareOn ? ' on' : ' off'}`} />
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="form-lbl" style={{ marginBottom: 8 }}>Alert me</label>
            <div className="radio-group">
              {(['never', 'daily', 'instant'] as const).map(freq => (
                <div key={freq} className="radio-opt" onClick={() => setAlertFreq(freq)}>
                  <div className={`radio-dot${alertFreq === freq ? ' checked' : ''}`}>
                    {alertFreq === freq && <div className="radio-dot-fill" />}
                  </div>
                  <span>
                    {freq === 'never'   && 'Never'}
                    {freq === 'daily'   && 'Daily digest'}
                    {freq === 'instant' && 'Instantly'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-ftr">
          <button
            onClick={() => setSaveModalOpen(false)}
            style={{
              padding: '7px 14px', borderRadius: 6,
              border: '1px solid #E7E5E4', background: 'transparent',
              color: '#78716C', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={() => setSaveModalOpen(false)}
            style={{
              padding: '7px 16px', borderRadius: 6, border: 'none',
              background: '#006044', color: 'white', fontSize: 13,
              fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >Save view</button>
        </div>
      </div>
    </div>
  )

  // ── Layout ──────────────────────────────────────────────────
  return (
    <>
      <div className="search-view">
        {sidebar}
        <div className="search-main">
          {queryBar}
          {syntaxErrorRow}
          {compilationCard}
          {helperRow}
          {resultsArea}
        </div>
      </div>
      {saveModal}
    </>
  )
}
