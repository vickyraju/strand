// Server-backed people search for the pickers. The workspace does not hold a global user list
// (`/users` is capped at the first 1000), so the assignee/lead pickers query `/users/search` as the
// user types instead of filtering a local array. Without an API the pickers keep working off the store.
import { useEffect, useRef, useState } from 'react'
import { api, apiEnabled } from './client'
import { mapUser, type Row } from './map'
import type { User } from '../data/reducer'

/** One page of `GET /users/search` (keyset-paginated, name order). */
export function searchUsers(query = '', limit = 30, cursor?: string | null): Promise<{ items: User[]; next: string | null }> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (query) q.set('query', query)
  if (cursor) q.set('cursor', cursor)
  return api<{ items: Row[]; next: string | null }>('GET', `/api/users/search?${q}`)
    .then(page => ({ items: page.items.map(mapUser), next: page.next }))
}

/** Debounced people search for a picker: shows the first page while idle, searches as the user types,
 *  remembers every user it has seen so a selected person renders even when they are not in the page. */
export function useUserSearch() {
  const [results, setResults] = useState<User[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [seeded, setSeeded] = useState(false)   // whether the initial (empty-query) page has loaded
  const cache = useRef(new Map<string, User>())   // every user seen, for the trigger label
  const seq = useRef(0)                            // drop stale responses (a fast retype)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const remember = (users: User[]) => { for (const u of users) cache.current.set(u.id, u) }
  const userById = (id?: string | null) => (id ? cache.current.get(id) : undefined)

  // Seed the picker with the first page so it is never empty on open.
  useEffect(() => {
    if (!apiEnabled || seeded) return
    let cancelled = false
    searchUsers().then(page => {
      if (cancelled) return
      remember(page.items); setResults(page.items); setNext(page.next); setSeeded(true)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Debounced: call when the search text changes. An empty query re-seeds the first page. */
  const search = (query: string) => {
    clearTimeout(timer.current)
    if (!apiEnabled) return
    timer.current = setTimeout(() => {
      const mySeq = ++seq.current
      setBusy(true)
      searchUsers(query.trim()).then(page => {
        if (mySeq !== seq.current) return
        remember(page.items); setResults(page.items); setNext(page.next); setBusy(false); setFailed(false)
      }).catch(() => { if (mySeq === seq.current) { setBusy(false); setFailed(true) } })
    }, 150)
  }

  /** Append the next page (no-op when there is no cursor). */
  const loadMore = () => {
    if (!apiEnabled || !next || busy) return
    const mySeq = ++seq.current
    setBusy(true)
    searchUsers('', 30, next).then(page => {
      if (mySeq !== seq.current) return
      remember(page.items); setResults(prev => [...prev, ...page.items]); setNext(page.next); setBusy(false)
    }).catch(() => { if (mySeq === seq.current) { setBusy(false); setFailed(true) } })
  }

  return { users: results, userById, search, loadMore, hasMore: !!next, busy, failed }
}