import { createContext, useContext, useEffect } from 'react'
import type { NewIssue } from './data/store'
import type { ProjectTab } from './router'

export type { ProjectTab }
export type AppView = 'home' | 'inbox' | 'search' | 'projects' | 'settings' | 'dashboards'

export interface AppActions {
  goTo:        (view: AppView, query?: string) => void
  openProject: (id: string, tab?: ProjectTab, sub?: string) => void
  /** Opens the side panel; `full` opens the full page instead. */
  openIssue:   (id: string, opts?: { full?: boolean }) => void
  closeIssue:  () => void
  createIssue: (defaults?: Partial<NewIssue>) => void
  toast:       (text: string, opts?: { issueId?: string; tone?: 'ok' | 'warn' }) => void
  /** The list the user is looking at, for previous/next in the detail view. */
  setNavList:  (ids: string[]) => void
}

export const AppContext = createContext<AppActions | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppContext')
  return ctx
}

/** Register the visible order of work items so the detail view can step through them. */
export function useNavList(ids: string[]) {
  const { setNavList } = useApp()
  const key = ids.join(',')
  useEffect(() => { setNavList(ids) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
