import { useEffect, useRef } from 'react'
import { api, apiEnabled } from './client'
import { issueSync } from './sync'
import { commentDeps, commentSync, fetchIssueDetail } from './comments'
import { sprintDeps, sprintSync } from './sprints'
import { loadProjectIssues, loadWorkspace } from './load'
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

  // Comments: tell the sync how to reach the app, then send changes (issues first, so an issue exists before its comment)
  useEffect(() => {
    if (!apiEnabled) return
    commentDeps.getIssues = () => latest.current.issues
    commentDeps.onError = m => toastRef.current(`Couldn't save that change: ${m}. Showing what the server has.`, { tone: 'warn' })
    commentDeps.reloadDetail = async id => {
      const issue = latest.current.issues.find(i => i.id === id)
      if (!issue) return
      const d = await fetchIssueDetail(issue)
      commentSync.load(d.comments, c => c.issueId === id)
      dispatch({ type: 'loadIssueDetail', ...d })
    }
  }, [dispatch])

  // Sprints: sent before issues, so a sprint exists before an issue is put in it
  useEffect(() => {
    if (!apiEnabled) return
    sprintDeps.getIssues = () => latest.current.issues
    sprintDeps.projectKey = id => latest.current.projects.find(p => p.id === id)?.key
    sprintDeps.applySprint = sprint => dispatch({ type: 'syncSprint', sprint })
    sprintDeps.onError = m => toastRef.current(`Couldn't save that change: ${m}. Showing what the server has.`, { tone: 'warn' })
    sprintDeps.reloadProject = async projectId => {
      const key = latest.current.projects.find(p => p.id === projectId)?.key
      if (!key) return
      const loaded = await loadProjectIssues(key)
      issueSync.load(projectId, loaded)
      dispatch({ type: 'loadIssues', projectId, issues: loaded.map(({ version, ...i }: any) => i) })
    }
    sprintDeps.reloadAll = async () => {
      const fresh = await loadWorkspace()            // also resets the sprint base
      dispatch({ type: 'replace', state: { ...latest.current, sprints: fresh.sprints } })
    }
  }, [dispatch])
  useEffect(() => { if (apiEnabled) sprintSync.flush(state.sprints) }, [state.sprints])

  useEffect(() => { if (apiEnabled) issueSync.flush() }, [state.issues])
  useEffect(() => { if (apiEnabled) commentSync.flush(state.comments) }, [state.comments])
}
