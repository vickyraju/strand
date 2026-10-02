import { useState, useEffect, useRef } from 'react'
import { X, CheckCircle2 } from 'lucide-react'
import NavRail from './components/NavRail'
import TopBar, { type Crumb } from './components/TopBar'
import CommandPalette from './components/CommandPalette'
import SearchView from './components/SearchView'
import YourWork from './components/YourWork'
import SettingsView from './components/SettingsView'
import PeekPanel from './components/PeekPanel'
import WorkItemDetail from './components/WorkItemDetail'
import Welcome from './components/Welcome'
import CreateProjectModal from './components/CreateProjectModal'
import CreateIssueModal from './components/CreateIssueModal'
import { ProjectsView, ProjectView } from './components/ProjectView'
import { StoreProvider, useStore, type NewIssue } from './data/store'
import { AppContext, type AppActions, type AppView, type ProjectTab } from './appContext'

const VIEW_TITLE: Record<AppView, string> = {
  'my-work': 'Your work', projects: 'Projects', project: 'Projects', search: 'Search', settings: 'Settings',
}
const TAB_TITLE: Record<ProjectTab, string> = { board: 'Board', list: 'List', backlog: 'Backlog', settings: 'Settings' }

const isTyping = (el: Element | null) =>
  !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable)

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}

function Shell() {
  const { state, dispatch } = useStore()
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [paletteOpen,   setPaletteOpen]   = useState(false)
  const [view,          setView]          = useState<AppView>('my-work')
  const [projectId,     setProjectId]     = useState<string>()
  const [projectTab,    setProjectTab]    = useState<ProjectTab>('board')
  const [detail,        setDetail]        = useState<{ id: string; mode: 'peek' | 'full' } | null>(null)
  const [createDefaults, setCreateDefaults] = useState<Partial<NewIssue> | null>(null)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; issueId?: string; n: number } | null>(null)
  const toastTimer = useRef<number>(undefined)

  const project = state.projects.find(p => p.id === projectId)
  const openIssueExists = detail && state.issues.some(i => i.id === detail.id)

  const actions: AppActions = {
    goTo: v => { setView(v); setDetail(null) },
    openProject: (id, tab) => {
      const p = state.projects.find(x => x.id === id)
      setProjectId(id)
      setProjectTab(tab ?? (p?.template === 'scrum' ? 'backlog' : 'board'))
      setView('project')
      setDetail(null)
    },
    openIssue: id => {
      dispatch({ type: 'markViewed', issueId: id })
      setDetail(d => ({ id, mode: d?.mode === 'full' ? 'full' : 'peek' }))
    },
    createIssue: (defaults = {}) => {
      if (!state.projects.length) { setCreateProjectOpen(true); return }
      // Default to the project on screen
      setCreateDefaults({ projectId: view === 'project' ? projectId : undefined, ...defaults })
    },
    toast: (text, issueId) => {
      window.clearTimeout(toastTimer.current)
      setToast({ text, issueId, n: Date.now() })
      toastTimer.current = window.setTimeout(() => setToast(null), 5000)
    },
  }

  const modalOpen = paletteOpen || !!createDefaults || createProjectOpen

  // Keep the latest handlers for the global key listener
  const keyState = useRef({ modalOpen, detail, actions })
  keyState.current = { modalOpen, detail, actions }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { modalOpen, detail, actions } = keyState.current
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(v => !v)
        return
      }
      if (e.key === 'Escape') {
        if (paletteOpen) { setPaletteOpen(false); return }
        if (!modalOpen && detail) setDetail(null)
        return
      }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !modalOpen && !isTyping(document.activeElement)) {
        e.preventDefault()
        actions.createIssue()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [paletteOpen])

  if (!state.me) return <Welcome />

  const currentView: AppView = view === 'project' && !project ? 'projects' : view
  const crumbs: Crumb[] = currentView === 'project' && project
    ? [
        { label: 'Projects', onClick: () => actions.goTo('projects') },
        { label: project.name, onClick: () => actions.openProject(project.id) },
        { label: TAB_TITLE[projectTab] },
      ]
    : [{ label: VIEW_TITLE[currentView] }]

  return (
    <AppContext.Provider value={actions}>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#FAFAF9' }}>

        <NavRail
          collapsed={railCollapsed}
          onCollapseToggle={() => setRailCollapsed(v => !v)}
          onCmdK={() => setPaletteOpen(true)}
          currentView={currentView}
          currentProjectId={projectId}
          onCreateProject={() => setCreateProjectOpen(true)}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, position: 'relative' }}>
          <TopBar crumbs={crumbs} onCreateProject={() => setCreateProjectOpen(true)} />

          {openIssueExists && detail.mode === 'full' ? (
            <div className="detail-page">
              <WorkItemDetail
                issueId={detail.id}
                mode="full"
                onExpand={() => setDetail({ ...detail, mode: 'peek' })}
                onClose={() => setDetail(null)}
              />
            </div>
          ) : (
            <>
              {currentView === 'my-work'  && <YourWork onCreateProject={() => setCreateProjectOpen(true)} />}
              {currentView === 'projects' && <ProjectsView onCreate={() => setCreateProjectOpen(true)} />}
              {currentView === 'project'  && project && <ProjectView project={project} tab={projectTab} />}
              {currentView === 'search'   && <SearchView />}
              {currentView === 'settings' && <SettingsView />}
              {openIssueExists && (
                <PeekPanel
                  issueId={detail.id}
                  onExpandFull={() => setDetail({ ...detail, mode: 'full' })}
                  onClose={() => setDetail(null)}
                />
              )}
            </>
          )}

          {toast && (
            <div className="toast" role="status" key={toast.n}>
              <CheckCircle2 size={16} strokeWidth={2} color="#368727" />
              <span>{toast.text}</span>
              {toast.issueId && state.issues.some(i => i.id === toast.issueId) && (
                <button className="wi-link" onClick={() => { actions.openIssue(toast.issueId!); setToast(null) }}>View</button>
              )}
              <button className="col-hdr-btn" onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} /></button>
            </div>
          )}
        </main>

        {createProjectOpen && (
          <CreateProjectModal
            onClose={() => setCreateProjectOpen(false)}
            onCreated={id => { setCreateProjectOpen(false); actions.openProject(id) }}
          />
        )}

        {createDefaults && (
          <CreateIssueModal defaults={createDefaults} onClose={() => setCreateDefaults(null)} />
        )}

        {paletteOpen && (
          <CommandPalette onClose={() => setPaletteOpen(false)} onCreateProject={() => setCreateProjectOpen(true)} />
        )}
      </div>
    </AppContext.Provider>
  )
}
