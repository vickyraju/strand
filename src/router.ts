import { useSyncExternalStore } from 'react'

export type ProjectTab = 'summary' | 'board' | 'backlog' | 'list' | 'timeline' | 'calendar' | 'reports' | 'settings'

export type Route =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'search'; q: string }
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'project'; key: string; tab?: ProjectTab; sub?: string }
  | { name: 'issue'; key: string }
  | { name: 'not-found' }

const TABS: ProjectTab[] = ['summary', 'board', 'backlog', 'list', 'timeline', 'calendar', 'reports', 'settings']

export function parse(pathname: string, search: string): { route: Route; peek?: string } {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const params = new URLSearchParams(search)
  const peek = params.get('peek') ?? undefined
  const [a, b, c, d] = parts
  let route: Route = { name: 'not-found' }

  if (!a)                         route = { name: 'home' }
  else if (a === 'inbox')         route = { name: 'inbox' }
  else if (a === 'search')        route = { name: 'search', q: params.get('q') ?? '' }
  else if (a === 'projects' && !b) route = { name: 'projects' }
  else if (a === 'settings')      route = { name: 'settings' }
  else if (a === 'i' && b)        route = { name: 'issue', key: b.toUpperCase() }
  else if (a === 'p' && b && (!c || (TABS as string[]).includes(c)))
    route = { name: 'project', key: b.toUpperCase(), tab: c as ProjectTab | undefined, sub: d }
  return { route, peek }
}

export function href(route: Route, peek?: string): string {
  const q = peek ? `?peek=${encodeURIComponent(peek)}` : ''
  switch (route.name) {
    case 'home':      return `/${q}`
    case 'inbox':     return `/inbox${q}`
    case 'search':    return `/search${route.q ? `?q=${encodeURIComponent(route.q)}` : ''}${peek ? `${route.q ? '&' : '?'}peek=${encodeURIComponent(peek)}` : ''}`
    case 'projects':  return `/projects${q}`
    case 'settings':  return `/settings${q}`
    case 'issue':     return `/i/${route.key}`
    case 'project':   return `/p/${route.key}${route.tab ? `/${route.tab}` : ''}${route.sub ? `/${route.sub}` : ''}${q}`
    case 'not-found': return '/'
  }
}

// ── History plumbing ───────────────────────────────────────

const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
window.addEventListener('popstate', emit)

export function navigate(to: string, { replace = false } = {}) {
  if (to === location.pathname + location.search) return
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => location.pathname + location.search

export function useLocation() {
  const loc = useSyncExternalStore(subscribe, snapshot)
  const i = loc.indexOf('?')
  return parse(i < 0 ? loc : loc.slice(0, i), i < 0 ? '' : loc.slice(i))
}
