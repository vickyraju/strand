import { useState } from 'react'
import {
  BookOpen, ChevronsUp, ChevronDown, ChevronRight,
  Eye, Link2, Maximize2, X, Minus,
  CheckCircle2, Circle, AlertCircle,
  Plus, Sparkles, List, AtSign, Paperclip, Code, Send,
  ShieldAlert, Copy, MoreHorizontal,
} from 'lucide-react'
import { useForge } from '../App'

// ── Static data for PAY-393 ─────────────────────────────────

const PR = { initials: 'PR', color: '#4F46E5', name: 'Priya Raman' }
const DO = { initials: 'DO', color: '#0891B2', name: 'Daniel Okafor' }
const SM = { initials: 'SM', color: '#16A34A', name: 'Sofia Marek' }
const LF = { initials: 'LF', color: '#0369A1', name: 'Luca Ferreira' }

const SUBTASKS = [
  { key: 'PAY-400', title: 'Implement structured retry logging', status: 'done',        assignee: SM },
  { key: 'PAY-401', title: 'Retry budget configuration for partial settlement failures', status: 'in-progress', assignee: LF },
  { key: 'PAY-402', title: 'Configure DLQ and alerting for webhook failures',           status: 'todo',        assignee: PR },
]

const LINKED = [
  { rel: 'Blocks',      key: 'RISK-1204', title: 'KYC document expiry alerts: 90-day window not triggering in prod', status: 'blocked',     assignee: DO },
  { rel: 'Relates to',  key: 'PLAT-4801', title: 'Event sourcing: replay pipeline for downstream consumers',         status: 'in-progress', assignee: LF },
]

const COMMENTS = [
  {
    id: 'c1', author: 'Daniel Okafor', av: DO, time: '2h ago',
    text: "Reproduced in staging with the June month-end dataset. `WebhookDispatcher.handleRetryExhaustion()` logs the failure but skips the DLQ write. Adding a breakpoint at line 347 confirms the DLQ client is null after key rotation.",
    reactions: [],
  },
  {
    id: 'c2', author: 'Priya Raman', av: PR, time: '1h ago',
    text: null, // rendered with mention chip inline
    hasMention: true,
    reactions: [{ emoji: '👍', count: 3, reacted: true }, { emoji: '🔥', count: 1, reacted: false }],
  },
  {
    id: 'c3', author: 'Sofia Marek', av: SM, time: '43m ago',
    text: "PR #2841 covers PAY-400 (retry logging). Leaving DLQ work for PAY-402 so this lands in staging by EOD. Note: `webhook.dlq.enabled` still needs toggling in the staging config — flagging for ops.",
    reactions: [],
  },
]

// ── Status helpers ──────────────────────────────────────────

function statusLabel(s: string) {
  if (s === 'in-progress') return 'In progress'
  if (s === 'in-review')   return 'In review'
  if (s === 'blocked')     return 'Blocked'
  if (s === 'done')        return 'Done'
  return 'To do'
}
function statusDotColor(s: string) {
  if (s === 'in-progress') return '#D97706'
  if (s === 'in-review')   return '#4F46E5'
  if (s === 'blocked')     return '#DC2626'
  if (s === 'done')        return '#16A34A'
  return '#A8A29E'
}
function linkedStatusStyle(s: string) {
  if (s === 'blocked')     return { bg: '#FEF2F2', color: '#DC2626' }
  if (s === 'in-progress') return { bg: '#FEF3C7', color: '#B45309' }
  if (s === 'done')        return { bg: '#F0FDF4', color: '#15803D' }
  if (s === 'in-review')   return { bg: '#EEF2FF', color: '#4338CA' }
  return { bg: '#F5F5F4', color: '#78716C' }
}
function subtaskStatusStyle(s: string) {
  if (s === 'done')        return { dot: '#16A34A', chip: { bg: '#F0FDF4', color: '#15803D' }, label: 'Done' }
  if (s === 'in-progress') return { dot: '#D97706', chip: { bg: '#FEF3C7', color: '#B45309' }, label: 'In progress' }
  return { dot: '#A8A29E', chip: { bg: '#F5F5F4', color: '#78716C' }, label: 'To do' }
}

// ── Mini avatar ─────────────────────────────────────────────

function Av({ m, size = 22 }: { m: typeof PR; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: m.color, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: size * 0.38,
      fontWeight: 600, color: 'white', flexShrink: 0,
    }}>{m.initials}</div>
  )
}

// ── Props ────────────────────────────────────────────────────

export interface WorkItemDetailProps {
  mode:           'peek' | 'full'
  onExpandFull?:  () => void
  onClose:        () => void
}

// ════════════════════════════════════════════════════════════
// Root component
// ════════════════════════════════════════════════════════════

export default function WorkItemDetail({ mode, onExpandFull, onClose }: WorkItemDetailProps) {
  const { aiOn } = useForge()
  const [statusOpen,    setStatusOpen]    = useState(false)
  const [activeTab,     setActiveTab]     = useState<'comments' | 'history' | 'worklog'>('comments')
  const [piiGuard,      setPiiGuard]      = useState(false)
  const [moreFields,    setMoreFields]    = useState(false)
  const [composerText,  setComposerText]  = useState('')

  const doneCount = SUBTASKS.filter(t => t.status === 'done').length

  // ── Header ─────────────────────────────────────────────────
  const header = (
    <div className="detail-header">
      {/* Key chip */}
      <button
        className="issue-key-chip"
        title="Copy issue key"
        onClick={() => navigator.clipboard?.writeText('PAY-393')}
      >
        <BookOpen size={11} strokeWidth={1.5} color="#4F46E5" />
        PAY-393
        <Copy size={9} strokeWidth={2} style={{ color: '#A8A29E', marginLeft: 1 }} />
      </button>

      <span className="detail-header-sep">/</span>

      <span className="detail-header-crumb">
        Payments / <span>Sprint 42</span>
      </span>

      {/* Actions */}
      <div className="detail-header-actions">
        {/* Watch */}
        <button className="dhdr-btn" title="Watch (7 watchers)" style={{ position: 'relative' }}>
          <Eye size={14} strokeWidth={1.5} />
          <span style={{
            position: 'absolute', bottom: 5, right: 4,
            fontSize: 8, fontWeight: 700, color: '#78716C', lineHeight: 1,
          }}>7</span>
        </button>

        {/* Link */}
        <button className="dhdr-btn" title="Copy link">
          <Link2 size={14} strokeWidth={1.5} />
        </button>

        {/* Expand to full page — peek only */}
        {mode === 'peek' && onExpandFull && (
          <button className="dhdr-btn" title="Open full page" onClick={onExpandFull}>
            <Maximize2 size={14} strokeWidth={1.5} />
          </button>
        )}

        {/* More */}
        <button className="dhdr-btn" title="More actions">
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>

        {/* Close */}
        <button className="dhdr-btn" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )

  // ── Left column content ─────────────────────────────────────
  const leftCol = (
    <div className="detail-left">

      {/* Title */}
      <div className="detail-title-wrap">
        <textarea
          className="detail-title"
          defaultValue="Settlement webhook retries exhausted after 5 attempts"
          rows={2}
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = el.scrollHeight + 'px'
          }}
        />
      </div>

      {/* Status row */}
      <div className="status-row">
        {/* Status chip + dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            className={`status-chip-btn s-inprogress`}
            onClick={() => setStatusOpen(v => !v)}
            title="Change status — S"
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#D97706', flexShrink: 0,
            }} />
            In progress
            <ChevronDown size={12} strokeWidth={1.5} />
            <span className="status-kbd-hint">S</span>
          </button>

          {statusOpen && (
            <>
              {/* Click-outside dismiss */}
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                onClick={() => setStatusOpen(false)}
              />
              <div className="status-dropdown">
                <div className="status-dropdown-cur">Change status</div>

                {[
                  { id: 'todo',        label: 'To do',      req: null },
                  { id: 'in-review',   label: 'In review',  req: 'requires: reviewer assigned' },
                  { id: 'blocked',     label: 'Blocked',    req: null },
                  { id: 'done',        label: 'Done',       req: 'requires: all sub-tasks complete' },
                ].map(opt => (
                  <div
                    key={opt.id}
                    className="status-dropdown-item"
                    onClick={() => setStatusOpen(false)}
                  >
                    <div className="status-dropdown-item-label">
                      <span className="status-dot" style={{ background: statusDotColor(opt.id) }} />
                      {opt.label}
                    </div>
                    {opt.req && (
                      <div className="status-dropdown-item-req">{opt.req}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Priority */}
        <button className="priority-btn" title="Change priority">
          <ChevronsUp size={12} strokeWidth={2} color="#DC2626" />
          Urgent
          <ChevronDown size={11} strokeWidth={1.5} />
        </button>

        {/* Blocked-by chip */}
        <div className="blocked-by-chip">
          <AlertCircle size={11} strokeWidth={2} />
          Blocked by
          <span style={{ fontFamily: 'monospace', fontSize: 11 }}>PLAT-4790</span>
          <button className="blocked-rm-btn" title="Remove blocker">
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Description */}
      <div className="description-hover" style={{ marginBottom: 24 }}>
        <p className="desc-para">
          After 5 consecutive retry attempts, the settlement webhook delivery enters a terminal
          failure state without persisting the failure to the dead letter queue. Downstream
          consumers receive no notification of settlement completion, causing silent reconciliation
          failures during month-end close.
        </p>
        <p className="desc-para">
          Reproduced consistently against the v2 webhook protocol with HMAC-SHA256 signing.
          The v1 protocol uses a separate retry queue and is unaffected. Root cause is in{' '}
          <code style={{ background: '#F5F5F4', borderRadius: 3, padding: '1px 5px', fontSize: 12, fontFamily: 'monospace' }}>
            WebhookDispatcher.handleRetryExhaustion()
          </code>
          {' '}— the DLQ write is skipped when the signing key is rotated mid-dispatch.
        </p>

        {/* Checklist */}
        <ul className="checklist">
          <li className="checklist-item done">
            <span className="check-ico">
              <CheckCircle2 size={14} strokeWidth={1.5} color="#16A34A" />
            </span>
            Add structured error context to each retry attempt log
          </li>
          <li className="checklist-item">
            <span className="check-ico">
              <Circle size={14} strokeWidth={1.5} color="#D6D3D1" />
            </span>
            Route exhausted events to the dead letter queue
          </li>
          <li className="checklist-item">
            <span className="check-ico">
              <Circle size={14} strokeWidth={1.5} color="#D6D3D1" />
            </span>
            Alert when DLQ depth exceeds 500 within any 5-minute window
          </li>
        </ul>

        {/* Code block */}
        <div className="code-block">
          <span className="code-cmt">{'// POST /webhooks/v2/settlement-complete\n'}</span>
          {'{\n'}
          {'  '}<span className="code-key">"event"</span>{': '}<span className="code-str">"settlement.failed"</span>{',\n'}
          {'  '}<span className="code-key">"settlement_id"</span>{': '}<span className="code-str">"stl_8x92kp3m"</span>{',\n'}
          {'  '}<span className="code-key">"retry_count"</span>{': '}<span className="code-num">5</span>{',\n'}
          {'  '}<span className="code-key">"last_error"</span>{': '}<span className="code-str">"connect timeout after 8000ms"</span>{'\n'}
          {'}'}
        </div>
      </div>

      <div className="section-divider" />

      {/* Sub-tasks */}
      <div style={{ marginBottom: 24 }}>
        <div className="section-hdr">
          <span className="section-title">Sub-tasks</span>
          <span className="section-count">{doneCount} of {SUBTASKS.length}</span>
          <div className="stask-prog">
            <div className="stask-prog-fill" style={{ width: `${(doneCount / SUBTASKS.length) * 100}%` }} />
          </div>
          <div style={{ flex: 1 }} />
          <button className="ghost-btn">
            <Plus size={11} strokeWidth={2} />
            Add sub-task
          </button>
        </div>

        <div className="subtask-list">
          {SUBTASKS.map(t => {
            const st = subtaskStatusStyle(t.status)
            return (
              <div key={t.key} className="subtask-row">
                <span className="subtask-sdot" style={{ background: st.dot }} />
                <span className="subtask-key">{t.key}</span>
                <span className={`subtask-title-cell${t.status === 'done' ? ' st-done' : ''}`}>
                  {t.title}
                </span>
                <span className="subtask-status-chip" style={{ background: st.chip.bg, color: st.chip.color }}>
                  {st.label}
                </span>
                <Av m={t.assignee} size={20} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="section-divider" />

      {/* Linked items */}
      <div style={{ marginBottom: 24 }}>
        <div className="section-hdr">
          <span className="section-title">Linked items</span>
          <div style={{ flex: 1 }} />
          <button className="ghost-btn">
            <Plus size={11} strokeWidth={2} />
            Add link
          </button>
        </div>

        <div className="linked-list">
          {LINKED.map(l => {
            const sc = linkedStatusStyle(l.status)
            return (
              <div key={l.key} className="linked-row">
                <span className="linked-rel">{l.rel}</span>
                <span className="linked-key">{l.key}</span>
                <span className="linked-title-cell">{l.title}</span>
                <span className="linked-status-chip" style={{ background: sc.bg, color: sc.color }}>
                  {statusLabel(l.status)}
                </span>
                <Av m={l.assignee} size={20} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="section-divider" />

      {/* Activity */}
      <div style={{ marginBottom: 24 }}>
        <div className="activity-tab-row">
          {(['comments', 'history', 'worklog'] as const).map(tab => (
            <button
              key={tab}
              className={`activity-tab-btn${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
              style={{ textTransform: 'capitalize' }}
            >
              {tab === 'comments' ? 'Comments (8)' : tab === 'history' ? 'History' : 'Worklog'}
            </button>
          ))}

          {/* AI summarize — purple, hidden when AI off */}
          {aiOn && (
            <button className="ai-summarize-btn">
              <Sparkles size={11} strokeWidth={1.5} />
              Summarize activity
            </button>
          )}
        </div>

        {activeTab === 'comments' && (
          <div className="comment-list">
            {/* Comment 1 */}
            <div className="comment-item">
              <div className="comment-av" style={{ background: DO.color }}>{DO.initials}</div>
              <div className="comment-body">
                <div className="comment-meta">
                  <span className="comment-author">{COMMENTS[0].author}</span>
                  <span className="comment-time">{COMMENTS[0].time}</span>
                </div>
                <div className="comment-text">{COMMENTS[0].text}</div>
              </div>
            </div>

            {/* Comment 2 — with @mention */}
            <div className="comment-item">
              <div className="comment-av" style={{ background: PR.color }}>{PR.initials}</div>
              <div className="comment-body">
                <div className="comment-meta">
                  <span className="comment-author">Priya Raman</span>
                  <span className="comment-time">1h ago</span>
                </div>
                <div className="comment-text">
                  <span className="mention-chip">@Daniel Okafor</span>
                  {' '}good find. This also fails silently when the endpoint returns 200 after the 8s timeout — the success path doesn{"'"}t check latency. Should handle timeout as a distinct failure mode.
                </div>
                <div className="reactions">
                  <button className="reaction-chip reacted">👍 3</button>
                  <button className="reaction-chip">🔥 1</button>
                  <button className="reaction-chip" title="Add reaction">+</button>
                </div>
              </div>
            </div>

            {/* Comment 3 */}
            <div className="comment-item">
              <div className="comment-av" style={{ background: SM.color }}>{SM.initials}</div>
              <div className="comment-body">
                <div className="comment-meta">
                  <span className="comment-author">Sofia Marek</span>
                  <span className="comment-time">43m ago</span>
                </div>
                <div className="comment-text">{COMMENTS[2].text}</div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="history-list">
            <div className="history-row">
              <div className="history-av" style={{ background: DO.color }}>{DO.initials}</div>
              <div className="history-body">
                <span className="history-actor">Daniel Okafor</span>
                {' '}changed status{' '}
                <span className="history-old">In progress</span>
                {' → '}
                <span className="history-new">Blocked</span>
              </div>
              <span className="history-time">3h ago</span>
            </div>
            <div className="history-row">
              <div className="history-av" style={{ background: PR.color }}>{PR.initials}</div>
              <div className="history-body">
                <span className="history-actor">Priya Raman</span>
                {' '}added label{' '}
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  background: '#FEF3C7', color: '#B45309',
                  padding: '0 5px', borderRadius: 3, fontSize: 11,
                }}>regulatory</span>
              </div>
              <span className="history-time">4h ago</span>
            </div>
            <div className="history-row">
              <div className="history-av" style={{ background: SM.color }}>{SM.initials}</div>
              <div className="history-body">
                <span className="history-actor">Sofia Marek</span>
                {' '}linked{' '}
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>PAY-401</span>
                {' '}Retry budget configuration
              </div>
              <span className="history-time">5h ago</span>
            </div>
            <div className="history-row">
              <div className="history-av" style={{ background: PR.color }}>{PR.initials}</div>
              <div className="history-body">
                <span className="history-actor">Priya Raman</span>
                {' '}created this issue
              </div>
              <span className="history-time">12 Jun</span>
            </div>
          </div>
        )}

        {activeTab === 'worklog' && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '32px 0', gap: 6, color: '#A8A29E',
          }}>
            <Minus size={20} strokeWidth={1.5} />
            <span style={{ fontSize: 13 }}>No time logged yet</span>
          </div>
        )}
      </div>

      {/* bottom spacer */}
      <div style={{ height: 32 }} />
    </div>
  )

  // ── Right sidebar ───────────────────────────────────────────
  const sidebar = (
    <aside className="detail-sidebar">
      <div className="sidebar-section">
        <div className="sidebar-label">Details</div>

        {/* Assignee */}
        <div className="field-row">
          <div className="field-lbl">Assignee</div>
          <div className="field-val" title="Change assignee — A">
            <Av m={PR} size={20} />
            Priya Raman
            <span className="field-kbd-hint">A</span>
          </div>
        </div>

        {/* Reporter */}
        <div className="field-row">
          <div className="field-lbl">Reporter</div>
          <div className="field-val">
            <Av m={DO} size={20} />
            Daniel Okafor
          </div>
        </div>

        {/* Sprint */}
        <div className="field-row">
          <div className="field-lbl">Sprint</div>
          <div className="field-val">
            Sprint 42
          </div>
        </div>

        {/* Epic */}
        <div className="field-row">
          <div className="field-lbl">Epic</div>
          <div className="field-val">
            <span style={{
              width: 8, height: 8, borderRadius: 2, background: '#D97706', flexShrink: 0,
            }} />
            Month-end resilience
          </div>
        </div>

        {/* Labels */}
        <div className="field-row">
          <div className="field-lbl">Labels</div>
          <div className="field-val" style={{ gap: 4, flexWrap: 'wrap', minHeight: 'unset' }}>
            <span className="label-pill" style={{ background: '#F5F5F4', color: '#78716C' }}>month-end</span>
            <span className="label-pill" style={{ background: '#FEF3C7', color: '#B45309' }}>regulatory</span>
            <button className="ghost-btn" style={{ padding: '1px 6px', fontSize: 11 }}>
              <Plus size={9} strokeWidth={2} />
              Add
            </button>
          </div>
        </div>

        {/* Story points */}
        <div className="field-row">
          <div className="field-lbl">Story points</div>
          <div className="field-val">5</div>
        </div>

        {/* Component */}
        <div className="field-row">
          <div className="field-lbl">Component</div>
          <div className="field-val" style={{ fontFamily: 'monospace', fontSize: 12 }}>
            settlement-svc
          </div>
        </div>

        {/* Fix version */}
        <div className="field-row">
          <div className="field-lbl">Fix version</div>
          <div className="field-val">2026.08</div>
        </div>
      </div>

      {/* Collapsed fields */}
      <button
        className="collapsed-fields-btn"
        onClick={() => setMoreFields(v => !v)}
      >
        {moreFields
          ? <ChevronDown size={12} strokeWidth={1.5} />
          : <ChevronRight size={12} strokeWidth={1.5} />
        }
        {moreFields ? 'Hide extra fields' : 'More fields (6)'}
      </button>

      {moreFields && (
        <div style={{ marginTop: 10 }}>
          {[
            { label: 'Environment',  val: 'Production, Staging' },
            { label: 'Priority',     val: 'Urgent' },
            { label: 'Time estimate',val: '8h' },
            { label: 'Due date',     val: '22 Jul 2026' },
            { label: 'Team',         val: 'Payments Platform' },
            { label: 'Stakeholders', val: 'Marcus Chen, Nadia Osei' },
          ].map(f => (
            <div className="field-row" key={f.label}>
              <div className="field-lbl">{f.label}</div>
              <div className="field-val">{f.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Meta footer */}
      <div className="meta-footer">
        <div>Created <strong style={{ color: '#78716C' }}>12 Jun 2026</strong> by Priya Raman</div>
        <div>Updated <strong style={{ color: '#78716C' }}>today at 09:41</strong></div>
        <div style={{ marginTop: 4 }}>
          <span style={{
            background: '#FEF2F2', color: '#DC2626', padding: '1px 6px',
            borderRadius: 4, fontSize: 10, fontWeight: 500,
          }}>
            <ShieldAlert size={9} strokeWidth={2} style={{ display: 'inline', marginRight: 3 }} />
            PII reviewed
          </span>
        </div>
      </div>
    </aside>
  )

  // ── Comment composer ────────────────────────────────────────
  const composer = (
    <div className="composer-section">
      <div className={`composer-inner${piiGuard ? ' pii-error' : ''}`}>
        {/* Text area */}
        <textarea
          className="composer-input"
          placeholder="Add a comment…"
          value={composerText}
          onChange={e => {
            setComposerText(e.target.value)
            // demo: trigger PII guard when user types account number pattern
            setPiiGuard(e.target.value.includes('4532'))
          }}
        />

        {/* PII warning */}
        {piiGuard && (
          <div className="pii-warning-bar">
            <ShieldAlert size={11} strokeWidth={2} />
            Potential PII detected — remove account numbers before posting
          </div>
        )}

        {/* Toolbar */}
        <div className="composer-toolbar">
          <button className="tb-btn" title="Bold">B</button>
          <button className="tb-btn" title="Bullet list" style={{ fontWeight: 400 }}>
            <List size={12} strokeWidth={1.5} />
          </button>
          <button className="tb-btn" title="Mention">
            <AtSign size={12} strokeWidth={1.5} />
          </button>
          <button className="tb-btn" title="Attach file">
            <Paperclip size={12} strokeWidth={1.5} />
          </button>
          <button className="tb-btn" title="Code">
            <Code size={12} strokeWidth={1.5} />
          </button>

          <div className="tb-divider" />

          {/* AI draft reply — purple, hidden when AI off */}
          {aiOn && (
            <button className="tb-btn ai-btn" title="Draft reply with AI">
              <Sparkles size={12} strokeWidth={1.5} />
            </button>
          )}

          <button
            className="send-btn"
            disabled={piiGuard || composerText.trim() === ''}
            style={{ marginLeft: 'auto' }}
          >
            <Send size={11} strokeWidth={1.5} />
            Send
          </button>
        </div>
      </div>
    </div>
  )

  // ── Layout ──────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {header}
      <div className="detail-body">
        {leftCol}
        {sidebar}
      </div>
      {composer}
    </div>
  )
}
