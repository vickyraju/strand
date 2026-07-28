import { Filter, ChevronRight, Share2, Plus, Sparkles } from 'lucide-react'
import { useForge } from '../App'

export default function TopBar() {
  const { aiOn } = useForge()

  return (
    <div className="topbar">

      {/* ── Breadcrumb ─────────────────────────────────── */}
      <nav className="breadcrumb" aria-label="Breadcrumb" style={{ flex: 1, minWidth: 0 }}>
        <span className="breadcrumb-item">Payments</span>
        <ChevronRight size={13} className="breadcrumb-sep" strokeWidth={1.5} />
        <span className="breadcrumb-item">Board</span>
        <ChevronRight size={13} className="breadcrumb-sep" strokeWidth={1.5} />
        <span className="breadcrumb-item current">Sprint 42</span>
      </nav>

      {/* ── Right toolbar ──────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>

        {/* AI Assist indicator — only when aiOn */}
        {aiOn && (
          <button className="topbar-icon-btn" title="AI assist is active" style={{ color: '#76A923', width: 'auto', padding: '0 8px', gap: 4 }}>
            <Sparkles size={13} strokeWidth={1.5} />
            <span style={{ fontSize: 11, fontWeight: 500 }}>Assist</span>
          </button>
        )}

        <div className="topbar-divider" />

        <button className="topbar-icon-btn" title="Filter issues (F)">
          <Filter size={14} strokeWidth={1.5} />
        </button>

        <button className="topbar-icon-btn" title="Share this view">
          <Share2 size={14} strokeWidth={1.5} />
        </button>

        <div className="topbar-divider" />

        {/* Create — primary action */}
        <button className="btn-create" title="Create issue (C)">
          <Plus size={14} strokeWidth={2} />
          Create
          <kbd style={{
            fontSize: 10, color: 'rgba(255,255,255,0.5)',
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 3, padding: '1px 4px',
            fontFamily: 'inherit', lineHeight: 1.4,
          }}>C</kbd>
        </button>

        <div className="topbar-divider" />

        {/* Avatar */}
        <div style={{ position: 'relative', marginLeft: 2 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: '#4F46E5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 600, color: 'white', cursor: 'pointer',
          }}>PR</div>
          <div style={{
            position: 'absolute', bottom: 0, right: 0,
            width: 7, height: 7, borderRadius: '50%',
            background: '#16A34A', border: '1.5px solid white',
          }} />
        </div>
      </div>
    </div>
  )
}
