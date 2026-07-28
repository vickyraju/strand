import { useState, useEffect, useRef } from 'react'
import {
  Search, Hash, Columns2,
  User, GitPullRequest, Sparkles,
} from 'lucide-react'
import { useForge } from '../App'

// ── Result data ──────────────────────────────────────────────
const RESULTS = {
  actions: [
    {
      icon: <User size={14} strokeWidth={1.5} />,
      label: <>Assign <em>PAY-393</em> to…</>,
      hint: '↵',
      id: 'assign',
    },
    {
      icon: <GitPullRequest size={14} strokeWidth={1.5} />,
      label: <>Move <em>PAY-393</em> to In review</>,
      hint: '↵',
      id: 'move',
    },
  ],
  issues: [
    {
      icon: <Hash size={14} strokeWidth={1.5} />,
      label: <><em>PAY-393</em> Settlement webhook retries exhausted</>,
      hint: <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#D97706' }}>in progress</span>,
      id: 'pay-393',
    },
  ],
  boards: [
    {
      icon: <Columns2 size={14} strokeWidth={1.5} />,
      label: <>Payments board — Sprint 42</>,
      hint: '↵',
      id: 'pay-board',
    },
  ],
}

// Total focusable rows (actions + issues + boards + assist row slot)
const ALL_IDS = [
  ...RESULTS.actions.map(r => r.id),
  ...RESULTS.issues.map(r => r.id),
  ...RESULTS.boards.map(r => r.id),
  'assist',
]

interface CommandPaletteProps { onClose: () => void }

export default function CommandPalette({ onClose }: CommandPaletteProps) {
  const { aiOn }            = useForge()
  const [query, setQuery]   = useState('assign pay-393')
  const [focusIdx, setFocus] = useState(0)
  const inputRef            = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const ids = aiOn ? ALL_IDS : ALL_IDS.filter(id => id !== 'assist')
  const total = ids.length

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(i => (i + 1) % total) }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setFocus(i => (i - 1 + total) % total) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [total])

  const isFocused = (id: string) => ids[focusIdx] === id

  const ResultRow = ({
    id, icon, label, hint, color,
  }: { id: string; icon: React.ReactNode; label: React.ReactNode; hint?: React.ReactNode; color?: string }) => (
    <div
      className={`cmd-row${isFocused(id) ? ' focused' : ''}`}
      onMouseEnter={() => setFocus(ids.indexOf(id))}
      role="option"
      aria-selected={isFocused(id)}
    >
      <span style={{ color: color ?? '#78716C', flexShrink: 0, display: 'flex' }}>{icon}</span>
      <span className="cmd-row-label" style={{ color: color }}>{label}</span>
      {hint && (
        typeof hint === 'string'
          ? <span className="cmd-kbd">{hint}</span>
          : <span className="cmd-row-hint">{hint}</span>
      )}
    </div>
  )

  return (
    <div className="cmd-backdrop" onClick={onClose} role="dialog" aria-label="Command palette" aria-modal="true">
      <div className="cmd-panel" onClick={e => e.stopPropagation()}>

        {/* ── Input ──────────────────────────────────────── */}
        <div style={{
          display:      'flex', alignItems: 'center', gap: 10,
          padding:      '13px 16px',
          borderBottom: '1px solid #F0EFEE',
        }}>
          <Search size={16} color="#A8A29E" strokeWidth={1.5} style={{ flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setFocus(0) }}
            placeholder="Search or jump to…"
            aria-label="Command search"
            style={{
              flex: 1, border: 'none', outline: 'none',
              fontSize: 15, color: '#1C1917',
              background: 'transparent', fontFamily: 'inherit',
            }}
          />
          <kbd style={{
            fontSize: 11, color: '#A8A29E', background: '#F5F5F4',
            border: '1px solid #E7E5E4', borderRadius: 4,
            padding: '2px 6px', fontFamily: 'inherit',
          }}>Esc</kbd>
        </div>

        {/* ── Results ────────────────────────────────────── */}
        <div style={{ maxHeight: 380, overflowY: 'auto' }} role="listbox">

          {/* Actions */}
          <div className="cmd-section-label">Actions</div>
          {RESULTS.actions.map(r => <ResultRow key={r.id} {...r} />)}

          {/* Issues */}
          <div className="cmd-section-label" style={{ marginTop: 4 }}>Issues</div>
          {RESULTS.issues.map(r => <ResultRow key={r.id} {...r} />)}

          {/* AI Assist row — only when aiOn; screen reads complete without it */}
          {aiOn && (
            <div
              className={`cmd-assist-row${isFocused('assist') ? ' focused' : ''}`}
              onMouseEnter={() => setFocus(ids.indexOf('assist'))}
              role="option"
              aria-selected={isFocused('assist')}
            >
              <Sparkles size={13} strokeWidth={1.5} color="#76A923" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: '#76A923', flexShrink: 0 }}>Assist</span>
              <span style={{ fontSize: 13, color: '#78716C', flex: 1 }}>Summarize PAY-393 for me</span>
              <span className="cmd-kbd" style={{ color: '#76A923', borderColor: '#C6D9A0', background: '#F3F9E8' }}>↵</span>
            </div>
          )}

          {/* Boards */}
          <div className="cmd-section-label" style={{ marginTop: 4 }}>Boards</div>
          {RESULTS.boards.map(r => <ResultRow key={r.id} {...r} />)}
        </div>

        {/* ── Footer ─────────────────────────────────────── */}
        <div style={{
          display:    'flex', alignItems: 'center', gap: 16,
          padding:    '8px 16px',
          borderTop:  '1px solid #F0EFEE',
        }}>
          {[
            ['↑↓', 'Navigate'],
            ['↵',  'Select'],
            ['Esc', 'Dismiss'],
          ].map(([key, label]) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#A8A29E' }}>
              <kbd className="cmd-kbd">{key}</kbd>
              {label}
            </span>
          ))}
          <div style={{ flex: 1 }} />
          {aiOn && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#76A923' }}>
              <Sparkles size={11} />
              AI assist on
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
