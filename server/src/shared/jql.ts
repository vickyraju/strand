// A subset of JQL, Jira's query language, so teams keep writing (and bringing over) the filters they know:
//   project = PAY AND (status = "In progress" OR priority in (high, urgent)) AND assignee = currentUser() ORDER BY created DESC
// Clauses: field op value. Ops: = != in, not in, ~ !~ (text contains), > >= < <= (numbers and dates), is empty, is not empty.
// Values: words, "quoted text", numbers, dates (2026-10-01), relative dates (-7d, 2w, 1h), and functions: currentUser(),
// now(), currentLogin(), lastLogin(), startOf/endOf Day, Week, Month, Year (with Jira's increment, startOfMonth(-1)), open, closed and
// future sprints, released and unreleased versions, linkedIssues(), watchedIssues(), issueHistory(), updatedBy(), membersOf("group"), and Xray's test functions:
// issue in requirementTests("PAY-1"), testRequirements(…), testSetTests(…), testPlanTests("PAY-9", "FAIL"), testExecutionTests(…).
// History (spec 0602): status WAS "In Progress", WAS IN (…), WAS NOT, WAS NOT IN, assignee CHANGED, each followed by
// AFTER d, BEFORE d, ON d, DURING (d1, d2), BY person or BY (p1, p2); CHANGED also takes FROM v and TO v.
// Combine with AND, OR, NOT and parentheses; sort with ORDER BY field [ASC|DESC], …  Pure: parsed here, run elsewhere.

export type Op = '=' | '!=' | 'in' | 'not in' | '~' | '!~' | '>' | '>=' | '<' | '<=' | 'is empty' | 'is not empty'
  | 'was' | 'was in' | 'was not' | 'was not in' | 'changed'
export type Value = { kind: 'text'; text: string } | { kind: 'fn'; name: string; arg?: string; args?: string[] }
/** The predicates after WAS… and CHANGED (spec 0602 R3). */
export interface History { after?: Value; before?: Value; on?: Value; during?: [Value, Value]; by?: Value[]; from?: Value; to?: Value }
export interface Clause { kind: 'clause'; field: string; op: Op; values: Value[]; history?: History }
export interface Not { kind: 'not'; item: Node }
export interface Group { kind: 'and' | 'or'; items: Node[] }
export type Node = Clause | Not | Group
export interface Sort { field: string; dir: 'asc' | 'desc' }
export interface Query { where: Node | null; orderBy: Sort[] }

export class JqlError extends Error {
  at: number
  constructor(message: string, at: number) { super(message); this.at = at }
}

/** The fields JQL knows (with Jira's other names for them). Anything else is read as a custom field's name. */
export const FIELDS: Record<string, string> = {
  project: 'project', key: 'key', issuekey: 'key', id: 'key', issue: 'key',
  type: 'type', issuetype: 'type', status: 'status', statuscategory: 'statusCategory', priority: 'priority',
  assignee: 'assignee', reporter: 'reporter', labels: 'labels', label: 'labels', component: 'component', components: 'component',
  fixversion: 'fixVersion', release: 'fixVersion', affectedversion: 'affectedVersion', affectsversion: 'affectedVersion',
  sprint: 'sprint', parent: 'parent', epic: 'parent', resolution: 'resolution', flagged: 'flagged', category: 'category', projectcategory: 'category', 'epic status': 'epicStatus', epicstatus: 'epicStatus',
  text: 'text', summary: 'summary', title: 'summary', description: 'description',
  created: 'created', createddate: 'created', updated: 'updated', updateddate: 'updated', resolved: 'resolved', resolutiondate: 'resolved',
  due: 'due', duedate: 'due', start: 'start', startdate: 'start',
  storypoints: 'estimate', 'story points': 'estimate', estimate: 'estimate', originalestimate: 'timeEstimate', remainingestimate: 'timeRemaining',
  // Jira's development fields (spec 0707); builds, deployments and reviews come from tools Strand doesn't connect yet
  votes: 'votes', voter: 'voter', voters: 'voter', watcher: 'watcher', watchers: 'watchers',
  'development[commits].all': 'devCommits', 'development[branches].all': 'devBranches', 'development[pullrequests].all': 'devPrs',
  'development[pullrequests].open': 'devPrsOpen', 'development[pullrequests].merged': 'devPrsMerged', 'development[pullrequests].declined': 'devPrsDeclined',
  'development[pullrequests].status': 'devPrStatus',
  'development[builds].all': 'devNone', 'development[builds].failing': 'devNone', 'development[builds].passing': 'devNone', 'development[builds].status': 'devNoneText',
  'development[deployments].all': 'devNone', 'development[deployments].deployed': 'devNone', 'development[deployments].environment': 'devNoneText',
  'development[reviews].all': 'devNone', 'development[reviews].open': 'devNone',
}
/** Fields people sort by. */
export const SORTS = ['created', 'updated', 'priority', 'due', 'key', 'rank', 'status', 'resolved', 'summary', 'estimate', 'votes']

interface Tok { t: 'word' | 'str' | 'op' | '(' | ')' | ','; v: string; at: number }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c, v: c, at: i }); i++; continue }
    if (c === '"' || c === "'") {
      let j = i + 1, v = ''
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) j++; v += src[j]; j++ }
      if (j >= src.length) throw new JqlError('A quote is not closed', i)
      out.push({ t: 'str', v, at: i }); i = j + 1; continue
    }
    const two = src.slice(i, i + 2)
    if (['!=', '!~', '>=', '<='].includes(two)) { out.push({ t: 'op', v: two, at: i }); i += 2; continue }
    if ('=~<>'.includes(c)) { out.push({ t: 'op', v: c, at: i }); i++; continue }
    const m = /^[^\s()",'=!~<>]+/.exec(src.slice(i))
    if (!m) throw new JqlError(`Unexpected “${c}”`, i)
    out.push({ t: 'word', v: m[0], at: i }); i += m[0].length
  }
  return out
}

/** Parse a JQL query. Throws JqlError with the position of the problem. */
export function parseJql(src: string): Query {
  const toks = lex(src)
  let p = 0
  const peek = (o = 0) => toks[p + o]
  const kw = (w: string, o = 0) => peek(o)?.t === 'word' && peek(o)!.v.toLowerCase() === w
  const end = () => (toks.length ? toks[toks.length - 1]!.at + toks[toks.length - 1]!.v.length : 0)
  const fail = (msg: string, t = peek()): never => { throw new JqlError(msg, t?.at ?? end()) }

  const value = (): Value => {
    const t = peek()
    if (!t || (t.t !== 'word' && t.t !== 'str')) return fail('Expected a value')
    p++
    if (t.t === 'word' && peek()?.t === '(') {                       // a function: name(…)
      p++
      const args: string[] = []
      while (peek()?.t === 'word' || peek()?.t === 'str') {
        args.push(toks[p++]!.v)
        if (peek()?.t === ',') p++
        else break
      }
      if (peek()?.t !== ')') fail('Expected “)” to close the function')
      p++
      const name = t.v.toLowerCase()
      return !args.length ? { kind: 'fn', name } : args.length === 1 ? { kind: 'fn', name, arg: args[0] } : { kind: 'fn', name, arg: args[0], args }
    }
    return { kind: 'text', text: t.v }
  }
  /** ( value, value, … ) */
  const list = (): Value[] => {
    if (peek()?.t !== '(') fail('Expected “(” and a list, such as (high, urgent)')
    p++
    const values = [value()]
    while (peek()?.t === ',') { p++; values.push(value()) }
    if (peek()?.t !== ')') fail('Expected “)” to close the list')
    p++
    return values
  }
  const predicates = (changed: boolean): History => {
    const h: History = {}
    for (;;) {
      if (kw('after') || kw('before') || kw('on') || changed && (kw('from') || kw('to'))) { const k = toks[p++]!.v.toLowerCase() as 'after'; h[k] = value() }
      else if (kw('during')) {
        p++
        const d = list()
        if (d.length !== 2) fail('DURING takes two dates, such as DURING ("2026-01-01", "2026-02-01")', toks[p - 1])
        h.during = [d[0]!, d[1]!]
      } else if (kw('by')) { p++; h.by = peek()?.t === '(' ? list() : [value()] }
      else return h
    }
  }
  const clause = (): Node => {
    if (kw('not')) { p++; return { kind: 'not', item: clause() } }
    if (peek()?.t === '(') {
      p++
      const n = or()
      if (peek()?.t !== ')') fail('Expected “)”')
      p++
      return n
    }
    const f = peek()
    if (!f || (f.t !== 'word' && f.t !== 'str')) return fail('Expected a field, such as status or assignee')
    p++
    let field = f.v
    // cf[uuid] and "Custom field name"
    const known = FIELDS[field.toLowerCase()]
    field = known ?? (/^cf\[.+\]$/i.test(field) ? `cf:${field.slice(3, -1)}` : `custom:${field}`)
    let op: Op
    if (kw('was')) {
      p++
      op = kw('not') ? (kw('in', 1) ? 'was not in' : 'was not') : kw('in') ? 'was in' : 'was'
      p += op === 'was' ? 0 : op === 'was not in' ? 2 : 1
      const values = op.endsWith(' in') ? list() : [value()]
      return { kind: 'clause', field, op, values, history: predicates(false) }
    }
    if (kw('changed')) { p++; return { kind: 'clause', field, op: 'changed', values: [], history: predicates(true) } }
    if (peek()?.t === 'op') op = toks[p++]!.v as Op
    else if (kw('in')) { p++; op = 'in' }
    else if (kw('not') && kw('in', 1)) { p += 2; op = 'not in' }
    else if (kw('is') && kw('empty', 1)) { p += 2; return { kind: 'clause', field, op: 'is empty', values: [] } }
    else if (kw('is') && kw('not', 1) && kw('empty', 2)) { p += 3; return { kind: 'clause', field, op: 'is not empty', values: [] } }
    else if (kw('is') && (kw('null', 1) || kw('not', 1) && kw('null', 2))) { const neg = kw('not', 1); p += neg ? 3 : 2; return { kind: 'clause', field, op: neg ? 'is not empty' : 'is empty', values: [] } }
    else return fail(`Expected an operator after ${f.v}: =, !=, in, ~, >, <, is empty, was, changed…`)
    if (op === 'in' || op === 'not in') {
      // a function that stands for a list, as in Jira: issue in testPlanTests("PAY-9"), sprint in openSprints()
      if (peek()?.t === 'word' && peek(1)?.t === '(') return { kind: 'clause', field, op, values: [value()] }
      return { kind: 'clause', field, op, values: list() }
    }
    return { kind: 'clause', field, op, values: [value()] }
  }
  const and = (): Node => {
    const items = [clause()]
    while (kw('and') || peek()?.t === 'word' && peek()!.v === '&&') { p++; items.push(clause()) }
    return items.length === 1 ? items[0]! : { kind: 'and', items }
  }
  const or = (): Node => {
    const items = [and()]
    while (kw('or') || peek()?.t === 'word' && peek()!.v === '||') { p++; items.push(and()) }
    return items.length === 1 ? items[0]! : { kind: 'or', items }
  }

  const where = toks.length && !kw('order') ? or() : null
  const orderBy: Sort[] = []
  if (kw('order')) {
    p++
    if (!kw('by')) fail('Expected BY after ORDER')
    p++
    do {
      if (peek()?.t === ',') p++
      const t = peek()
      if (!t || t.t === ',') return fail('Expected a field to sort by')
      p++
      const field = FIELDS[t.v.toLowerCase()] ?? t.v
      if (!SORTS.includes(field)) fail(`Can’t sort by ${t.v}: use ${SORTS.join(', ')}`, t)
      let dir: 'asc' | 'desc' = field === 'created' || field === 'updated' ? 'desc' : 'asc'
      if (kw('asc') || kw('desc')) dir = toks[p++]!.v.toLowerCase() as 'asc' | 'desc'
      orderBy.push({ field, dir })
    } while (peek()?.t === ',')
  }
  if (p < toks.length) fail(`Unexpected “${peek()!.v}”: join clauses with AND or OR`)
  return { where, orderBy }
}

/** A relative date ("-7d", "2w", "-1h", "0d") as milliseconds from now, or null. Jira's units: w d h m. */
export function relative(text: string): number | null {
  const m = /^([+-]?)(\d+)([wdhm])$/i.exec(text.trim())
  if (!m) return null
  const unit = { w: 7 * 86_400_000, d: 86_400_000, h: 3_600_000, m: 60_000 }[m[3]!.toLowerCase() as 'w' | 'd' | 'h' | 'm']
  return (m[1] === '-' ? -1 : 1) * Number(m[2]) * unit
}

/** JQL for simple search filters, so switching to JQL starts from what was chosen. */
export function filtersToJql(f: { projectKey?: string; assignee?: string | null; assigneeName?: string; type?: string; priority?: string; label?: string; resolution?: 'open' | 'done' | 'all'; q?: string }) {
  const q = (s: string) => (/^[A-Za-z0-9_.@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`)
  const parts: string[] = []
  if (f.projectKey) parts.push(`project = ${f.projectKey}`)
  if (f.assignee === 'me') parts.push('assignee = currentUser()')
  else if (f.assignee === '') parts.push('assignee is empty')
  else if (f.assignee && f.assigneeName) parts.push(`assignee = ${q(f.assigneeName)}`)
  if (f.type) parts.push(`type = ${q(f.type)}`)
  if (f.priority) parts.push(`priority = ${f.priority}`)
  if (f.label) parts.push(`labels = ${q(f.label)}`)
  if (f.resolution === 'open') parts.push('statusCategory != Done')
  if (f.resolution === 'done') parts.push('statusCategory = Done')
  if (f.q?.trim()) parts.push(`text ~ ${q(f.q.trim())}`)
  return parts.join(' AND ')
}

/** The projects a query names (Jira: a board's filter decides the projects its sprints need permission in), lower-cased
 *  keys or names as written; null when it can't be told (a part without a project clause, `!=`, `not in`, NOT, a function), when any
 *  project could match. AND keeps what its project-naming parts share; OR needs every branch to name projects. */
export function filterProjects(jql: string): string[] | null {
  type Cover = Set<string> | null                      // null: any project
  const walk = (n: Node | null): Cover => {
    if (!n) return null
    if (n.kind === 'not') return null
    if (n.kind === 'clause') {
      if (n.field.toLowerCase() !== 'project' || (n.op !== '=' && n.op !== 'in') || n.values.some(v => v.kind !== 'text')) return null
      return new Set(n.values.map(v => (v as { text: string }).text.toLowerCase()))
    }
    const parts = n.items.map(walk)
    if (n.kind === 'or') return parts.some(x => x === null) ? null : new Set(parts.flatMap(x => [...x!]))
    const named = parts.filter((x): x is Set<string> => x !== null)
    return named.length ? named.reduce((a, b) => new Set([...a].filter(x => b.has(x)))) : null
  }
  const cover = walk(parseJql(jql).where)
  return cover && [...cover]
}

const PERIODS = { day: 'd', week: 'w', month: 'M', year: 'y' } as const
/** Jira's startOfDay(), endOfMonth("-1"), startOfWeek("+2w")… (spec 0603 R1): the start or end of this day, week (from Monday),
 *  month or year, moved by the increment `(+/-)nn(y|M|w|d|h|m)` (no unit: the function's own period). Null: not one of them. */
export function periodBound(name: string, inc: string | undefined, now = new Date()): Date | null {
  const m = /^(start|end)of(day|week|month|year)$/.exec(name.toLowerCase())
  if (!m) return null
  const period = m[2] as keyof typeof PERIODS
  const d = new Date(now); d.setHours(0, 0, 0, 0)
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  if (period === 'month' || period === 'year') d.setDate(1)
  if (period === 'year') d.setMonth(0)
  const add = (n: number, unit: string) => {
    if (unit === 'y') d.setFullYear(d.getFullYear() + n)
    else if (unit === 'M') d.setMonth(d.getMonth() + n)
    else if (unit === 'w') d.setDate(d.getDate() + 7 * n)
    else if (unit === 'd') d.setDate(d.getDate() + n)
    else if (unit === 'h') d.setTime(d.getTime() + n * 3_600_000)
    else d.setTime(d.getTime() + n * 60_000)
  }
  if (m[1] === 'end') add(1, PERIODS[period])                      // the next period's start, less a millisecond
  if (inc != null && inc.trim() !== '') {
    const i = /^([+-]?)(\d+)([yMwdhm]?)$/.exec(inc.trim())
    if (!i) throw new JqlError(`“${inc}” isn’t an increment: use one like -1, +2w or -3d`, 0)
    add((i[1] === '-' ? -1 : 1) * Number(i[2]), i[3] || PERIODS[period])
  }
  if (m[1] === 'end') d.setTime(d.getTime() - 1)
  return d
}

