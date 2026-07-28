import { useState } from 'react'
import {
  BookOpen, Bug, CheckSquare, Bell, BellOff,
  Check, Eye, Settings, Sparkles, X, ShieldAlert,
  Mail, Layers, ChevronRight,
} from 'lucide-react'
import { useForge } from '../App'

// ── Types ──────────────────────────────────────────────────

type IType = 'story' | 'bug' | 'task'
type NState = 'unread' | 'read' | 'done'

interface NRow {
  id: string
  key: string
  type: IType
  title: string
  eventLine: string
  actors: { initials: string; color: string }[]
  state: NState
  isMention?: boolean
  isPii?: boolean
  timeAgo: string
}

// ── Data ───────────────────────────────────────────────────

const TYPE_META: Record<IType, { color: string; Icon: typeof BookOpen }> = {
  story: { color: '#4F46E5', Icon: BookOpen    },
  bug:   { color: '#DC2626', Icon: Bug         },
  task:  { color: '#78716C', Icon: CheckSquare },
}

const ROWS: NRow[] = [
  {
    id: 'n1', key: 'PAY-393', type: 'story', state: 'unread',
    title: 'Settlement webhook retries exhausted after 3rd-party timeout',
    eventLine: 'Daniel assigned you · 2 comments · status → Blocked',
    actors: [{ initials: 'DO', color: '#0891B2' }, { initials: 'SM', color: '#16A34A' }],
    timeAgo: '40m ago',
  },
  {
    id: 'n2', key: 'RISK-1204', type: 'task', state: 'unread', isMention: true,
    title: 'SOC 2 audit trail — quarterly review',
    eventLine: 'Marcus Chen mentioned you · "Priya can you confirm the scope?"',
    actors: [{ initials: 'MC', color: '#EA580C' }],
    timeAgo: '1h ago',
  },
  {
    id: 'n3', key: 'PAY-416', type: 'task', state: 'unread',
    title: 'Webhook delivery log retention: enforce 90-day default policy',
    eventLine: 'Sofia added 3 comments',
    actors: [{ initials: 'SM', color: '#16A34A' }, { initials: 'LF', color: '#0369A1' }],
    timeAgo: '2h ago',
  },
  {
    id: 'n4', key: 'PLAT-4825', type: 'bug', state: 'unread',
    title: 'Memory leak in reconciliation job under high-cardinality load',
    eventLine: 'Marcus changed status to In Review',
    actors: [{ initials: 'MC', color: '#EA580C' }],
    timeAgo: '3h ago',
  },
  {
    id: 'n5', key: 'PAY-421', type: 'story', state: 'read',
    title: 'Configure HMAC verification for v3 webhook endpoints',
    eventLine: 'Added to Sprint 42 · assigned to you',
    actors: [{ initials: 'DO', color: '#0891B2' }],
    timeAgo: '1d ago',
  },
  {
    id: 'n6', key: 'PAY-419', type: 'story', state: 'read',
    title: 'Dead letter queue for failed settlement events past retry budget',
    eventLine: 'Luca Ferreira left a comment',
    actors: [{ initials: 'LF', color: '#0369A1' }],
    timeAgo: '1d ago',
  },
  {
    id: 'n7', key: 'PAY-422', type: 'task', state: 'read',
    title: 'Structured retry logging: add correlation IDs to all attempt entries',
    eventLine: 'Status changed to Done',
    actors: [{ initials: 'PR', color: '#006044' }],
    timeAgo: '2d ago',
  },
  {
    id: 'n8', key: 'PAY-426', type: 'task', state: 'read', isPii: true,
    title: 'Rotate signing keys for all active webhook subscriptions',
    eventLine: 'Comment removed by PII guard',
    actors: [{ initials: 'SM', color: '#16A34A' }],
    timeAgo: '2d ago',
  },
]

// ── Notification row ───────────────────────────────────────

function NRowEl({
  row,
  isDoneSwipe,
  onDone,
  onMute,
}: {
  row: NRow
  isDoneSwipe?: boolean
  onDone: () => void
  onMute: () => void
}) {
  const [hover, setHover] = useState(false)
  const { Icon, color } = TYPE_META[row.type]

  return (
    <div
      className={`inbox-row${row.state === 'unread' ? ' unread' : ''}${row.isMention ? ' mention' : ''}${isDoneSwipe ? ' done-swipe' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Done-swipe check revealed */}
      {isDoneSwipe && (
        <div className="inbox-swipe-check">
          <Check size={14} strokeWidth={2.5} color="white" />
        </div>
      )}

      {/* Unread dot */}
      <div className="inbox-unread-dot">
        {row.state === 'unread' && <div className="inbox-dot" />}
      </div>

      {/* Type icon + mention badge */}
      <div className="inbox-type-wrap">
        <Icon size={14} strokeWidth={1.5} color={color} />
        {row.isMention && <span className="inbox-mention-badge">@</span>}
      </div>

      {/* Content */}
      <div className="inbox-content">
        <div className="inbox-item-header">
          <span className="inbox-key">{row.key}</span>
          <span className="inbox-title">{row.title}</span>
        </div>
        <div className="inbox-event-line">
          {row.isPii && (
            <span className="inbox-pii-flag">
              <ShieldAlert size={10} strokeWidth={2} />
              PII guard
            </span>
          )}
          {row.eventLine}
          <span className="inbox-time">&nbsp;·&nbsp;{row.timeAgo}</span>
        </div>
      </div>

      {/* Actor avatars */}
      <div className="inbox-actors">
        {row.actors.slice(0, 3).map((a, i) => (
          <div
            key={i}
            className="inbox-av"
            style={{ background: a.color, zIndex: 3 - i, marginLeft: i > 0 ? -6 : 0 }}
          >
            {a.initials}
          </div>
        ))}
      </div>

      {/* Hover quick actions */}
      {hover && !isDoneSwipe && (
        <div className="inbox-quick">
          <button className="rqa-btn" title="Open peek"><Eye size={13} strokeWidth={1.5} /></button>
          <button className="rqa-btn" title="Mark done" onClick={onDone}><Check size={13} strokeWidth={1.5} /></button>
          <button className="rqa-btn" title="Mute" onClick={onMute}><BellOff size={13} strokeWidth={1.5} /></button>
        </div>
      )}
    </div>
  )
}

// ── AI Summary card ────────────────────────────────────────

function AiSummaryCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="inbox-ai-card">
      <div className="inbox-ai-card-bar" />
      <div className="inbox-ai-card-body">
        <div className="inbox-ai-card-hdr">
          <Sparkles size={12} strokeWidth={1.5} color="#76A923" />
          <span className="inbox-ai-card-label">Assist</span>
          <span className="inbox-ai-card-sub">2 items need action</span>
        </div>
        <div className="inbox-ai-card-items">
          <div className="inbox-ai-item">
            <ChevronRight size={11} strokeWidth={2} color="#006044" />
            <span><strong>PAY-393</strong> is blocked — you are the last reviewer</span>
            <button className="inbox-ai-open">Open</button>
          </div>
          <div className="inbox-ai-item">
            <ChevronRight size={11} strokeWidth={2} color="#006044" />
            <span><strong>RISK-1204</strong> review requested by Marcus Chen</span>
            <button className="inbox-ai-open">Open</button>
          </div>
        </div>
        <button className="inbox-ai-dismiss" onClick={onDismiss}><X size={12} strokeWidth={1.5} /></button>
      </div>
    </div>
  )
}

// ── Notification settings modal ────────────────────────────

interface NotifSettingsProps { onClose: () => void }

interface NotifToggleRow {
  id: string
  label: string
  inApp: boolean
  email: boolean
  fixed?: boolean
}

function NotifSettings({ onClose }: NotifSettingsProps) {
  const [instant, setInstant] = useState<NotifToggleRow[]>([
    { id: 'mention',  label: '@mentions',          inApp: true, email: true  },
    { id: 'assigned', label: 'Assigned to you',    inApp: true, email: false },
    { id: 'blocked',  label: 'Your item blocked',  inApp: true, email: false, fixed: true },
    { id: 'review',   label: 'Review requested',   inApp: true, email: false },
  ])
  const [digest, setDigest] = useState<NotifToggleRow[]>([
    { id: 'watched-comments', label: 'Comments on watched items',     inApp: true, email: false },
    { id: 'watched-status',   label: 'Status changes on watched',     inApp: true, email: false },
    { id: 'sprint-events',    label: 'Sprint events',                 inApp: true, email: false },
    { id: 'security',         label: 'Security notices',              inApp: true, email: false, fixed: true },
  ])

  const toggleInstant = (id: string, field: 'inApp' | 'email') => {
    setInstant(rows => rows.map(r => r.id === id && !r.fixed ? { ...r, [field]: !r[field] } : r))
  }
  const toggleDigest = (id: string, field: 'inApp' | 'email') => {
    setDigest(rows => rows.map(r => r.id === id && !r.fixed ? { ...r, [field]: !r[field] } : r))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="notif-modal" onClick={e => e.stopPropagation()}>
        <div className="notif-modal-hdr">
          <div className="notif-modal-title">Notification preferences</div>
          <button className="rqa-btn" onClick={onClose}><X size={14} strokeWidth={1.5} /></button>
        </div>

        {/* Instant section */}
        <div className="notif-section">
          <div className="notif-section-hdr">
            <Bell size={13} strokeWidth={1.5} color="#006044" />
            <span>Instant</span>
          </div>
          <div className="notif-col-hdr">
            <span style={{ flex: 1 }} />
            <span className="notif-ch">In-app</span>
            <span className="notif-ch">Email</span>
          </div>
          {instant.map(row => (
            <div key={row.id} className="notif-row">
              <span className="notif-row-label">{row.label}</span>
              {row.fixed && <span className="notif-fixed-note">always on</span>}
              <button
                className={`notif-tog${row.inApp ? ' on' : ''}`}
                onClick={() => toggleInstant(row.id, 'inApp')}
                disabled={row.fixed}
                title={row.fixed ? 'Cannot be disabled' : undefined}
              >
                <div className="notif-tog-thumb" />
              </button>
              <button
                className={`notif-tog${row.email ? ' on' : ''}`}
                onClick={() => toggleInstant(row.id, 'email')}
                disabled={row.fixed}
                title={row.fixed ? 'Cannot be disabled' : undefined}
              >
                <div className="notif-tog-thumb" />
              </button>
            </div>
          ))}
        </div>

        {/* Daily digest section */}
        <div className="notif-section">
          <div className="notif-section-hdr">
            <Layers size={13} strokeWidth={1.5} color="#78716C" />
            <span>Daily digest</span>
          </div>
          <div className="notif-col-hdr">
            <span style={{ flex: 1 }} />
            <span className="notif-ch">In-app</span>
            <span className="notif-ch">Email</span>
          </div>
          {digest.map(row => (
            <div key={row.id} className="notif-row">
              <span className="notif-row-label">{row.label}</span>
              {row.fixed && <span className="notif-fixed-note">always on</span>}
              <button
                className={`notif-tog${row.inApp ? ' on' : ''}`}
                onClick={() => toggleDigest(row.id, 'inApp')}
                disabled={row.fixed}
              >
                <div className="notif-tog-thumb" />
              </button>
              <button
                className={`notif-tog${row.email ? ' on' : ''}`}
                onClick={() => toggleDigest(row.id, 'email')}
                disabled={row.fixed}
              >
                <div className="notif-tog-thumb" />
              </button>
            </div>
          ))}
          <div className="notif-digest-preview">
            <Mail size={11} strokeWidth={1.5} color="#78716C" />
            Delivered 8:00 AM — 1 email summarising everything else.
          </div>
        </div>

        <div className="notif-footer">
          Blocked and security notices cannot be muted.
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// InboxView root
// ════════════════════════════════════════════════════════════

type InboxTab = 'unread' | 'read' | 'done'

export default function InboxView() {
  const { aiOn } = useForge()

  const [activeTab, setActiveTab] = useState<InboxTab>('unread')
  const [showSettings, setShowSettings] = useState(false)
  const [showAiSummary, setShowAiSummary] = useState(false)
  const [showAiCard, setShowAiCard] = useState(false)
  const [inboxZero, setInboxZero] = useState(false)
  const [doneSwipeId] = useState('n8')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visibleRows = ROWS.filter(r => !dismissed.has(r.id))
  const unreadRows = visibleRows.filter(r => r.state === 'unread')
  const readRows   = visibleRows.filter(r => r.state === 'read')

  const handleDone = (id: string) => setDismissed(prev => new Set([...prev, id]))
  const handleMute = (id: string) => setDismissed(prev => new Set([...prev, id]))

  const displayRows = activeTab === 'unread' ? unreadRows : activeTab === 'read' ? readRows : []
  const isEmpty = inboxZero || displayRows.length === 0

  return (
    <div className="inbox-root">
      {/* ── Header ──────────────────────────────────────── */}
      <div className="inbox-header">
        <div className="inbox-header-left">
          <h1 className="inbox-title">Inbox</h1>

          {/* Segmented tabs */}
          <div className="inbox-seg">
            {(['unread', 'read', 'done'] as InboxTab[]).map(t => (
              <button
                key={t}
                className={`inbox-seg-btn${activeTab === t ? ' active' : ''}`}
                onClick={() => setActiveTab(t)}
              >
                {t === 'unread' ? `Unread (${unreadRows.length})` : t === 'read' ? 'Read' : 'Done'}
              </button>
            ))}
          </div>
        </div>

        <div className="inbox-header-right">
          {/* AI summarize — visible only when aiOn */}
          {aiOn && (
            <button
              className="inbox-ai-btn"
              onClick={() => { setShowAiSummary(true); setShowAiCard(true) }}
            >
              <Sparkles size={12} strokeWidth={1.5} color="#76A923" />
              <span>Summarise unread</span>
            </button>
          )}

          {/* Edge state demo toggle */}
          <button
            className="inbox-ghost-btn"
            onClick={() => setInboxZero(v => !v)}
            title="Toggle inbox zero demo"
          >
            {inboxZero ? 'Show items' : 'Mark all read'}
          </button>

          <button className="rqa-btn" title="Notification settings" onClick={() => setShowSettings(true)}>
            <Settings size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* ── AI summary card ──────────────────────────────── */}
      {aiOn && showAiSummary && showAiCard && (
        <div className="inbox-ai-strip">
          <AiSummaryCard onDismiss={() => setShowAiCard(false)} />
        </div>
      )}

      {/* ── Notification list ────────────────────────────── */}
      <div className="inbox-list">
        {isEmpty ? (
          <div className="inbox-zero">
            <div className="inbox-zero-icon">
              <Check size={22} strokeWidth={2} color="#A8A29E" />
            </div>
            <div className="inbox-zero-text">You're caught up.</div>
            <div className="inbox-zero-sub">No new notifications.</div>
          </div>
        ) : (
          displayRows.map(row => (
            <NRowEl
              key={row.id}
              row={row}
              isDoneSwipe={row.id === doneSwipeId && activeTab === 'read'}
              onDone={() => handleDone(row.id)}
              onMute={() => handleMute(row.id)}
            />
          ))
        )}
      </div>

      {/* ── Keyboard hint footer ─────────────────────────── */}
      <div className="inbox-kbd-footer">
        <kbd>j</kbd><kbd>k</kbd> navigate &nbsp;·&nbsp;
        <kbd>e</kbd> done &nbsp;·&nbsp;
        <kbd>o</kbd> open &nbsp;·&nbsp;
        <kbd>m</kbd> mute
      </div>

      {/* ── Notification settings modal ──────────────────── */}
      {showSettings && <NotifSettings onClose={() => setShowSettings(false)} />}
    </div>
  )
}
