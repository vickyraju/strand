import { useSyncExternalStore } from 'react'

export type ProjectTab = 'summary' | 'board' | 'backlog' | 'list' | 'timeline' | 'calendar' | 'releases' | 'reports' | 'tests' | 'settings'

export type AdminSection = 'people' | 'groups' | 'license' | 'audit' | 'backups' | 'settings' | 'link-types' | 'views'
const ADMIN: AdminSection[] = ['people', 'groups', 'license', 'audit', 'backups', 'settings', 'link-types', 'views']

export type Route =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'search'; q: string; view?: string }
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'admin'; section?: AdminSection }
  | { name: 'project'; key: string; tab?: ProjectTab; sub?: string }
  | { name: 'issue'; key: string }
  | { name: 'not-found' }

const TABS: ProjectTab[] = ['summary', 'board', 'backlog', 'list', 'timeline', 'calendar', 'releases', 'reports', 'tests', 'settings']

export function parse(pathname: string, search: string): { route: Route; peek?: string } {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const params = new URLSearchParams(search)
  const peek = params.get('peek') ?? undefined
  const [a, b, c, d] = parts
  let route: Route = { name: 'not-found' }

  if (!a)                         route = { name: 'home' }
  else if (a === 'inbox')         route = { name: 'inbox' }
  else if (a === 'search')        route = { name: 'search', q: params.get('q') ?? '', view: params.get('view') ?? undefined }
  else if (a === 'dashboards')    route = { name: 'home' }   // old bookmarks: the Dashboards page is gone, a project's Summary replaces it
  else if (a === 'projects' && !b) route = { name: 'projects' }
  else if (a === 'settings')      route = { name: 'settings' }
  else if (a === 'groups')        route = { name: 'admin', section: 'groups' }   // old address: groups live in Administration / Configuration
  else if (a === 'admin' && (!b || (ADMIN as string[]).includes(b))) route = { name: 'admin', section: b as AdminSection | undefined }
  else if (a === 'i' && b)        route = { name: 'issue', key: b.toUpperCase() }
  else if ((a === 'project' || a === 'p') && b &&(!c || (TABS as string[]).includes(c)))
    route = { name: 'project', key: b.toUpperCase(), tab: c as ProjectTab | undefined, sub: d }
  return { route, peek }
}

export function href(route: Route, peek?: string): string {
  const q = peek ? `?peek=${encodeURIComponent(peek)}` : ''
  switch (route.name) {
    case 'home':      return `/${q}`
    case 'inbox':     return `/inbox${q}`
    case 'search': {
      const qs = new URLSearchParams()
      if (route.view) qs.set('view', route.view)
      if (route.q) qs.set('q', route.q)
      if (peek) qs.set('peek', peek)
      const str = qs.toString()
      return `/search${str ? `?${str}` : ''}`
    }
    case 'projects':  return `/projects${q}`
    case 'settings':  return `/settings${q}`
    case 'admin':     return `/admin${route.section ? `/${route.section}` : ''}`
    case 'issue':     return `/i/${route.key}`
    case 'project':   return `/project/${route.key}${route.tab ? `/${route.tab}` : ''}${route.sub ? `/${route.sub}` : ''}${q}`
    case 'not-found': return '/'
  }
}

// ── History plumbing ───────────────────────────────────────

// Legacy /p/KEY links → canonical /project/KEY (before first render)
if (location.pathname.startsWith('/p/')) history.replaceState(null, '', '/project' + location.pathname.slice(2) + location.search)

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
