// Finds issue keys in branch names, PR titles/bodies and commit messages. Pure: no database, no GitHub.
//
// - Keys come from the workspace's real project keys, so tokens like UTF-8 or SHA-256 never match.
// - Case-insensitive (branch names are lowercase); output keys are upper-case.
// - Closing words ("Fixes PAY-1, PAY-2") mark a link as closing. Only title/body/commit text is scanned
//   for them, never branch names.
// - "skip PAY-1" / "ignore PAY-1" in any source removes that key everywhere.

export type Via = 'branch' | 'title' | 'body' | 'commit'
export interface Source { via: Via; text: string }
export interface Link { key: string; via: Via; closing: boolean }

const CLOSING = 'clos(?:e[sd]?|ing)|fix(?:es|ed|ing)?|resolv(?:e[sd]?|ing)|complet(?:e[sd]?|ing)'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `sources` are in priority order: the first source that mentions a key is reported as its `via`. */
export function extractLinks(sources: Source[], projectKeys: string[]): Link[] {
  if (!projectKeys.length) return []
  const KEY = `(?<![A-Za-z0-9])(?:${projectKeys.map(escape).join('|')})-\\d+(?![0-9])`
  const norm = (k: string) => k.toUpperCase()
  const keysIn = (text: string) => [...text.matchAll(new RegExp(KEY, 'gi'))].map(m => norm(m[0]))

  const skipped = new Set<string>()
  const skipRe = new RegExp(`(?<![A-Za-z])(?:skip|ignore)\\s+(${KEY})`, 'gi')
  for (const s of sources) for (const m of s.text.matchAll(skipRe)) skipped.add(norm(m[1]!))

  const closingRe = new RegExp(`(?<![A-Za-z])(?:${CLOSING})\\s*:?\\s+(${KEY}(?:\\s*(?:,|and|&)\\s*${KEY})*)`, 'gi')
  const found = new Map<string, Link>()
  for (const s of sources) {
    const closing = new Set<string>()
    if (s.via !== 'branch') for (const m of s.text.matchAll(closingRe)) for (const k of keysIn(m[1]!)) closing.add(k)
    for (const key of keysIn(s.text)) {
      if (skipped.has(key)) continue
      const prev = found.get(key)
      if (!prev) found.set(key, { key, via: s.via, closing: closing.has(key) })
      else if (closing.has(key)) prev.closing = true
    }
  }
  return [...found.values()]
}

/** Branch name suggested for an issue: "pay-12-fix-login-redirect". */
export function branchName(key: string, title: string, maxLen = 60): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const name = `${key.toLowerCase()}${slug ? '-' + slug : ''}`
  return name.slice(0, maxLen).replace(/-+$/, '')
}
