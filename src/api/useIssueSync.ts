import { useEffect, useRef } from 'react'
import { api, apiEnabled } from './client'
import { loadProjectIssues } from './load'
import { issueSync } from './sync'
import { useStore } from '../data/store'

type Toast = (text: string, opts?: { tone?: 'ok' | 'warn' }) => void

/** With an API configured, sends local issue changes to it (see sync.ts). A no-op otherwise. */
export function useIssueSync(toast: Toast) {
  const { state, dispatch } = useStore()
  const latest = useRef(state)
  latest.current = state
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    if (!apiEnabled) return
    issueSync.configure({
      call: api,
      getIssues: () => latest.current.issues,
      projectKey: id => latest.current.projects.find(p => p.id === id)?.key,
      applyServerIssue: issue => dispatch({ type: 'syncIssue', issue }),
      applyProjectIssues: (projectId, issues) =>
        dispatch({ type: 'loadIssues', projectId, issues: issues.map(({ version, ...i }: any) => i) }),
      loadProjectIssues,
      onError: m => toastRef.current(`Couldn't save that change: ${m}. Showing what the server has.`, { tone: 'warn' }),
    })
  }, [dispatch])

  useEffect(() => { if (apiEnabled) issueSync.flush() }, [state.issues])
}
