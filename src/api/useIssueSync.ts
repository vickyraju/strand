import { useEffect, useRef } from 'react'
import { api, apiEnabled } from './client'
import { issueSync } from './sync'
import { commentDeps, commentSync, detailLoaded, fetchIssueDetail } from './comments'
import { adoptDetail, linkItems, linkSync, watchItems, watchSync, worklogItems, worklogSync } from './detail'
import { sprintDeps, sprintSync } from './sprints'
import { loadProjectIssues, loadWorkspace } from './load'
import { KINDS, kindSyncs, itemsOf, projectSync, sendDetails, settingsDeps, starSync } from './settings'
import { isDone } from '../data/reducer'
import { dashboardSync, notificationSync, personalDeps, refreshNotifications, viewSync } from './personal'
import { useStore } from '../data/store'

type Toast = (text: string, opts?: { tone?: 'ok' | 'warn' }) => void

/** With an API configured, sends local issue changes to it (see sync.ts). A no-op otherwise. */
export function useIssueSync(toast: Toast) {
  const { state, dispatch } = useStore()
  const latest = useRef(state)
  latest.current = state
  const projectDeleteTimer = useRef<number>(undefined)
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    if (!apiEnabled) return
    issueSync.configure({
      call: api,
      getIssues: () => latest.current.issues,
      projectKey: id => latest.current.projects.find(p => p.id === id)?.key,
      statusExists: (projectId, statusId) => !!latest.current.projects.find(p => p.id === projectId)?.statuses.some(s => s.id === statusId),
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
      adoptDetail(d, latest.current.ownerId)
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
    // After a failed request: take projects, sprints and stars from the server (this also resets every sync's base)
    sprintDeps.reloadAll = async () => {
      const fresh = await loadWorkspace(latest.current.projects.map(p => p.key))   // keep what is on screen, not only starred and recent
      dispatch({ type: 'replace', state: { ...latest.current, projects: fresh.projects, sprints: fresh.sprints, starred: fresh.starred,
        views: fresh.views, dashboards: fresh.dashboards, notifications: fresh.notifications } })
    }
  }, [dispatch])

  // Personal: views, dashboards, notifications (read/archive), plus a periodic refresh of new notifications
  useEffect(() => {
    if (!apiEnabled) return
    personalDeps.meId = () => latest.current.ownerId
    personalDeps.reloadAll = sprintDeps.reloadAll
    personalDeps.setNotifications = notifications => dispatch({ type: 'setNotifications', notifications })
    personalDeps.onError = m => toastRef.current(`Couldn't save that change: ${m}. Showing what the server has.`, { tone: 'warn' })
    const tick = () => { if (!document.hidden) refreshNotifications().catch(() => {}) }
    const t = window.setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [dispatch])
  useEffect(() => { if (apiEnabled) viewSync.flush(state.views.filter(v => v.ownerId === state.ownerId)) }, [state.views])
  useEffect(() => { if (apiEnabled) dashboardSync.flush(state.dashboards.filter(d => d.ownerId === state.ownerId)) }, [state.dashboards])
  useEffect(() => { if (apiEnabled) notificationSync.flush(state.notifications.filter(n => n.userId === state.ownerId)) }, [state.notifications])

  // Project settings: workflow, fields, templates, rules, releases, stars, details, delete
  useEffect(() => {
    if (!apiEnabled) return
    settingsDeps.getProjects = () => latest.current.projects
    settingsDeps.getIssues = () => latest.current.issues
    settingsDeps.baseIssues = () => issueSync.baseList()
    settingsDeps.isUnfinished = issue => {
      const project = latest.current.projects.find(p => p.id === issue.projectId)
      return !project || !isDone(project, issue)
    }
    settingsDeps.onError = m => toastRef.current(`Couldn't save that change: ${m}. Showing what the server has.`, { tone: 'warn' })
    settingsDeps.reloadProject = sprintDeps.reloadProject
    settingsDeps.reloadAll = sprintDeps.reloadAll
  }, [dispatch])
  // creates and edits first (a status must exist before an issue moves into it) …
  useEffect(() => {
    if (!apiEnabled) return
    for (const k of KINDS) kindSyncs[k].flush(itemsOf(state.projects, k), 'writes')
    sendDetails(state.projects)
  }, [state.projects])
  useEffect(() => { if (apiEnabled) starSync.flush(state.starred.map(id => ({ id }))) }, [state.starred])
  useEffect(() => { if (apiEnabled) sprintSync.flush(state.sprints) }, [state.sprints])

  useEffect(() => { if (apiEnabled) issueSync.flush() }, [state.issues])
  useEffect(() => { if (apiEnabled) commentSync.flush(state.comments) }, [state.comments])
  // Time logs, links and watching: only for issues whose detail is known (an issue made here has no server detail to wait for)
  useEffect(() => {
    if (!apiEnabled) return
    for (const i of state.issues) if (issueSync.createdHere(i.id)) detailLoaded.add(i.id)
    worklogSync.flush(worklogItems(state.issues, detailLoaded))
    linkSync.flush(linkItems(state.issues, detailLoaded))
    watchSync.flush(watchItems(state.issues, detailLoaded, state.ownerId))
  }, [state.issues])
  // … and removals last (a status can only be deleted once its issues have been moved off it)
  useEffect(() => {
    if (!apiEnabled) return
    for (const k of [...KINDS].reverse()) kindSyncs[k].flush(itemsOf(state.projects, k), 'deletes')
    // A deleted project is removed on the server only after the Undo window (the toast offers Undo for 8 s)
    window.clearTimeout(projectDeleteTimer.current)
    projectDeleteTimer.current = window.setTimeout(
      () => projectSync.flush(latest.current.projects.map(p => ({ id: p.id, key: p.key, body: {} }))), 9000)
  }, [state.projects])
}
