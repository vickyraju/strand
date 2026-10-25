import { api } from './client'
import { mapWorkspace, mapIssue, mapProject, mapSprint } from './map'
import { sprintSync } from './sprints'
import { adoptProject, loadSettingsBase } from './settings'
import { keysToLoad, readRecent } from './recent'
import { loadPersonalBase } from './personal'
import type { Issue, LinkType, Sprint, State } from '../data/reducer'

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!) }
  }))
  return out
}

/** One project in full (workflow, fields, releases, templates, rules, sprints), ready for the store. */
export async function fetchProject(key: string) {
  const detail = await api<any>('GET', `/api/projects/${encodeURIComponent(key)}`)
  return { project: mapProject(detail), sprints: (detail.sprints ?? []).map(mapSprint) as Sprint[] }
}

/** A project opened by link or from search. Its settings and sprints become the sync base, so they are not sent back. */
export async function loadProjectByKey(key: string) {
  const { project, sprints } = await fetchProject(key)
  adoptProject(project)
  sprintSync.load(sprints, s => s.projectId === project.id)
  return { project, sprints }
}

/** Loads who you are, the people, and the projects you are likely to use: starred ones, recently opened ones, and any
 *  already on screen (`keep`). Every other project is fetched when opened, or found with the project search.
 *  ponytail: users still load as one list (first 1000 by name). At tens of thousands of users the pickers need to search. */
let signedIn = false
export async function loadWorkspace(keep: string[] = []): Promise<State> {
  // once per app start: the server puts me back in the default group (and system-administrators, with Entra's admin role)
  if (!signedIn) { signedIn = true; await api('POST', '/api/me/sign-in').catch(() => {}) }
  const [me, users, starredPage, views, notifications, linkTypes] = await Promise.all([
    api<any>('GET', '/api/me'),
    api<any[]>('GET', '/api/users'),
    api<{ items: any[] }>('GET', '/api/projects/search?starred=1&limit=100'),
    api<any[]>('GET', '/api/views'),
    api<any[]>('GET', '/api/notifications'),
    api<LinkType[]>('GET', '/api/link-types').catch(() => undefined),
  ])
  let keys = keysToLoad(starredPage.items.map(p => p.key), readRecent(), keep)
  // Nothing starred or opened yet (a new teammate, a new browser): start from where work is happening, not from an empty app
  if (!keys.length) keys = (await api<{ key: string }[]>('GET', '/api/me/projects/recent').catch(() => [])).map(p => p.key)
  const loaded = await mapLimit(keys, 6, async k => { try { return await fetchProject(k) } catch { return null } })   // a project that is gone or hidden is skipped
  const ok = loaded.filter((x): x is NonNullable<typeof x> => !!x)
  const state = mapWorkspace(me, users, [], starredPage.items.map(p => p.id), { views, notifications })
  state.projects = ok.map(x => x.project)
  if (linkTypes) state.linkTypes = linkTypes.map(({ id, name, outward, inward, builtin }) => ({ id, name, outward, inward, builtin }))
  state.sprints = ok.flatMap(x => x.sprints)
  sprintSync.load(state.sprints)   // the server's data is the base, so none of it is sent back
  loadSettingsBase(state.projects, state.starred)
  loadPersonalBase(state, me.id)
  return state
}

const PAGE = 500
const CAP = 5000   // ponytail: a project beyond this shows its first CAP items by rank; add "load more" when one gets there

/** All of a project's issues, in backlog order, following the server's cursor. */
export type LoadedIssue = Issue & { version?: number }

export async function loadProjectIssues(key: string): Promise<LoadedIssue[]> {
  const out: LoadedIssue[] = []
  let cursor: string | null = null
  do {
    const qs: string = `limit=${PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const page: { items: any[]; next: string | null } = await api('GET', `/api/projects/${encodeURIComponent(key)}/issues?${qs}`)
    out.push(...page.items.map(i => ({ ...mapIssue(i), version: i.version })))
    cursor = page.next
  } while (cursor && out.length < CAP)
  return out
}
