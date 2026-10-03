import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { reducer, migrate, EMPTY, AUTOMATION, type Action, type State, type User } from './reducer'
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

const StoreContext = createContext<{ state: View; dispatch: (a: Action) => void } | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer((s: State, a: Action) => reducer(s, a), undefined, load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    pruneFiles(new Set(state.issues.flatMap(i => i.attachments.map(a => a.id))))
  }, [state])

  // Due-date reminders are created when the app opens
  useEffect(() => { dispatch({ type: 'checkDue', now: Date.now() }) }, [])

  const value = useMemo(() => {
    const owner = state.users.find(u => u.id === state.ownerId) ?? null
    const me = state.users.find(u => u.id === state.actingAsId) ?? owner
    return { state: { ...state, me, owner }, dispatch }
  }, [state])

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
