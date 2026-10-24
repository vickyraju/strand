// Limits an administrator sets in System settings that the web app needs too (so it can say "at most 25 MB" before an
// upload starts, offer the right token lifetimes, and so on). Loaded once and shared; without a server, the built-in values.
import { useEffect, useState } from 'react'
import { api, apiEnabled } from './client'

export interface PublicSettings {
  attachments: { enabled: boolean; maxSizeMb: number }
  accessTokens: { enabled: boolean; maxPerUser: number; maxExpiryDays: number; defaultExpiryDays: number }
  searchAndBulk: { exportMaxRows: number; bulkMaxItems: number }
  dueReminders: { enabled: boolean; daysAhead: number; daysLate: number; dueSoonDays: number }
}

/** The same values as the server's defaults; used without a server and until the real ones arrive. */
export const DEFAULT_SETTINGS: PublicSettings = {
  attachments: { enabled: true, maxSizeMb: 25 },
  accessTokens: { enabled: true, maxPerUser: 10, maxExpiryDays: 365, defaultExpiryDays: 90 },
  searchAndBulk: { exportMaxRows: 20_000, bulkMaxItems: 200 },
  dueReminders: { enabled: true, daysAhead: 1, daysLate: 3, dueSoonDays: 3 },
}

let loading: Promise<PublicSettings> | undefined
let current: PublicSettings = DEFAULT_SETTINGS
const listeners = new Set<(s: PublicSettings) => void>()

/** Fetch again (after an admin saves a change in this browser). */
export function reloadPublicSettings() {
  if (!apiEnabled) return Promise.resolve(current)
  loading = api<PublicSettings>('GET', '/api/settings/public')
    .then(s => { current = { ...DEFAULT_SETTINGS, ...s }; listeners.forEach(l => l(current)); return current })
    .catch(() => { loading = undefined; return current })
  return loading
}

export function usePublicSettings(): PublicSettings {
  const [s, setS] = useState(current)
  useEffect(() => {
    listeners.add(setS)
    if (!loading) void reloadPublicSettings()
    return () => { listeners.delete(setS) }
  }, [])
  return s
}
