import { useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Rows3, LayoutGrid, Flag } from 'lucide-react'
import { BOARD_CARDS, EPICS, STATUS_TOTALS, STATUS_COLOR, STATUS_LABEL, type CardStatus, type BoardCard as CardType } from '../data/board'
import BoardCard from './BoardCard'
import { useForge } from '../App'

// ── Column definitions ───────────────────────────────────────
const COLUMNS: { id: CardStatus; wipLimit?: number }[] = [
  { id: 'backlog'                    },
  { id: 'in-progress', wipLimit: 6   },
  { id: 'in-review'                  },
  { id: 'blocked'                    },
  { id: 'done'                       },
]

const TOTAL_ITEMS = Object.values(STATUS_TOTALS).reduce((a, b) => a + b, 0)

// ── Toolbar ──────────────────────────────────────────────────
function BoardToolbar({ swimlanes, onSwimlanes, compact, onCompact }: {
  swimlanes: boolean
  onSwimlanes: (v: boolean) => void
  compact: boolean
  onCompact: (v: boolean) => void
}) {
  return (
    <div className="bv-toolbar">
      <span className="bv-toolbar-count">{TOTAL_ITEMS} items in the active sprint</span>
      <div style={{ flex: 1 }} />
      <button className={`density-btn${swimlanes ? ' active' : ''}`} onClick={() => onSwimlanes(!swimlanes)}>
        <Rows3 size={13} strokeWidth={1.5} />
        Swimlanes
      </button>
      <button className={`density-btn${compact ? ' active' : ''}`} onClick={() => onCompact(!compact)}>
        <LayoutGrid size={13} strokeWidth={1.5} />
        Compact
      </button>
    </div>
  )
}

// ── Board mode ───────────────────────────────────────────────
function BoardColumns({ cards, onMoveStatus, draggingId, onDragToggle, onCardClick, compact }: {
  cards: CardType[]
  onMoveStatus: (id: string, status: CardStatus) => void
  draggingId: string | null
  onDragToggle: (id: string) => void
  onCardClick: () => void
  compact: boolean
}) {
  const byStatus = (s: CardStatus) => cards.filter(c => c.status === s)

  return (
    <div className="board-area">
      {COLUMNS.map(col => {
        const colCards = byStatus(col.id)
        const isDone  = col.id === 'done'
        const wipAtLimit = col.wipLimit != null && colCards.length >= col.wipLimit
        const total   = STATUS_TOTALS[col.id]
        const cardCompact = compact || isDone

        return (
          <div
            key={col.id}
            className={`board-col${isDone ? ' board-col-done' : ''}`}
            style={{ borderTopColor: STATUS_COLOR[col.id] }}
          >
            {/* Column header */}
            <div className="board-col-hdr">
              <span className="board-col-dot" style={{ background: STATUS_COLOR[col.id] }} />
              <span className="board-col-label">{STATUS_LABEL[col.id]}</span>
              <span className="wip-count wip-count-ok">{total}</span>

              {col.wipLimit != null && (
                <span className={`wip-count ${wipAtLimit ? 'wip-count-max' : 'wip-count-ok'}`}>
                  WIP {colCards.length}/{col.wipLimit}
                </span>
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
              {colCards.length === 0 && (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: 4, padding: 16, textAlign: 'center',
                }}>
                  {col.id === 'blocked' ? (
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
              {colCards.map(card => (
                <BoardCard
                  key={card.id}
                  card={card}
                  compact={cardCompact}
                  ghost={draggingId === card.id}
                  onMoveStatus={s => onMoveStatus(card.id, s)}
                  onClickDemo={card.id === 'ip1' ? () => onDragToggle(card.id) : undefined}
                  onOpenDetail={card.id !== 'ip1' ? onCardClick : onCardClick}
                />
              ))}

              {/* Done: "+N more" footer */}
              {isDone && total > colCards.length && (
                <div style={{
                  padding: '5px 10px',
                  fontSize: 11, color: '#A8A29E',
                  borderTop: '1px solid #F0EFEE',
                }}>
                  + {total - colCards.length} more
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Floating drag clone — fixed position over board */}
      {draggingId && (() => {
        const card = cards.find(c => c.id === draggingId)
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
function SwimlaneView({ cards, onMoveStatus, compact }: { cards: CardType[]; onMoveStatus: (id: string, status: CardStatus) => void; compact: boolean }) {
  const epicGroups = [
    ...Object.entries(EPICS).map(([key, epic]) => ({
      key, epic,
      cards: cards.filter(c => c.epicKey === key),
    })),
    {
      key: 'none',
      epic: { key: 'none', name: 'No epic', color: '#A8A29E' },
      cards: cards.filter(c => !c.epicKey),
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
            {STATUS_LABEL[col.id]}
          </div>
        ))}
      </div>

      {/* Lanes */}
      {epicGroups.map(({ key, epic, cards: laneCards }) => {
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
                <span style={{ fontSize: 11, color: '#A8A29E', flexShrink: 0 }}>({laneCards.length})</span>
              </div>
            </div>

            {/* Lane card rows */}
            {!collapsed && (
              <div className="swimlane-lane-row">
                {COLUMNS.map(col => {
                  const colCards = laneCards.filter(c => c.status === col.id)
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
                            onMoveStatus={s => onMoveStatus(card.id, s)}
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
  const { density } = useForge()
  const [cards,       setCards]       = useState(BOARD_CARDS)
  const [swimlanes,   setSwimlanes]   = useState(false)
  const [compact,     setCompact]     = useState(density === 'compact')
  const [draggingId,  setDraggingId]  = useState<string | null>(null)

  const handleDragToggle = (id: string) =>
    setDraggingId(prev => prev === id ? null : id)

  const handleMoveStatus = (id: string, status: CardStatus) =>
    setCards(prev => prev.map(c => c.id === id ? { ...c, status } : c))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <BoardToolbar swimlanes={swimlanes} onSwimlanes={setSwimlanes} compact={compact} onCompact={setCompact} />

      {swimlanes
        ? <SwimlaneView cards={cards} onMoveStatus={handleMoveStatus} compact={compact} />
        : <BoardColumns cards={cards} onMoveStatus={handleMoveStatus} draggingId={draggingId} onDragToggle={handleDragToggle} onCardClick={onCardClick ?? (() => {})} compact={compact} />
      }
    </div>
  )
}
