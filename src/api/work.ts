// Server-backed lists for the screens that must not scan every work item: cross-project search,
// "Your work" (assigned / recently worked on) and the inbox. Without an API these return the empty,
// already-loaded shape, so the screens keep working off the local store.
import { useEffect, useRef, useState } from 'react'
import { api, apiEnabled } from './client'
import { mapSearchRow, type Row } from './map'
import type { Issue, ViewFilters } from '../data/reducer'

/** One page of a list endpoint; `loading` until the first answer, `error` if it fails. */
export type Load = {
  items: Issue[]
  /** `next` cursor from the API, to fetch the following page. */
  next: string | null
  status: 'ready' | 'loading' | 'error'
  retry: () => void
  /** Fetch and append the next page (no-op when there is no next). */
  loadMore: () => void
}

/** The app's view filters mapped onto the API's `GET /search` query string. */
function searchParams(f: ViewFilters, limit: number, cursor?: string | null): URLSearchParams {
  const q = new URLSearchParams({ q: f.q, resolution: f.resolution })
  if (f.projectId) q.set('project', f.projectId)
  if (f.assignee !== null) q.set('assignee', f.assignee || 'none')   // '' = Unassigned
  if (f.type) q.set('type', f.type)
  if (f.priority) q.set('priority', f.priority)
  if (f.label) q.set('label', f.label)
  if (cursor) q.set('cursor', cursor)
  q.set('limit', String(limit))
  return q
}

/** Cross-project search: `GET /api/search` for the view's filters, with "load more" by cursor. */
export function useSearch(f: ViewFilters, limit = 50): Load {
  const [items, setItems] = useState<Issue[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [status, setStatus] = useState<Load['status']>(apiEnabled ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)
  const [appending, setAppending] = useState(false)
  const nextRef = useRef<string | null>(null)
  const filterKey = JSON.stringify([f.q, f.projectId, f.assignee, f.type, f.priority, f.label, f.resolution])
  const filtersRef = useRef(f)
  filtersRef.current = f

  useEffect(() => {
    if (!apiEnabled) { setItems([]); setNext(null); return }
    let cancelled = false
    setStatus('loading')
    api<{ items: Row[]; next: string | null }>('GET', `/api/search?${searchParams(f, limit)}`)
      .then(page => {
        if (cancelled) return
        setItems(page.items.map(mapSearchRow))
        setNext(page.next)
        nextRef.current = page.next
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, attempt])

  const loadMore = () => {
    const cursor = nextRef.current
    if (!apiEnabled || !cursor || appending) return
    setAppending(true)
    api<{ items: Row[]; next: string | null }>('GET', `/api/search?${searchParams(filtersRef.current, limit, cursor)}`)
      .then(page => {
        setItems(prev => [...prev, ...page.items.map(mapSearchRow)])
        setNext(page.next)
        nextRef.current = page.next
      })
      .catch(() => {})
      .finally(() => setAppending(false))
  }
  return { items, next, status, retry: () => setAttempt(a => a + 1), loadMore }
}

/** "Your work" → Assigned to me: open issues assigned to me, due soonest first. */
export function useMyWork(): Load {
  const [items, setItems] = useState<Issue[]>([])
  const [status, setStatus] = useState<Load['status']>(apiEnabled ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!apiEnabled) { setItems([]); return }
    let cancelled = false
    setStatus('loading')
    api<Row[]>('GET', '/api/me/work').then(rows => {
      if (cancelled) return
      setItems(rows.map(mapSearchRow))
      setStatus('ready')
    }, () => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [attempt])
  return { items, next: null, status, retry: () => setAttempt(a => a + 1), loadMore: () => {} }
}

/** "Your work" → Worked on: the issues I last touched (activity, comments, work logs), most recent first. */
export function useMyRecent(): Load {
  const [items, setItems] = useState<Issue[]>([])
  const [status, setStatus] = useState<Load['status']>(apiEnabled ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!apiEnabled) { setItems([]); return }
    let cancelled = false
    setStatus('loading')
    api<Row[]>('GET', '/api/me/recent').then(rows => {
      if (cancelled) return
      setItems(rows.map(mapSearchRow))
      setStatus('ready')
    }, () => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [attempt])
  return { items, next: null, status, retry: () => setAttempt(a => a + 1), loadMore: () => {} }
}

/** Resolves a server list row (not in the store yet) to its issue key and asks the app to load its project;
 *  the project's issues then arrive through useProjectIssues, which also registers them with the sync layer. */
export function loadIssueFull(id: string): Promise<string | undefined> {
  if (!apiEnabled) return Promise.resolve(undefined)
  return api<any>('GET', `/api/issues/${encodeURIComponent(id)}`).then(detail => {
    const key = String(detail.key)
    window.dispatchEvent(new CustomEvent('strand:issue-full', { detail: { key: key.split('-')[0] } }))
    return key
  }).catch(() => undefined)
}
// ── Search pickers ──

/** A project as the project filter shows it. */
export interface ProjectOption { id: string; key: string; name: string; color: string }
export const searchProjects = (query: string) =>
  api<{ items: Row[] }>('GET', `/api/projects/search?limit=30${query ? `&query=${encodeURIComponent(query)}` : ''}`)
    .then(p => p.items.map((r): ProjectOption => ({ id: r.id, key: r.key, name: r.name, color: r.color })))
export const searchLabels = (query: string) => api<string[]>('GET', `/api/labels${query ? `?query=${encodeURIComponent(query)}` : ''}`)

// ── Your work: counts, recent projects, viewed ──

/** The numbers on the Your work cards, counted by the database (so they stay right past the first page of items). */
export interface WorkSummary { assigned: number; dueSoon: number; overdue: number; blocked: number }
/** One of the most recently active projects, with the person's open items and how much is done. */
export interface RecentProject { id: string; key: string; name: string; color: string; template: 'kanban' | 'scrum'; myOpen: number; done: number; total: number }

/** Fetch once when the screen opens; `undefined` until it arrives (or without an API, or if it fails: the screen then shows nothing rather than a wrong number). */
function useServerValue<T>(path: string): T | undefined {
  const [value, setValue] = useState<T>()
  useEffect(() => {
    if (!apiEnabled) return
    let cancelled = false
    api<T>('GET', path).then(v => { if (!cancelled) setValue(v) }, () => {})
    return () => { cancelled = true }
  }, [path])
  return value
}

export const useWorkSummary = () => useServerValue<WorkSummary>('/api/me/work/summary')
export const useRecentProjects = () => useServerValue<RecentProject[]>('/api/me/projects/recent')

/** "Your work" → Viewed: the work items I opened most recently, from the server. */
export function useMyViewed(): Load {
  const [items, setItems] = useState<Issue[]>([])
  const [status, setStatus] = useState<Load['status']>(apiEnabled ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!apiEnabled) { setItems([]); return }
    let cancelled = false
    setStatus('loading')
    api<Row[]>('GET', '/api/me/viewed').then(rows => {
      if (cancelled) return
      setItems(rows.map(mapSearchRow)); setStatus('ready')
    }, () => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [attempt])
  return { items, next: null, status, retry: () => setAttempt(a => a + 1), loadMore: () => {} }
}

/** Tell the server I opened this work item (Your work → Viewed). Once a minute per item is plenty. */
const lastView = new Map<string, number>()
export function recordView(key: string, now = Date.now()) {
  if (!apiEnabled || now - (lastView.get(key) ?? 0) < 60_000) return
  lastView.set(key, now)
  api('POST', `/api/issues/${encodeURIComponent(key)}/view`).catch(() => lastView.delete(key))
}
