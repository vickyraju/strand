import { useState, useEffect, useRef, type ReactNode } from 'react'
import { Search, Plus, FolderPlus, LayoutGrid, FolderKanban, SearchCode, Settings, Inbox, LayoutDashboard, Bookmark } from 'lucide-react'
import { navigate, href } from '../router'
import { useStore, projectOf } from '../data/store'
import { useApp, type AppView } from '../appContext'
import { ProjectIcon } from './ProjectView'
import { TypeIcon } from './ui'

interface Item { id: string; section: string; icon: ReactNode; label: ReactNode; hint?: string; run: () => void }

export default function CommandPalette({ onClose, onCreateProject }: { onClose: () => void; onCreateProject: () => void }) {
  const { state } = useStore()
  const { openIssue, openProject, createIssue, goTo } = useApp()
  const [query, setQuery]   = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const match = (...s: string[]) => !q || s.some(x => x.toLowerCase().includes(q))

  const go = (view: AppView, label: string, icon: ReactNode): Item =>
    ({ id: `go-${view}`, section: 'Navigation', icon, label, run: () => goTo(view) })

  const items: Item[] = [
    ...(state.projects.length ? [{ id: 'new-issue', section: 'Actions', icon: <Plus size={14} />, label: 'Create work item', hint: 'C', run: () => createIssue() }] : []),
    { id: 'new-project', section: 'Actions', icon: <FolderPlus size={14} />, label: 'Create project', run: onCreateProject },
    go('home',     'Go to Your work',     <LayoutGrid size={14} />),
    go('inbox',    'Go to Inbox',         <Inbox size={14} />),
    go('projects', 'Go to All projects',  <FolderKanban size={14} />),
    ...(q ? [{ id: 'search-all', section: 'Actions', icon: <SearchCode size={14} />, label: `Search all work items for “${query.trim()}”`, run: () => goTo('search', query.trim()) }] : []),
    go('search',   'Go to Search',        <SearchCode size={14} />),
    go('dashboards', 'Go to Dashboards',  <LayoutDashboard size={14} />),
    go('settings', 'Go to Settings',      <Settings size={14} />),
  ].filter(i => i.id === 'search-all' || match(String(i.label)))

  const projects: Item[] = state.projects
    .filter(p => match(p.name, p.key))
    .map(p => ({ id: p.id, section: 'Projects', icon: <ProjectIcon project={p} size={14} />, label: p.name, hint: p.key, run: () => openProject(p.id) }))

  const recentFirst = [...state.viewed.map(id => state.issues.find(i => i.id === id)).filter(Boolean), ...state.issues]
  const seen = new Set<string>()
  const issues: Item[] = recentFirst
    .filter(i => i && !seen.has(i.id) && (seen.add(i.id), match(i.key, i.title)))
    .slice(0, q ? 12 : 6)
    .map(i => ({
      id: i!.id, section: q ? 'Work items' : 'Recent work items', icon: <TypeIcon type={i!.type} />,
      label: <><em>{i!.key}</em> {i!.title}</>, hint: projectOf(state, i!.projectId)?.name, run: () => openIssue(i!.id),
    }))

  const views: Item[] = state.views
    .filter(v => (v.shared || v.ownerId === state.me?.id) && match(v.name))
    .map(v => ({ id: v.id, section: 'Saved views', icon: <Bookmark size={14} />, label: v.name, run: () => navigate(href({ name: 'search', q: '', view: v.id })) }))

  const all = [...issues, ...projects, ...views, ...items]
  const safeCursor = Math.min(cursor, Math.max(all.length - 1, 0))

  useEffect(() => { setCursor(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector('.cmd-row.focused')?.scrollIntoView({ block: 'nearest' })
  }, [safeCursor])

  const run = (item?: Item) => { if (!item) return; onClose(); item.run() }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((safeCursor + 1) % all.length) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor((safeCursor - 1 + all.length) % all.length) }
    if (e.key === 'Enter')     { e.preventDefault(); run(all[safeCursor]) }
    if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  let lastSection = ''
  return (
    <div className="cmd-backdrop" onClick={onClose} role="dialog" aria-label="Command palette" aria-modal="true">
      <div className="cmd-panel" onClick={e => e.stopPropagation()}>
        <div className="cmd-input-row">
          <Search size={16} strokeWidth={1.5} color="#A8A29E" />
          <input
            className="cmd-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search work items, projects and actions…"
            aria-label="Search"
            autoFocus
          />
          <kbd className="cmd-kbd">Esc</kbd>
        </div>
        <div ref={listRef} className="cmd-list" role="listbox">
          {all.length === 0 && <div className="yw-empty-tab" style={{ padding: 24 }}>No results for “{query}”.</div>}
          {all.map((item, idx) => {
            const header = item.section !== lastSection ? (lastSection = item.section) : null
            return (
              <div key={item.id}>
                {header && <div className="cmd-section-label">{header}</div>}
                <div
                  role="option"
                  aria-selected={idx === safeCursor}
                  className={`cmd-row${idx === safeCursor ? ' focused' : ''}`}
                  onMouseMove={() => setCursor(idx)}
                  onClick={() => run(item)}
                >
                  <span style={{ display: 'inline-flex', color: '#78716C' }}>{item.icon}</span>
                  <span className="cmd-row-label">{item.label}</span>
                  {item.hint && <span className="cmd-row-hint">{item.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
