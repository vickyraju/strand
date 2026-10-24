// Remaining estimate, as Jira tracks time: an item has an original estimate and a remaining one (minutes). Setting the
// original when there is no remaining one starts the remaining at the same value. Logging, changing or removing work
// adjusts the remaining estimate in one of Jira's four ways (its `adjustEstimate`). Shared by the server and the app.

export type Adjust =
  | { adjustEstimate: 'auto' }                              // reduce by the time logged (add it back when work is removed)
  | { adjustEstimate: 'leave' }                             // leave it as it is
  | { adjustEstimate: 'new'; newEstimate: number }          // set it to this
  | { adjustEstimate: 'manual'; reduceBy: number }          // reduce it by this (or, removing work, increase it by this)

/** The remaining estimate after `delta` minutes of work are logged (positive) or taken away (negative). Null stays null
 *  unless set: an item with no estimate has nothing to count down. */
export function adjustRemaining(remaining: number | null | undefined, delta: number, a: Adjust = { adjustEstimate: 'auto' }): number | null {
  const r = remaining ?? null
  switch (a.adjustEstimate) {
    case 'leave': return r
    case 'new': return Math.max(0, Math.round(a.newEstimate))
    case 'auto': return r === null ? null : Math.max(0, r - delta)
    case 'manual': return r === null ? null : Math.max(0, r - Math.sign(delta || 1) * a.reduceBy)
  }
}

/** Setting the original estimate: the remaining one starts at it when there isn't one yet. */
export const remainingWhenEstimated = (remaining: number | null | undefined, original: number | null | undefined) =>
  (remaining ?? null) === null && original != null ? original : remaining ?? null
