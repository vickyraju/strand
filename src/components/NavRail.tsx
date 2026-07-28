import {
  LayoutGrid, Inbox, Columns2, List, BarChart2,
  Hash, Settings, HelpCircle, Search,
  PanelLeftClose, PanelLeftOpen, SearchCode, GitBranch,
} from 'lucide-react'

// ── Forge logomark ─────────────────────────────────────────
function Logomark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="6" fill="#368727" />
      {/* Bold geometric F — three rectangles */}
      <rect x="8"  y="8"  width="2.5" height="12" fill="white" />
      <rect x="8"  y="8"  width="10"  height="2.5" fill="white" />
      <rect x="8"  y="13" width="7.5" height="2.5" fill="white" />
    </svg>
  )
}

// ── Project color squares ─────────────────────────────────
const PINNED = [
  { key: 'PLAT', name: 'Platform Core',    color: '#4F46E5' },
  { key: 'PAY',  name: 'Payments',         color: '#D97706' },
  { key: 'RISK', name: 'Risk Engineering', color: '#DC2626' },
]

const VIEWS = [
  { icon: LayoutGrid, label: 'Your work',     key: 'my-work' },
  { icon: Inbox,      label: 'Inbox',         key: 'inbox',   badge: 12 },
  { icon: Columns2,   label: 'Boards',        key: 'boards' },
  { icon: List,       label: 'Backlog',       key: 'backlog' },
  { icon: SearchCode, label: 'Search & query',key: 'search' },
  { icon: BarChart2,  label: 'Reports',       key: 'reports' },
  { icon: GitBranch,  label: 'Workflows',     key: 'workflow' },
]

const RECENT = [
  { key: 'PLAT-4821', title: 'Reconciliation job exceeds 4h window' },
  { key: 'PAY-393',   title: 'Settlement webhook retries exhausted' },
]

interface NavRailProps {
  collapsed:         boolean
  onCollapseToggle:  () => void
  onCmdK:            () => void
  currentView?:      string
  onViewChange?:     (view: 'board' | 'backlog' | 'search' | 'my-work' | 'inbox' | 'reports' | 'workflow') => void
}

export default function NavRail({ collapsed, onCollapseToggle, onCmdK, currentView, onViewChange }: NavRailProps) {
  const cls = `nav-rail${collapsed ? ' collapsed' : ''}`

  return (
    <nav className={cls} aria-label="Main navigation">

      {/* ── Logo + collapse ──────────────────────────────── */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        gap:            8,
        padding:        '12px 10px 8px',
        borderBottom:   '1px solid #E7E5E4',
        flexShrink:     0,
      }}>
        <div style={{ flexShrink: 0 }}>
          <Logomark size={28} />
        </div>
        <div className="nav-item-label" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.01em', lineHeight: 1.2 }}>Forge</div>
          <div style={{ fontSize: 11, color: '#A8A29E', lineHeight: 1.2 }}>Meridian Capital</div>
        </div>
        <button
          className="nav-icon-btn"
          onClick={onCollapseToggle}
          title={collapsed ? 'Expand rail' : 'Collapse rail'}
          style={{ flexShrink: 0 }}
        >
          {collapsed
            ? <PanelLeftOpen  size={15} strokeWidth={1.5} />
            : <PanelLeftClose size={15} strokeWidth={1.5} />
          }
        </button>
      </div>

      {/* ── Search / Cmd+K ──────────────────────────────── */}
      <button className="nav-search" onClick={onCmdK} title="Search or jump to… ⌘K">
        <Search size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
        <span className="nav-search-text" style={{ flex: 1, fontSize: 12, color: '#A8A29E' }}>
          Search or jump to…
        </span>
        <kbd className="nav-search-kbd" style={{
          fontSize: 10, color: '#A8A29E', background: '#FFFFFF',
          border: '1px solid #E7E5E4', borderRadius: 3,
          padding: '1px 4px', fontFamily: 'inherit', flexShrink: 0,
        }}>⌘K</kbd>
      </button>

      {/* ── Scrollable body ─────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 6px' }}>

        {/* Pinned */}
        <div className="nav-section-label">Pinned</div>
        {PINNED.map(({ key, name, color }) => (
          <button key={key} className="nav-item" title={collapsed ? `${key} ${name}` : undefined}>
            {/* 14px colored square glyph */}
            <div style={{
              width: 14, height: 14, borderRadius: 3,
              background: color, flexShrink: 0,
            }} />
            <span className="nav-item-label" style={{ flex: 1 }}>
              <span style={{ fontSize: 11, color: '#A8A29E', fontFamily: 'monospace', marginRight: 5 }}>{key}</span>
              {name}
            </span>
          </button>
        ))}

        {/* Views */}
        <div className="nav-section-label">Views</div>
        {VIEWS.map(({ icon: Icon, label, key, badge }) => {
          const viewKey = key === 'boards' ? 'board'
            : key === 'backlog' ? 'backlog'
            : key === 'search' ? 'search'
            : key === 'my-work' ? 'my-work'
            : key === 'inbox' ? 'inbox'
            : key === 'reports' ? 'reports'
            : key === 'workflow' ? 'workflow'
            : null
          const isActive = viewKey ? currentView === viewKey : false
          return (
            <button
              key={key}
              className={`nav-item${isActive ? ' active' : ''}`}
              title={collapsed ? label : undefined}
              onClick={() => {
                if (viewKey) onViewChange?.(viewKey as 'board' | 'backlog' | 'search' | 'my-work' | 'inbox' | 'reports' | 'workflow')
              }}
            >
              <Icon size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
              <span className="nav-item-label" style={{ flex: 1 }}>{label}</span>
              {badge && <span className="nav-item-badge">{badge}</span>}
            </button>
          )
        })}

        {/* Recent */}
        <div className="nav-section-label">Recent</div>
        {RECENT.map(({ key, title }) => (
          <button key={key} className="nav-item" title={collapsed ? `${key} ${title}` : undefined}>
            <Hash size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#A8A29E' }} />
            <span className="nav-item-label" style={{ flex: 1 }}>
              <span style={{ fontSize: 11, color: '#A8A29E', fontFamily: 'monospace', marginRight: 5 }}>{key}</span>
              <span style={{ fontSize: 12 }}>{title}</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── Bottom ──────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid #E7E5E4', padding: '8px 10px', flexShrink: 0 }}>

        {/* Admin + Help */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 6, justifyContent: collapsed ? 'center' : 'flex-start', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center' }}>
          <button className="nav-icon-btn" title="Admin settings">
            <Settings size={15} strokeWidth={1.5} />
          </button>
          <button className="nav-icon-btn" title="Help & support">
            <HelpCircle size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </nav>
  )
}
