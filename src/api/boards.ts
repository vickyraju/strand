// Boards from the server: a board's definition, and the work items it finds, a page at a time. The items join the store
// (`mergeIssues`) so cards, the detail panel and edits work on them as on any item.
import { useEffect, useRef, useState } from 'react'
import { api, apiEnabled, errorMessage } from './client'
import { mapIssue, type Row } from './map'
import { issueSync } from './sync'
import { useStore, statistic, type Board, type BoardRef, type Project, type Sprint } from '../data/store'
import { loadProjectByKey } from './load'

/** At most this many items on one board (as in Jira, a board is for work in flight; narrow the filter for more). */
export const BOARD_CAP = 5000

/** A project's boards, in order (the project's own list until the server's arrives); `version` fetches them again. */
export function useBoards(project: Project, version = 0) {
  const [boards, setBoards] = useState<(BoardRef & { canManage?: boolean })[]>(project.boards ?? [])
  useEffect(() => {
    if (!apiEnabled) return
    let live = true
    api<(BoardRef & { canManage: boolean })[]>('GET', `/api/projects/${encodeURIComponent(project.key)}/boards`).then(b => { if (live) setBoards(b) }, () => { /* keep the list we have */ })
    return () => { live = false }
  }, [project.key, version])
  return boards
}

/** One board in full; `reload` fetches it again (after it is changed). */
export function useBoard(id: string | undefined) {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!id) return
    let live = true
    setError('')
    api<Board & { estimationFieldId?: string | null }>('GET', `/api/boards/${encodeURIComponent(id)}`).then(b => { if (live) setBoard({ ...b, estimation: statistic(b as any) }) }, e => { if (live) setError(errorMessage(e)) })
    return () => { live = false }
  }, [id, n])
  return { board: board?.id === id ? board : null, error, reload: () => setN(x => x + 1), replace: setBoard }
}

interface Found { ids: string[]; lanes: Map<string, string>; colors: Map<string, string>; total: number; status: 'loading' | 'ready' | 'error'; error: string }

/** The items a board shows (ids in rank order, and each one's swimlane query) for these quick filters and scope,
 *  loaded into the store. Reloads when the board's filters, the quick filters, the scope or `version` change. */
export function useBoardItems(board: Board | null, o: { quick: string[]; scope?: 'board' | 'backlog'; version?: string | number }) {
  const { dispatch } = useStore()
  const [found, setFound] = useState<Found>({ ids: [], lanes: new Map(), colors: new Map(), total: 0, status: 'loading', error: '' })
  const [attempt, setAttempt] = useState(0)
  const seq = useRef(0)
  const key = board ? JSON.stringify([board.id, board.jql, board.quickFilters, board.swimlanes, board.cardColors?.queries, board.doneDays, o.quick, o.scope ?? 'board', o.version ?? 0, attempt]) : ''
  useEffect(() => {
    if (!board) return
    const mine = ++seq.current
    setFound(f => ({ ...f, status: 'loading', error: '' }))
    ;(async () => {
      const ids: string[] = [], lanes = new Map<string, string>(), colors = new Map<string, string>()
      let cursor: string | null = null, total = 0
      do {
        const q = new URLSearchParams({ limit: '500', scope: o.scope ?? 'board', ...(o.quick.length ? { quick: o.quick.join(',') } : {}), ...(cursor ? { cursor } : {}) })
        const page: { items: Row[]; total: number; next: string | null } = await api('GET', `/api/boards/${encodeURIComponent(board.id)}/issues?${q}`)
        if (mine !== seq.current) return
        total = page.total
        for (const r of page.items) { ids.push(r.id); lanes.set(r.id, r.lane ?? ''); colors.set(r.id, r.color ?? '') }
        // the sync layer learns them first, so they aren't taken for local changes and sent back
        issueSync.merge(page.items.map(r => ({ ...mapIssue(r), version: r.version })))
        dispatch({ type: 'mergeIssues', issues: page.items.map(mapIssue) })
        cursor = page.next
      } while (cursor && ids.length < BOARD_CAP)
      if (mine === seq.current) setFound({ ids, lanes, colors, total, status: 'ready', error: '' })
    })().catch(e => { if (mine === seq.current) setFound(f => ({ ...f, status: 'error', error: errorMessage(e) })) })
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  return { ...found, retry: () => setAttempt(a => a + 1) }
}

/** The board this person last used in a project (remembered in this browser). */
export const lastBoard = {
  get: (projectId: string) => localStorage.getItem(`strand:board:${projectId}`) ?? undefined,
  set: (projectId: string, boardId: string) => localStorage.setItem(`strand:board:${projectId}`, boardId),
}

/** Collapsed columns and swimlanes: how this person likes to see a board, kept in this browser (not a board setting,
 *  so anyone can collapse a column without changing the board for everyone). */
export function useBoardView(boardId: string | undefined) {
  const k = `strand:board-view:${boardId}`
  const read = (): { cols: string[]; lanes: string[] } => { try { return { cols: [], lanes: [], ...JSON.parse(localStorage.getItem(k) ?? '{}') } } catch { return { cols: [], lanes: [] } } }
  const [view, setView] = useState(read)
  useEffect(() => { setView(read()) }, [boardId])   // eslint-disable-line react-hooks/exhaustive-deps
  const save = (v: { cols: string[]; lanes: string[] }) => { setView(v); localStorage.setItem(k, JSON.stringify(v)) }
  return { view, save }
}

/** How many items a JQL query finds (or what is wrong with it), a moment after typing stops; `run` checks at once. */
export function useJqlCount(jql: string, on = true) {
  const [check, setCheck] = useState<{ jql: string; count?: number; error?: string }>()
  const run = (q: string) => api<{ count: number }>('POST', '/api/jql/check', { jql: q })
    .then(r => setCheck({ jql: q, count: r.count }), e => setCheck({ jql: q, error: errorMessage(e) }))
  useEffect(() => {
    if (!on || !jql.trim()) return
    const t = setTimeout(() => run(jql.trim()), 500)
    return () => clearTimeout(t)
  }, [jql, on])   // eslint-disable-line react-hooks/exhaustive-deps
  return { checked: check?.jql === jql.trim() ? check : undefined, run }
}

/** After a board is made or removed: the project again (its board list decides whether it has a backlog). */
export const reloadBoards = (key: string, dispatch: (a: { type: 'loadProject'; project: Project; sprints: Sprint[] }) => void) =>
  loadProjectByKey(key).then(({ project, sprints }) => dispatch({ type: 'loadProject', project, sprints }), () => {})
