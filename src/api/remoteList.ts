import { useRef, useState } from 'react'
import { apiEnabled } from './client'

/** A picker that searches the server as you type (debounced) instead of listing everything in the browser.
 *  `search('')` (a picker opening) loads the first page; later calls drop answers that arrive out of order.
 *  Everything it has ever shown is remembered, so a selected item still has a name when it is not on the current page. */
export function useRemoteList<T>(load: (query: string) => Promise<T[]>, idOf: (t: T) => string) {
  const [items, setItems] = useState<T[]>([])
  const [busy, setBusy] = useState(false)
  const seen = useRef(new Map<string, T>())
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const search = (query: string) => {
    clearTimeout(timer.current)
    if (!apiEnabled) return
    const q = query.trim()
    timer.current = setTimeout(() => {
      const mine = ++seq.current
      setBusy(true)
      load(q).then(list => {
        if (mine !== seq.current) return
        for (const t of list) seen.current.set(idOf(t), t)
        setItems(list); setBusy(false)
      }, () => { if (mine === seq.current) setBusy(false) })
    }, q ? 150 : 0)
  }
  const remember = (t: T) => { seen.current.set(idOf(t), t) }
  const byId = (id?: string | null) => (id ? seen.current.get(id) : undefined)
  return { items, busy, search, byId, remember }
}
