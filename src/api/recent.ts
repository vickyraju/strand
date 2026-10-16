// "Recently opened projects", kept in this browser. Used at startup to decide which projects to load in full:
// a workspace can have tens of thousands of projects, but a person works in a handful.
const KEY = 'strand:recent-projects'
const MAX = 30

/** Newest first, no duplicates, at most MAX. Keys are compared case-insensitively and stored upper-case. */
export function pushRecent(list: string[], key: string): string[] {
  const k = key.toUpperCase()
  return [k, ...list.filter(x => x !== k)].slice(0, MAX)
}

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch { return [] }
}

export function rememberProject(key: string) {
  try { localStorage.setItem(KEY, JSON.stringify(pushRecent(readRecent(), key))) } catch { /* private mode: fine */ }
}

/** Project keys to load in full at startup: starred, then recently opened, then ones already on screen; capped. */
export function keysToLoad(starred: string[], recent: string[], current: string[], cap = 60): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const k of [...starred, ...recent, ...current]) {
    const u = k.toUpperCase()
    if (!seen.has(u)) { seen.add(u); out.push(u) }
  }
  return out.slice(0, cap)
}
