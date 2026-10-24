// The workflow as a plain value: statuses, the transitions between them, and where each status sits on the canvas.
// Pure (no React, no DOM): every operation returns a new Workflow, or the very same object when nothing changes,
// so the editor can keep undo history cheaply and tests can run under Node.
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre'
import { uid, type Category, type Status, type Transition } from './reducer.ts'

export interface Pos { x: number; y: number }
export interface Workflow { statuses: Status[]; transitions: Transition[]; layout: Record<string, Pos> }

/** Size of a status box on the canvas. The layout and the drawing both use it. */
export const NODE_W = 156
export const NODE_H = 40
const NEW_STATUS_COLOR = '#78716C'

export const sameWorkflow = (a: Workflow, b: Workflow) =>
  a === b || JSON.stringify([a.statuses, a.transitions, a.layout]) === JSON.stringify([b.statuses, b.transitions, b.layout])

// ── Statuses ─────────────────────────────────────────────

export interface NewStatus { id?: string; name: string; category?: Category; color?: string; global?: boolean }

/** Add a status before the Done ones (a Done status goes last). With `global` (the default) anything can move into it,
 *  and an in-progress status gets one way on, so it is usable straight away; without it the status starts unconnected. */
export function addStatus(w: Workflow, n: NewStatus): { workflow: Workflow; id: string } {
  const id = n.id ?? uid()
  const category = n.category ?? 'in-progress'
  const status: Status = { id, name: n.name, color: n.color ?? NEW_STATUS_COLOR, category }
  const at = category === 'done' ? -1 : w.statuses.findIndex(s => s.category === 'done')
  const statuses = at < 0 ? [...w.statuses, status] : [...w.statuses.slice(0, at), status, ...w.statuses.slice(at)]
  const transitions = [...w.transitions]
  if (n.global !== false) {
    transitions.push({ id: uid(), name: n.name, from: 'any', to: id })
    const next = category === 'done' ? undefined : w.statuses.find(s => s.category === 'in-progress') ?? w.statuses[0]
    if (next) transitions.push({ id: uid(), name: `Move to ${next.name}`, from: [id], to: next.id })
  }
  return { workflow: { ...w, statuses, transitions }, id }
}

/** Change a status. Renaming also renames the "from any status" transition that carries its name. */
export function updateStatus(w: Workflow, id: string, patch: Partial<Omit<Status, 'id'>>): Workflow {
  const old = w.statuses.find(s => s.id === id)
  if (!old || Object.entries(patch).every(([k, v]) => old[k as keyof Status] === v)) return w
  const transitions = patch.name !== undefined && patch.name !== old.name
    ? w.transitions.map(t => (t.to === id && t.from === 'any' && t.name === old.name ? { ...t, name: patch.name! } : t))
    : w.transitions
  return { ...w, statuses: w.statuses.map(s => (s.id === id ? { ...s, ...patch } : s)), transitions }
}

/** Remove a status and every transition into it or out of it. The last status cannot be removed. */
export function deleteStatus(w: Workflow, id: string): Workflow {
  if (w.statuses.length <= 1 || !w.statuses.some(s => s.id === id)) return w
  const transitions = w.transitions
    .filter(t => t.to !== id)
    .map(t => (t.from === 'any' ? t : { ...t, from: t.from.filter(f => f !== id) }))
    .filter(t => t.from === 'any' || t.from.length > 0)
  const { [id]: _gone, ...layout } = w.layout
  return { statuses: w.statuses.filter(s => s.id !== id), transitions, layout }
}

/** Move a status to a new position in the order. The order is the board's column order. */
export function moveStatus(w: Workflow, id: string, toIndex: number): Workflow {
  const from = w.statuses.findIndex(s => s.id === id)
  const to = Math.max(0, Math.min(w.statuses.length - 1, toIndex))
  if (from < 0 || from === to) return w
  const statuses = [...w.statuses]
  statuses.splice(to, 0, statuses.splice(from, 1)[0]!)
  return { ...w, statuses }
}

/** New work items start in the first status. */
export const setStart = (w: Workflow, id: string) => moveStatus(w, id, 0)

export const hasGlobal = (w: Workflow, statusId: string) => w.transitions.some(t => t.to === statusId && t.from === 'any')

/** "Allow all statuses to move here". */
export function setGlobal(w: Workflow, statusId: string, on: boolean): Workflow {
  const status = w.statuses.find(s => s.id === statusId)
  if (!status || hasGlobal(w, statusId) === on) return w
  return {
    ...w,
    transitions: on
      ? [...w.transitions, { id: uid(), name: status.name, from: 'any', to: statusId }]
      : w.transitions.filter(t => !(t.to === statusId && t.from === 'any')),
  }
}

export function moveNode(w: Workflow, id: string, pos: Pos): Workflow {
  const p = { x: Math.round(pos.x), y: Math.round(pos.y) }
  const old = w.layout[id]
  return old && old.x === p.x && old.y === p.y ? w : { ...w, layout: { ...w.layout, [id]: p } }
}

// ── Transitions ──────────────────────────────────────────

/** A move never starts where it ends (a loop, `to` null, stays where it starts), and a status is listed once. */
const cleanFrom = (from: string[] | 'any', to: string | null) => (from === 'any' ? 'any' : [...new Set(from)].filter(f => f !== to))

export function addTransition(w: Workflow, t: { name: string; from: string[] | 'any'; to: string | null }): { workflow: Workflow; id?: string } {
  const from = cleanFrom(t.from, t.to)
  if (from !== 'any' && from.length === 0) return { workflow: w }
  const id = uid()
  return { workflow: { ...w, transitions: [...w.transitions, { id, name: t.name, from, to: t.to }] }, id }
}

/** Draw a move from one status to another (dragging between two boxes). If the workflow already allows it, nothing is
 *  added and the existing transition is returned so it can be selected. */
export function connect(w: Workflow, fromId: string, toId: string, name?: string): { workflow: Workflow; id?: string; created: boolean } {
  const target = w.statuses.find(s => s.id === toId)
  if (fromId === toId || !target || !w.statuses.some(s => s.id === fromId)) return { workflow: w, created: false }
  const existing = w.transitions.find(t => t.to === toId && (t.from === 'any' || t.from.includes(fromId)))
  if (existing) return { workflow: w, id: existing.id, created: false }
  return { ...addTransition(w, { name: name?.trim() || target.name, from: [fromId], to: toId }), created: true }
}

export function updateTransition(w: Workflow, id: string, patch: Partial<Pick<Transition, 'name' | 'from' | 'to' | 'rules' | 'types'>>): Workflow {
  const old = w.transitions.find(t => t.id === id)
  if (!old) return w
  const to = patch.to !== undefined ? patch.to : old.to
  const next: Transition = { ...old, name: patch.name ?? old.name, to, from: cleanFrom(patch.from ?? old.from, to), ...(patch.rules !== undefined ? { rules: patch.rules } : {}) }
  if ('types' in patch) { if (patch.types?.length) next.types = patch.types; else delete next.types }
  if (next.name === old.name && next.to === old.to && JSON.stringify(next.from) === JSON.stringify(old.from) && JSON.stringify(next.rules) === JSON.stringify(old.rules)
    && JSON.stringify(next.types) === JSON.stringify(old.types)) return w
  return { ...w, transitions: w.transitions.map(t => (t.id === id ? next : t)) }
}

export const removeTransition = (w: Workflow, id: string): Workflow =>
  w.transitions.some(t => t.id === id) ? { ...w, transitions: w.transitions.filter(t => t.id !== id) } : w

/** Drag the arrow head to another status. The whole transition moves, so every From status now leads there.
 *  Refused (unchanged) when that would leave it with no From status. */
export function reconnectTarget(w: Workflow, id: string, newTo: string): Workflow {
  const t = w.transitions.find(x => x.id === id)
  if (!t || t.to === newTo || !w.statuses.some(s => s.id === newTo)) return w
  const from = cleanFrom(t.from, newTo)
  return from !== 'any' && from.length === 0 ? w : updateTransition(w, id, { to: newTo })
}

/** Drag the arrow tail to another status: that From status is replaced, the others stay. */
export function reconnectSource(w: Workflow, id: string, oldFrom: string, newFrom: string): Workflow {
  const t = w.transitions.find(x => x.id === id)
  if (!t || t.from === 'any' || !t.from.includes(oldFrom) || oldFrom === newFrom || !w.statuses.some(s => s.id === newFrom)) return w
  const from = cleanFrom(t.from.map(f => (f === oldFrom ? newFrom : f)), t.to)
  return from.length === 0 ? w : updateTransition(w, id, { from })
}

/** Every transition that starts or ends at a status: what disappears with it when it is deleted. */
export const transitionsTouching = (w: Workflow, statusId: string) =>
  w.transitions.filter(t => t.to === statusId || (t.from !== 'any' && t.from.includes(statusId)))

/** The workflow being edited, plus where the work items of each deleted status are to be moved when it is saved. */
export interface Draft { workflow: Workflow; moves: Record<string, string> }

/** Delete a status and remember where its work items go. */
export function deleteStatusMoving(d: Draft, id: string, moveTo: string): Draft {
  const workflow = deleteStatus(d.workflow, id)
  return workflow === d.workflow ? d : { workflow, moves: { ...d.moves, [id]: moveTo } }
}

/** Where a deleted status's work items finally go. If the chosen status was itself deleted later, follow its move too.
 *  Undefined when the chain leads nowhere that still exists (the caller then picks the start status). */
export function resolveMove(moves: Record<string, string>, id: string, exists: (id: string) => boolean): string | undefined {
  const seen = new Set<string>([id])
  for (let next = moves[id]; next && !seen.has(next); next = moves[next]) {
    if (exists(next)) return next
    seen.add(next)
  }
  return undefined
}

// ── Reading the graph ────────────────────────────────────

/** One arrow on the canvas. A transition with several From statuses is several arrows; "any status" is not drawn as arrows. */
export interface WorkflowEdge { id: string; transitionId: string; from: string; to: string; name: string }

export function edgesOf(w: Workflow): WorkflowEdge[] {
  const ids = new Set(w.statuses.map(s => s.id))
  return w.transitions.flatMap(t => (t.from === 'any' || t.to === null || !ids.has(t.to)
    ? []
    : t.from.filter(f => ids.has(f)).map(f => ({ id: `${t.id}:${f}`, transitionId: t.id, from: f, to: t.to as string, name: t.name }))))
}

/** How far to bend each arrow sideways so arrows between the same two statuses do not sit on top of each other:
 *  opposite directions go to opposite sides, and several the same way fan out. */
export function edgeOffsets(edges: WorkflowEdge[]): Map<string, number> {
  const groups = new Map<string, WorkflowEdge[]>()
  for (const e of edges) groups.set(`${e.from}>${e.to}`, [...(groups.get(`${e.from}>${e.to}`) ?? []), e])
  const out = new Map<string, number>()
  for (const [key, list] of groups) {
    const [from, to] = key.split('>') as [string, string]
    const hasReverse = groups.has(`${to}>${from}`)
    const side = hasReverse ? (from < to ? 1 : -1) : 0
    list.forEach((e, i) => out.set(e.id, i - (list.length - 1) / 2 + side))
  }
  return out
}

/** Statuses work can reach: the start status, anything that "any status" can move into, and everything those lead on to. */
export function reachable(w: Workflow): Set<string> {
  const ids = new Set(w.statuses.map(s => s.id))
  const seen = new Set<string>()
  const queue: string[] = []
  const visit = (id: string) => { if (ids.has(id) && !seen.has(id)) { seen.add(id); queue.push(id) } }
  if (w.statuses[0]) visit(w.statuses[0].id)
  for (const t of w.transitions) if (t.from === 'any' && t.to) visit(t.to)
  while (queue.length) {
    const id = queue.pop()!
    for (const t of w.transitions) if (t.from !== 'any' && t.from.includes(id) && t.to) visit(t.to)
  }
  return seen
}

// ── Checking ─────────────────────────────────────────────

export interface WorkflowIssue {
  level: 'error' | 'warning'
  code: 'no-statuses' | 'no-done' | 'blank-name' | 'duplicate-name' | 'unreachable' | 'dead-end' | 'blank-transition-name' | 'transition-no-from' | 'start-is-done'
  message: string
  /** What to select when the person clicks the message. */
  target?: { kind: 'status' | 'transition'; id: string }
}

/** Errors block saving; warnings do not. */
export function validateWorkflow(w: Workflow): WorkflowIssue[] {
  const errors: WorkflowIssue[] = []
  const warnings: WorkflowIssue[] = []
  if (w.statuses.length === 0) return [{ level: 'error', code: 'no-statuses', message: 'Add at least one status.' }]
  if (!w.statuses.some(s => s.category === 'done'))
    errors.push({ level: 'error', code: 'no-done', message: 'Add at least one status in the Done category so work can be finished.' })

  const names = new Set<string>()
  for (const s of w.statuses) {
    const key = s.name.trim().toLowerCase()
    if (!key) errors.push({ level: 'error', code: 'blank-name', message: 'Every status needs a name.', target: { kind: 'status', id: s.id } })
    else if (names.has(key)) errors.push({ level: 'error', code: 'duplicate-name', message: `“${s.name.trim()}” is used by more than one status.`, target: { kind: 'status', id: s.id } })
    names.add(key)
  }

  const reach = reachable(w)
  for (const s of w.statuses) {
    if (!reach.has(s.id)) errors.push({ level: 'error', code: 'unreachable', message: `“${s.name}” can’t be reached. Add a transition into it.`, target: { kind: 'status', id: s.id } })
    if (s.category !== 'done' && !w.transitions.some(t => t.to !== null && t.to !== s.id && (t.from === 'any' || t.from.includes(s.id))))
      errors.push({ level: 'error', code: 'dead-end', message: `Work can’t leave “${s.name}”. Add a transition out of it.`, target: { kind: 'status', id: s.id } })
  }

  for (const t of w.transitions) {
    if (!t.name.trim()) errors.push({ level: 'error', code: 'blank-transition-name', message: 'Every transition needs a name.', target: { kind: 'transition', id: t.id } })
    if (t.from !== 'any' && t.from.length === 0) errors.push({ level: 'error', code: 'transition-no-from', message: `“${t.name || 'Transition'}” has no From status.`, target: { kind: 'transition', id: t.id } })
  }

  if (w.statuses[0]!.category === 'done')
    warnings.push({ level: 'warning', code: 'start-is-done', message: `New work items start in “${w.statuses[0]!.name}”, which is a Done status.`, target: { kind: 'status', id: w.statuses[0]!.id } })
  return [...errors, ...warnings]
}

// ── Layout ───────────────────────────────────────────────

/** Left-to-right positions (top-left corners, snapped to a 10 px grid) for every status, with the Start marker kept on
 *  the left. "Any status" transitions are left out so they do not turn the picture into a tangle; a status that has no
 *  arrows at all is placed after the one before it in the status order, so a workflow made only of "any status" moves
 *  still reads left to right in board order. Same input, same output. */
export function autoLayout(w: Workflow): Record<string, Pos> {
  if (w.statuses.length === 0) return {}
  const START = '\u0000start'
  const g = new graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setNode(START, { width: 44, height: 44 })
  for (const s of w.statuses) g.setNode(s.id, { width: NODE_W, height: NODE_H })
  g.setEdge(START, w.statuses[0]!.id)
  const edges = edgesOf(w)
  g.setGraph({ rankdir: 'LR', ranksep: edges.length ? 150 : 70, nodesep: 40, marginx: 0, marginy: 0 })   // arrow labels need room between the boxes
  for (const e of edges) g.setEdge(e.from, e.to)
  const joined = new Set(edges.flatMap(e => [e.from, e.to]))
  w.statuses.forEach((s, i) => { if (i > 0 && !joined.has(s.id)) g.setEdge(w.statuses[i - 1]!.id, s.id) })
  dagreLayout(g)

  const raw = w.statuses.map(s => { const n = g.node(s.id)!; return [s.id, n.x - NODE_W / 2, n.y - NODE_H / 2] as const })
  const minX = Math.min(...raw.map(r => r[1])), minY = Math.min(...raw.map(r => r[2]))
  const snap = (v: number) => Math.round(v / 10) * 10
  return Object.fromEntries(raw.map(([id, x, y]) => [id, { x: snap(x - minX + 120), y: snap(y - minY + 60) }]))
}

/** Where every status is drawn: its saved position where there is one, auto layout when nothing is saved yet, and a place
 *  to the right of everything saved for any status that has none (so a new status never lands on top of another). */
export function positionsOf(w: Workflow): Record<string, Pos> {
  const saved = w.statuses.filter(s => w.layout[s.id])
  if (saved.length === 0) return autoLayout(w)
  const out: Record<string, Pos> = Object.fromEntries(saved.map(s => [s.id, w.layout[s.id]!]))
  const x = Math.max(...saved.map(s => w.layout[s.id]!.x)) + NODE_W + 90
  const top = Math.min(...saved.map(s => w.layout[s.id]!.y))
  w.statuses.filter(s => !out[s.id]).forEach((s, row) => { out[s.id] = { x, y: top + row * (NODE_H + 36) } })
  return out
}

// ── Undo / redo ──────────────────────────────────────────

export interface History<T> { past: T[]; present: T; future: T[]; lastKey?: string; lastAt?: number }
const MAX_UNDO = 100

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] })
export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0

/** Record a new state. Changes with the same `coalesce` key within `windowMs` (default 800 ms) are one undo step, so a
 *  drag or a burst of typing is undone in one go. Passing the same object again is not a change. */
export function pushHistory<T>(h: History<T>, next: T, o: { coalesce?: string; at?: number; windowMs?: number } = {}): History<T> {
  if (next === h.present) return h
  const at = o.at ?? Date.now()
  const joins = o.coalesce !== undefined && o.coalesce === h.lastKey && h.lastAt !== undefined && at - h.lastAt < (o.windowMs ?? 800)
  return {
    past: joins ? h.past : [...h.past, h.present].slice(-MAX_UNDO),
    present: next, future: [], lastKey: o.coalesce, lastAt: at,
  }
}

export function undo<T>(h: History<T>): History<T> {
  if (!canUndo(h)) return h
  return { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] }
}

export function redo<T>(h: History<T>): History<T> {
  if (!canRedo(h)) return h
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) }
}

/** Replace the current state and forget the history (after saving or discarding). */
export const resetHistory = <T>(present: T): History<T> => startHistory(present)

// ── Comparing (saving shows what changes; versions compare with each other) ──

export interface WorkflowDiff {
  statusesAdded: Status[]; statusesRemoved: Status[]; statusesRenamed: { from: string; to: string }[]; statusesChanged: Status[]
  transitionsAdded: Transition[]; transitionsRemoved: Transition[]; transitionsChanged: Transition[]
}

/** What changes going from one workflow to another, matched by id. Layout (where boxes sit) is not a change. */
export function diffWorkflows(a: Pick<Workflow, 'statuses' | 'transitions'>, b: Pick<Workflow, 'statuses' | 'transitions'>): WorkflowDiff {
  const sa = new Map(a.statuses.map(s => [s.id, s])), sb = new Map(b.statuses.map(s => [s.id, s]))
  const ta = new Map(a.transitions.map(t => [t.id, t])), tb = new Map(b.transitions.map(t => [t.id, t]))
  const both = b.statuses.filter(s => sa.has(s.id))
  const rest = (s: Status) => { const { name: _n, ...x } = s; return JSON.stringify(x) }
  return {
    statusesAdded: b.statuses.filter(s => !sa.has(s.id)),
    statusesRemoved: a.statuses.filter(s => !sb.has(s.id)),
    statusesRenamed: both.filter(s => sa.get(s.id)!.name !== s.name).map(s => ({ from: sa.get(s.id)!.name, to: s.name })),
    statusesChanged: both.filter(s => rest(sa.get(s.id)!) !== rest(s)),
    transitionsAdded: b.transitions.filter(t => !ta.has(t.id)),
    transitionsRemoved: a.transitions.filter(t => !tb.has(t.id)),
    transitionsChanged: b.transitions.filter(t => ta.has(t.id) && JSON.stringify(ta.get(t.id)) !== JSON.stringify(t)),
  }
}

/** The diff as sentences, for people. Empty when nothing changes. */
export function describeDiff(d: WorkflowDiff): string[] {
  const names = (xs: { name: string }[]) => xs.map(x => `“${x.name}”`).join(', ')
  const out: string[] = []
  if (d.statusesAdded.length) out.push(`Adds ${d.statusesAdded.length === 1 ? 'the status' : 'statuses'} ${names(d.statusesAdded)}`)
  if (d.statusesRemoved.length) out.push(`Removes ${d.statusesRemoved.length === 1 ? 'the status' : 'statuses'} ${names(d.statusesRemoved)}`)
  for (const r of d.statusesRenamed) out.push(`Renames “${r.from}” to “${r.to}”`)
  if (d.statusesChanged.length) out.push(`Changes ${names(d.statusesChanged)} (category, colour, description, WIP limit or position)`)
  if (d.transitionsAdded.length) out.push(`Adds ${d.transitionsAdded.length === 1 ? 'the transition' : 'transitions'} ${names(d.transitionsAdded)}`)
  if (d.transitionsRemoved.length) out.push(`Removes ${d.transitionsRemoved.length === 1 ? 'the transition' : 'transitions'} ${names(d.transitionsRemoved)}`)
  if (d.transitionsChanged.length) out.push(`Changes ${d.transitionsChanged.length === 1 ? 'the transition' : 'transitions'} ${names(d.transitionsChanged)} (where it goes, its rules or work types)`)
  return out
}
