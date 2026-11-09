// Project keys as Jira checks them (spec 0308): a pattern from System settings › Project keys, anchored, and a maximum
// length. Shared by the server and the app.

export interface KeyRule { pattern: string; maxLength: number }
export const DEFAULT_KEY_RULE: KeyRule = { pattern: '[A-Z][A-Z]+', maxLength: 10 }

/** Does a key fit the rule? */
export const keyFits = (key: string, r: KeyRule) => key.length <= r.maxLength && new RegExp(`^(?:${r.pattern})$`).test(key)

/** A project key pattern Jira would accept (R3): it compiles, and keys it allows start with a capital letter and hold
 *  only A–Z, 0–9 and _ (tried on keys that must be refused). */
export function keyPatternOk(pattern: string) {
  try { new RegExp(pattern) } catch { return false }
  return !['1AB', '_AB', 'A-B', 'AB-1', 'A B', 'ab', 'Ab', 'AB.C', 'ÄB', ''].some(k => keyFits(k, { pattern, maxLength: 255 }))
}

/** The rule in words, as the create dialog shows it: Jira's default reads "2–10 capital letters". */
export function describeKeyRule(r: KeyRule) {
  return r.pattern === '[A-Z][A-Z]+' ? `2–${r.maxLength} capital letters`
    : r.pattern === '[A-Z][A-Z0-9]+' ? `2–${r.maxLength} capital letters and digits, starting with a letter`
    : `At most ${r.maxLength} characters, matching ${r.pattern}`
}
