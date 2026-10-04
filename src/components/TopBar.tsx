import { ChevronRight, Plus, Bell, HelpCircle, Settings, UserRoundCog, Check, Keyboard, Moon, Sun, Menu as MenuIcon } from 'lucide-react'
import { useThemePref, setThemePref } from '../theme'
import { useStore } from '../data/store'
import { useApp } from '../appContext'
import { Avatar, Menu } from './ui'

export interface Crumb { label: string; onClick?: () => void }

export default function TopBar({ crumbs, onCreateProject, onShortcuts, onMenu }: {
  crumbs: Crumb[]; onCreateProject: () => void; onShortcuts: () => void; onMenu?: () => void
}) {
  const { state, dispatch } = useStore()
  const { createIssue, goTo } = useApp()
  const hasProjects = state.projects.length > 0
  useThemePref()
  const dark = document.documentElement.dataset.theme === 'dark'
  const unread = state.notifications.filter(n => n.userId === state.me?.id && !n.read && !n.archived).length

  return (
    <header className="topbar">
      {onMenu && <button className="icon-btn topbar-menu" onClick={onMenu} aria-label="Open navigation"><MenuIcon size={18} /></button>}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            {i > 0 && <ChevronRight size={13} className="crumb-sep" />}
            {c.onClick && i < crumbs.length - 1
              ? <button className="crumb-link" onClick={c.onClick}>{c.label}</button>
              : <span className={i === crumbs.length - 1 ? 'crumb-current' : ''} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
          </span>
        ))}
      </nav>

      <div className="topbar-actions">
        <button className="btn btn-primary" onClick={() => hasProjects ? createIssue() : onCreateProject()}
          title={hasProjects ? 'Create work item (C)' : 'Create a project first'}>
          <Plus size={15} strokeWidth={2.25} />
          <span className="create-label">{hasProjects ? 'Create' : 'Create project'}</span>
        </button>
        <button className="icon-btn" onClick={() => goTo('inbox')} title="Inbox" aria-label={`Inbox, ${unread} unread`}>
          <Bell size={17} strokeWidth={1.75} />
          {unread > 0 && <span className="dot-badge" />}
        </button>
        <button className="icon-btn" onClick={onShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <HelpCircle size={17} strokeWidth={1.75} />
        </button>
        <Menu
          title="Account"
          className="avatar-btn"
          trigger={<Avatar user={state.me} size={28} />}
          items={[
            ...state.users.map((u, i) => ({
              label: u.id === state.ownerId ? `${u.name} (you)` : `Act as ${u.name}`,
              icon: state.me?.id === u.id ? <Check size={14} color="var(--brand)" /> : <Avatar user={u} size={18} />,
              onClick: () => dispatch({ type: 'actAs', userId: u.id }),
              divider: i === 0 ? false : i === 1,
            })),
            { label: 'Manage people', icon: <UserRoundCog size={14} />, onClick: () => goTo('settings'), divider: true },
            { label: 'Settings', icon: <Settings size={14} />, onClick: () => goTo('settings') },
            { label: dark ? 'Light mode' : 'Dark mode', icon: dark ? <Sun size={14} /> : <Moon size={14} />, onClick: () => setThemePref(dark ? 'light' : 'dark') },
            { label: 'Keyboard shortcuts', icon: <Keyboard size={14} />, onClick: onShortcuts, hint: '?' },
          ]}
        />
      </div>
    </header>
  )
}
