import { useEffect, useState } from 'react'
import { apiEnabled } from './client'
import { loadProjectByKey } from './load'
import { useStore } from '../data/store'

export type OnDemand = 'ready' | 'loading' | 'missing'

/** With an API, fetches a project the first time it is needed (opened by link, search result or ?peek=) if it is not loaded yet.
 *  `missing` = the server does not know it (or you cannot see it). Without an API every project is already local. */
export function useProjectOnDemand(key: string | undefined): OnDemand {
  const { state, dispatch } = useStore()
  const present = !!key && state.projects.some(p => p.key === key)
  const [missing, setMissing] = useState<string | null>(null)

  useEffect(() => {
    if (!apiEnabled || !key || present || missing === key) return
    let cancelled = false
    loadProjectByKey(key).then(
      ({ project, sprints }) => { if (!cancelled) dispatch({ type: 'loadProject', project, sprints }) },
      () => { if (!cancelled) setMissing(key) },
    )
    return () => { cancelled = true }
  }, [key, present]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!apiEnabled || !key || present) return 'ready'
  return missing === key ? 'missing' : 'loading'
}
