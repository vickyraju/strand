import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useStore } from '../../data/store'

// Bits the testing screens share: the workspace's run and step statuses, a status lozenge, a progress bar, and items
// named by id (defects) shown by key.

export interface TestStatus { kind: 'run' | 'step'; key: string; name: string; description: string; color: string; final: boolean; mapsTo: string; rank: number; builtin: boolean }
export interface TestRun {
  id: string; executionId: string; executionKey: string; executionTitle: string; environments: string[]
  testId: string; testKey: string; testTitle: string; status: string; assigneeId: string | null; executedBy: string | null
  startedAt: string | null; finishedAt: string | null; spec: any; comment: string; defectIds: string[]; evidenceIds: string[]
  steps: { id: string; status: string; actual: string; comment: string; defectIds: string[]; evidenceIds: string[] }[]
  version: number; createdAt: string; updatedAt: string; specChanged: boolean
}
export const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')
export const enc = encodeURIComponent

let cache: Promise<TestStatus[]> | null = null
/** Run and step statuses (loaded once; `refreshTestStatuses` after an admin changes them). */
export function useTestStatuses() {
  const [list, setList] = useState<TestStatus[]>([])
  useEffect(() => { (cache ??= api<TestStatus[]>('GET', '/api/test-statuses')).then(setList, () => { cache = null }) }, [])
  return list
}
export const refreshTestStatuses = () => { cache = null }

export function StatusLozenge({ statuses, kind = 'run', status }: { statuses: TestStatus[]; kind?: 'run' | 'step'; status: string }) {
  const s = statuses.find(x => x.kind === kind && x.key === status)
  return <span className="test-lozenge" style={{ background: s?.color ?? '#A8A29E' }} title={s?.description}>{s?.name ?? status}</span>
}

/** Tests by status, as one bar (statuses in rank order, so passed and failed stand out at the ends). */
export function ProgressBar({ statuses, byStatus, total }: { statuses: TestStatus[]; byStatus: Record<string, number>; total: number }) {
  const run = statuses.filter(s => s.kind === 'run')
  const keys = Object.keys(byStatus).sort((a, b) => (run.find(s => s.key === a)?.rank ?? 99) - (run.find(s => s.key === b)?.rank ?? 99))
  const name = (k: string) => run.find(s => s.key === k)?.name ?? k
  return (
    <div className="test-progress">
      <div className="test-progress-bar" role="img" aria-label={keys.map(k => `${byStatus[k]} ${name(k)}`).join(', ') || 'No tests'}>
        {keys.map(k => <span key={k} style={{ width: `${(100 * byStatus[k]!) / Math.max(1, total)}%`, background: run.find(s => s.key === k)?.color ?? '#A8A29E' }} />)}
      </div>
      <span className="muted sm">{keys.map(k => `${byStatus[k]} ${name(k).toLowerCase()}`).join(' · ') || 'No tests'}</span>
    </div>
  )
}

/** Work items by id (defects), from the store or the server. */
export function useItems(ids: string[]) {
  const { state } = useStore()
  const [loaded, setLoaded] = useState<Record<string, { key: string; title: string }>>({})
  const missing = ids.filter(id => !loaded[id] && !state.issues.some(i => i.id === id))
  useEffect(() => {
    for (const id of missing) api<{ key: string; title: string }>('GET', `/api/issues/${id}?expand=links`).then(i => setLoaded(l => ({ ...l, [id]: { key: i.key, title: i.title } })), () => {})
  }, [missing.join(',')])   // eslint-disable-line react-hooks/exhaustive-deps
  return (id: string) => state.issues.find(i => i.id === id) ?? loaded[id]
}

export function useProgress(key: string, deps: unknown[] = []) {
  const [p, setP] = useState<{ total: number; byStatus: Record<string, number> } | null>(null)
  useEffect(() => { api<{ total: number; byStatus: Record<string, number> }>('GET', `/api/issues/${enc(key)}/test-progress`).then(setP, () => {}) }, [key, ...deps])   // eslint-disable-line react-hooks/exhaustive-deps
  return p
}
