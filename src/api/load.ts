import { api } from './client'
import { mapWorkspace } from './map'
import type { State } from '../data/reducer'

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
