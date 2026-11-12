// Per-issue extras that arrive with the single-issue call and are edited in the detail panel:
// time logs, issue links and "I'm watching". Comments live in comments.ts.
import { api } from './client.ts'
import { createCollectionSync } from './collections.ts'
import { commentDeps, commentSync, detailLoaded, keyOf } from './comments.ts'
import { issueSync } from './sync.ts'
import type { Issue, Worklog } from '../data/reducer.ts'

export interface WorklogItem extends Worklog { issueId: string }
export interface LinkItem { id: string; issueId: string; type: string; otherId: string }
export interface WatchItem { id: string }                 // issue id: I am watching it

// ── Pure: what the local issues say, for the issues whose detail has been loaded ──

export const worklogItems = (issues: Issue[], loaded: ReadonlySet<string>): WorklogItem[] =>
  issues.filter(i => loaded.has(i.id)).flatMap(i => i.worklogs.map(w => ({ ...w, issueId: i.id })))

export const linkId = (issueId: string, type: string, otherId: string) => `${issueId}|${type}|${otherId}`
export const linkItems = (issues: Issue[], loaded: ReadonlySet<string>): LinkItem[] =>
  issues.filter(i => loaded.has(i.id)).flatMap(i => i.links.map(l => ({ id: linkId(i.id, l.type, l.issueId), issueId: i.id, type: l.type, otherId: l.issueId })))

export const watchItems = (issues: Issue[], loaded: ReadonlySet<string>, meId: string | null): WatchItem[] =>
  meId ? issues.filter(i => loaded.has(i.id) && i.watcherIds.includes(meId)).map(i => ({ id: i.id })) : []

// ── Syncs ──

const issueOf = (id: string) => commentDeps.getIssues().find(i => i.id === id)
const exists = (id: string) => !!issueOf(id)

export const worklogSync = createCollectionSync<WorklogItem>({
  id: w => w.id,
  changed: (a, b) => a.minutes !== b.minutes || a.date !== b.date || a.note !== b.note,
  // the app changes the item's remaining estimate itself (and sends it with the item), so these leave it as it is
  create: async w => { await api('POST', `/api/issues/${keyOf(w.issueId)}/worklogs`, { id: w.id, minutes: w.minutes, date: w.date, note: w.note, adjustEstimate: 'leave' }) },
  update: async (_a, b) => { await api('PATCH', `/api/worklogs/${b.id}`, { minutes: b.minutes, date: b.date, note: b.note, adjustEstimate: 'leave' }) },
  remove: async w => { await api('DELETE', `/api/worklogs/${w.id}?adjustEstimate=leave`) },
  shouldDelete: w => exists(w.issueId),
  recover: async () => { await Promise.all([...detailLoaded].map(id => commentDeps.reloadDetail(id))) },
  onError: m => commentDeps.onError(m),
})

export const linkSync = createCollectionSync<LinkItem>({
  id: l => l.id,
  changed: () => false,
  create: async l => {
    const other = issueOf(l.otherId)
    if (!other) throw new Error('Linked work item not found')
    await api('POST', `/api/issues/${keyOf(l.issueId)}/links`, { type: l.type, targetKey: issueSync.serverKey(other) })
  },
  update: async () => {},
  remove: async l => {
    const other = issueOf(l.otherId)
    if (!other) return
    await api('DELETE', `/api/issues/${keyOf(l.issueId)}/links?type=${l.type}&target=${encodeURIComponent(issueSync.serverKey(other))}`)
  },
  shouldDelete: l => exists(l.issueId) && exists(l.otherId),
  recover: async () => { await Promise.all([...detailLoaded].map(id => commentDeps.reloadDetail(id))) },
  onError: m => commentDeps.onError(m),
})

export const watchSync = createCollectionSync<WatchItem>({
  id: w => w.id,
  changed: () => false,
  create: async w => { await api('PUT', `/api/issues/${keyOf(w.id)}/watch`) },
  update: async () => {},
  remove: async w => { await api('DELETE', `/api/issues/${keyOf(w.id)}/watch`) },
  shouldDelete: w => exists(w.id),
  recover: async () => { await Promise.all([...detailLoaded].map(id => commentDeps.reloadDetail(id))) },
  onError: m => commentDeps.onError(m),
})

/** One issue's detail arrived from the server: it becomes the base for comments, time logs, links and watching. */
export function adoptDetail(
  d: { issueId: string; comments: import('../data/reducer.ts').Comment[]; worklogs: Worklog[]; links: { type: string; issueId: string }[]; watcherIds: string[] },
  meId: string | null,
) {
  const id = d.issueId
  detailLoaded.add(id)
  commentSync.load(d.comments, c => c.issueId === id)
  worklogSync.load(d.worklogs.map(w => ({ ...w, issueId: id })), w => w.issueId === id)
  linkSync.load(d.links.map(l => ({ id: linkId(id, l.type, l.issueId), issueId: id, type: l.type, otherId: l.issueId })), l => l.issueId === id)
  watchSync.load(meId && d.watcherIds.includes(meId) ? [{ id }] : [], w => w.id === id)
}
