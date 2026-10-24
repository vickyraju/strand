// Transition rules, the way Jira has them (Cloud's names; Data Center calls them conditions, validators and post functions):
//   Restrict  — who may use the transition at all; when not met it is hidden. Rules sit in groups that must all
//               ("Must be all") or any ("Can be any") be met, and groups can nest.
//   Validate  — checked when the move is made; it is refused with a message for each problem.
//   Screen    — fields (and a comment) to fill in while moving.
//   Actions   — changes made as part of the move, in the same transaction.
// Pure (no database, no React): the server enforces with it and the web app uses it to hide moves and explain refusals,
// so the two always agree. Shared by `server/src` and `src/data/transitionRules.ts`.

export type Who = 'assignee' | 'reporter' | 'lead'
export type Condition =
  | { kind: 'person'; who: Who }                                   // the mover is the item's assignee / reporter / the project lead
  | { kind: 'users'; userIds: string[] }                           // the mover is one of these people
  | { kind: 'role'; roles: ('admin' | 'member')[] }               // the mover has one of these project roles
  | { kind: 'group'; groupIds: string[] }                          // the mover is in one of these groups
  | { kind: 'field'; field: string; op: 'empty' | 'notEmpty' | 'is' | 'isNot'; value?: string | number }
  | { kind: 'childrenDone' }                                       // every child item is in a Done status
  | { kind: 'hidden' }                                             // nobody: only automation may use it
export interface ConditionGroup { op: 'all' | 'any'; items: (Condition | ConditionGroup)[] }

export type Validator =
  | { kind: 'required'; fields: string[] }                         // these fields (or 'comment') have a value after the move
  | { kind: 'changed'; field: string }                             // this field is changed in the move
  | { kind: 'parentStatus'; statusIds: string[] }                  // the parent item is in one of these statuses

export type Action =
  | { kind: 'assign'; to: 'mover' | 'reporter' | 'lead' | 'none' | 'user'; userId?: string }
  | { kind: 'set'; field: string; value: string | number | null } // null clears; 'today' sets a date field to today
  | { kind: 'copyFromParent'; field: string }
  | { kind: 'comment'; body: string }

export interface TransitionRules { restrict?: ConditionGroup; validate?: Validator[]; screen?: string[]; actions?: Action[] }

/** Jira's limits per transition. */
export const LIMITS = { groups: 10, rulesPerGroup: 50, validators: 50, actions: 50, depth: 3 }

/** Fields rules can name, with the words people see. Custom fields are `custom.<field id>`. */
export const RULE_FIELDS: Record<string, string> = {
  assigneeId: 'Assignee', priority: 'Priority', labels: 'Labels', dueDate: 'Due date', startDate: 'Start date',
  estimate: 'Estimate', timeEstimate: 'Time estimate', description: 'Description', releaseId: 'Release',
  sprintId: 'Sprint', resolution: 'Resolution', type: 'Type',
}
export const DATE_FIELDS = ['dueDate', 'startDate']
/** Fields an action may set (Assignee has its own action; Type changes the item's nature, so it is left to people). */
export const SETTABLE = ['priority', 'labels', 'dueDate', 'startDate', 'estimate', 'timeEstimate', 'releaseId', 'sprintId', 'resolution']

export const isRuleField = (f: string) => f in RULE_FIELDS || /^custom\.[0-9a-f-]{36}$/i.test(f)

/** A work item as rules read it: the issue's fields by name (server and web use the same names), custom values by id. */
export type Item = Record<string, unknown> & { custom?: Record<string, string | number> }

/** Who is moving the item, or null for automation. */
export interface Mover { id: string; role?: 'admin' | 'member' | 'viewer' | null; groupIds: string[] }

export interface RuleCtx {
  mover: Mover | null
  item: Item
  leadId: string | null
  /** Children of the item that are not in a Done status. */
  openChildren: number
  parent: (Item & { statusId: string }) | null
  /** Names for messages; the field label (RULE_FIELDS) is used when not given. */
  fieldName?: (field: string) => string
  statusName?: (id: string) => string
}

export const valueOf = (i: Item, field: string): unknown => (field.startsWith('custom.') ? i.custom?.[field.slice(7)] : i[field])
export const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const isGroup = (x: Condition | ConditionGroup): x is ConditionGroup => 'items' in x

function met(c: Condition, ctx: RuleCtx): boolean {
  const m = ctx.mover
  switch (c.kind) {
    // Automation has no person behind it: rules about who moves don't apply to it, and "hidden" is meant for it
    case 'hidden': return !m
    case 'person': {
      if (!m) return true
      const who = c.who === 'assignee' ? ctx.item.assigneeId : c.who === 'reporter' ? ctx.item.reporterId : ctx.leadId
      return !!who && who === m.id
    }
    case 'users': return !m || c.userIds.includes(m.id)
    case 'role': return !m || (!!m.role && (c.roles as string[]).includes(m.role))
    case 'group': return !m || c.groupIds.some(g => m.groupIds.includes(g))
    case 'childrenDone': return ctx.openChildren === 0
    case 'field': {
      const v = valueOf(ctx.item, c.field)
      if (c.op === 'empty') return isEmpty(v)
      if (c.op === 'notEmpty') return !isEmpty(v)
      const is = Array.isArray(v) ? v.includes(c.value) : v === c.value
      return c.op === 'is' ? is : !is
    }
  }
}

/** Does the Restrict part let this mover use the transition? No rules: anyone who may edit the item can. */
export function allows(g: ConditionGroup | undefined, ctx: RuleCtx): boolean {
  if (!g || g.items.length === 0) return true
  const each = (x: Condition | ConditionGroup) => (isGroup(x) ? allows(x, ctx) : met(x, ctx))
  return g.op === 'all' ? g.items.every(each) : g.items.some(each)
}

/** Problems with a move, by field (`comment`, `parent`, or a field name); empty when it may go ahead.
 *  `before` and `after` are the item before and after the move (with the fields filled in on the screen). */
export function problems(r: TransitionRules | undefined, ctx: RuleCtx, before: Item, after: Item, comment?: string): Record<string, string> {
  const out: Record<string, string> = {}
  const label = (f: string) => (f === 'comment' ? 'A comment' : ctx.fieldName?.(f) ?? RULE_FIELDS[f] ?? 'This field')
  for (const v of r?.validate ?? []) {
    if (v.kind === 'required') {
      for (const f of v.fields) if (f === 'comment' ? !comment?.trim() : isEmpty(valueOf(after, f))) out[f] ??= `${label(f)} is required for this move`
    } else if (v.kind === 'changed') {
      if (same(valueOf(before, v.field), valueOf(after, v.field))) out[v.field] ??= `Change ${label(v.field).toLowerCase()} as part of this move`
    } else if (v.kind === 'parentStatus') {
      if (!ctx.parent || !v.statusIds.includes(ctx.parent.statusId)) {
        const names = v.statusIds.map(id => ctx.statusName?.(id) ?? 'another status').join(' or ')
        out.parent ??= ctx.parent ? `The parent item must be in ${names} first` : 'This move is only for items with a parent'
      }
    }
  }
  return out
}

/** Can this be done in one step, without asking anything? (No screen and nothing to fix.) */
export const needsInput = (r: TransitionRules | undefined, ctx: RuleCtx, before: Item, after: Item) =>
  (r?.screen?.length ?? 0) > 0 || Object.keys(problems(r, ctx, before, after)).length > 0

export const today = (now = new Date()) => now.toISOString().slice(0, 10)

/** What the Actions part changes, given the item after the move: field changes (custom values as a whole `custom`) and
 *  comments to add. The caller applies them and checks what only it can (such as whether the new assignee is in the project). */
export function actionChanges(r: TransitionRules | undefined, ctx: RuleCtx, after: Item, now = new Date()): { patch: Item; comments: string[] } {
  const patch: Item = {}
  const comments: string[] = []
  let custom: Record<string, string | number> | undefined
  const put = (field: string, value: unknown) => {
    if (!field.startsWith('custom.')) { patch[field] = value; return }
    custom ??= { ...(after.custom ?? {}) }
    if (value == null || value === '') delete custom[field.slice(7)]
    else custom[field.slice(7)] = value as string | number
  }
  for (const a of r?.actions ?? []) {
    switch (a.kind) {
      case 'assign': {
        const to = a.to === 'mover' ? ctx.mover?.id : a.to === 'reporter' ? after.reporterId : a.to === 'lead' ? ctx.leadId : a.to === 'user' ? a.userId : null
        if (to !== undefined) patch.assigneeId = to ?? null
        break
      }
      case 'set': put(a.field, a.value === 'today' && DATE_FIELDS.includes(a.field) ? today(now) : a.value); break
      case 'copyFromParent': if (ctx.parent) put(a.field, valueOf(ctx.parent, a.field) ?? null); break
      case 'comment': if (a.body.trim()) comments.push(a.body); break
    }
  }
  if (custom) patch.custom = custom
  return { patch, comments }
}

/** Every rule in a Restrict group, however deeply nested. */
export const conditionsIn = (g: ConditionGroup | undefined): Condition[] =>
  !g ? [] : g.items.flatMap(x => (isGroup(x) ? conditionsIn(x) : [x]))
export const depthOf = (g: ConditionGroup): number => 1 + Math.max(0, ...g.items.filter(isGroup).map(depthOf))
export const groupsIn = (g: ConditionGroup): number => 1 + g.items.filter(isGroup).reduce((n, x) => n + groupsIn(x), 0)
export { isGroup }
