// Live edit presence (Jira/monday.com style, soft): while you have an issue open for editing, the server
// knows, and it tells the people in the same project. No hard lock — everyone can still edit; they just
// see who else is here ("Maya is editing").
//
// Transport: the project's SSE stream (GET /api/projects/:key/events), read with fetch so the bearer token goes along. One shared stream per project;
// every client of that project receives `issue.editing` / `issue.updated` payloads with the editors list.
// A heartbeat (POST /issues/:key/presence) every 30 s keeps your row alive; the server prunes anything
// older than 90 s, so a closed tab disappears on its own. The explicit DELETE clears it immediately.
import { useEffect, useRef } from 'react'
import { api, apiEnabled, buildRequest, API_URL } from './client'
import { accessToken } from './auth.ts'
import { useStore } from '../data/store'
import { loadProjectIssues } from './load'
import { issueSync } from './sync'
import type { Editor, Issue } from '../data/reducer'

// —— The project event stream (one shared fetch-based SSE reader per project) ——
// EventSource cannot send an Authorization header, so the stream is read with fetch and parsed by hand.

interface StreamEvent { type: string; key?: string; id?: string; editors?: Editor[] }
interface Stream { abort: AbortController; handlers: Set<(e: StreamEvent) => void> }
const streams = new Map<string, Stream>()

/** Read the stream until aborted, reconnecting with a growing pause (1 s … 30 s) after any failure. */
async function run(key: string, s: Stream) {
  let wait = 1000, connected = false
  while (!s.abort.signal.aborted) {
    try {
      const [url, init] = buildRequest(API_URL!, await accessToken(), 'GET', `/api/projects/${encodeURIComponent(key)}/events`, undefined, { accept: 'text/event-stream' })
      const res = await fetch(url, { ...init, signal: s.abort.signal })
      if (res.status === 403 || res.status === 404) return   // no access (any more): retrying cannot help
      if (!res.ok || !res.body) throw new Error(String(res.status))
      wait = 1000
      // after a drop, events may have been missed: tell the handlers to catch up
      if (connected) s.handlers.forEach(h => h({ type: 'stream.resumed' }))
      connected = true
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
          buf = buf.slice(i + 2)
          if (!data) continue
          let ev: StreamEvent
          try { ev = JSON.parse(data) } catch { continue }
          s.handlers.forEach(h => h(ev))
        }
      }
    } catch { /* aborted or dropped: fall through to reconnect */ }
    if (s.abort.signal.aborted) return
    await new Promise(r => setTimeout(r, wait))
    wait = Math.min(wait * 2, 30_000)
  }
}

/** Subscribe to one project's stream; the stream is shared and stops when the last subscriber leaves. */
function subscribe(projectId: string, key: string, handler: (e: StreamEvent) => void): () => void {
  let s = streams.get(projectId)
  if (!s) { s = { abort: new AbortController(), handlers: new Set() }; streams.set(projectId, s); void run(key, s) }
  s.handlers.add(handler)
  return () => {
    s.handlers.delete(handler)
    if (!s.handlers.size) { s.abort.abort(); streams.delete(projectId) }
  }
}

/** Events after which the project's items on screen may be out of date. */
const CHANGED = new Set(['issue.created', 'issue.updated', 'issue.deleted', 'issues.reranked', 'stream.resumed'])

/** Dispatches `setEditors` for any event that carries an editors list. With `reloadOnChange` (the open project page),
 *  also reloads the project's items shortly after anyone changes them, so everyone sees the same board. Several changes in a burst cause one reload.
 *  ponytail: reloads the whole project (up to the load cap); fetch only the changed item when projects get large. */
export function useProjectEvents(projectId: string | undefined, projectKey: string | undefined, enabled: boolean, reloadOnChange = false) {
  const { state, dispatch } = useStore()
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!apiEnabled || !projectId || !projectKey || !enabled) return
    let timer: number | undefined
    const reload = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        loadProjectIssues(projectKey).then(loaded => {
          issueSync.load(projectId, loaded)     // the server's copy becomes the base, so it is not sent back
          dispatch({ type: 'loadIssues', projectId, issues: loaded.map(({ version, ...i }: any) => i) })
        }, () => { /* offline: the next event or reconnect tries again */ })
      }, 800)
    }
    const unsubscribe = subscribe(projectId, projectKey, data => {
      if (reloadOnChange && CHANGED.has(data.type)) reload()
      if (!data.editors || !data.key) return
      // resolve the key ("PAY-12") to the local issue id; skip keys we don't have loaded
      const issue = stateRef.current.issues.find(i => i.key === data.key)
      if (issue) dispatch({ type: 'setEditors', issueId: issue.id, editors: data.editors })
    })
    return () => { window.clearTimeout(timer); unsubscribe() }
  }, [projectId, projectKey, enabled, reloadOnChange, dispatch])
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
