// Server-backed people search for the pickers. The workspace does not hold a global user list
// (`/users` is capped at the first 1000), so the assignee/lead pickers query `/users/search` as the
// user types instead of filtering a local array. Without an API the pickers keep working off the store.
import { useRef, useState } from 'react'
import { api, apiEnabled } from './client'
import { mapUser, type Row } from './map'
import type { User } from '../data/reducer'

/** One page of `GET /users/search` (keyset-paginated, name order). */
export function searchUsers(query = '', limit = 30, cursor?: string | null, project?: string): Promise<{ items: User[]; next: string | null }> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (query) q.set('query', query)
  if (cursor) q.set('cursor', cursor)
  if (project) q.set('project', project)   // key or id: only people who can work in that project
  return api<{ items: Row[]; next: string | null }>('GET', `/api/users/search?${q}`)
    .then(page => ({ items: page.items.map(mapUser), next: page.next }))
}

// The empty-query first page is the same for every picker, so they share one request (retried after a failure).
let firstPage: ReturnType<typeof searchUsers> | undefined
const sharedFirstPage = () => (firstPage ??= searchUsers().catch(e => { firstPage = undefined; throw e }))

/** Debounced people search for a picker: shows the first page while idle, searches as the user types,
 *  remembers every user it has seen so a selected person renders even when they are not in the page. */
export function useUserSearch(project?: string) {
  const [results, setResults] = useState<User[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const cache = useRef(new Map<string, User>())   // every user seen, for the trigger label
  const seq = useRef(0)                            // drop stale responses (a fast retype)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const remember = (users: User[]) => { for (const u of users) cache.current.set(u.id, u) }
  const userById = (id?: string | null) => (id ? cache.current.get(id) : undefined)

  const lastQuery = useRef('')

  /** Call when a picker opens or the search text changes (debounced). The empty query is the shared first page,
   *  fetched once however many pickers are on screen. */
  const search = (query: string) => {
    clearTimeout(timer.current)
    if (!apiEnabled) return
    const q = query.trim()
    lastQuery.current = q
    timer.current = setTimeout(() => {
      const mySeq = ++seq.current
      setBusy(true)
      ;(q || project ? searchUsers(q, 30, null, project) : sharedFirstPage()).then(page => {
        if (mySeq !== seq.current) return
        remember(page.items); setResults(page.items); setNext(page.next); setBusy(false); setFailed(false)
      }).catch(() => { if (mySeq === seq.current) { setBusy(false); setFailed(true) } })
    }, q ? 150 : 0)
  }

  /** Append the next page (no-op when there is no cursor). */
  const loadMore = () => {
    if (!apiEnabled || !next || busy) return
    const mySeq = ++seq.current
    setBusy(true)
    searchUsers(lastQuery.current, 30, next, project).then(page => {
      if (mySeq !== seq.current) return
      remember(page.items); setResults(prev => [...prev, ...page.items]); setNext(page.next); setBusy(false)
    }).catch(() => { if (mySeq === seq.current) { setBusy(false); setFailed(true) } })
  }

  return { users: results, userById, search, loadMore, hasMore: !!next, busy, failed }
}