import { useState } from 'react'
import {
  ChevronDown, ChevronRight, MoreHorizontal, Plus,
  Sparkles, X, ChevronDown as Chevron, Flag,
  CheckCircle2,
} from 'lucide-react'
import { BOARD_CARDS, SPRINT_MEMBERS, EPICS, STATUS_TOTALS, type CardStatus } from '../data/board'
import BoardCard from './BoardCard'
import { useForge } from '../App'

// ── Column definitions ───────────────────────────────────────
const COLUMNS: { id: CardStatus; label: string; wipLimit?: number }[] = [
  { id: 'backlog',       label: 'Backlog'     },
  { id: 'in-progress',   label: 'In progress', wipLimit: 6 },
  { id: 'in-review',     label: 'In review'   },
  { id: 'blocked',       label: 'Blocked'     },
  { id: 'done',          label: 'Done'        },
]

// ── Filter token type ────────────────────────────────────────
interface Token { id: string; key: string; op: string; val: string }

const DEFAULT_TOKENS: Token[] = [
  { id: 'assignee', key: 'assignee', op: '=', val: '@me'        },
  { id: 'label',    key: 'label',    op: '=', val: '"month-end"' },
]

// ── Sprint header ────────────────────────────────────────────
function BoardHeader({ viewMode, onViewModeChange }: {
  viewMode: 'board' | 'swimlane'
  onViewModeChange: (m: 'board' | 'swimlane') => void
}) {
  return (
    <div className="board-header">
      {/* Sprint title */}
      <button style={{
        display: 'flex', alignItems: 'center', gap: 5,
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        fontFamily: 'inherit',
      }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
          Sprint 42 — Settlement hardening
        </span>
        <Chevron size={16} strokeWidth={1.5} color="#A8A29E" />
      </button>

      {/* 8 days left */}
      <span className="days-chip">8 days left</span>

      {/* Sprint progress bar */}
      <div className="sprint-progress">
        <div className="sprint-progress-fill" style={{ width: '34%' }} />
      </div>

      <div style={{ flex: 1 }} />

      {/* Avatar stack: 6 members + 3 overflow */}
      <div className="avatar-stack">
        {SPRINT_MEMBERS.map((m, i) => (
          <div
            key={m.initials}
            className="avatar-stack-item"
            title={m.name}
            style={{ background: m.color, zIndex: SPRINT_MEMBERS.length - i }}
          >{m.initials}</div>
        ))}
        <div className="avatar-stack-item avatar-overflow" style={{ zIndex: 0 }}>+3</div>
      </div>

      {/* Complete sprint */}
      <button className="btn-sprint">
        <CheckCircle2 size={13} strokeWidth={1.5} />
        Complete sprint
      </button>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: '#E7E5E4', flexShrink: 0 }} />

      {/* Board / Swimlane toggle */}
      <div className="view-toggle">
        {(['board', 'swimlane'] as const).map(m => (
          <button
            key={m}
            className={`view-toggle-btn ${viewMode === m ? 'active' : 'inactive'}`}
            onClick={() => onViewModeChange(m)}
            style={{ textTransform: 'capitalize' }}
          >{m}</button>
        ))}
      </div>
    </div>
  )
}

// ── Filter bar ───────────────────────────────────────────────
function FilterBar({ tokens, onRemove }: {
  tokens: Token[]
  onRemove: (id: string) => void
}) {
  const { aiOn } = useForge()

  return (
    <div className="filter-bar">
      {/* Token chips */}
      {tokens.map(t => (
        <span key={t.id} className="filter-token">
          <span className="filter-token-key">{t.key}</span>
          <span className="filter-token-op">{t.op}</span>
          <span className="filter-token-val">{t.val}</span>
          <button className="filter-token-rm" onClick={() => onRemove(t.id)} title={`Remove ${t.key} filter`}>
            <X size={10} strokeWidth={2.5} />
          </button>
        </span>
      ))}

      {/* + Filter */}
      <button className="btn-filter-add">
        <Plus size={12} strokeWidth={2} />
        Filter
      </button>

      {/* Saved view dropdown */}
      <button className="saved-view-btn">
        My month-end view
        <ChevronDown size={12} strokeWidth={1.5} />
      </button>

      <div style={{ flex: 1 }} />

      {/* AI assist filter — hidden when aiOn = false */}
      {aiOn && (
        <button className="btn-assist-filter">
          <Sparkles size={11} strokeWidth={1.5} />
          Filter with plain English
        </button>
      )}
    </div>
  )
}

// ── Board mode ───────────────────────────────────────────────
function BoardColumns({ draggingId, onDragToggle, onCardClick }: {
  draggingId: string | null
  onDragToggle: (id: string) => void
  onCardClick: () => void
}) {
  const { density } = useForge()
  const compact = density === 'compact'

  const byStatus = (s: CardStatus) => BOARD_CARDS.filter(c => c.status === s)

  return (
    <div className="board-area">
      {COLUMNS.map(col => {
        const cards   = byStatus(col.id)
        const isDone  = col.id === 'done'
        const isBlocked = col.id === 'blocked'
        const wipAtLimit = col.wipLimit != null && cards.length >= col.wipLimit
        const total   = STATUS_TOTALS[col.id]
        const cardCompact = compact || isDone

        return (
          <div
            key={col.id}
            className={`board-col${isDone ? ' board-col-done' : ''}${isBlocked ? ' board-col-blocked' : ''}`}
          >
            {/* Column header */}
            <div className="board-col-hdr">
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1C1917', whiteSpace: 'nowrap' }}>
                {col.label}
              </span>

              {col.wipLimit != null ? (
                <span className={`wip-count ${wipAtLimit ? 'wip-count-max' : 'wip-count-ok'}`}>
                  {cards.length} / WIP {col.wipLimit}
                </span>
              ) : (
                <span className="wip-count wip-count-ok">{total}</span>
              )}

              <div style={{ flex: 1 }} />

              {!isDone && (
                <>
                  <button className="col-hdr-btn" title="Add issue">
                    <Plus size={13} strokeWidth={2} />
                  </button>
                  <button className="col-hdr-btn" title="Column options">
                    <MoreHorizontal size={13} strokeWidth={1.5} />
                  </button>
                </>
              )}
            </div>

            {/* Column body */}
            <div className="board-col-body">

              {/* Empty state (Blocked column) */}
              {cards.length === 0 && (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: 4, padding: 16, textAlign: 'center',
                }}>
                  {isBlocked ? (
                    <>
                      <Flag size={18} strokeWidth={1.5} color="#A8A29E" />
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#1C1917' }}>
                        Nothing blocked
                      </span>
                      <span style={{ fontSize: 12, color: '#A8A29E' }}>Nice.</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: '#A8A29E' }}>No issues</span>
                  )}
                </div>
              )}

              {/* Drop placeholder in "In review" when dragging */}
              {col.id === 'in-review' && draggingId && (
                <div className="drop-slot">
                  <span style={{ fontSize: 11, color: '#818CF8' }}>Drop to move here</span>
                </div>
              )}

              {/* Cards */}
              {cards.map(card => (
                <BoardCard
                  key={card.id}
                  card={card}
                  compact={cardCompact}
                  ghost={draggingId === card.id}
                  onClickDemo={card.id === 'ip1' ? () => onDragToggle(card.id) : undefined}
                  onOpenDetail={card.id !== 'ip1' ? onCardClick : onCardClick}
                />
              ))}

              {/* Done: "+N more" footer */}
              {isDone && total > cards.length && (
                <div style={{
                  padding: '5px 10px',
                  fontSize: 11, color: '#A8A29E',
                  borderTop: '1px solid #F0EFEE',
                }}>
                  + {total - cards.length} more
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Floating drag clone — fixed position over board */}
      {draggingId && (() => {
        const card = BOARD_CARDS.find(c => c.id === draggingId)
        if (!card) return null
        return (
          <div style={{
            position: 'fixed',
            top: 200,
            left: 380,
            width: 248,
            zIndex: 300,
            pointerEvents: 'none',
          }}>
            <BoardCard card={card} dragging />
          </div>
        )
      })()}
    </div>
  )
}

// ── Swimlane mode ────────────────────────────────────────────
function SwimlaneView() {
  const { density } = useForge()
  const compact = density === 'compact'

  const epicGroups = [
    ...Object.entries(EPICS).map(([key, epic]) => ({
      key, epic,
      cards: BOARD_CARDS.filter(c => c.epicKey === key),
    })),
    {
      key: 'none',
      epic: { key: 'none', name: 'No epic', color: '#A8A29E' },
      cards: BOARD_CARDS.filter(c => !c.epicKey),
    },
  ].filter(g => g.cards.length > 0)

  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())

  const toggleLane = (key: string) =>
    setCollapsedLanes(prev => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
      {/* Sticky column headers */}
      <div className="swimlane-col-headers">
        {COLUMNS.map(col => (
          <div
            key={col.id}
            className={`swimlane-col-hdr-cell${col.id === 'done' ? ' swimlane-col-hdr-done' : ''}`}
          >
            {col.label}
          </div>
        ))}
      </div>

      {/* Lanes */}
      {epicGroups.map(({ key, epic, cards }) => {
        const collapsed = collapsedLanes.has(key)
        return (
          <div key={key}>
            {/* Lane header */}
            <div className="swimlane-lane-hdr" onClick={() => toggleLane(key)}>
              {/* Spacer to align with lane rows (which have 200px left padding) */}
              <div style={{ width: 184, display: 'flex', alignItems: 'center', gap: 8 }}>
                {collapsed
                  ? <ChevronRight size={13} strokeWidth={1.5} color="#A8A29E" />
                  : <ChevronDown  size={13} strokeWidth={1.5} color="#A8A29E" />
                }
                <div style={{ width: 8, height: 8, borderRadius: 2, background: epic.color, flexShrink: 0 }} />
                {key !== 'none' && (
                  <span style={{ fontSize: 11, color: '#78716C', fontFamily: 'monospace', flexShrink: 0 }}>
                    {epic.key}
                  </span>
                )}
                <span style={{ fontSize: 12, fontWeight: 600, color: '#1C1917', whiteSpace: 'nowrap' }}>
                  {epic.name}
                </span>
                <span style={{ fontSize: 11, color: '#A8A29E', flexShrink: 0 }}>({cards.length})</span>
              </div>
            </div>

            {/* Lane card rows */}
            {!collapsed && (
              <div className="swimlane-lane-row">
                {COLUMNS.map(col => {
                  const colCards = cards.filter(c => c.status === col.id)
                  return (
                    <div
                      key={col.id}
                      className={`swimlane-cell${col.id === 'done' ? ' swimlane-cell-done' : ''}`}
                    >
                      {colCards.length === 0 ? (
                        <div className="swimlane-empty-cell">
                          <span style={{ fontSize: 10, color: '#E7E5E4' }}>—</span>
                        </div>
                      ) : (
                        colCards.map(card => (
                          <BoardCard
                            key={card.id}
                            card={card}
                            compact={compact || col.id === 'done'}
                          />
                        ))
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Root board view ──────────────────────────────────────────
export default function BoardView({ onCardClick }: { onCardClick?: () => void }) {
  const [viewMode,    setViewMode]    = useState<'board' | 'swimlane'>('board')
  const [draggingId,  setDraggingId]  = useState<string | null>(null)
  const [tokens,      setTokens]      = useState(DEFAULT_TOKENS)

  const handleDragToggle = (id: string) =>
    setDraggingId(prev => prev === id ? null : id)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <BoardHeader viewMode={viewMode} onViewModeChange={setViewMode} />
      <FilterBar tokens={tokens} onRemove={id => setTokens(t => t.filter(x => x.id !== id))} />

      {viewMode === 'board'
        ? <BoardColumns draggingId={draggingId} onDragToggle={handleDragToggle} onCardClick={onCardClick ?? (() => {})} />
        : <SwimlaneView />
      }
    </div>
  )
}
