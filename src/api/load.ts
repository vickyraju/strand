import { api } from './client'
import { mapWorkspace, mapIssue } from './map'
import type { Issue, State } from '../data/reducer'

/** Loads who you are, the people and the projects (with workflow, sprints, fields…) from the API.
 *  ponytail: fetches every project's detail up front, which is fine for a dev workspace. Slice 3 loads a
 *  project's detail when it is opened and keeps only the list here, which is what 50k projects needs. */
export async function loadWorkspace(): Promise<State> {
  const [me, users, list] = await Promise.all([
    api<any>('GET', '/api/me'),
    api<any[]>('GET', '/api/users'),
    api<any[]>('GET', '/api/projects'),
  ])
  const details = await Promise.all(list.map(p => api<any>('GET', `/api/projects/${encodeURIComponent(p.key)}`)))
  return mapWorkspace(me, users, details, list.filter(p => p.starred).map(p => p.id))
}

const PAGE = 500
const CAP = 5000   // ponytail: a project beyond this shows its first CAP items by rank; add "load more" when one gets there

/** All of a project's issues, in backlog order, following the server's cursor. */
export async function loadProjectIssues(key: string): Promise<Issue[]> {
  const out: Issue[] = []
  let cursor: string | null = null
  do {
    const qs: string = `limit=${PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const page: { items: any[]; next: string | null } = await api('GET', `/api/projects/${encodeURIComponent(key)}/issues?${qs}`)
    out.push(...page.items.map(mapIssue))
    cursor = page.next
  } while (cursor && out.length < CAP)
  return out
}
