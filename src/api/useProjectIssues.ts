import { useEffect, useState } from 'react'
import { apiEnabled } from './client'
import { loadProjectIssues } from './load'
import { useStore } from '../data/store'

export type IssuesStatus = 'ready' | 'loading' | 'error'

/** With an API, loads a project's issues the first time it is opened. Without one, issues are already local. */
export function useProjectIssues(project: { id: string; key: string } | undefined): { status: IssuesStatus; retry: () => void } {
  const { dispatch } = useStore()
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set())
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const id = project?.id, key = project?.key

  useEffect(() => {
    if (!apiEnabled || !id || !key || loaded.has(id)) return
    let cancelled = false
    setFailed(null)
    loadProjectIssues(key).then(
      issues => { if (!cancelled) { dispatch({ type: 'loadIssues', projectId: id, issues }); setLoaded(s => new Set(s).add(id)) } },
      () => { if (!cancelled) setFailed(id) },
    )
    return () => { cancelled = true }
  }, [id, key, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!apiEnabled || !id) return { status: 'ready', retry: () => {} }
  return { status: loaded.has(id) ? 'ready' : failed === id ? 'error' : 'loading', retry: () => setAttempt(a => a + 1) }
}
