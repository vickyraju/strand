import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { migrate, EMPTY, AUTOMATION, type Action, type State, type User } from './reducer'
import { undoableReducer, canUndo, type StoreAction, type Undoable } from './history'
import { pruneFiles } from './files'

export * from './reducer'

const STORAGE_KEY = 'forge:v1'

/** State plus the people the UI needs everywhere: who is acting, and who owns the workspace. */
export type View = State & { me: User | null; owner: User | null }

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? migrate(JSON.parse(raw)) : EMPTY
  } catch {
    return EMPTY
  }
}

const StoreContext = createContext<{ state: View; dispatch: (a: StoreAction) => void; undoType: Action['type'] | null } | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store, dispatch] = useReducer(undoableReducer, undefined, (): Undoable => ({ state: load() }))
  const state = store.state

  // Remove attachment files nothing points to. Only at startup, so an undone removal still has its file.
  // ponytail: orphans from this session linger until the next load; fine for a local store
  const pruned = useRef(false)
  useEffect(() => {
    if (pruned.current) return
    pruned.current = true
    pruneFiles(new Set(state.issues.flatMap(i => i.attachments.map(a => a.id))))
  }, [state])

  // Save shortly after changes settle (large workspaces take a moment to serialize), and always on leaving
  const latest = useRef(state)
  const saved = useRef(state)
  latest.current = state
  useEffect(() => {
    const save = () => {
      if (saved.current === latest.current) return
      localStorage.setItem(STORAGE_KEY, JSON.stringify(latest.current))
      saved.current = latest.current
    }
    const t = window.setTimeout(save, 250)
    window.addEventListener('pagehide', save)
    return () => { window.clearTimeout(t); window.removeEventListener('pagehide', save) }
  }, [state])

  // Due-date reminders are created when the app opens
  useEffect(() => { dispatch({ type: 'checkDue', now: Date.now() }) }, [])

  const value = useMemo(() => {
    const owner = state.users.find(u => u.id === state.ownerId) ?? null
    const me = state.users.find(u => u.id === state.actingAsId) ?? owner
    return { state: { ...state, me, owner }, dispatch, undoType: canUndo(store) ? store.undo!.type : null }
  }, [store]) // eslint-disable-line react-hooks/exhaustive-deps

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}

export const projectOf = (state: State, id: string | undefined) => state.projects.find(p => p.id === id)
/** The pseudo-user shown for changes made by automation rules. */
export const AUTOMATION_USER: User = { id: AUTOMATION, name: 'Automation', initials: 'AU', color: '#57534E' }
export const userOf = (state: State, id: string | undefined) =>
  id === AUTOMATION ? AUTOMATION_USER : state.users.find(u => u.id === id)
