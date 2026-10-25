// A subset of JQL, Jira's query language, so teams keep writing (and bringing over) the filters they know:
//   project = PAY AND (status = "In progress" OR priority in (high, urgent)) AND assignee = currentUser() ORDER BY created DESC
// Clauses: field op value. Ops: = != in, not in, ~ !~ (text contains), > >= < <= (numbers and dates), is empty, is not empty.
// Values: words, "quoted text", numbers, dates (2026-10-01), relative dates (-7d, 2w, 1h), and functions: currentUser(),
// now(), startOfDay(), endOfDay(), startOfWeek(), openSprints(), closedSprints(), membersOf("group"), and Xray's test functions:
// issue in requirementTests("PAY-1"), testRequirements(…), testSetTests(…), testPlanTests("PAY-9", "FAIL"), testExecutionTests(…).
// Combine with AND, OR, NOT and parentheses; sort with ORDER BY field [ASC|DESC], …  Pure: parsed here, run elsewhere.

export type Op = '=' | '!=' | 'in' | 'not in' | '~' | '!~' | '>' | '>=' | '<' | '<=' | 'is empty' | 'is not empty'
export type Value = { kind: 'text'; text: string } | { kind: 'fn'; name: string; arg?: string; args?: string[] }
export interface Clause { kind: 'clause'; field: string; op: Op; values: Value[] }
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
  sprint: 'sprint', parent: 'parent', epic: 'parent', resolution: 'resolution',
  text: 'text', summary: 'summary', title: 'summary', description: 'description',
  created: 'created', createddate: 'created', updated: 'updated', updateddate: 'updated', resolved: 'resolved', resolutiondate: 'resolved',
  due: 'due', duedate: 'due', start: 'start', startdate: 'start',
  storypoints: 'estimate', 'story points': 'estimate', estimate: 'estimate', originalestimate: 'timeEstimate', remainingestimate: 'timeRemaining',
}
/** Fields people sort by. */
export const SORTS = ['created', 'updated', 'priority', 'due', 'key', 'rank', 'status', 'resolved', 'summary', 'estimate']

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
    if (peek()?.t === 'op') op = toks[p++]!.v as Op
    else if (kw('in')) { p++; op = 'in' }
    else if (kw('not') && kw('in', 1)) { p += 2; op = 'not in' }
    else if (kw('is') && kw('empty', 1)) { p += 2; return { kind: 'clause', field, op: 'is empty', values: [] } }
    else if (kw('is') && kw('not', 1) && kw('empty', 2)) { p += 3; return { kind: 'clause', field, op: 'is not empty', values: [] } }
    else if (kw('is') && (kw('null', 1) || kw('not', 1) && kw('null', 2))) { const neg = kw('not', 1); p += neg ? 3 : 2; return { kind: 'clause', field, op: neg ? 'is not empty' : 'is empty', values: [] } }
    else return fail(`Expected an operator after ${f.v}: =, !=, in, ~, >, <, is empty…`)
    if (op === 'in' || op === 'not in') {
      // a function that stands for a list, as in Jira: issue in testPlanTests("PAY-9"), sprint in openSprints()
      if (peek()?.t === 'word' && peek(1)?.t === '(') return { kind: 'clause', field, op, values: [value()] }
      if (peek()?.t !== '(') fail('Expected “(” and a list, such as (high, urgent)')
      p++
      const values = [value()]
      while (peek()?.t === ',') { p++; values.push(value()) }
      if (peek()?.t !== ')') fail('Expected “)” to close the list')
      p++
      return { kind: 'clause', field, op, values }
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
