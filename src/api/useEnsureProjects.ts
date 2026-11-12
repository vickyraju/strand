import { useEffect } from 'react'
import { apiEnabled } from './client'
import { loadProjectByKey } from './load'
import { useStore } from '../data/store'

const asked = new Set<string>()   // keys already requested this session, so a failing one is not retried on every render

/** Work item lists (Your work, search results) come from the server and can belong to projects that are not loaded yet.
 *  Without the project, a row has no workflow, so its status shows blank. This loads each missing project's definition
 *  (not its work items), in a few at a time. `keys` are project keys. */
export function useEnsureProjects(keys: string[]) {
  const { state, dispatch } = useStore()
  const missing = [...new Set(keys.map(k => k.toUpperCase()))].filter(k => !state.projects.some(p => p.key === k) && !asked.has(k))
  const signature = missing.join(',')
  useEffect(() => {
    if (!apiEnabled || !missing.length) return
    for (const k of missing.slice(0, 6)) {
      asked.add(k)
      loadProjectByKey(k).then(({ project, sprints }) => dispatch({ type: 'loadProject', project, sprints }), () => { /* not visible to this person: leave the stub */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
}

export const projectKeyOf = (issueKey: string) => issueKey.split('-')[0]!
