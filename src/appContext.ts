import { createContext, useContext, useEffect } from 'react'
import type { Action, NewIssue } from './data/store'
import type { ProjectTab } from './router'

export type { ProjectTab }
export type AppView = 'home' | 'inbox' | 'search' | 'projects' | 'settings' | 'admin'

export interface AppActions {
  goTo:        (view: AppView, query?: string) => void
  openProject: (id: string, tab?: ProjectTab, sub?: string) => void
  /** Load a project by key (fetching it first if the app does not hold it), then open it. */
  openProjectByKey: (key: string, tab?: ProjectTab, sub?: string) => void
  /** Opens the side panel; `full` opens the full page instead. */
  openIssue:   (id: string, opts?: { full?: boolean }) => void
  /** Load an issue's full copy from the server (list rows only carry the fields their table shows). */
  loadIssue:   (id: string) => void
  closeIssue:  () => void
  createIssue: (defaults?: Partial<NewIssue>) => void
  /** `undo`: the action this toast reports; an Undo button shows while that change is still the latest. */
  toast:       (text: string, opts?: { issueId?: string; tone?: 'ok' | 'warn'; undo?: Action['type'] }) => void
  /** Move a work item to a status the way the workflow says: straight away, or through its transition screen when the
   *  move asks for input or isn't ready. A move the workflow doesn't offer this person is refused with a message. */
  moveIssue:   (issueId: string, statusId: string) => void
  /** Make one transition by id (loops, from the Actions menu). */
  runTransition: (issueId: string, transitionId: string) => void
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
