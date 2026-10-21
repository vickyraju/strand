// Live edit presence (Jira/monday.com style, soft): while you have an issue open for editing, the server
// knows, and it tells the people in the same project. No hard lock — everyone can still edit; they just
// see who else is here ("Maya is editing").
//
// Transport: the project's SSE stream (GET /api/projects/:key/events). One shared stream per project;
// every client of that project receives `issue.editing` / `issue.updated` payloads with the editors list.
// A heartbeat (POST /issues/:key/presence) every 30 s keeps your row alive; the server prunes anything
// older than 90 s, so a closed tab disappears on its own. The explicit DELETE clears it immediately.
import { useEffect, useRef } from 'react'
import { api, apiEnabled, buildRequest, getLogin, API_URL } from './client'
import { useStore } from '../data/store'
import type { Editor, Issue } from '../data/reducer'

// —— The project event stream (one shared EventSource per project) ——

const streams = new Map<string, EventSource>()
const subs = new Map<string, number>()   // projectId → how many live subscribers

interface StreamEvent { type: string; key?: string; id?: string; editors?: Editor[] }

/** Open the project's stream once (auth headers come from the shared dev login). */
function openStream(projectId: string, key: string): EventSource {
  const existing = streams.get(projectId)
  if (existing) return existing
  const [url, init] = buildRequest(API_URL!, getLogin(), 'GET', `/api/projects/${encodeURIComponent(key)}/events`)
  const es = new EventSource(url, init as EventSourceInit)
  streams.set(projectId, es)
  return es
}

function closeStream(projectId: string) {
  const es = streams.get(projectId)
  if (es) { es.close(); streams.delete(projectId) }
}

/** Subscribe to one project's stream; dispatches `setEditors` for any event that carries an editors list.
 *  The stream is shared; it closes only when the last subscriber leaves. */
export function useProjectEvents(projectId: string | undefined, projectKey: string | undefined, enabled: boolean) {
  const { state, dispatch } = useStore()
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!apiEnabled || !projectId || !projectKey || !enabled) return
    let stopped = false
    const es = openStream(projectId, projectKey)
    const onMessage = (e: MessageEvent) => {
      if (stopped) return
      let data: StreamEvent
      try { data = JSON.parse(e.data) } catch { return }
      if (data.editors && data.key) {
        // resolve the key ("PAY-12") to the local issue id; skip keys we don't have loaded
        const issue = stateRef.current.issues.find(i => i.key === data.key)
        if (!issue) return
        dispatch({ type: 'setEditors', issueId: issue.id, editors: data.editors })
      }
    }
    es.addEventListener('message', onMessage)
    const count = (subs.get(projectId) ?? 0) + 1
    subs.set(projectId, count)
    return () => {
      stopped = true
      es.removeEventListener('message', onMessage)
      const left = (subs.get(projectId) ?? 1) - 1
      subs.set(projectId, left)
      if (left <= 0) { subs.delete(projectId); closeStream(projectId) }
    }
  }, [projectId, projectKey, enabled, dispatch]) // eslint-disable-line react-hooks/exhaustive-deps
}


// —— The heartbeat: tells the server I'm editing this issue; prunes when I'm not ——

/** While the panel is open (`active`), send a presence heartbeat for this issue every 30 s and clear
 *  it on unmount. `active` is "the detail panel for this issue is visible". */
export function usePresence(issue: Issue | undefined, active: boolean) {
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!apiEnabled || !issue || !active) return
    const key = issue.key
    const beat = () => { api('POST', `/api/issues/${encodeURIComponent(key)}/presence`).catch(() => {}) }
    beat()
    timer.current = window.setInterval(beat, 30_000)
    return () => {
      if (timer.current) { window.clearInterval(timer.current); timer.current = undefined }
      api('DELETE', `/api/issues/${encodeURIComponent(key)}/presence`).catch(() => {})
    }
  }, [apiEnabled, issue?.id, active]) // eslint-disable-line react-hooks/exhaustive-deps
}
