import { ChevronRight, Plus } from 'lucide-react'
import { useStore } from '../data/store'
import { useApp } from '../appContext'
import { Avatar } from './ui'

export interface Crumb { label: string; onClick?: () => void }

export default function TopBar({ crumbs, onCreateProject }: { crumbs: Crumb[]; onCreateProject: () => void }) {
  const { state } = useStore()
  const { createIssue, goTo } = useApp()
  const hasProjects = state.projects.length > 0

  return (
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb" style={{ flex: 1, minWidth: 0 }}>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && <ChevronRight size={13} className="breadcrumb-sep" strokeWidth={1.5} />}
            {c.onClick && i < crumbs.length - 1
              ? <button className="breadcrumb-item breadcrumb-link" onClick={c.onClick}>{c.label}</button>
              : <span className={`breadcrumb-item${i === crumbs.length - 1 ? ' current' : ''}`}>{c.label}</span>}
          </span>
        ))}
      </nav>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          className="btn-create"
          title={hasProjects ? 'Create work item (C)' : 'Create a project first'}
          onClick={() => hasProjects ? createIssue() : onCreateProject()}
        >
          <Plus size={14} strokeWidth={2} />
          {hasProjects ? 'Create' : 'Create project'}
          {hasProjects && (
            <kbd style={{
              fontSize: 10, color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: 3, padding: '1px 4px',
              fontFamily: 'inherit', lineHeight: 1.4,
            }}>C</kbd>
          )}
        </button>
        <button className="topbar-avatar" onClick={() => goTo('settings')} title={`${state.me?.name} · Settings`}>
          <Avatar user={state.me ?? undefined} size={28} />
        </button>
      </div>
    </div>
  )
}
