// JQL (shared/jql.ts) to SQL over `issues i join projects p join statuses st`. Every value is a query parameter.
import type { Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { parseJql, relative, JqlError, type Clause, type Node, type Query, type Value } from './shared/jql.ts'

const CATEGORY: Record<string, string> = { 'to do': 'todo', todo: 'todo', 'in progress': 'in-progress', 'in-progress': 'in-progress', done: 'done' }
const PRIORITY_RANK = `case i.priority when 'urgent' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 else 1 end`
const DATES: Record<string, string> = { created: 'i.created_at', updated: 'i.updated_at', resolved: 'i.resolved_at', due: 'i.due_date', start: 'i.start_date' }
const NUMBERS: Record<string, string> = { estimate: 'i.estimate', timeEstimate: 'i.time_estimate', timeRemaining: 'i.time_remaining' }
const EMPTY: Record<string, string> = {
  assignee: 'i.assignee_id is null', reporter: 'i.reporter_id is null', labels: 'cardinality(i.labels) = 0', component: 'cardinality(i.component_ids) = 0',
  fixVersion: 'i.release_id is null', affectedVersion: 'cardinality(i.affects_release_ids) = 0', sprint: 'i.sprint_id is null', parent: 'i.parent_id is null',
  resolution: 'i.resolution is null', description: `coalesce(i.description, '') = ''`,
  due: 'i.due_date is null', start: 'i.start_date is null', resolved: 'i.resolved_at is null',
  estimate: 'i.estimate is null', timeEstimate: 'i.time_estimate is null', timeRemaining: 'i.time_remaining is null',
}
export const ORDER: Record<string, string> = {
  created: 'i.created_at', updated: 'i.updated_at', priority: PRIORITY_RANK, due: 'i.due_date', key: 'p.key, i.number', rank: 'i.rank',
  status: `case st.category when 'todo' then 0 when 'in-progress' then 1 else 2 end, st.position`, resolved: 'i.resolved_at', summary: 'lower(i.title)', estimate: 'i.estimate',
}

/** Parse, or answer 400 with where the mistake is. */
export function parseOr400(src: string): Query {
  try { return parseJql(src) } catch (e) {
    if (e instanceof JqlError) throw new HttpError(400, `JQL: ${e.message} (at character ${e.at + 1})`, { jql: e.message })
    throw e
  }
}

/** Custom fields named in the query must exist in some project of the workspace: a typo is an error, not an empty result. */
async function checkFieldNames(d: Db, me: Me, n: Node | null) {
  const names = new Set<string>()
  const walk = (x: Node) => { if (x.kind === 'clause') { if (x.field.startsWith('custom:')) names.add(x.field.slice(7).toLowerCase()) } else if (x.kind === 'not') walk(x.item); else x.items.forEach(walk) }
  if (n) walk(n)
  if (!names.size) return
  const found = new Set((await d.query<{ name: string }>(
    `select distinct lower(f.name) as name from field_defs f join projects p on p.id = f.project_id where p.workspace_id = $1 and lower(f.name) = any($2::text[])`,
    [me.workspaceId, [...names]])).map(r => r.name))
  const missing = [...names].filter(x => !found.has(x))
  if (missing.length) throw new HttpError(400, `JQL: there is no field called “${missing[0]}”`, { jql: `Unknown field ${missing[0]}` })
}

// ── Xray's test functions: issue in requirementTests("REQ-1", …), testRequirements("TEST-1", …), testSetTests("SET-1"),
// testPlanTests("PLAN-1"[, status…]) (each test's status in the plan, by Xray's rules), testExecutionTests("EXEC-1"[, status…]).
// The items named must be ones the searcher can see (a hidden one is "not found", like a missing one). ──
const TEST_FNS = new Set(['requirementtests', 'testrequirements', 'testsettests', 'testplantests', 'testexecutiontests'])
const fnKey = (v: Extract<Value, { kind: 'fn' }>) => `${v.name}(${(v.args ?? (v.arg ? [v.arg] : [])).join('\u0000')})`
async function prepareTestFns(d: Db, me: Me, n: Node | null): Promise<Map<string, string[]>> {
  const fns: Extract<Value, { kind: 'fn' }>[] = []
  const walk = (x: Node) => { if (x.kind === 'clause') { for (const v of x.values) if (v.kind === 'fn' && TEST_FNS.has(v.name)) fns.push(v) } else if (x.kind === 'not') walk(x.item); else x.items.forEach(walk) }
  if (n) walk(n)
  const out = new Map<string, string[]>()
  if (!fns.length) return out
  const { levelOk, visibleAs } = await import('./access.ts')
  const items = async (keys: string[]) => {
    if (!keys.length) throw new HttpError(400, 'JQL: name at least one work item, such as testPlanTests("PAY-9")', { jql: 'Missing work item' })
    const rows = await d.query<{ id: string; key: string; type: string }>(
      `select i.id, p.key || '-' || i.number as key, i.type from issues i join projects p on p.id = i.project_id
        where i.workspace_id = $1 and (p.key || '-' || i.number) = any($2::text[]) and i.deleted_at is null and ${visibleAs(me, 'i.project_id', 3)} and ${levelOk(me, 3)}`,
      [me.workspaceId, keys.map(k => k.toUpperCase()), me.id])
    const missing = keys.find(k => !rows.some(r => r.key === k.toUpperCase()))
    if (missing) throw new HttpError(400, `JQL: there is no work item ${missing}`, { jql: `Unknown work item ${missing}` })
    return rows
  }
  const statusKeys = async (names: string[]) => {
    const rows = await d.query<{ key: string; name: string }>(`select key, name from test_statuses where workspace_id = $1 and kind = 'run'`, [me.workspaceId])
    return names.map(n => {
      const hit = rows.find(r => r.key.toUpperCase() === n.toUpperCase() || r.name.toUpperCase() === n.toUpperCase())
      if (!hit) throw new HttpError(400, `JQL: there is no test status “${n}”`, { jql: `Unknown test status ${n}` })
      return hit.key
    })
  }
  const one = (rows: { type: string; key: string }[], type: string, what: string) => {
    const bad = rows.find(r => r.type !== type)
    if (bad) throw new HttpError(400, `JQL: ${bad.key} isn’t a ${what}`, { jql: `Not a ${what}` })
  }
  for (const v of fns) {
    const key = fnKey(v)
    if (out.has(key)) continue
    const args = v.args ?? (v.arg ? [v.arg] : [])
    let ids: string[]
    if (v.name === 'requirementtests' || v.name === 'testrequirements') {
      const its = await items(args)
      const [from, to] = v.name === 'requirementtests' ? ['target_id', 'issue_id'] : ['issue_id', 'target_id']
      ids = (await d.query<{ id: string }>(`select distinct ${to} as id from issue_links where type = 'tests' and ${from} = any($1::uuid[])`, [its.map(i => i.id)])).map(r => r.id)
    } else if (v.name === 'testsettests') {
      const its = await items(args); one(its, 'test_set', 'Test Set')
      ids = (await d.query<{ id: string }>(`select member_id as id from test_items ti join issues t on t.id = ti.member_id where container_id = any($1::uuid[]) and t.type = 'test'`, [its.map(i => i.id)])).map(r => r.id)
    } else if (v.name === 'testexecutiontests') {
      const [exec] = await items(args.slice(0, 1)); one([exec!], 'test_execution', 'Test Execution')
      const st = args.length > 1 ? await statusKeys(args.slice(1)) : null
      ids = (await d.query<{ id: string }>(`select test_id as id from test_runs where execution_id = $1 ${st ? 'and status = any($2::text[])' : ''}`, st ? [exec!.id, st] : [exec!.id])).map(r => r.id)
    } else {
      const [plan] = await items(args.slice(0, 1)); one([plan!], 'test_plan', 'Test Plan')
      const tests = (await d.query<{ id: string }>(`select member_id as id from test_items ti join issues t on t.id = ti.member_id where container_id = $1 and t.type = 'test'`, [plan!.id])).map(r => r.id)
      if (args.length > 1) {
        const want = new Set(await statusKeys(args.slice(1)))
        const { testStatus } = await import('./shared/testStatus.ts')
        const { getSetting } = await import('./settings.ts')
        const runs = await d.query<any>(
          `select r.test_id, r.status, r.finished_at, r.created_at, e.test_environments as environments from test_runs r join issues e on e.id = r.execution_id
            where r.execution_id in (select member_id from test_items where container_id = $1) and e.deleted_at is null and ${visibleAs(me, 'e.project_id', 2)} and ${levelOk(me, 2, 'e')}`, [plan!.id, me.id])
        const st = await d.query<any>(`select key, final, maps_to, rank from test_statuses where workspace_id = $1 and kind = 'run'`, [me.workspaceId])
        const { finalStatusesHavePrecedence } = await getSetting(me.workspaceId, 'testing')
        const iso = (x: any) => (x ? new Date(x).toISOString() : null)
        ids = tests.filter(t => want.has(testStatus(runs.filter(r => r.testId === t).map(r => ({ status: r.status, finishedAt: iso(r.finishedAt), createdAt: iso(r.createdAt)!, environments: r.environments })), st, finalStatusesHavePrecedence) ?? 'TODO'))
      } else ids = tests
    }
    out.set(key, ids)
  }
  return out
}

/** The SQL condition for a JQL query (null: no condition) and its ORDER BY (null: the caller's default). */
export async function jqlToSql(d: Db, me: Me, q: Query, args: unknown[]): Promise<{ where: string | null; order: string | null }> {
  await checkFieldNames(d, me, q.where)
  const testFnIds = await prepareTestFns(d, me, q.where)
  const put = (v: unknown) => { args.push(v); return `$${args.length}` }
  const text = (v: Value, field: string): string => {
    if (v.kind === 'text') return v.text
    throw new HttpError(400, `JQL: ${v.name}() can’t be used with ${field}`, { jql: `${v.name}() not allowed here` })
  }
  /** A date value as a timestamp: 2026-10-01, -7d, now(), startOfDay(), endOfDay(), startOfWeek(). */
  const when = (v: Value): string => {
    if (v.kind === 'fn') {
      const now = new Date()
      const day = new Date(now); day.setHours(0, 0, 0, 0)
      if (v.name === 'now') return put(now.toISOString())
      if (v.name === 'startofday') return put(day.toISOString())
      if (v.name === 'endofday') return put(new Date(day.getTime() + 86_400_000 - 1).toISOString())
      if (v.name === 'startofweek') { const w = new Date(day); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return put(w.toISOString()) }
      throw new HttpError(400, `JQL: ${v.name}() isn’t a date`, { jql: `${v.name}() is not a date` })
    }
    const rel = relative(v.text)
    if (rel !== null) return put(new Date(Date.now() + rel).toISOString())
    if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v.text) && !Number.isNaN(Date.parse(v.text.replace(' ', 'T')))) return put(v.text.replace(' ', 'T'))
    throw new HttpError(400, `JQL: “${v.text}” isn’t a date (use 2026-10-01, -7d or now())`, { jql: `Not a date: ${v.text}` })
  }
  const number = (v: Value) => {
    if (v.kind === 'text' && v.text !== '' && Number.isFinite(Number(v.text))) return put(Number(v.text))
    throw new HttpError(400, `JQL: “${v.kind === 'text' ? v.text : v.name}” isn’t a number`, { jql: 'Not a number' })
  }
  const person = (col: string, v: Value) => {
    if (v.kind === 'fn' && v.name === 'currentuser') return `${col} = ${put(me.id)}`
    if (v.kind === 'fn' && v.name === 'membersof' && v.arg) return `${col} in (select gm.user_id from group_members gm join groups g on g.id = gm.group_id where lower(g.display_name) = lower(${put(v.arg)}))`
    const t = put(text(v, 'a person'))
    return `${col} in (select id from users where lower(email) = lower(${t}) or lower(name) = lower(${t}) or id::text = ${t})`
  }
  /** The condition for "field = one value". */
  const eq = (c: Clause, v: Value): string => {
    if (c.field === 'key' && v.kind === 'fn' && TEST_FNS.has(v.name)) return testFn(v)
    switch (c.field) {
      case 'project': { const t = put(text(v, 'project')); return `(p.key = upper(${t}) or lower(p.name) = lower(${t}))` }
      case 'key': return `(p.key || '-' || i.number) = upper(${put(text(v, 'key'))})`
      case 'type': { const t = put(text(v, 'type')); return `(i.type = lower(${t}) or exists (select 1 from work_types wt where wt.project_id = i.project_id and wt.key = i.type and lower(wt.name) = lower(${t})))` }
      case 'status': return `lower(st.name) = lower(${put(text(v, 'status'))})`
      case 'statusCategory': {
        const cat = CATEGORY[text(v, 'statusCategory').toLowerCase()]
        if (!cat) throw new HttpError(400, 'JQL: statusCategory is "To Do", "In Progress" or Done', { jql: 'Unknown status category' })
        return `st.category = ${put(cat)}`
      }
      case 'priority': return `i.priority = lower(${put(text(v, 'priority'))})`
      case 'assignee': return person('i.assignee_id', v)
      case 'reporter': return person('i.reporter_id', v)
      case 'labels': return `${put(text(v, 'labels'))} = any(i.labels)`
      case 'component': return `exists (select 1 from components c where c.id = any(i.component_ids) and lower(c.name) = lower(${put(text(v, 'component'))}))`
      case 'fixVersion': return `i.release_id in (select r.id from releases r where r.project_id = i.project_id and lower(r.name) = lower(${put(text(v, 'fixVersion'))}))`
      case 'affectedVersion': return `exists (select 1 from releases r where r.id = any(i.affects_release_ids) and lower(r.name) = lower(${put(text(v, 'affectedVersion'))}))`
      case 'sprint':
        if (v.kind === 'fn' && (v.name === 'opensprints' || v.name === 'closedsprints')) return `i.sprint_id in (select id from sprints where state = '${v.name === 'opensprints' ? 'active' : 'closed'}')`
        return `i.sprint_id in (select s.id from sprints s where s.project_id = i.project_id and lower(s.name) = lower(${put(text(v, 'sprint'))}))`
      case 'parent': return `i.parent_id in (select pi.id from issues pi join projects pp on pp.id = pi.project_id where pp.key || '-' || pi.number = upper(${put(text(v, 'parent'))}))`
      case 'resolution': {
        const t = text(v, 'resolution')
        return t.toLowerCase() === 'unresolved' ? 'i.resolution is null' : `lower(i.resolution) = lower(${put(t)})`
      }
    }
    if (c.field in DATES) return `${DATES[c.field]}::date = (${when(v)})::timestamptz::date`
    if (c.field in NUMBERS) return `${NUMBERS[c.field]} = ${number(v)}`
    if (c.field === 'text' || c.field === 'summary' || c.field === 'description')
      throw new HttpError(400, `JQL: search ${c.field} with ~ (contains), for example ${c.field} ~ "login"`, { jql: `Use ~ with ${c.field}` })
    return custom(c, `lower(i.custom->>(f.id::text)) = lower(${put(text(v, c.field))})`)
  }
  /** A condition on the item's value for a custom field (named in any of its project's fields), `cond` reading f.id. */
  const custom = (c: Clause, cond: string) => {
    const match = c.field.startsWith('cf:') ? `f.id::text = ${put(c.field.slice(3))}` : `lower(f.name) = lower(${put(c.field.slice(7))})`
    return `exists (select 1 from field_defs f where f.project_id = i.project_id and ${match} and ${cond})`
  }
  const isCustom = (f: string) => f.startsWith('custom:') || f.startsWith('cf:')

  const clause = (c: Clause): string => {
    if (c.op === 'is empty' || c.op === 'is not empty') {
      const empty = isCustom(c.field) ? `not ${custom(c, `i.custom ? (f.id::text)`)}` : EMPTY[c.field]
      if (!empty) throw new HttpError(400, `JQL: ${c.field} always has a value`, { jql: `${c.field} can’t be empty` })
      return c.op === 'is empty' ? `(${empty})` : `not (${empty})`
    }
    if (c.op === '~' || c.op === '!~') {
      const t = put(text(c.values[0]!, c.field))
      const like = `'%' || replace(replace(replace(${t}, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`
      const cond = c.field === 'text' ? `(i.search @@ websearch_to_tsquery('simple', ${t}) or i.title ilike ${like})`
        : c.field === 'summary' ? `i.title ilike ${like}` : c.field === 'description' ? `i.description ilike ${like}`
        : c.field === 'labels' ? `exists (select 1 from unnest(i.labels) l where l ilike ${like})`
        : isCustom(c.field) ? custom(c, `(i.custom->>(f.id::text)) ilike ${like}`) : null
      if (!cond) throw new HttpError(400, `JQL: ~ searches text: summary, description, text, labels or a text field`, { jql: `~ not allowed with ${c.field}` })
      return c.op === '~' ? cond : `not ${cond}`
    }
    if (c.op === '>' || c.op === '>=' || c.op === '<' || c.op === '<=') {
      const v = c.values[0]!
      if (c.field in DATES) return `${DATES[c.field]} ${c.op} (${when(v)})::timestamptz${c.field === 'due' || c.field === 'start' ? '::date' : ''}`
      if (c.field in NUMBERS) return `${NUMBERS[c.field]} ${c.op} ${number(v)}`
      if (c.field === 'priority') {
        const rank = { urgent: 5, highest: 5, high: 4, medium: 3, low: 2, lowest: 2, none: 1 }[text(v, 'priority').toLowerCase()]
        if (!rank) throw new HttpError(400, 'JQL: priority is urgent, high, medium, low or none', { jql: 'Unknown priority' })
        return `(${PRIORITY_RANK}) ${c.op} ${put(rank)}`
      }
      if (isCustom(c.field)) {
        const v0 = c.values[0]!
        const cmp = v0.kind === 'text' && Number.isFinite(Number(v0.text)) ? `(i.custom->>(f.id::text)) ~ '^-?[0-9.]+$' and (i.custom->>(f.id::text))::numeric ${c.op} ${number(v0)}`
          : `(i.custom->>(f.id::text)) ~ '^[0-9]{4}-' and (i.custom->>(f.id::text))::date ${c.op} (${when(v0)})::timestamptz::date`
        return custom(c, cmp)
      }
      throw new HttpError(400, `JQL: ${c.op} compares dates, numbers and priority, not ${c.field}`, { jql: `${c.op} not allowed with ${c.field}` })
    }
    const any = c.values.map(v => eq(c, v))
    const cond = any.length === 1 ? any[0]! : `(${any.join(' or ')})`
    return c.op === '=' || c.op === 'in' ? cond : `not ${cond.startsWith('(') ? cond : `(${cond})`}`   // as in Jira, an empty field matches neither = nor !=
  }
  /** Xray's test functions (issue in testPlanTests("PAY-9", "FAIL")…), each worked out here into the items it means. */
  const testFn = (v: Extract<Value, { kind: 'fn' }>): string => {
    const r = testFnIds.get(fnKey(v))
    if (!r) throw new HttpError(500, 'JQL: test function not prepared')
    return `i.id = any(${put(r)}::uuid[])`
  }
  const node = (n: Node): string => n.kind === 'clause' ? clause(n) : n.kind === 'not' ? `not (${node(n.item)})`
    : `(${n.items.map(node).join(n.kind === 'and' ? ' and ' : ' or ')})`

  const where = q.where ? node(q.where) : null
  const order = q.orderBy.length ? q.orderBy.map(s => ORDER[s.field]!.split(', ').map(x => `${x} ${s.dir} nulls last`).join(', ')).join(', ') : null
  return { where, order }
}
