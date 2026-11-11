// Limits an administrator sets in System settings that the web app needs too (so it can say "at most 25 MB" before an
// upload starts, offer the right token lifetimes, and so on). Loaded once and shared; without a server, the built-in values.
import { useEffect, useState } from 'react'
import type { Estimation } from '../data/reducer.ts'
import { api, apiEnabled } from './client'
import { DEFAULT_PRIORITIES, DEFAULT_RESOLUTIONS, setLists, type PriorityDef, type ResolutionDef } from '../data/lists'
import { DEFAULT_KEY_RULE, type KeyRule } from '../../server/src/shared/projectKeys.ts'
import { DEFAULT_TIME, parseDuration, formatDuration, statLabel, type TimeSettings } from '../data/time'

export interface PublicSettings {
  announcement: { text: string; visibility: 'public' | 'private' }
  attachments: { enabled: boolean; maxSizeMb: number }
  voting: { enabled: boolean }
  accessTokens: { enabled: boolean; maxPerUser: number; maxExpiryDays: number; defaultExpiryDays: number }
  searchAndBulk: { exportMaxRows: number; bulkMaxItems: number; importMaxRows: number }
  testing: { finalStatusesHavePrecedence: boolean; resultImportMaxMb: number; resultImportMaxTests: number }
  groups: { whoCanCreate: 'everyone' | 'admins' }
  filterSubscriptions: { groupSubscribers: 'everyone' | 'admins'; maxItems: number }
  dueReminders: { enabled: boolean; daysAhead: number; daysLate: number; dueSoonDays: number }
  timeTracking: TimeSettings
  projectKeys: KeyRule
  priorities: PriorityDef[]
  resolutions: ResolutionDef[]
}

/** The same values as the server's defaults; used without a server and until the real ones arrive. */
export const DEFAULT_SETTINGS: PublicSettings = {
  announcement: { text: '', visibility: 'private' },
  attachments: { enabled: true, maxSizeMb: 25 },
  voting: { enabled: true },
  accessTokens: { enabled: true, maxPerUser: 10, maxExpiryDays: 365, defaultExpiryDays: 90 },
  searchAndBulk: { exportMaxRows: 20_000, bulkMaxItems: 200, importMaxRows: 10_000 },
  testing: { finalStatusesHavePrecedence: true, resultImportMaxMb: 10, resultImportMaxTests: 2000 },
  groups: { whoCanCreate: 'everyone' },
  filterSubscriptions: { groupSubscribers: 'everyone', maxItems: 200 },
  dueReminders: { enabled: true, daysAhead: 1, daysLate: 3, dueSoonDays: 3 },
  timeTracking: DEFAULT_TIME,
  projectKeys: DEFAULT_KEY_RULE,
  priorities: DEFAULT_PRIORITIES,
  resolutions: DEFAULT_RESOLUTIONS,
}

let loading: Promise<PublicSettings> | undefined
let current: PublicSettings = DEFAULT_SETTINGS
const listeners = new Set<(s: PublicSettings) => void>()

/** Fetch again (after an admin saves a change in this browser). */
export function reloadPublicSettings() {
  if (!apiEnabled) return Promise.resolve(current)
  loading = api<PublicSettings>('GET', '/api/settings/public')
    .then(s => { current = { ...DEFAULT_SETTINGS, ...s }; setLists(current.priorities, current.resolutions); listeners.forEach(l => l(current)); return current })
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

/** Reading and showing durations with this workspace's time tracking settings (spec 0306). */
export function useDurations() {
  const t = usePublicSettings().timeTracking
  return { parse: (text: string) => parseDuration(text, t), format: (minutes: number) => formatDuration(minutes, t),
    /** A total in an estimation statistic, with its unit (spec 0404). */
    stat: (total: number, e?: Estimation) => statLabel(total, e, t) }
}
