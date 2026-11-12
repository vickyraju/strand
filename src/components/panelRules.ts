// The backlog's Epics and Versions panels (spec 0407): Jira's epic colours, what dropping items on an epic or a version
// does, and the panel filters. Plain functions, unit-tested; BacklogPanels.tsx draws them.

/** Jira's fourteen epic colours (ghx-label-1 … 14), as on its boards. */
export const EPIC_COLORS: Record<string, string> = {
  'ghx-label-1': '#815B3A', 'ghx-label-2': '#F79232', 'ghx-label-3': '#D39C3F', 'ghx-label-4': '#3B7FC4', 'ghx-label-5': '#4A6785',
  'ghx-label-6': '#8EB021', 'ghx-label-7': '#AC707A', 'ghx-label-8': '#654982', 'ghx-label-9': '#F15C75', 'ghx-label-10': '#2A8735',
  'ghx-label-11': '#46A4AF', 'ghx-label-12': '#707070', 'ghx-label-13': '#84BD5D', 'ghx-label-14': '#E0A400',
}
const LABELS = Object.keys(EPIC_COLORS)

/** An epic's colour: its own, else one picked from its key, so it is the same everywhere (R6). */
export function epicColor(e: { key: string; epicColor?: string }) {
  if (e.epicColor && EPIC_COLORS[e.epicColor]) return EPIC_COLORS[e.epicColor]!
  let h = 0
  for (const c of e.key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return EPIC_COLORS[LABELS[h % LABELS.length]!]!
}

/** A filter chosen in a panel: everything, items without one, or one epic or version. */
export type PanelFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'one'; id: string }
export const ALL: PanelFilter = { kind: 'all' }

interface Item { id: string; key: string; type: string; parentId?: string; fixReleaseIds?: string[] }

/** R3, R8: the items a panel filter keeps. An item's epic is its parent when that is an epic. */
export function panelFilter<I extends Item>(items: I[], o: { epic: PanelFilter; version: PanelFilter; isEpic: (id: string) => boolean }) {
  const epicOf = (i: I) => (i.parentId && o.isEpic(i.parentId) ? i.parentId : null)
  const keep = (f: PanelFilter, v: string | null, vs?: string[]) =>
    f.kind === 'all' || (f.kind === 'none' ? (vs ? !vs.length : !v) : vs ? vs.includes(f.id) : v === f.id)
  return items.filter(i => keep(o.epic, epicOf(i)) && keep(o.version, null, i.fixReleaseIds ?? []))
}

/** R4: dropped on an epic (or on "Issues without epics", null): the new parent of each item, all or none. Epics and
 *  sub-items can't go under an epic (spec 0303); an item already there is left as it is. */
export function planEpicDrop<I extends Item>(items: I[], epicId: string | null, o: { isEpic: (id: string) => boolean; isSubItem: (i: I) => boolean }):
  { moves: { id: string; parentId: string | null }[] } | { blocked: string } {
  const moves: { id: string; parentId: string | null }[] = []
  for (const i of items) {
    if (epicId && i.type === 'epic') return { blocked: `${i.key} is an epic: an epic has no parent` }
    if (o.isSubItem(i)) return { blocked: `${i.key} is a sub-item: its parent stays its own` }
    const now = i.parentId && o.isEpic(i.parentId) ? i.parentId : null
    if (now !== epicId) moves.push({ id: i.id, parentId: epicId })
  }
  return { moves }
}

/** R9: dropped on a version, it joins each item's fix versions; on "Issues without versions" (null), they are cleared. */
export function planVersionDrop<I extends Item>(items: I[], versionId: string | null) {
  return items.flatMap(i => {
    const now = i.fixReleaseIds ?? []
    const next = versionId ? (now.includes(versionId) ? now : [...now, versionId]) : []
    return next.length === now.length && next.every((v, k) => v === now[k]) ? [] : [{ id: i.id, fixReleaseIds: next }]
  })
}

/** Drop targets of the panels, beside the backlog's own. */
export const epicTarget = (id: string | null) => `epic:${id ?? 'none'}`
export const versionTarget = (id: string | null) => `version:${id ?? 'none'}`
export function panelTarget(over: string): { kind: 'epic' | 'version'; id: string | null } | null {
  const [kind, id] = [over.slice(0, over.indexOf(':')), over.slice(over.indexOf(':') + 1)]
  return kind === 'epic' || kind === 'version' ? { kind, id: id === 'none' ? null : id } : null
}
