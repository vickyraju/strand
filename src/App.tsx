import { useState, useEffect, useRef } from 'react'
import { X, CheckCircle2, AlertTriangle, SearchX } from 'lucide-react'
import NavRail from './components/NavRail'
import TopBar, { type Crumb } from './components/TopBar'
import CommandPalette from './components/CommandPalette'
import SearchView from './components/SearchView'
import YourWork from './components/YourWork'
import InboxView from './components/InboxView'
import SettingsView from './components/SettingsView'
import WorkItemDetail from './components/WorkItemDetail'
import Welcome from './components/Welcome'
import CreateProjectModal from './components/CreateProjectModal'
import CreateIssueModal from './components/CreateIssueModal'
import ShortcutsDialog from './components/ShortcutsDialog'
import { ProjectsView, ProjectView, TAB_LABEL } from './components/ProjectView'
import { StoreProvider, useStore, type NewIssue } from './data/store'
import { AppContext, type AppActions } from './appContext'
import { useLocation, navigate, href, type Route } from './router'
import { Empty } from './components/ui'
import ErrorBoundary from './components/ErrorBoundary'

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
  const { state } = useStore()
  const { route, peek } = useLocation()
  const [railCollapsed, setRailCollapsed]   = useState(() => window.innerWidth < 1024)
  const [paletteOpen, setPaletteOpen]       = useState(false)
  const [shortcutsOpen, setShortcutsOpen]   = useState(false)
  const [createDefaults, setCreateDefaults] = useState<Partial<NewIssue> | null>(null)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; issueId?: string; tone: 'ok' | 'warn'; n: number } | null>(null)
  const toastTimer = useRef<number>(undefined)
  const navList = useRef<string[]>([])

  const project = route.name === 'project' ? state.projects.find(p => p.key === route.key) : undefined
  const peekIssue = peek ? state.issues.find(i => i.key === peek) : undefined
  const fullIssue = route.name === 'issue' ? state.issues.find(i => i.key === route.key) : undefined
  const keyOf = (id: string) => state.issues.find(i => i.id === id)?.key

  const actions: AppActions = {
    goTo: (view, query) => navigate(href(
      view === 'search' ? { name: 'search', q: query ?? '' } : { name: view === 'home' ? 'home' : view } as Route)),
    openProject: (id, tab, sub) => {
      const p = state.projects.find(x => x.id === id)
      if (p) navigate(href({ name: 'project', key: p.key, tab, sub }))
    },
    openIssue: (id, opts) => {
      const key = keyOf(id)
      if (!key) return
      if (opts?.full || route.name === 'issue') navigate(href({ name: 'issue', key }))
      else navigate(href(route, key), { replace: !!peek })
    },
    closeIssue: () => {
      if (route.name === 'issue') history.length > 1 ? history.back() : navigate('/')
      else navigate(href(route))
    },
    createIssue: (defaults = {}) => {
      if (!state.projects.length) { setCreateProjectOpen(true); return }
      setCreateDefaults({ projectId: project?.id ?? (fullIssue ?? peekIssue)?.projectId, ...defaults })
    },
    toast: (text, opts) => {
      window.clearTimeout(toastTimer.current)
      setToast({ text, issueId: opts?.issueId, tone: opts?.tone ?? 'ok', n: Date.now() })
      toastTimer.current = window.setTimeout(() => setToast(null), 5000)
    },
    setNavList: ids => { navList.current = ids },
  }

  const modalOpen = paletteOpen || shortcutsOpen || !!createDefaults || createProjectOpen

  // Global shortcuts. A ref keeps the listener stable while seeing current values.
  const keys = useRef({ modalOpen, actions, peek, gPending: 0 })
  keys.current = { ...keys.current, modalOpen, actions, peek }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = keys.current
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(v => !v); return }
      if (e.metaKey || e.ctrlKey || e.altKey || k.modalOpen || isTyping(document.activeElement)) return
      if (e.key === 'Escape' && k.peek) { k.actions.closeIssue(); return }
      if (Date.now() - k.gPending < 1000) {
        k.gPending = 0
        const to = { h: 'home', i: 'inbox', p: 'projects', s: 'search' }[e.key] as 'home' | undefined
        if (to) { e.preventDefault(); k.actions.goTo(to) }
        return
      }
      if (e.key === 'g') { k.gPending = Date.now(); return }
      if (e.key === 'c') { e.preventDefault(); k.actions.createIssue() }
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen(true) }
      if (e.key === '/') { e.preventDefault(); setPaletteOpen(true) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Page title
  useEffect(() => {
    const parts =
      fullIssue ? [`${fullIssue.key} ${fullIssue.title}`]
      : project ? [project.name]
      : route.name === 'inbox' ? ['Inbox'] : route.name === 'search' ? ['Search'] : route.name === 'projects' ? ['Projects']
      : route.name === 'settings' ? ['Settings'] : route.name === 'home' ? ['Your work'] : []
    document.title = [...parts, state.workspaceName || 'Forge'].join(' · ')
  }, [route, fullIssue, project, state.workspaceName])

  // Unknown project tab → its default tab, keeping the URL tidy
  useEffect(() => {
    if (route.name === 'project' && project && !route.tab) {
      navigate(href({ name: 'project', key: project.key, tab: project.template === 'scrum' ? 'backlog' : 'board' }, peek), { replace: true })
    }
  }, [route, project, peek])

  if (!state.owner) return <Welcome />

  const notFound = (what: string) => (
    <Empty icon={<SearchX size={20} strokeWidth={1.5} />} title={`${what} not found`}
      body="It may have been deleted, or the link is wrong."
      action={<button className="btn btn-primary" onClick={() => actions.goTo('home')}>Go to Your work</button>} />
  )

  const crumbs: Crumb[] =
    route.name === 'project' && project ? [
      { label: 'Projects', onClick: () => actions.goTo('projects') },
      { label: project.name, onClick: () => actions.openProject(project.id) },
      ...(route.tab ? [{ label: TAB_LABEL[route.tab] }] : []),
      ...(route.sub === 'workflow' ? [{ label: 'Workflow' }] : route.sub === 'automation' ? [{ label: 'Automation' }] : []),
    ]
    : route.name === 'issue' && fullIssue ? [
      { label: 'Projects', onClick: () => actions.goTo('projects') },
      { label: state.projects.find(p => p.id === fullIssue.projectId)?.name ?? '', onClick: () => actions.openProject(fullIssue.projectId) },
      { label: fullIssue.key },
    ]
    : [{ label: { home: 'Your work', inbox: 'Inbox', search: 'Search', projects: 'Projects', settings: 'Settings' }[route.name as 'home'] ?? '' }]

  const acting = state.actingAsId ? state.me : null

  return (
    <AppContext.Provider value={actions}>
      <div className="shell">
        <NavRail
          collapsed={railCollapsed}
          onCollapseToggle={() => setRailCollapsed(v => !v)}
          onCmdK={() => setPaletteOpen(true)}
          route={route}
          onCreateProject={() => setCreateProjectOpen(true)}
        />

        <main className="main">
          {acting && (
            <div className="acting-banner" role="status">
              You are acting as <b>{acting.name}</b>. Everything you do is attributed to them.
            </div>
          )}
          <TopBar crumbs={crumbs} onCreateProject={() => setCreateProjectOpen(true)} onShortcuts={() => setShortcutsOpen(true)} />

          <div className="content">
            <ErrorBoundary resetKey={location.pathname}>
            {route.name === 'home'     && <YourWork onCreateProject={() => setCreateProjectOpen(true)} />}
            {route.name === 'inbox'    && <InboxView />}
            {route.name === 'search'   && <SearchView query={route.q} viewId={route.view} />}
            {route.name === 'projects' && <ProjectsView onCreate={() => setCreateProjectOpen(true)} />}
            {route.name === 'settings' && <SettingsView />}
            {route.name === 'project'  && (project
              ? route.tab && <ProjectView project={project} tab={route.tab} sub={route.sub} />
              : notFound('Project'))}
            {route.name === 'issue' && (fullIssue
              ? <div className="detail-page"><WorkItemDetail issueId={fullIssue.id} mode="full" navList={navList.current} /></div>
              : notFound('Work item'))}
            {route.name === 'not-found' && notFound('Page')}

            {peekIssue && route.name !== 'issue' && route.name !== 'inbox' && (
              <>
                <div className="peek-dim" onClick={actions.closeIssue} />
                <aside className="peek-panel" role="dialog" aria-label={`${peekIssue.key} ${peekIssue.title}`}>
                  <WorkItemDetail issueId={peekIssue.id} mode="peek" navList={navList.current} />
                </aside>
              </>
            )}
            </ErrorBoundary>
          </div>

          {toast && (
            <div className={`toast toast-${toast.tone}`} role="status" key={toast.n}>
              {toast.tone === 'warn'
                ? <AlertTriangle size={16} strokeWidth={2} color="#D97706" />
                : <CheckCircle2 size={16} strokeWidth={2} color="var(--brand)" />}
              <span>{toast.text}</span>
              {toast.issueId && state.issues.some(i => i.id === toast.issueId) && (
                <button className="link" onClick={() => { actions.openIssue(toast.issueId!); setToast(null) }}>View</button>
              )}
              <button className="icon-btn sm" onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} /></button>
            </div>
          )}
        </main>

        {createProjectOpen && (
          <CreateProjectModal
            onClose={() => setCreateProjectOpen(false)}
            onCreated={id => { setCreateProjectOpen(false); actions.openProject(id) }}
          />
        )}
        {createDefaults && <CreateIssueModal defaults={createDefaults} onClose={() => setCreateDefaults(null)} />}
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onCreateProject={() => setCreateProjectOpen(true)} />}
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      </div>
    </AppContext.Provider>
  )
}
