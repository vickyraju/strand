import { useState } from 'react'
import {
  Bookmark, Bug, SquareCheck,
  ChevronsUp, ChevronUp, Equal, ChevronDown,
  MoreHorizontal, ShieldAlert,
} from 'lucide-react'
import type { BoardCard as CardType, Priority, CardType as CT, CardStatus } from '../data/board'
import { STATUS_COLOR, STATUS_LABEL } from '../data/board'

// ── Type icon ────────────────────────────────────────────────
const TYPE_META: Record<CT, { Icon: typeof Bookmark; color: string }> = {
  story: { Icon: Bookmark,   color: '#059669' },
  bug:   { Icon: Bug,        color: '#DC2626' },
  task:  { Icon: SquareCheck, color: '#4F46E5' },
}

// ── Priority glyph ───────────────────────────────────────────
function PriorityGlyph({ p }: { p: Priority }) {
  const s = { size: 13, strokeWidth: 2, style: { flexShrink: 0 } as React.CSSProperties }
  if (p === 'urgent') return <ChevronsUp {...s} color="#DC2626" />
  if (p === 'high')   return <ChevronUp  {...s} color="#D97706" />
  if (p === 'medium') return <Equal      {...s} color="#78716C" />
  return                       <ChevronDown {...s} color="#78716C" />
}

// ── Label chip ───────────────────────────────────────────────
const LABEL_STYLES = {
  gray:   { bg: '#F5F5F4', color: '#78716C',  border: 'transparent' },
  amber:  { bg: '#FEF3C7', color: '#B45309',  border: '#FDE68A'     },
  indigo: { bg: '#EEF2FF', color: '#4338CA',  border: 'transparent' },
  red:    { bg: '#FEF2F2', color: '#DC2626',  border: 'transparent' },
}

const STATUS_MENU: CardStatus[] = ['backlog', 'in-progress', 'in-review', 'blocked', 'done']

// ── Props ────────────────────────────────────────────────────
interface BoardCardProps {
  card:          CardType
  compact?:      boolean
  ghost?:        boolean
  dragging?:     boolean
  onMoveStatus?: (status: CardStatus) => void
  onClickDemo?:  () => void
  onOpenDetail?: () => void
}

export default function BoardCard({ card, compact, ghost, dragging, onMoveStatus, onClickDemo, onOpenDetail }: BoardCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  // ── Compact row (Done column / density=compact) ───────────
  if (compact) {
    return (
      <div
        className="board-card-compact"
        onClick={onClickDemo ?? onOpenDetail}
      >
        <span style={{ fontSize: 10, color: '#A8A29E', fontFamily: 'monospace', flexShrink: 0 }}>
          {card.key}
        </span>
        <span style={{
          flex: 1, fontSize: 12, color: '#1C1917',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {card.title}
        </span>
        <div style={{
          width: 18, height: 18, borderRadius: '50%', background: card.assignee.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 8, fontWeight: 600, color: 'white', flexShrink: 0,
        }}>{card.assignee.initials}</div>
      </div>
    )
  }

  // ── Full card ─────────────────────────────────────────────
  const { Icon: TypeIcon, color: typeColor } = TYPE_META[card.type]
  const otherStatuses = STATUS_MENU.filter(s => s !== card.status)

  return (
    <div
      className={`board-card${ghost ? ' ghost' : ''}${dragging ? ' is-dragging' : ''}`}
      onClick={onClickDemo ?? onOpenDetail}
    >
      {/* PII flag */}
      {card.piiFlag && (
        <div style={{ marginBottom: 6 }}>
          <span className="pii-badge">
            <ShieldAlert size={10} strokeWidth={2} />
            PII flagged
          </span>
        </div>
      )}

      {/* Row 1: type icon + key … priority + menu */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <TypeIcon size={14} strokeWidth={2} color={typeColor} style={{ flexShrink: 0 }} />
        <span className="bc-key">{card.key}</span>
        <div style={{ flex: 1 }} />
        <PriorityGlyph p={card.priority} />
        <div style={{ position: 'relative' }}>
          <button
            className="bc-menu-btn"
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
            title={`Move ${card.key}`}
          >
            <MoreHorizontal size={14} strokeWidth={1.5} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={e => { e.stopPropagation(); setMenuOpen(false) }} />
              <div className="bc-menu-dropdown" onClick={e => e.stopPropagation()}>
                <div className="status-dropdown-cur">Move to</div>
                {otherStatuses.map(s => (
                  <div
                    key={s}
                    className="status-dropdown-item"
                    onClick={() => { onMoveStatus?.(s); setMenuOpen(false) }}
                  >
                    <div className="status-dropdown-item-label">
                      <span className="status-dot" style={{ background: STATUS_COLOR[s] }} />
                      {STATUS_LABEL[s]}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Row 2: title */}
      <div style={{
        fontSize: 13, fontWeight: 600, color: '#1C1917',
        lineHeight: 1.4, marginBottom: 8,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>{card.title}</div>

      {/* Row 3: labels */}
      {card.labels.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {card.labels.slice(0, 2).map(l => {
            const s = LABEL_STYLES[l.variant]
            return (
              <span key={l.text} className="card-label" style={{
                background: s.bg, color: s.color,
                border: `1px solid ${s.border}`,
              }}>{l.text}</span>
            )
          })}
        </div>
      )}

      {/* Row 4: points + subtasks … avatar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {card.points != null && <span className="bc-points">{card.points}</span>}
        {card.subtasksTotal != null && (
          <span className="bc-subtasks">{card.subtasksDone ?? 0}/{card.subtasksTotal}</span>
        )}
        <div style={{ flex: 1 }} />
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: card.assignee.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 600, color: 'white', flexShrink: 0,
        }}>{card.assignee.initials}</div>
      </div>
    </div>
  )
}
