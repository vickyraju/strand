// Things that belong to the signed-in user: saved views and notification read/archive state.
import { api } from './client.ts'
import { createCollectionSync } from './collections.ts'
import { mapNotification } from './map.ts'
import type { Notification, SavedView, State } from '../data/reducer.ts'

export const personalDeps = {
  meId: (): string | null => null,
  reloadAll: async () => {},
  setNotifications: (_n: Notification[]) => {},
  onError: (_m: string) => {},
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Views of other people are visible (shared views) but read-only, so only my own are synced.
export const viewSync = createCollectionSync<SavedView>({
  id: v => v.id,
  changed: (a, b) => a.name !== b.name || a.shared !== b.shared || !same(a.filters, b.filters),
  create: async v => { await api('POST', '/api/views', { id: v.id, name: v.name, shared: v.shared, filters: v.filters }) },
  update: async (_a, v) => { await api('PATCH', `/api/views/${v.id}`, { name: v.name, shared: v.shared, filters: v.filters }) },
  remove: async v => { await api('DELETE', `/api/views/${v.id}`) },
  recover: () => personalDeps.reloadAll(),
  onError: m => personalDeps.onError(m),
})

/** Notifications the server created. Local-only ones (e.g. a due reminder made by the app) are never sent. */
const serverIds = new Set<string>()
export const notificationSync = createCollectionSync<Notification>({
  id: n => n.id,
  changed: (a, b) => a.read !== b.read || a.archived !== b.archived,
  create: async () => {},
  update: async (_a, n) => { if (serverIds.has(n.id)) await api('PATCH', `/api/notifications/${n.id}`, { read: n.read, archived: n.archived }) },
  remove: async () => {},
  recover: () => personalDeps.reloadAll(),
  onError: m => personalDeps.onError(m),
})

export function loadPersonalBase(state: State, meId: string) {
  viewSync.load(state.views.filter(v => v.ownerId === meId))
  loadNotificationBase(state.notifications)
}
function loadNotificationBase(list: Notification[]) {
  serverIds.clear(); for (const n of list) serverIds.add(n.id)
  notificationSync.load(list)
}

/** Fetch my notifications again (others assign, mention and comment while the app is open). */
export async function refreshNotifications() {
  const list = (await api<any[]>('GET', '/api/notifications')).map(mapNotification)
  loadNotificationBase(list)
  personalDeps.setNotifications(list)
}
