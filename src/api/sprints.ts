import { api } from './client.ts'
import { createCollectionSync } from './collections.ts'
import { mapSprint } from './map.ts'
import type { Issue, Sprint } from '../data/reducer'

/** What the sprint sync needs from the running app (set by useIssueSync). */
export const sprintDeps = {
  getIssues: (): Issue[] => [],
  projectKey: (_projectId: string): string | undefined => undefined,
  applySprint: (_s: Sprint) => {},
  /** Re-fetch a project's issues (starting or completing a sprint changes issues on the server). */
  reloadProject: async (_projectId: string) => {},
  /** Re-fetch every project (used after a failure). */
  reloadAll: async () => {},
  onError: (_m: string) => {},
}

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null)
const keyOf = (projectId: string) => {
  const k = sprintDeps.projectKey(projectId)
  if (!k) throw new Error('Project not found')
  return encodeURIComponent(k)
}

/** The projects whose work was in a sprint: its own, and those of the items it held (a board's sprint can span projects). */
export const projectsIn = (sprint: Sprint, issues: Issue[]) => {
  const members = new Set(sprint.issueIds ?? [])
  return [...new Set([sprint.projectId, ...issues.filter(i => members.has(i.id)).map(i => i.projectId)])]
}

/** Where unfinished work went when a sprint was completed locally: the sprint its members now point at, else the backlog. */
export function moveToOf(sprint: Sprint, issues: Issue[]): string | null {
  const members = new Set(sprint.issueIds ?? [])
  return issues.find(i => members.has(i.id) && i.sprintId && i.sprintId !== sprint.id)?.sprintId ?? null
}

export const sprintSync = createCollectionSync<Sprint>({
  id: s => s.id,
  // only fields the server stores from user input; point snapshots are the server's to compute
  changed: (a, b) => a.name !== b.name || a.goal !== b.goal || a.endsAt !== b.endsAt || a.state !== b.state,
  create: async s => {
    await api('POST', `/api/projects/${keyOf(s.projectId)}/sprints`, { id: s.id, name: s.name, goal: s.goal, endsAt: iso(s.endsAt), ...(s.boardId ? { boardId: s.boardId } : {}) })
  },
  update: async (a, b) => {
    const base = `/api/projects/${keyOf(b.projectId)}/sprints/${b.id}`
    if (a.name !== b.name || a.goal !== b.goal || (a.endsAt !== b.endsAt && b.state === a.state)) {
      await api('PATCH', base, { name: b.name, goal: b.goal, endsAt: iso(b.endsAt) })
    }
    if (a.state === 'planned' && b.state === 'active') {
      sprintDeps.applySprint(mapSprint(await api('POST', `${base}/start`, { endsAt: iso(b.endsAt ?? Date.now() + 14 * 864e5) })))
      await sprintDeps.reloadProject(b.projectId)
    } else if (a.state === 'closed' && b.state === 'active') {
      // reopened (spec 0403): the server brings its work back
      sprintDeps.applySprint(mapSprint(await api('POST', `${base}/reopen`)))
      for (const projectId of projectsIn(b, sprintDeps.getIssues())) await sprintDeps.reloadProject(projectId)
    } else if (a.state === 'active' && b.state === 'closed') {
      sprintDeps.applySprint(mapSprint(await api('POST', `${base}/complete`, { moveTo: moveToOf(b, sprintDeps.getIssues()) })))
      // the server moved the unfinished work of every project in the sprint: take their copies (and versions) again
      for (const projectId of projectsIn(b, sprintDeps.getIssues())) await sprintDeps.reloadProject(projectId)
    }
  },
  remove: async s => {
    await api('DELETE', `/api/projects/${keyOf(s.projectId)}/sprints/${s.id}`)
    // a completed sprint's unfinished work went to the board's next sprint (spec 0403): take the items again
    if (s.state === 'closed') await sprintDeps.reloadProject(s.projectId)
  },
  // the project itself was deleted: the project delete removes its sprints
  shouldDelete: s => !!sprintDeps.projectKey(s.projectId),
  recover: () => sprintDeps.reloadAll(),
  onError: m => sprintDeps.onError(m),
})
