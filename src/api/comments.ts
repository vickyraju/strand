import { api } from './client.ts'
import { createCollectionSync } from './collections.ts'
import { issueSync } from './sync.ts'
import { mapIssueDetail } from './map.ts'
import type { Comment, Issue } from '../data/reducer'

/** Everything the comment sync needs from the running app (set by useIssueSync). */
export const commentDeps = {
  getIssues: (): Issue[] => [],
  onError: (_message: string) => {},
  /** Re-fetch one issue's detail from the server and put it in the store. */
  reloadDetail: async (_issueId: string) => {},
}
/** Issues whose comments are loaded; only these can be reloaded after a failure. */
export const detailLoaded = new Set<string>()

export const keyOf = (issueId: string) => {
  const issue = commentDeps.getIssues().find(i => i.id === issueId)
  if (!issue) throw new Error('Work item not found')
  return encodeURIComponent(issueSync.serverKey(issue))
}

export const commentSync = createCollectionSync<Comment>({
  id: c => c.id,
  changed: (a, b) => a.body !== b.body,
  create: async c => { await api('POST', `/api/issues/${keyOf(c.issueId)}/comments`, { id: c.id, body: c.body }) },
  update: async (_a, b) => { await api('PATCH', `/api/comments/${b.id}`, { body: b.body }) },
  remove: async c => { await api('DELETE', `/api/comments/${c.id}`) },
  // comments vanish locally when their issue is deleted; the issue can be undeleted, so keep them on the server
  shouldDelete: c => commentDeps.getIssues().some(i => i.id === c.issueId),
  recover: async () => { await Promise.all([...detailLoaded].map(id => commentDeps.reloadDetail(id))) },
  onError: m => commentDeps.onError(m),
})

export async function fetchIssueDetail(issue: Issue) {
  const d = await api<any>('GET', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}`)
  return { issueId: issue.id, ...mapIssueDetail(d) }
}
