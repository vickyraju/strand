import { useState, useRef, useCallback, useEffect } from 'react'
import {
  GitBranch, Play, Upload, RotateCcw, ZoomIn, ZoomOut, Maximize2,
  X, ChevronRight, ChevronDown, Shield, AlertTriangle, CheckCircle2,
  Lock, Plus, Trash2,
  Copy, ArrowRight,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────
type StatusCategory = 'todo' | 'in-progress' | 'done' | 'cancelled'

interface WFNode {
  id: string
  label: string
  category: StatusCategory
  x: number
  y: number
}

interface WFTransition {
  id: string
  from: string
  to: string
  label: string
  hasCondition?: boolean
}

// ── Initial state ──────────────────────────────────────────────
const INITIAL_NODES: WFNode[] = [
  { id: 'backlog',      label: 'Backlog',      category: 'todo',        x: 80,  y: 200 },
  { id: 'in-progress',  label: 'In progress',  category: 'in-progress', x: 300, y: 200 },
  { id: 'in-review',    label: 'In review',    category: 'in-progress', x: 520, y: 200 },
  { id: 'blocked',      label: 'Blocked',      category: 'todo',        x: 300, y: 370 },
  { id: 'done',         label: 'Done',         category: 'done',        x: 740, y: 200 },
  { id: 'cancelled',    label: 'Cancelled',    category: 'cancelled',   x: 740, y: 370 },
]

const INITIAL_TRANSITIONS: WFTransition[] = [
  { id: 't1', from: 'backlog',     to: 'in-progress', label: 'Start',        hasCondition: false },
  { id: 't2', from: 'in-progress', to: 'in-review',   label: 'Submit',       hasCondition: false },
  { id: 't3', from: 'in-review',   to: 'done',        label: 'Approve',      hasCondition: true  },
  { id: 't4', from: 'in-review',   to: 'in-progress', label: 'Request changes', hasCondition: false },
  { id: 't5', from: 'in-progress', to: 'blocked',     label: 'Block',        hasCondition: false },
  { id: 't6', from: 'blocked',     to: 'in-progress', label: 'Unblock',      hasCondition: false },
  { id: 't7', from: 'in-progress', to: 'cancelled',   label: 'Cancel',       hasCondition: true  },
  { id: 't8', from: 'in-review',   to: 'cancelled',   label: 'Cancel',       hasCondition: true  },
]

// ── Status colors ──────────────────────────────────────────────
const STATUS_STYLE: Record<StatusCategory, { dot: string; bg: string; border: string; text: string }> = {
  'todo':        { dot: '#A8A29E', bg: '#FAFAF9', border: '#E7E5E4', text: '#78716C' },
  'in-progress': { dot: '#D97706', bg: '#FFFBEB', border: '#FDE68A', text: '#92400E' },
  'done':        { dot: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0', text: '#15803D' },
  'cancelled':   { dot: '#A8A29E', bg: '#F5F5F4', border: '#E7E5E4', text: '#78716C' },
}

function StatusDot({ category }: { category: StatusCategory }) {
  const c = STATUS_STYLE[category].dot
  return <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
}

// ── SVG arrow between nodes ────────────────────────────────────
const NODE_W = 160
const NODE_H = 44

function getPort(node: WFNode, side: 'right' | 'left' | 'bottom' | 'top') {
  const cx = node.x + NODE_W / 2
  const cy = node.y + NODE_H / 2
  if (side === 'right')  return { x: node.x + NODE_W, y: cy }
  if (side === 'left')   return { x: node.x,          y: cy }
  if (side === 'bottom') return { x: cx, y: node.y + NODE_H }
  return                        { x: cx, y: node.y }
}

function pickPorts(from: WFNode, to: WFNode): { p1: { x: number; y: number }; p2: { x: number; y: number } } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { p1: getPort(from, 'right'), p2: getPort(to, 'left') }
      : { p1: getPort(from, 'left'),  p2: getPort(to, 'right') }
  }
  return dy >= 0
    ? { p1: getPort(from, 'bottom'), p2: getPort(to, 'top') }
    : { p1: getPort(from, 'top'),    p2: getPort(to, 'bottom') }
}

function Arrow({ t, nodes, selected, onClick, simToken }: {
  t: WFTransition
  nodes: WFNode[]
  selected: boolean
  onClick: () => void
  simToken?: boolean
}) {
  const from = nodes.find(n => n.id === t.from)
  const to   = nodes.find(n => n.id === t.to)
  if (!from || !to) return null

  const { p1, p2 } = pickPorts(from, to)
  const midX = (p1.x + p2.x) / 2
  const midY = (p1.y + p2.y) / 2
  const path = `M${p1.x},${p1.y} C${midX},${p1.y} ${midX},${p2.y} ${p2.x},${p2.y}`
  const stroke = selected ? '#368727' : '#C8C4C0'
  const sw = selected ? 2 : 1.5

  return (
    <g style={{ cursor: 'pointer' }} onClick={onClick}>
      {/* Wider invisible hit target */}
      <path d={path} stroke="transparent" strokeWidth={12} fill="none" />
      <path d={path} stroke={stroke} strokeWidth={sw} fill="none" markerEnd={`url(#arrow-${selected ? 'sel' : 'def'})`} />
      {/* Label chip */}
      <foreignObject x={midX - 44} y={midY - 11} width={88} height={22} style={{ overflow: 'visible', pointerEvents: 'none' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: selected ? '#EAF6E6' : '#FFFFFF',
          border: `1px solid ${selected ? '#8FCB7C' : '#E7E5E4'}`,
          borderRadius: 100, padding: '1px 8px',
          fontSize: 10, fontWeight: selected ? 500 : 400,
          color: selected ? '#368727' : '#78716C',
          whiteSpace: 'nowrap', boxSizing: 'border-box',
        }}>
          {t.hasCondition && <Shield size={8} color={selected ? '#368727' : '#A8A29E'} />}
          {t.label}
        </div>
      </foreignObject>
      {/* Simulate token glow */}
      {simToken && (
        <circle cx={midX} cy={midY} r={6} fill="#D97706" opacity={0.8}>
          <animate attributeName="r" values="5;8;5" dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0.4;0.8" dur="1.4s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  )
}

// ── Status node card ───────────────────────────────────────────
function NodeCard({ node, selected, simCurrent, onSelect, onDragStart }: {
  node: WFNode
  selected: boolean
  simCurrent?: boolean
  onSelect: () => void
  onDragStart: (e: React.MouseEvent) => void
}) {
  const s = STATUS_STYLE[node.category]
  return (
    <div
      onMouseDown={e => { e.stopPropagation(); onDragStart(e) }}
      onClick={e => { e.stopPropagation(); onSelect() }}
      className="wfe-node"
      style={{
        left: node.x, top: node.y,
        width: NODE_W, height: NODE_H,
        background: s.bg,
        border: `${simCurrent ? 2 : selected ? 2 : 1}px solid ${simCurrent ? '#D97706' : selected ? '#368727' : s.border}`,
        boxShadow: simCurrent ? '0 0 0 3px rgba(217,119,6,0.2)' : selected ? '0 0 0 3px rgba(0,96,68,0.12)' : undefined,
      }}
    >
      {/* Resize handles when selected */}
      {selected && (
        <>
          <div className="wfe-handle wfe-handle-tl" />
          <div className="wfe-handle wfe-handle-tr" />
          <div className="wfe-handle wfe-handle-bl" />
          <div className="wfe-handle wfe-handle-br" />
        </>
      )}
      <StatusDot category={node.category} />
      <span style={{
        fontSize: 12, fontWeight: selected ? 500 : 400,
        color: selected ? '#368727' : '#1C1917',
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{node.label}</span>
      {simCurrent && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#D97706', flexShrink: 0, animation: 'wfe-pulse 1.2s ease-in-out infinite' }} />}
    </div>
  )
}

// ── Inspector panel ────────────────────────────────────────────
function InspectorPanel({ transition, nodes, onClose }: {
  transition: WFTransition
  nodes: WFNode[]
  onClose: () => void
}) {
  const from = nodes.find(n => n.id === transition.from)
  const to   = nodes.find(n => n.id === transition.to)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    who: true, checks: true, then: false,
  })
  const toggle = (k: string) => setOpenSections(s => ({ ...s, [k]: !s[k] }))

  const Section = ({ k, label, children }: { k: string; label: string; children: React.ReactNode }) => (
    <div className="wfe-insp-section">
      <button className="wfe-insp-section-hdr" onClick={() => toggle(k)}>
        {openSections[k] ? <ChevronDown size={13} strokeWidth={1.5} /> : <ChevronRight size={13} strokeWidth={1.5} />}
        <span>{label}</span>
      </button>
      {openSections[k] && <div className="wfe-insp-section-body">{children}</div>}
    </div>
  )

  return (
    <div className="wfe-inspector">
      {/* Header */}
      <div className="wfe-insp-hdr">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: '#A8A29E', marginBottom: 2 }}>Transition</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1C1917' }}>{transition.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, color: '#78716C' }}>
            <span>{from?.label}</span>
            <ArrowRight size={11} strokeWidth={1.5} />
            <span>{to?.label}</span>
          </div>
        </div>
        <button className="wfe-insp-close" onClick={onClose}><X size={14} strokeWidth={1.5} /></button>
      </div>

      {/* Sections */}
      <div className="wfe-insp-body">
        <Section k="who" label="Who can do this">
          <div className="wfe-rule-row">
            <div className="wfe-rule-icon wfe-rule-icon--ok"><CheckCircle2 size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Roles allowed</div>
              <div className="wfe-rule-value">Developer, Tech lead, Project admin</div>
            </div>
          </div>
          <div className="wfe-rule-row">
            <div className="wfe-rule-icon wfe-rule-icon--ok"><CheckCircle2 size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Assignee restriction</div>
              <div className="wfe-rule-value">Assignee must not be the current user</div>
            </div>
          </div>
        </Section>

        <Section k="checks" label="Checks before it happens">
          <div className="wfe-rule-row">
            <div className="wfe-rule-icon wfe-rule-icon--ok"><Shield size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Required fields</div>
              <div className="wfe-rule-value">PR link must be set</div>
            </div>
          </div>
          <div className="wfe-rule-row wfe-rule-row--warn">
            <div className="wfe-rule-icon wfe-rule-icon--warn"><AlertTriangle size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Linked CI check</div>
              <div className="wfe-rule-value">CI check "build" not found in this project <span className="wfe-fix-link">Fix →</span></div>
            </div>
          </div>
          <div className="wfe-rule-row">
            <div className="wfe-rule-icon wfe-rule-icon--ok"><Lock size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Approval gate</div>
              <div className="wfe-rule-value">At least 1 reviewer must approve</div>
            </div>
          </div>
        </Section>

        <Section k="then" label="Then do this">
          <div className="wfe-rule-row">
            <div className="wfe-rule-icon wfe-rule-icon--ok"><CheckCircle2 size={12} strokeWidth={1.5} /></div>
            <div className="wfe-rule-content">
              <div className="wfe-rule-label">Auto-assign</div>
              <div className="wfe-rule-value">Clear assignee on done</div>
            </div>
          </div>
        </Section>

        {/* Add rule button */}
        <button className="wfe-add-rule-btn">
          <Plus size={12} strokeWidth={2} />
          Add condition or action
        </button>
      </div>

      {/* Footer */}
      <div className="wfe-insp-footer">
        <div style={{ fontSize: 11, color: '#A8A29E' }}>
          Used by <strong style={{ color: '#78716C' }}>3 projects</strong> · 42 items in this state
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="wfe-insp-act-btn">
            <Copy size={11} strokeWidth={1.5} />
            Duplicate
          </button>
          <button className="wfe-insp-act-btn wfe-insp-act-btn--danger">
            <Trash2 size={11} strokeWidth={1.5} />
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Node inspector (when a status node is selected) ────────────
function NodeInspector({ node, onClose }: { node: WFNode; onClose: () => void }) {
  const CATS: StatusCategory[] = ['todo', 'in-progress', 'done', 'cancelled']
  return (
    <div className="wfe-inspector">
      <div className="wfe-insp-hdr">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: '#A8A29E', marginBottom: 2 }}>Status</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1C1917' }}>{node.label}</div>
        </div>
        <button className="wfe-insp-close" onClick={onClose}><X size={14} strokeWidth={1.5} /></button>
      </div>
      <div className="wfe-insp-body">
        <div className="wfe-insp-field">
          <label className="wfe-insp-field-label">Name</label>
          <input className="wfe-insp-input" defaultValue={node.label} />
        </div>
        <div className="wfe-insp-field">
          <label className="wfe-insp-field-label">Category</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {CATS.map(c => {
              const cs = STATUS_STYLE[c]
              return (
                <button key={c} style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                  borderRadius: 6, border: `1px solid ${node.category === c ? '#368727' : '#E7E5E4'}`,
                  background: node.category === c ? '#EAF6E6' : '#FFFFFF',
                  color: node.category === c ? '#368727' : '#78716C',
                  fontSize: 11, cursor: 'pointer',
                }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: cs.dot }} />
                  {c.replace('-', ' ')}
                </button>
              )
            })}
          </div>
        </div>
        <div className="wfe-insp-field">
          <label className="wfe-insp-field-label">Description</label>
          <textarea className="wfe-insp-input" rows={3} defaultValue="" placeholder="Optional description…" style={{ resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="wfe-insp-act-btn">
            <Copy size={11} strokeWidth={1.5} />
            Duplicate
          </button>
          <button className="wfe-insp-act-btn wfe-insp-act-btn--danger">
            <Trash2 size={11} strokeWidth={1.5} />
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Publish modal ──────────────────────────────────────────────
function PublishModal({ onClose }: { onClose: () => void }) {
  const [comment, setComment] = useState('')
  const diffs = [
    { type: 'add', label: 'Transition: In review → Cancelled (new)' },
    { type: 'mod', label: 'Transition "Approve": added CI check condition' },
    { type: 'mod', label: 'Status "In review": renamed from "Code review"' },
    { type: 'del', label: 'Transition: Backlog → Done (removed)' },
  ]
  const typeColor = { add: '#16A34A', mod: '#D97706', del: '#DC2626' }
  const typeLabel = { add: 'Added', mod: 'Changed', del: 'Removed' }

  return (
    <div className="wfe-modal-backdrop" onClick={onClose}>
      <div className="wfe-modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
        <div className="wfe-modal-hdr">
          <Upload size={16} strokeWidth={1.5} style={{ color: '#368727' }} />
          <span>Publish workflow</span>
          <button className="wfe-insp-close" onClick={onClose}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="wfe-modal-body">
          <div style={{ fontSize: 12, color: '#78716C', marginBottom: 12 }}>
            <strong style={{ color: '#1C1917' }}>Payments — Sprint workflow</strong> · Version 7 → <strong>8</strong>
          </div>

          {/* Diff list */}
          <div style={{ border: '1px solid #E7E5E4', borderRadius: 6, overflow: 'hidden', marginBottom: 14 }}>
            {diffs.map((d, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                borderBottom: i < diffs.length - 1 ? '1px solid #F5F5F4' : undefined,
                background: '#FFFFFF',
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                  color: typeColor[d.type as keyof typeof typeColor],
                  width: 48, flexShrink: 0,
                }}>{typeLabel[d.type as keyof typeof typeLabel].toUpperCase()}</span>
                <span style={{ fontSize: 12, color: '#1C1917', flex: 1 }}>{d.label}</span>
              </div>
            ))}
          </div>

          {/* Impact note */}
          <div style={{
            background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6,
            padding: '8px 12px', fontSize: 11, color: '#92400E', marginBottom: 14,
          }}>
            <strong>Impact:</strong> 3 projects and 142 active issues will be migrated to this workflow version on publish.
          </div>

          {/* Comment field */}
          <div className="wfe-insp-field">
            <label className="wfe-insp-field-label">Change note <span style={{ color: '#DC2626' }}>*</span></label>
            <textarea
              className="wfe-insp-input"
              rows={3}
              placeholder="Describe what changed and why…"
              value={comment}
              onChange={e => setComment(e.target.value)}
              style={{ resize: 'none' }}
            />
          </div>
        </div>
        <div className="wfe-modal-footer">
          <button className="wfe-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="wfe-modal-publish" disabled={!comment.trim()}>
            <Upload size={12} strokeWidth={2} />
            Publish version 8
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Simulate overlay ───────────────────────────────────────────
function SimulateOverlay({ nodes, transitions, onExit }: {
  nodes: WFNode[]
  transitions: WFTransition[]
  onExit: () => void
}) {
  const [currentNode, setCurrentNode] = useState('in-review')
  const [history, setHistory] = useState<string[]>(['backlog', 'in-progress', 'in-review'])

  const available = transitions.filter(t => t.from === currentNode)

  const step = (t: WFTransition) => {
    setCurrentNode(t.to)
    setHistory(h => [...h, t.to])
  }

  return (
    <div className="wfe-sim-overlay">
      {/* Sidebar */}
      <div className="wfe-sim-sidebar">
        <div className="wfe-sim-sidebar-hdr">
          <Play size={13} strokeWidth={1.5} style={{ color: '#D97706' }} />
          <span>Simulate</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#A8A29E' }}>PAY-393</span>
        </div>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #F5F5F4' }}>
          <div style={{ fontSize: 10, color: '#A8A29E', marginBottom: 4 }}>Current status</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot category={nodes.find(n => n.id === currentNode)?.category ?? 'todo'} />
            <span style={{ fontSize: 12, fontWeight: 500, color: '#1C1917' }}>
              {nodes.find(n => n.id === currentNode)?.label}
            </span>
          </div>
        </div>

        {/* Available transitions */}
        <div style={{ padding: '8px 12px' }}>
          <div style={{ fontSize: 10, color: '#A8A29E', marginBottom: 6 }}>Available transitions</div>
          {available.length === 0 ? (
            <div style={{ fontSize: 11, color: '#A8A29E', fontStyle: 'italic' }}>Terminal state — no transitions out</div>
          ) : available.map(t => {
            const toNode = nodes.find(n => n.id === t.to)
            return (
              <button key={t.id} className="wfe-sim-transition-btn" onClick={() => step(t)}>
                <ArrowRight size={11} strokeWidth={1.5} />
                <span style={{ flex: 1 }}>{t.label}</span>
                <span style={{ fontSize: 10, color: '#A8A29E' }}>→ {toNode?.label}</span>
              </button>
            )
          })}
        </div>

        {/* Step log */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #F5F5F4', flex: 1, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, color: '#A8A29E', marginBottom: 6 }}>Step log</div>
          {history.map((nodeId, i) => {
            const n = nodes.find(nd => nd.id === nodeId)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  background: i === history.length - 1 ? '#D97706' : '#E7E5E4',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, color: i === history.length - 1 ? 'white' : '#A8A29E', fontWeight: 600,
                }}>{i + 1}</div>
                <span style={{ fontSize: 11, color: i === history.length - 1 ? '#1C1917' : '#78716C' }}>
                  {n?.label}
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ padding: '8px 12px', borderTop: '1px solid #E7E5E4' }}>
          <button className="wfe-sim-reset-btn" onClick={() => { setCurrentNode('in-review'); setHistory(['backlog', 'in-progress', 'in-review']) }}>
            <RotateCcw size={11} strokeWidth={1.5} />
            Reset
          </button>
          <button className="wfe-sim-exit-btn" onClick={onExit}>
            <X size={11} strokeWidth={1.5} />
            Exit simulate
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────
function EmptyWorkflow({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: '#FAFAF9', gap: 12,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 12, background: '#EAF6E6',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <GitBranch size={24} strokeWidth={1.5} color="#368727" />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>No workflow yet</div>
      <div style={{ fontSize: 13, color: '#78716C', maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>
        Create a workflow to define how issues move through your process. Start from a template or from scratch.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        {['Bug triage', 'Sprint delivery', 'Code review'].map(t => (
          <button key={t} style={{
            padding: '7px 14px', borderRadius: 6, border: '1px solid #E7E5E4',
            background: '#FFFFFF', fontSize: 12, color: '#1C1917', cursor: 'pointer',
          }}>{t}</button>
        ))}
      </div>
      <button onClick={onCreate} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 16px', borderRadius: 6, border: 'none',
        background: '#368727', color: 'white', fontSize: 12, fontWeight: 500, cursor: 'pointer',
      }}>
        <Plus size={13} strokeWidth={2} />
        Start from scratch
      </button>
    </div>
  )
}

// ── Main WorkflowEditor ────────────────────────────────────────
export default function WorkflowEditor() {
  const [nodes, setNodes] = useState<WFNode[]>(INITIAL_NODES)
  const [transitions] = useState<WFTransition[]>(INITIAL_TRANSITIONS)
  const [selectedNode, setSelectedNode] = useState<string | null>('in-review')
  const [selectedTrans, setSelectedTrans] = useState<string | null>('t3')
  const [showPublish, setShowPublish] = useState(false)
  const [simMode, setSimMode] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 40, y: 60 })
  const [workflowName] = useState('Payments — Sprint workflow')

  const canvasRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<{ nodeId: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const panningRef = useRef<{ startX: number; startY: number; origPanX: number; origPanY: number } | null>(null)

  const startNodeDrag = useCallback((e: React.MouseEvent, nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    draggingRef.current = { nodeId, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y }
    e.preventDefault()
  }, [nodes])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) {
        const { nodeId, startX, startY, origX, origY } = draggingRef.current
        const dx = (e.clientX - startX) / zoom
        const dy = (e.clientY - startY) / zoom
        setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) } : n))
      }
      if (panningRef.current) {
        const { startX, startY, origPanX, origPanY } = panningRef.current
        setPan({ x: origPanX + e.clientX - startX, y: origPanY + e.clientY - startY })
      }
    }
    const onUp = () => { draggingRef.current = null; panningRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [zoom])

  const handleCanvasDown = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('wfe-canvas-inner')) {
      setSelectedNode(null); setSelectedTrans(null)
      panningRef.current = { startX: e.clientX, startY: e.clientY, origPanX: pan.x, origPanY: pan.y }
    }
  }

  const selTrans = transitions.find(t => t.id === selectedTrans)
  const selNode  = nodes.find(n => n.id === selectedNode)

  const CANVAS_W = 1200
  const CANVAS_H = 700

  if (showEmpty) return <EmptyWorkflow onCreate={() => setShowEmpty(false)} />

  return (
    <div className="wfe-root">
      {/* Floating header bar */}
      <div className="wfe-header-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <GitBranch size={14} strokeWidth={1.5} color="#368727" />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#1C1917' }}>{workflowName}</span>
          <span className="wfe-version-chip">v7 draft</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="wfe-hdr-btn" onClick={() => setShowEmpty(true)}>
            <RotateCcw size={12} strokeWidth={1.5} />
            Reset
          </button>
          <div className="wfe-hdr-divider" />
          <button className={`wfe-hdr-btn${simMode ? ' wfe-hdr-btn--active' : ''}`} onClick={() => setSimMode(s => !s)}>
            <Play size={12} strokeWidth={1.5} />
            Simulate
          </button>
          <button className="wfe-hdr-btn wfe-hdr-btn--primary" onClick={() => setShowPublish(true)}>
            <Upload size={12} strokeWidth={1.5} />
            Publish
          </button>
        </div>
      </div>

      {/* Zoom controls */}
      <div className="wfe-zoom-controls">
        <button className="wfe-zoom-btn" onClick={() => setZoom(z => Math.min(2, z + 0.1))}><ZoomIn size={13} strokeWidth={1.5} /></button>
        <span style={{ fontSize: 10, color: '#78716C', minWidth: 30, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button className="wfe-zoom-btn" onClick={() => setZoom(z => Math.max(0.3, z - 0.1))}><ZoomOut size={13} strokeWidth={1.5} /></button>
        <div style={{ width: 1, background: '#E7E5E4', margin: '2px 0' }} />
        <button className="wfe-zoom-btn" onClick={() => { setZoom(1); setPan({ x: 40, y: 60 }) }}><Maximize2 size={13} strokeWidth={1.5} /></button>
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="wfe-canvas"
        onMouseDown={handleCanvasDown}
        style={{ cursor: panningRef.current ? 'grabbing' : 'grab' }}
      >
        <div
          className="wfe-canvas-inner"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', width: CANVAS_W, height: CANVAS_H }}
        >
          {/* SVG layer for transitions */}
          <svg
            style={{ position: 'absolute', inset: 0, width: CANVAS_W, height: CANVAS_H, overflow: 'visible', pointerEvents: 'none' }}
          >
            <defs>
              <marker id="arrow-def" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill="#C8C4C0" />
              </marker>
              <marker id="arrow-sel" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill="#368727" />
              </marker>
            </defs>
            {transitions.map(t => (
              <Arrow
                key={t.id}
                t={t}
                nodes={nodes}
                selected={selectedTrans === t.id}
                onClick={() => { setSelectedTrans(t.id); setSelectedNode(null) }}
                simToken={simMode && t.from === 'in-review'}
              />
            ))}
          </svg>

          {/* Node cards */}
          {nodes.map(node => (
            <NodeCard
              key={node.id}
              node={node}
              selected={selectedNode === node.id}
              simCurrent={simMode && node.id === 'in-review'}
              onSelect={() => { setSelectedNode(node.id); setSelectedTrans(null) }}
              onDragStart={e => { setSelectedNode(node.id); setSelectedTrans(null); startNodeDrag(e, node.id) }}
            />
          ))}
        </div>
      </div>

      {/* Inspector */}
      {selectedTrans && selTrans && !simMode && (
        <InspectorPanel
          transition={selTrans}
          nodes={nodes}
          onClose={() => setSelectedTrans(null)}
        />
      )}
      {selectedNode && selNode && !simMode && (
        <NodeInspector
          node={selNode}
          onClose={() => setSelectedNode(null)}
        />
      )}

      {/* Simulate overlay sidebar */}
      {simMode && (
        <SimulateOverlay
          nodes={nodes}
          transitions={transitions}
          onExit={() => setSimMode(false)}
        />
      )}

      {/* Publish modal */}
      {showPublish && <PublishModal onClose={() => setShowPublish(false)} />}
    </div>
  )
}
