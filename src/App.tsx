import { useState, useEffect, createContext, useContext } from 'react'
import NavRail from './components/NavRail'
import TopBar from './components/TopBar'
import CommandPalette from './components/CommandPalette'
import BoardView from './components/BoardView'
import BacklogView from './components/BacklogView'
import SearchView from './components/SearchView'
import YourWork from './components/YourWork'
import InboxView from './components/InboxView'
import ReportsView from './components/ReportsView'
import WorkflowEditor from './components/WorkflowEditor'
import PeekPanel from './components/PeekPanel'
import WorkItemDetail from './components/WorkItemDetail'

// ── App-wide context ────────────────────────────────────────
interface ForgeCtx {
  aiOn: boolean
}
export const ForgeContext = createContext<ForgeCtx>({ aiOn: true })
export const useForge = () => useContext(ForgeContext)

export type AppView = 'board' | 'backlog' | 'search' | 'my-work' | 'inbox' | 'reports' | 'workflow'

export default function App() {
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [aiOn]                             = useState(true)
  const [paletteOpen,   setPaletteOpen]   = useState(false)
  const [currentView,   setCurrentView]   = useState<AppView>('my-work')

  // Work item detail state
  const [detailOpen, setDetailOpen] = useState<'none' | 'peek' | 'full'>('none')

  const openPeek = () => setDetailOpen('peek')
  const openFull = () => {
    setDetailOpen('full')
    setRailCollapsed(false)
  }
  const closeDetail = () => {
    setDetailOpen('none')
    if (currentView === 'board') setRailCollapsed(true)
  }

  const handleViewChange = (view: AppView) => {
    setCurrentView(view)
    setDetailOpen('none')
    // Search requires expanded rail; board stays collapsed
    if (view === 'search' || view === 'my-work' || view === 'inbox' || view === 'reports' || view === 'workflow') setRailCollapsed(false)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(v => !v)
      }
      if (e.key === 'Escape') {
        if (paletteOpen) { setPaletteOpen(false); return }
        if (detailOpen !== 'none') { closeDetail(); return }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [paletteOpen, detailOpen])

  return (
    <ForgeContext.Provider value={{ aiOn }}>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#FAFAF9' }}>

        <NavRail
          collapsed={railCollapsed}
          onCollapseToggle={() => setRailCollapsed(v => !v)}
          onCmdK={() => setPaletteOpen(true)}
          currentView={currentView}
          onViewChange={handleViewChange}
        />

        {/* Content column */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', minWidth: 0,
          position: 'relative',
        }}>
          <TopBar />

          {/* View routing */}
          {currentView === 'workflow' ? (
            <WorkflowEditor />
          ) : currentView === 'reports' ? (
            <ReportsView />
          ) : currentView === 'my-work' ? (
            <YourWork />
          ) : currentView === 'inbox' ? (
            <InboxView />
          ) : currentView === 'search' ? (
            <SearchView />
          ) : currentView === 'backlog' ? (
            <BacklogView />
          ) : detailOpen === 'full' ? (
            <div className="detail-page">
              <WorkItemDetail mode="full" onClose={closeDetail} />
            </div>
          ) : (
            <>
              <BoardView onCardClick={openPeek} />
              {detailOpen === 'peek' && (
                <PeekPanel onExpandFull={openFull} onClose={closeDetail} />
              )}
            </>
          )}
        </div>

        {paletteOpen && (
          <CommandPalette onClose={() => setPaletteOpen(false)} />
        )}
      </div>
    </ForgeContext.Provider>
  )
}
