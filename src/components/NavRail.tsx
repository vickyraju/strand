import { useState } from 'react'
import {
  LayoutGrid, Inbox, Search, Plus, Settings, PanelLeftClose, PanelLeftOpen, SearchCode, FolderKanban,
  ChevronRight, ChevronDown, Bookmark, Columns2, ListChecks, List, BarChart3, Gauge, Hash, GanttChart, CalendarDays, Rocket,
} from 'lucide-react'
import { useStore } from '../data/store'
import { useApp } from '../appContext'
import { href, navigate, type Route, type ProjectTab } from '../router'
import { ProjectIcon } from './ProjectView'

export function Logomark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <rect width="28" height="28" rx="6" fill="var(--brand)" />
      <path d="M8 8h10v2.5h-7.5V13h5v2.5h-5V20H8z" fill="white" />
    </svg>
  )
}

const PROJECT_LINKS: { tab: ProjectTab; label: string; Icon: typeof List; scrumOnly?: boolean }[] = [
  { tab: 'summary', label: 'Summary', Icon: Gauge },
  { tab: 'backlog', label: 'Backlog', Icon: ListChecks, scrumOnly: true },
  { tab: 'board',   label: 'Board',   Icon: Columns2 },
  { tab: 'list',    label: 'List',    Icon: List },
  { tab: 'timeline', label: 'Timeline', Icon: GanttChart },
  { tab: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { tab: 'releases', label: 'Releases', Icon: Rocket },
  { tab: 'reports', label: 'Reports', Icon: BarChart3 },
]

export default function NavRail({ collapsed, onCollapseToggle, onCmdK, route, onCreateProject }: {
  collapsed:        boolean
  onCollapseToggle: () => void
  onCmdK:           () => void
  route:            Route
  onCreateProject:  () => void
}) {
  const { state } = useStore()
  const { goTo, openIssue } = useApp()
  const currentKey = route.name === 'project' ? route.key : undefined
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentKey ? [currentKey] : []))
  const unread = state.notifications.filter(n => n.userId === state.me?.id && !n.read && !n.archived).length
  const starred = state.projects.filter(p => state.starred.includes(p.id))
  const views = state.views.filter(v => v.shared || v.ownerId === state.me?.id)
  const others = state.projects.filter(p => !state.starred.includes(p.id))
  const recent = state.viewed.slice(0, 5).map(id => state.issues.find(i => i.id === id)).filter(i => !!i)

  const toggle = (key: string) => setExpanded(prev => {
    const n = new Set(prev)
    if (n.has(key)) n.delete(key); else n.add(key)
    return n
  })

  const item = (active: boolean, label: string, Icon: typeof List, onClick: () => void, badge?: number) => (
    <button className={`nav-item${active ? ' active' : ''}`} title={collapsed ? label : undefined} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <Icon size={16} strokeWidth={1.75} className="nav-icon" />
      <span className="nav-label">{label}</span>
      {!!badge && <span className="nav-badge" aria-label={`${badge} unread`}>{badge > 99 ? '99+' : badge}</span>}
    </button>
  )

  const projectRow = (p: typeof state.projects[number]) => {
    const open = expanded.has(p.key) && !collapsed
    const active = currentKey === p.key
    return (
      <div key={p.id}>
        <div className={`nav-item nav-project${active && !open ? ' active' : ''}`} title={collapsed ? p.name : undefined}>
          <button className="nav-caret" onClick={() => toggle(p.key)} aria-label={open ? `Collapse ${p.name}` : `Expand ${p.name}`} aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <button className="nav-project-link" onClick={() => { navigate(href({ name: 'project', key: p.key })); setExpanded(s => new Set(s).add(p.key)) }}>
            <ProjectIcon project={p} size={18} />
            <span className="nav-label">{p.name}</span>
          </button>
        </div>
        {open && PROJECT_LINKS.filter(l => !l.scrumOnly || p.template === 'scrum').map(l => (
          <button key={l.tab}
            className={`nav-item nav-sub${active && route.name === 'project' && route.tab === l.tab ? ' active' : ''}`}
            onClick={() => navigate(href({ name: 'project', key: p.key, tab: l.tab }))}>
            <l.Icon size={14} strokeWidth={1.75} className="nav-icon" />
            <span className="nav-label">{l.label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <nav className={`nav-rail${collapsed ? ' collapsed' : ''}`} aria-label="Main navigation">
      <div className="nav-head">
        <Logomark size={26} />
        <span className="nav-label nav-workspace" title={state.workspaceName}>{state.workspaceName}</span>
        <button className="icon-btn" onClick={onCollapseToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
        </button>
      </div>

      <button className="nav-search" onClick={onCmdK} title="Search or jump to (⌘K)">
        <Search size={14} strokeWidth={1.75} />
        <span className="nav-label">Search or jump to…</span>
        <kbd className="kbd nav-label">⌘K</kbd>
      </button>

      <div className="nav-body">
        {item(route.name === 'home', 'Your work', LayoutGrid, () => goTo('home'))}
        {item(route.name === 'inbox', 'Inbox', Inbox, () => goTo('inbox'), unread)}
        {item(route.name === 'search' && !route.view, 'Search', SearchCode, () => goTo('search'))}

        {views.length > 0 && !collapsed && <div className="nav-section">Views</div>}
        {!collapsed && views.map(v => (
          <button key={v.id} className={`nav-item nav-recent${route.name === 'search' && route.view === v.id ? ' active' : ''}`}
            onClick={() => navigate(href({ name: 'search', q: '', view: v.id }))} title={v.shared ? `${v.name} (shared)` : v.name}>
            <Bookmark size={14} strokeWidth={1.75} className="nav-icon" />
            <span className="nav-label">{v.name}</span>
          </button>
        ))}

        {starred.length > 0 && <div className="nav-section">Starred</div>}
        {starred.map(projectRow)}

        <div className="nav-section nav-section-row">
          <span>Projects</span>
          <button className="icon-btn sm" onClick={onCreateProject} title="Create project" aria-label="Create project"><Plus size={14} /></button>
        </div>
        {others.map(projectRow)}
        {item(route.name === 'projects', 'All projects', FolderKanban, () => goTo('projects'))}

        {recent.length > 0 && !collapsed && <div className="nav-section">Recent</div>}
        {!collapsed && recent.map(i => (
          <button key={i.id} className="nav-item nav-recent" onClick={() => openIssue(i.id)} title={`${i.key} ${i.title}`}>
            <Hash size={13} strokeWidth={1.75} className="nav-icon" />
            <span className="nav-label"><span className="mono">{i.key}</span> {i.title}</span>
          </button>
        ))}
      </div>

      <div className="nav-foot">
        {item(route.name === 'settings', 'Settings', Settings, () => goTo('settings'))}
      </div>
    </nav>
  )
}
