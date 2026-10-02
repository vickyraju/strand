import {
  LayoutGrid, Hash, Settings, Search, Plus,
  PanelLeftClose, PanelLeftOpen, SearchCode, FolderKanban,
} from 'lucide-react'
import { useStore } from '../data/store'
import { useApp, type AppView } from '../appContext'
import { ProjectIcon } from './ProjectView'
import { Avatar } from './ui'

// ── Forge logomark ─────────────────────────────────────────
export function Logomark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <rect width="28" height="28" rx="6" fill="#368727" />
      {/* Bold geometric F — three rectangles */}
      <rect x="8"  y="8"  width="2.5" height="12" fill="white" />
      <rect x="8"  y="8"  width="10"  height="2.5" fill="white" />
      <rect x="8"  y="13" width="7.5" height="2.5" fill="white" />
    </svg>
  )
}

const VIEWS: { icon: typeof LayoutGrid; label: string; key: AppView }[] = [
  { icon: LayoutGrid, label: 'Your work', key: 'my-work' },
  { icon: SearchCode, label: 'Search',    key: 'search'  },
]

interface NavRailProps {
  collapsed:         boolean
  onCollapseToggle:  () => void
  onCmdK:            () => void
  currentView:       AppView
  currentProjectId?: string
  onCreateProject:   () => void
}

export default function NavRail({ collapsed, onCollapseToggle, onCmdK, currentView, currentProjectId, onCreateProject }: NavRailProps) {
  const { state } = useStore()
  const { goTo, openProject, openIssue } = useApp()
  const projects = [...state.projects].sort((a, b) =>
    Number(state.starred.includes(b.id)) - Number(state.starred.includes(a.id)))
  const recent = state.viewed.slice(0, 5).map(id => state.issues.find(i => i.id === id)).filter(Boolean)

  return (
    <nav className={`nav-rail${collapsed ? ' collapsed' : ''}`} aria-label="Main navigation">

      {/* ── Logo + collapse ──────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 10px 8px', borderBottom: '1px solid #E7E5E4', flexShrink: 0,
      }}>
        <div style={{ flexShrink: 0 }}><Logomark size={28} /></div>
        <div className="nav-item-label" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.01em' }}>
          Forge
        </div>
        <button className="nav-icon-btn" onClick={onCollapseToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} style={{ flexShrink: 0 }}>
          {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.5} /> : <PanelLeftClose size={15} strokeWidth={1.5} />}
        </button>
      </div>

      {/* ── Search / Cmd+K ──────────────────────────────── */}
      <button className="nav-search" onClick={onCmdK} title="Search or jump to… ⌘K">
        <Search size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
        <span className="nav-search-text" style={{ flex: 1, fontSize: 12, color: '#A8A29E' }}>Search or jump to…</span>
        <kbd className="nav-search-kbd" style={{
          fontSize: 10, color: '#A8A29E', background: '#FFFFFF', border: '1px solid #E7E5E4',
          borderRadius: 3, padding: '1px 4px', fontFamily: 'inherit', flexShrink: 0,
        }}>⌘K</kbd>
      </button>

      {/* ── Scrollable body ─────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 6px' }}>
        {VIEWS.map(({ icon: Icon, label, key }) => (
          <button key={key} className={`nav-item${currentView === key ? ' active' : ''}`} title={collapsed ? label : undefined} onClick={() => goTo(key)}>
            <Icon size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            <span className="nav-item-label" style={{ flex: 1 }}>{label}</span>
          </button>
        ))}

        {/* Projects */}
        <div className="nav-section-label nav-section-row">
          <span>Projects</span>
          <button className="nav-section-add" onClick={onCreateProject} title="Create project" aria-label="Create project">
            <Plus size={13} strokeWidth={1.75} />
          </button>
        </div>
        {projects.map(p => (
          <button
            key={p.id}
            className={`nav-item${currentView === 'project' && currentProjectId === p.id ? ' active' : ''}`}
            title={collapsed ? `${p.key} ${p.name}` : undefined}
            onClick={() => openProject(p.id)}
          >
            <ProjectIcon project={p} size={14} />
            <span className="nav-item-label" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          </button>
        ))}
        <button className={`nav-item${currentView === 'projects' ? ' active' : ''}`} title={collapsed ? 'All projects' : undefined} onClick={() => goTo('projects')}>
          <FolderKanban size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
          <span className="nav-item-label" style={{ flex: 1 }}>All projects</span>
        </button>

        {/* Recent */}
        {recent.length > 0 && <div className="nav-section-label">Recent</div>}
        {recent.map(i => (
          <button key={i!.id} className="nav-item" title={collapsed ? `${i!.key} ${i!.title}` : undefined} onClick={() => openIssue(i!.id)}>
            <Hash size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#A8A29E' }} />
            <span className="nav-item-label" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ fontSize: 11, color: '#A8A29E', fontFamily: 'monospace', marginRight: 5 }}>{i!.key}</span>
              <span style={{ fontSize: 12 }}>{i!.title}</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── Bottom ──────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid #E7E5E4', padding: '6px', flexShrink: 0 }}>
        <button className={`nav-item${currentView === 'settings' ? ' active' : ''}`} title={collapsed ? 'Settings' : undefined} onClick={() => goTo('settings')}>
          <Settings size={15} strokeWidth={1.5} style={{ flexShrink: 0 }} />
          <span className="nav-item-label" style={{ flex: 1 }}>Settings</span>
          {!collapsed && <Avatar user={state.me ?? undefined} size={20} />}
        </button>
      </div>
    </nav>
  )
}
