import { useState } from 'react'
import {
  BookOpen, Bug, CheckSquare,
  ChevronsUp, ChevronUp, Minus, ChevronDown,
  User, ArrowRight, Flag, MessageSquare, Paperclip, ShieldAlert,
} from 'lucide-react'
import type { BoardCard as CardType, Priority, CardType as CT } from '../data/board'

// ── Type icon ────────────────────────────────────────────────
const TYPE_META: Record<CT, { Icon: typeof BookOpen; color: string }> = {
  story: { Icon: BookOpen,    color: '#4F46E5' },
  bug:   { Icon: Bug,         color: '#DC2626' },
  task:  { Icon: CheckSquare, color: '#78716C' },
}

// ── Priority glyph ───────────────────────────────────────────
function PriorityGlyph({ p }: { p: Priority }) {
  const s = { size: 12, strokeWidth: 2, style: { flexShrink: 0 } as React.CSSProperties }
  if (p === 'urgent') return <ChevronsUp {...s} color="#DC2626" />
  if (p === 'high')   return <ChevronUp  {...s} color="#D97706" />
  if (p === 'medium') return <Minus      {...s} color="#D6D3D1" />
  return                       <ChevronDown {...s} color="#E7E5E4" />
}

// ── Label chip ───────────────────────────────────────────────
const LABEL_STYLES = {
  gray:   { bg: '#F5F5F4', color: '#78716C',  border: 'transparent' },
  amber:  { bg: '#FEF3C7', color: '#B45309',  border: '#FDE68A'     },
  indigo: { bg: '#EEF2FF', color: '#4338CA',  border: 'transparent' },
  red:    { bg: '#FEF2F2', color: '#DC2626',  border: 'transparent' },
}

// ── Props ────────────────────────────────────────────────────
interface BoardCardProps {
  card:          CardType
  compact?:      boolean
  ghost?:        boolean
  dragging?:     boolean
  onClickDemo?:  () => void
  onOpenDetail?: () => void
}

export default function BoardCard({ card, compact, ghost, dragging, onClickDemo, onOpenDetail }: BoardCardProps) {
  const [hovered, setHovered] = useState(false)

  // ── Compact row (Done column / density=compact) ───────────
  if (compact) {
    return (
      <div
        className="board-card-compact"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ background: hovered ? '#F5F5F4' : 'transparent' }}
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

  return (
    <div
      className={`board-card${ghost ? ' ghost' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{
        borderLeft: card.epicColor && !ghost ? `4px solid ${card.epicColor}` : undefined,
        paddingLeft: card.epicColor && !ghost ? 8 : undefined,
      }}
      onMouseEnter={() => !ghost && !dragging && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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

      {/* Row 1: key + type icon + priority */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
        <span style={{
          fontSize: 10, color: '#A8A29E', fontFamily: 'monospace',
          letterSpacing: '0.01em', flexShrink: 0,
        }}>{card.key}</span>
        <TypeIcon size={13} strokeWidth={1.5} color={typeColor} style={{ flexShrink: 0 }} />
        <PriorityGlyph p={card.priority} />
      </div>

      {/* Row 2: title */}
      <div style={{
        fontSize: 13, fontWeight: 500, color: '#1C1917',
        lineHeight: 1.4, marginBottom: 8,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>{card.title}</div>

      {/* Row 3: labels + avatar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0, flexWrap: 'nowrap', overflow: 'hidden' }}>
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
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: card.assignee.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 600, color: 'white', flexShrink: 0,
        }}>{card.assignee.initials}</div>
      </div>

      {/* Hover reveal: quick actions + meta */}
      {hovered && !ghost && (
        <div className="card-actions">
          {[
            { Icon: User,        title: 'Assign — A'        },
            { Icon: ArrowRight,  title: 'Move — M'          },
            { Icon: Flag,        title: 'Flag as blocked — F'},
          ].map(({ Icon, title }) => (
            <button key={title} className="card-action-btn" title={title}>
              <Icon size={11} strokeWidth={1.5} />
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {card.commentCount != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#A8A29E' }}>
              <MessageSquare size={10} strokeWidth={1.5} />
              {card.commentCount}
            </span>
          )}
          {card.attachCount != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#A8A29E', marginLeft: 4 }}>
              <Paperclip size={10} strokeWidth={1.5} />
              {card.attachCount}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
