import type { Issue } from './reducer.ts'

/** "1h 30m", "45m", "2d" (8h days) → minutes. Returns null when it can't be read. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60)  // bare number = hours
  let total = 0
  let matched = ''
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)/g)) {
    total += Number(m[1]) * (m[2] === 'd' ? 480 : m[2] === 'h' ? 60 : 1)
    matched += m[0]
  }
  return matched.replace(/\s/g, '') === s.replace(/\s/g, '') && total > 0 ? Math.round(total) : null
}

export function formatDuration(minutes: number) {
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60), m = minutes % 60
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ')
}

export const loggedMinutes = (i: Issue) => i.worklogs.reduce((n, w) => n + w.minutes, 0)

