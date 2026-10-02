import { createContext, useContext } from 'react'
import type { NewIssue } from './data/store'

export type ProjectTab = 'board' | 'list' | 'backlog' | 'settings'
export type AppView    = 'my-work' | 'projects' | 'project' | 'search' | 'settings'

export interface AppActions {
  goTo:        (view: AppView) => void
  openIssue:   (id: string) => void
  openProject: (id: string, tab?: ProjectTab) => void
  createIssue: (defaults?: Partial<NewIssue>) => void
  toast:       (text: string, issueId?: string) => void
}

export const AppContext = createContext<AppActions | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppContext')
  return ctx
}
