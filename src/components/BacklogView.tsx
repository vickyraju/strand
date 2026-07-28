import { useState, useEffect, useRef } from 'react'
import {
  ChevronDown, ChevronRight, Plus, Sparkles, X,
  MoreHorizontal, BookOpen, Bug, CheckSquare, ShieldAlert,
  GripVertical, Trash2, Tag, User, Check, ArrowUp,
  LayoutList,
} from 'lucide-react'
import { useForge } from '../App'

// ── Data ─────────────────────────────────────────────────────

const PR = { initials: 'PR', color: '#4F46E5', name: 'Priya Raman' }
const DO = { initials: 'DO', color: '#0891B2', name: 'Daniel Okafor' }
const SM = { initials: 'SM', color: '#16A34A', name: 'Sofia Marek' }
const LF = { initials: 'LF', color: '#0369A1', name: 'Luca Ferreira' }
const MC = { initials: 'MC', color: '#EA580C', name: 'Marcus Chen' }
const NO = { initials: 'NO', color: '#DB2777', name: 'Nadia Osei' }

type IT = 'story' | 'bug' | 'task'

interface BItem {
  id: string; key: string; type: IT; pts: number
  title: string
  epicKey?: string; epicColor?: string
  label?: { text: string; bg: string; color: string }
  assignee?: typeof PR
  piiFlag?: boolean
}

const TYPE_META: Record<IT, { color: string; Icon: typeof BookOpen }> = {
  story: { color: '#4F46E5', Icon: BookOpen    },
  bug:   { color: '#DC2626', Icon: Bug         },
  task:  { color: '#78716C', Icon: CheckSquare },
}

const ME_LABEL  = { text: 'month-end',  bg: '#F5F5F4', color: '#78716C' }
const REG_LABEL = { text: 'regulatory', bg: '#FEF3C7', color: '#B45309' }

const SPRINT_ITEMS: BItem[] = [
  { id: 's1', key: 'PAY-421',   type: 'story', pts: 8, title: 'Configure HMAC verification for v3 webhook endpoints',               epicKey: 'PAY-201', epicColor: '#D97706', label: ME_LABEL,  assignee: PR },
  { id: 's2', key: 'PAY-419',   type: 'story', pts: 5, title: 'Dead letter queue for failed settlement events past retry budget',   epicKey: 'PAY-201', epicColor: '#D97706', label: ME_LABEL,  assignee: SM },
  { id: 's3', key: 'PAY-422',   type: 'task',  pts: 3, title: 'Structured retry logging: add correlation IDs to all attempt entries', epicKey: 'PAY-201', epicColor: '#D97706',                 assignee: LF },
  { id: 's4', key: 'PLAT-4825', type: 'bug',   pts: 8, title: 'Memory leak in reconciliation job under high-cardinality load',      epicKey: 'PLAT-101', epicColor: '#16A34A',                  assignee: DO },
  { id: 's5', key: 'PAY-423',   type: 'story', pts: 7, title: 'FX rate circuit breaker: configurable threshold per currency pair',  epicKey: 'PAY-201', epicColor: '#D97706',                  assignee: MC },
]

const BACKLOG_ITEMS: BItem[] = [
  { id: 'b1',  key: 'PAY-415',   type: 'task',  pts: 3, title: 'Add OpenTelemetry spans to the settlement pipeline',              epicKey: 'PLAT-101', epicColor: '#16A34A',                  assignee: LF },
  { id: 'b2',  key: 'PAY-416',   type: 'task',  pts: 2, title: 'Webhook delivery log retention: enforce 90-day default policy',                                                                assignee: MC },
  { id: 'b3',  key: 'PAY-417',   type: 'story', pts: 8, title: 'FX rate fallback strategy when primary provider is unreachable',   epicKey: 'PAY-201', epicColor: '#D97706', label: ME_LABEL,  assignee: PR },
  { id: 'b4',  key: 'PAY-424',   type: 'story', pts: 5, title: 'Dead letter queue visual status in operations admin dashboard',                                                                  assignee: SM },
  { id: 'b5',  key: 'PAY-420',   type: 'task',  pts: 3, title: 'Audit trail for manual settlement overrides by operations team',                                                                assignee: NO },
  { id: 'b6',  key: 'PAY-425',   type: 'bug',   pts: 5, title: 'SWIFT MT103 parser fails on trailing whitespace in amount field',  epicKey: 'PAY-108', epicColor: '#7C3AED', label: REG_LABEL, assignee: DO },
  { id: 'b7',  key: 'PAY-426',   type: 'task',  pts: 3, title: 'Rotate signing keys for all active webhook subscriptions',         epicKey: 'PAY-108', epicColor: '#7C3AED',                  assignee: LF },
  { id: 'b8',  key: 'PAY-427',   type: 'story', pts: 5, title: 'Rate limit webhook delivery per subscriber tier',                 epicKey: 'PAY-201', epicColor: '#D97706', label: ME_LABEL,  assignee: PR },
  { id: 'b9',  key: 'RISK-1205', type: 'task',  pts: 2, title: 'KYC batch job: alert on >100 document expiries in rolling 24h',                                                                assignee: DO, piiFlag: true },
  { id: 'b10', key: 'PAY-428',   type: 'bug',   pts: 5, title: 'Settlement confirmation callback: 504 not retried under NGINX config', epicKey: 'PLAT-101', epicColor: '#16A34A',             assignee: SM },
]

const EPICS = [
  { key: 'PAY-201',  name: 'Month-end resilience', color: '#D97706', done: 12, total: 31, pts: 86 },
  { key: 'PAY-108',  name: 'Auth hardening',        color: '#7C3AED', done: 8,  total: 18, pts: 52 },
  { key: 'PLAT-101', name: 'Infrastructure',         color: '#16A34A', done: 15, total: 22, pts: 47 },
  { key: 'RISK-100', name: 'Compliance',             color: '#DC2626', done: 3,  total: 9,  pts: 24 },
]

// ── Row component ─────────────────────────────────────────────

function BlRow({
  item, isSelected, isDragging, isChecked, multiSelect, onCheck, onClick,
}: {
  item: BItem
  isSelected?: boolean
  isDragging?: boolean
  isChecked?: boolean
  multiSelect?: boolean
  onCheck?: () => void
  onClick?: () => void
}) {
  const { Icon, color } = TYPE_META[item.type]

  let rowClass = 'bl-row'
  if (isSelected) rowClass += ' is-selected'
  if (isDragging) rowClass += ' is-dragging'

  return (
    <div className={rowClass} onClick={onClick}>
      {/* Drag handle */}
      <div className="bl-drag-handle">
        <GripVertical size={13} strokeWidth={1.5} />
      </div>

      {/* Checkbox — shown on hover or in multi-select mode */}
      {(multiSelect || isChecked) && (
        <div
          className={`bl-check${isChecked ? ' checked' : ''}`}
          onClick={e => { e.stopPropagation(); onCheck?.() }}
          style={{ opacity: 1 }}
        >
          {isChecked && <Check size={9} strokeWidth={3} color="white" />}
        </div>
      )}
      {!multiSelect && !isChecked && (
        <div className="bl-check" onClick={e => { e.stopPropagation(); onCheck?.() }} />
      )}

      {/* Type icon */}
      <Icon size={13} strokeWidth={1.5} color={color} style={{ flexShrink: 0 }} />

      {/* Key */}
      <span className="bl-key">{item.key}</span>

      {/* Title */}
      <span className="bl-title-cell">{item.title}</span>

      {/* PII badge */}
      {item.piiFlag && (
        <span className="pii-badge-sm">
          <ShieldAlert size={9} strokeWidth={2} />
          PII
        </span>
      )}

      {/* Epic dot */}
      {item.epicColor && (
        <span className="bl-epic-dot" style={{ background: item.epicColor }} title={item.epicKey} />
      )}

      {/* Points */}
      <span className="bl-pts">{item.pts}</span>

      {/* Label */}
      {item.label && (
        <span className="bl-label" style={{ background: item.label.bg, color: item.label.color }}>
          {item.label.text}
        </span>
      )}

      {/* Avatar */}
      {item.assignee && (
        <div className="bl-av" style={{ background: item.assignee.color }} title={item.assignee.name}>
          {item.assignee.initials}
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// BacklogView root
// ════════════════════════════════════════════════════════════

export default function BacklogView() {
  const { aiOn } = useForge()

  const [sprintCollapsed, setSprintCollapsed] = useState(false)
  const [epicPanelOpen,   setEpicPanelOpen]   = useState(false)
  const [overCapacity,    setOverCapacity]    = useState(false)
  const [showAssistCard,  setShowAssistCard]  = useState(false)
  const [emptySprintMode, setEmptySprintMode] = useState(false)
  const [activeEpic,      setActiveEpic]      = useState<string | null>(null)
  const [qcActive,        setQcActive]        = useState(false)
  const [qcText,          setQcText]          = useState('')
  const [multiSelect,     setMultiSelect]     = useState(false)
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set())
  const [typeFilter,      setTypeFilter]      = useState<'story' | null>('story')

  const qcRef = useRef<HTMLInputElement>(null)

  // capacity
  const pts      = overCapacity ? 42 : 31
  const velocity = 36
  const capPct   = Math.min((pts / velocity) * 100, 100)
  const isOver   = pts > velocity

  // pre-select rows for multi-select demo
  useEffect(() => {
    if (multiSelect) {
      setSelectedIds(new Set(['b2', 'b3', 'b6']))
    } else {
      setSelectedIds(new Set())
    }
  }, [multiSelect])

  // N key → activate quick create
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        setQcActive(true)
        setTimeout(() => qcRef.current?.focus(), 50)
      }
      if (e.key === 'Escape') {
        setQcActive(false)
        setQcText('')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggleCheck = (id: string) => {
    setSelectedIds(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      if (n.size > 0) setMultiSelect(true)
      return n
    })
  }

  const clearSelect = () => {
    setSelectedIds(new Set())
    setMultiSelect(false)
  }

  const filteredBacklog = activeEpic
    ? BACKLOG_ITEMS.filter(i => i.epicKey === activeEpic)
    : BACKLOG_ITEMS

  // ── Context header ────────────────────────────────────────
  const ctxHeader = (
    <div className="bl-ctx-hdr">
      <span className="bl-ctx-title">Backlog — Payments</span>

      {/* Epic panel toggle */}
      <button
        onClick={() => setEpicPanelOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 9px', borderRadius: 6,
          border: `1px solid ${epicPanelOpen ? '#C7D2FE' : '#E7E5E4'}`,
          background: epicPanelOpen ? '#ECFDF5' : '#FFFFFF',
          color: epicPanelOpen ? '#004833' : '#78716C',
          fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
          fontWeight: epicPanelOpen ? 500 : 400,
          transition: 'all var(--dur-micro) var(--ease)',
        }}
      >
        <LayoutList size={13} strokeWidth={1.5} />
        Epics
      </button>

      {/* Filter token: type = story */}
      {typeFilter && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 8px', borderRadius: 5,
          border: '1px solid #E7E5E4', background: '#F5F5F4',
          fontSize: 12, color: '#78716C',
        }}>
          <span style={{ fontWeight: 500, color: '#1C1917' }}>type</span>
          <span style={{ color: '#A8A29E' }}>=</span>
          <span>story</span>
          <button
            onClick={() => setTypeFilter(null)}
            style={{
              border: 'none', background: 'none', cursor: 'pointer',
              color: '#A8A29E', display: 'flex', padding: 0,
            }}
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </span>
      )}

      {/* Epic filter token */}
      {activeEpic && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 8px', borderRadius: 5,
          border: '1px solid #86C5A8', background: '#ECFDF5',
          fontSize: 12, color: '#004833',
        }}>
          <span style={{ fontWeight: 500 }}>epic</span>
          <span style={{ color: '#818CF8' }}>=</span>
          <span>{activeEpic}</span>
          <button
            onClick={() => setActiveEpic(null)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#818CF8', display: 'flex', padding: 0 }}
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </span>
      )}

      <button style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 9px', borderRadius: 5,
        border: '1px solid #E7E5E4', background: 'transparent',
        color: '#78716C', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
      }}>
        <Plus size={11} strokeWidth={2} />
        Filter
      </button>

      <div style={{ flex: 1 }} />

      {/* Multi-select demo toggle */}
      <button
        onClick={() => setMultiSelect(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 9px', borderRadius: 5,
          border: `1px solid ${multiSelect ? '#C7D2FE' : '#E7E5E4'}`,
          background: multiSelect ? '#ECFDF5' : 'transparent',
          color: multiSelect ? '#004833' : '#78716C',
          fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', fontWeight: multiSelect ? 500 : 400,
        }}
        title="Toggle multi-select demo"
      >
        {multiSelect ? <Check size={11} strokeWidth={2} /> : null}
        {multiSelect ? 'Multi-select on' : 'Select'}
      </button>

      {/* Start sprint */}
      <button style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 14px', borderRadius: 6,
        border: 'none', background: '#006044',
        color: 'white', fontSize: 13, fontWeight: 500,
        fontFamily: 'inherit', cursor: 'pointer',
      }}>
        Start sprint
      </button>
    </div>
  )

  // ── Sprint band ───────────────────────────────────────────
  const sprintBand = (
    <div className="sprint-band">
      {/* Header row */}
      <div className="sprint-band-hdr" onClick={() => setSprintCollapsed(v => !v)}>
        {sprintCollapsed
          ? <ChevronRight size={13} strokeWidth={1.5} color="#78716C" />
          : <ChevronDown  size={13} strokeWidth={1.5} color="#78716C" />
        }

        <span className="sprint-name">Sprint 43 — Draft</span>

        <span className="date-chip">17 Jul – 31 Jul</span>

        <div style={{ flex: 1 }} />

        {/* Capacity summary + bar */}
        <button
          onClick={e => { e.stopPropagation(); setOverCapacity(v => !v) }}
          title="Toggle over-capacity demo"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
            padding: '2px 4px', borderRadius: 4,
          }}
        >
          <span className={`cap-summary${isOver ? ' over' : ''}`}>
            {isOver
              ? `${pts} pts · ${pts - velocity} pts over`
              : `${pts} pts committed · team velocity ~${velocity}`
            }
          </span>
          <div className="cap-bar">
            <div
              className={`cap-fill${isOver ? ' over' : ' safe'}`}
              style={{ width: `${capPct}%` }}
            />
          </div>
        </button>

        {/* AI Suggest sprint scope — purple, hidden when AI off */}
        {aiOn && (
          <button
            onClick={e => { e.stopPropagation(); setShowAssistCard(v => !v) }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 9px', borderRadius: 5,
              border: '1px solid #B8E0A0', background: showAssistCard ? '#E8F5D0' : '#F3F9E8',
              color: '#4A7A1A', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            <Sparkles size={10} strokeWidth={1.5} />
            Suggest sprint scope
          </button>
        )}

        <button
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, borderRadius: 5,
            border: 'none', background: 'transparent', cursor: 'pointer', color: '#78716C',
          }}
          onClick={e => e.stopPropagation()}
          title="Sprint options"
        >
          <MoreHorizontal size={13} strokeWidth={1.5} />
        </button>

        {/* Empty sprint demo toggle */}
        <button
          onClick={e => { e.stopPropagation(); setEmptySprintMode(v => !v) }}
          style={{
            fontSize: 10, color: '#A8A29E', border: '1px solid #E7E5E4', background: 'none',
            borderRadius: 4, padding: '1px 5px', cursor: 'pointer', fontFamily: 'inherit',
          }}
          title="Toggle empty sprint demo"
        >
          {emptySprintMode ? 'fill' : 'empty'}
        </button>
      </div>

      {/* Assist suggest card */}
      {!sprintCollapsed && aiOn && showAssistCard && (
        <div className="assist-suggest-card">
          <Sparkles size={13} strokeWidth={1.5} color="#76A923" style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            Assist suggests <strong>4 items (28 pts)</strong> based on priority and velocity
          </span>
          <button
            onClick={() => setShowAssistCard(false)}
            style={{
              padding: '3px 10px', borderRadius: 5, border: '1px solid #76A923',
              background: '#76A923', color: '#1C1917', fontSize: 11,
              fontFamily: 'inherit', cursor: 'pointer', fontWeight: 500,
            }}
          >Apply</button>
          <button
            onClick={() => setShowAssistCard(false)}
            style={{
              padding: '3px 8px', borderRadius: 5, border: '1px solid #C6D9A0',
              background: 'transparent', color: '#4A7A1A', fontSize: 11,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >Dismiss</button>
        </div>
      )}

      {/* Sprint body */}
      {!sprintCollapsed && (
        <div className="sprint-body">
          {emptySprintMode ? (
            <div className="sprint-empty">
              <ArrowUp size={18} strokeWidth={1.5} />
              <span style={{ fontSize: 13, fontWeight: 500, color: '#78716C' }}>
                Drag items here or press N to plan Sprint 43
              </span>
              <span style={{ fontSize: 12 }}>0 of 36 pts</span>
            </div>
          ) : (
            SPRINT_ITEMS.map((item) => (
              <BlRow
                key={item.id}
                item={item}
                isSelected={item.id === 's3'}
                multiSelect={multiSelect}
                isChecked={selectedIds.has(item.id)}
                onCheck={() => toggleCheck(item.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )

  // ── Quick-create row ──────────────────────────────────────
  const quickCreate = qcActive ? (
    /* Active state */
    <div className="qc-row" style={{ background: '#F5F5F4', borderLeft: '2px solid #006044' }}>
      <div className="bl-drag-handle" style={{ opacity: 0 }}>
        <GripVertical size={13} strokeWidth={1.5} />
      </div>
      <div style={{ width: 15, flexShrink: 0 }} />
      <CheckSquare size={13} strokeWidth={1.5} color="#78716C" style={{ flexShrink: 0 }} />
      <input
        ref={qcRef}
        className="qc-input"
        placeholder="Issue title…"
        value={qcText}
        onChange={e => setQcText(e.target.value)}
        onBlur={() => { if (!qcText.trim()) { setQcActive(false) } }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setQcActive(false); setQcText('') }
          if (e.key === 'Escape') { setQcActive(false); setQcText('') }
        }}
      />
      {/* Inline type picker */}
      <button className="qc-type-pick">
        <CheckSquare size={10} strokeWidth={1.5} color="#78716C" />
        Task
        <ChevronDown size={10} strokeWidth={1.5} />
      </button>
      {/* Points */}
      <button className="qc-type-pick" style={{ minWidth: 32 }}>
        —
      </button>
      <span className="qc-hint">↵ create · ⇧↵ create + open</span>
    </div>
  ) : (
    /* Ghost state */
    <div
      className="qc-row"
      onClick={() => { setQcActive(true); setTimeout(() => qcRef.current?.focus(), 50) }}
    >
      <div style={{ width: 18, flexShrink: 0 }} />
      <div style={{ width: 15, flexShrink: 0 }} />
      <Plus size={12} strokeWidth={2} color="#A8A29E" style={{ flexShrink: 0 }} />
      <span className="qc-ghost-text">Create item — press N</span>
    </div>
  )

  // ── Backlog section ───────────────────────────────────────
  const backlogSection = (
    <div>
      <div className="bl-section-hdr">
        <span className="bl-section-title">Backlog</span>
        <span style={{ fontSize: 11, color: '#A8A29E' }}>
          ({activeEpic ? filteredBacklog.length : 247})
        </span>
        <div style={{ flex: 1 }} />
        <button style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 9px', borderRadius: 5,
          border: '1px solid #E7E5E4', background: 'transparent',
          color: '#78716C', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
        }}>
          <Plus size={11} strokeWidth={2} />
          Create item
        </button>
      </div>

      {/* Quick-create */}
      {quickCreate}

      {/* Backlog rows with drag state and drop indicator */}
      {filteredBacklog.map((item) => (
        <div key={item.id}>
          <BlRow
            item={item}
            isDragging={item.id === 'b2'}
            isChecked={selectedIds.has(item.id)}
            multiSelect={multiSelect}
            onCheck={() => toggleCheck(item.id)}
          />
          {/* Drop indicator between b4 and b5 */}
          {item.id === 'b4' && (
            <div className="drop-indicator" />
          )}
        </div>
      ))}

      <div style={{ height: 80 }} />
    </div>
  )

  // ── Epic panel ────────────────────────────────────────────
  const epicPanel = epicPanelOpen && (
    <div className="epic-panel">
      <div className="epic-panel-hdr">
        <span style={{ flex: 1 }}>Epics</span>
        <button
          onClick={() => setEpicPanelOpen(false)}
          style={{
            display: 'flex', border: 'none', background: 'none',
            cursor: 'pointer', color: '#A8A29E', padding: 0,
          }}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className="epic-list">
        {EPICS.map(epic => (
          <div
            key={epic.key}
            className={`epic-card${activeEpic === epic.key ? ' active' : ''}`}
            onClick={() => setActiveEpic(prev => prev === epic.key ? null : epic.key)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 9, height: 9, borderRadius: 2,
                background: epic.color, flexShrink: 0,
              }} />
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#1C1917', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {epic.name}
              </span>
              <span style={{ fontSize: 11, color: '#A8A29E', flexShrink: 0 }}>{epic.pts} pts</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
              <span style={{ fontSize: 11, color: '#A8A29E' }}>
                {epic.done} of {epic.total} done
              </span>
            </div>
            <div className="epic-prog">
              <div
                className="epic-prog-fill"
                style={{ width: `${(epic.done / epic.total) * 100}%`, background: epic.color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  // ── Bulk action bar ───────────────────────────────────────
  const bulkBar = selectedIds.size > 0 && (
    <div className="bulk-bar">
      <span className="bulk-count">{selectedIds.size} selected</span>
      <div className="bulk-sep" />
      <button className="bulk-action-btn">
        <ArrowUp size={12} strokeWidth={1.5} />
        Move to sprint
        <span className="bulk-kbd">M</span>
      </button>
      <button className="bulk-action-btn">
        <User size={12} strokeWidth={1.5} />
        Assign
        <span className="bulk-kbd">A</span>
      </button>
      <button className="bulk-action-btn">
        <Tag size={12} strokeWidth={1.5} />
        Label
        <span className="bulk-kbd">L</span>
      </button>
      <button className="bulk-action-btn">
        <span style={{ fontSize: 11, fontWeight: 600 }}>#</span>
        Points
        <span className="bulk-kbd">P</span>
      </button>
      <div className="bulk-sep" />
      <button className="bulk-action-btn danger">
        <Trash2 size={12} strokeWidth={1.5} />
        Delete
        <span className="bulk-kbd">⌫</span>
      </button>
      <button className="bulk-clear" onClick={clearSelect} title="Clear selection">
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  )

  // ── Layout ────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {ctxHeader}

      {/* Body: main + optional epic panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div className="bl-main">
          {sprintBand}
          {backlogSection}
        </div>
        {epicPanel}
      </div>

      {bulkBar}
    </div>
  )
}
