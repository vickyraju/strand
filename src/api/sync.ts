// Keeps the API in step with the local store, for issues.
//
// The UI keeps dispatching the same reducer actions as before (create, edit, move, bulk edit, delete, Undo).
// Instead of translating each action into a request, this compares the local issues with a "base" (what the
// server was last told) and sends the difference. One mechanism therefore covers every action, including
// Undo and changes the reducer makes by itself (sprint completion, automation).
//
// - Requests run one at a time, in order, so a create always lands before the edits that follow it.
// - Each request carries the server's version (If-Match), so a stale edit is refused (409) and not overwritten.
// - When any request fails the project's issues are reloaded from the server (server wins) and the queued work
//   from before the failure is dropped.
import type { Issue } from '../data/reducer.ts'
import { mapIssue } from './map.ts'
import { enqueue as queue, idle as queueIdle } from './queue.ts'

type Call = <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>

/** Issue fields the server owns a copy of. Watchers, links, work logs and attachments sync separately. */
const SCALARS = [
  'type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'estimate', 'timeEstimate',
  'dueDate', 'startDate', 'sprintId', 'releaseId', 'parentId', 'custom', 'rank',
] as const
type Scalar = typeof SCALARS[number]
const wire = (f: Scalar) => (f === 'status' ? 'statusId' : f)

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
export const sameScalars = (a: Issue, b: Issue) => SCALARS.every(f => same(a[f], b[f]))

/** Fields to send when creating: everything that has a value. */
export function bodyOf(issue: Issue): Record<string, unknown> {
  const out: Record<string, unknown> = { id: issue.id }
  for (const f of SCALARS) if (issue[f] !== undefined) out[wire(f)] = issue[f]
  return out
}

/** Fields that changed between two copies of an issue, or null. A field that was cleared is sent as null. */
export function patchOf(before: Issue, after: Issue): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const f of SCALARS) if (!same(before[f], after[f])) out[wire(f)] = after[f] ?? null
  return Object.keys(out).length ? out : null
}

export interface Plan {
  creates: Issue[]
  restores: Issue[]
  deletes: Issue[]
  patches: { issue: Issue; patch: Record<string, unknown> }[]
}

/** `base`: issues the server knows about. `trashed`: ids we deleted on the server (so a return means restore). */
export function diffIssues(base: Map<string, Issue>, local: Issue[], trashed: Set<string>): Plan {
  const plan: Plan = { creates: [], restores: [], deletes: [], patches: [] }
  const seen = new Set<string>()
  for (const issue of local) {
    seen.add(issue.id)
    const was = base.get(issue.id)
    if (!was) (trashed.has(issue.id) ? plan.restores : plan.creates).push(issue)
    else {
      const patch = patchOf(was, issue)
      if (patch) plan.patches.push({ issue, patch })
    }
  }
  for (const [id, issue] of base) if (!seen.has(id)) plan.deletes.push(issue)
  return plan
}

export interface SyncDeps {
  call: Call
  /** Latest local issues (read when a request runs, never captured earlier). */
  getIssues: () => Issue[]
  projectKey: (projectId: string) => string | undefined
  /** Replace one issue with the server's copy, keeping the local-only parts. */
  applyServerIssue: (issue: Issue) => void
  /** Replace a project's issues wholesale (used when recovering from a failed request). */
  applyProjectIssues: (projectId: string, issues: Issue[]) => void
  loadProjectIssues: (projectKey: string) => Promise<Issue[]>
  onError: (message: string) => void
}

export function createIssueSync(initial?: SyncDeps) {
  let deps = initial
  const base = new Map<string, Issue>()
  const trash = new Map<string, Issue>()
  const keys = new Map<string, string>()        // issue id → the key the server uses (local keys can differ until synced)
  const versions = new Map<string, number>()
  let epoch = 0

  const keyOf = (i: Issue) => keys.get(i.id) ?? i.key

  /** Call when issues arrive from the server: they become the base, so they are never sent back. */
  function load(projectId: string, issues: (Issue & { version?: number })[]) {
    for (const [id, i] of base) if (i.projectId === projectId) base.delete(id)
    for (const i of issues) { base.set(i.id, i); keys.set(i.id, i.key); if (i.version != null) versions.set(i.id, i.version) }
  }

  const enqueue = (run: () => Promise<void>) => {
    const mine = epoch
    queue(async () => {
      if (mine !== epoch) return                 // queued before a failure that already reloaded the project
      try { await run() } catch (e) { await recover(e) }
    })
  }

  async function recover(e: unknown) {
    if (!deps) return
    epoch++
    deps.onError(e instanceof Error ? e.message : 'Could not save your change')
    // Reload every project that has unsynced work, so what is on screen is what the server has.
    const ids = new Set(deps.getIssues().map(i => i.projectId))
    for (const projectId of ids) {
      const key = deps.projectKey(projectId)
      if (!key) continue
      try {
        const issues = await deps.loadProjectIssues(key)
        load(projectId, issues)
        deps.applyProjectIssues(projectId, issues)
      } catch { /* still offline: the next change retries */ }
    }
    trash.clear()
  }

  /** After a write, adopt the server's copy unless the user has changed the issue again meanwhile. */
  function reconcile(sent: Issue, response: any) {
    keys.set(sent.id, response.key)
    versions.set(sent.id, response.version)
    const server = mapIssue(response)
    const now = deps!.getIssues().find(i => i.id === sent.id)
    if (now && sameScalars(now, sent)) {
      base.set(sent.id, { ...now, ...server, watcherIds: now.watcherIds, links: now.links, attachments: now.attachments, worklogs: now.worklogs })
      deps!.applyServerIssue(server)
    }
  }

  function flush() {
    if (!deps) return
    const plan = diffIssues(base, deps.getIssues(), new Set(trash.keys()))
    const d = deps

    for (const issue of plan.creates) {
      base.set(issue.id, issue)
      enqueue(async () => {
        const key = d.projectKey(issue.projectId)
        if (!key) throw new Error('Project not found')
        reconcile(issue, await d.call('POST', `/api/projects/${encodeURIComponent(key)}/issues`, bodyOf(issue)))
      })
    }
    for (const issue of plan.restores) {
      base.set(issue.id, issue); trash.delete(issue.id)
      enqueue(async () => {
        reconcile(issue, await d.call('POST', `/api/issues/${encodeURIComponent(keyOf(issue))}/restore`))
        // the issue may have been edited before it was deleted; the diff below sends any difference
      })
    }
    for (const { issue, patch } of plan.patches) {
      base.set(issue.id, issue)
      enqueue(async () => {
        const v = versions.get(issue.id)
        reconcile(issue, await d.call('PATCH', `/api/issues/${encodeURIComponent(keyOf(issue))}`, patch, v != null ? { 'if-match': String(v) } : undefined))
      })
    }
    for (const issue of plan.deletes) {
      base.delete(issue.id); trash.set(issue.id, issue)
      enqueue(async () => { await d.call('DELETE', `/api/issues/${encodeURIComponent(keyOf(issue))}`) })
    }
  }

  return {
    configure(next: SyncDeps) { deps = next },
    load, flush,
    /** Resolves when everything queued so far has been sent (used by tests and before sign-out). */
    idle: queueIdle,
    /** The key the server knows an issue by (a new issue's local key differs until its create is answered). */
    serverKey: (issue: Issue) => keyOf(issue),
    /** True once the server has this issue (it came from the server, or its create was answered). */
    known: (id: string) => keys.has(id),
  }
}

export const issueSync = createIssueSync()
