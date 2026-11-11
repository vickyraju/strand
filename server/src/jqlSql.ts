// JQL (shared/jql.ts) to SQL over `issues i join projects p join statuses st`. Every value is a query parameter.
import type { Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { parseJql, relative, periodBound, JqlError, type Clause, type Node, type Query, type Value } from './shared/jql.ts'
import { PERMISSIONS, rolesWith, type Permission, type Role } from './shared/permissions.ts'

const CATEGORY: Record<string, string> = { 'to do': 'todo', todo: 'todo', 'in progress': 'in-progress', 'in-progress': 'in-progress', done: 'done' }
/** Higher for higher priorities: the list's order (Administration › Priorities, spec 0305 R4), first is highest. */
const PRIORITY_RANK = `(select -pr.position from priorities pr where pr.workspace_id = i.workspace_id and pr.key = i.priority)`
const DATES: Record<string, string> = { created: 'i.created_at', updated: 'i.updated_at', resolved: 'i.resolved_at', due: 'i.due_date', start: 'i.start_date' }
/** How many of an item's linked development records match (spec 0707). */
const dev = (where: string) => `(select count(*) from dev_links dl join dev_entities de on de.id = dl.entity_id where dl.issue_id = i.id and ${where})`
const PR_STATES: Record<string, string> = { open: 'open', merged: 'merged', declined: 'closed' }   // GitHub's closed without merging is Jira's declined
const NUMBERS: Record<string, string> = {
  estimate: 'i.estimate', timeEstimate: 'i.time_estimate', timeRemaining: 'i.time_remaining',
  devCommits: dev(`de.kind = 'commit'`), devBranches: dev(`de.kind = 'branch' and de.state is distinct from 'deleted'`), devPrs: dev(`de.kind = 'pull_request'`),
  devPrsOpen: dev(`de.kind = 'pull_request' and de.state = 'open'`), devPrsMerged: dev(`de.kind = 'pull_request' and de.state = 'merged'`),
  devPrsDeclined: dev(`de.kind = 'pull_request' and de.state = 'closed'`), devNone: '0',
  votes: '(select count(*) from issue_votes vv where vv.issue_id = i.id)',   // Jira's votes (spec 0506)
  watchers: '(select count(*) from issue_watchers ww where ww.issue_id = i.id)',
}
const EMPTY: Record<string, string> = {
  flagged: 'not i.flagged', epicStatus: 'i.epic_status is null', assignee: 'i.assignee_id is null', reporter: 'i.reporter_id is null', labels: 'cardinality(i.labels) = 0', component: 'cardinality(i.component_ids) = 0',
  fixVersion: 'cardinality(i.fix_release_ids) = 0', affectedVersion: 'cardinality(i.affects_release_ids) = 0', sprint: 'i.sprint_id is null', parent: 'i.parent_id is null',
  voter: 'not exists (select 1 from issue_votes vv where vv.issue_id = i.id)', watcher: 'not exists (select 1 from issue_watchers ww where ww.issue_id = i.id)',
  resolution: 'i.resolution is null', category: 'p.category_id is null', description: `coalesce(i.description, '') = ''`,
  due: 'i.due_date is null', start: 'i.start_date is null', resolved: 'i.resolved_at is null',
  estimate: 'i.estimate is null', timeEstimate: 'i.time_estimate is null', timeRemaining: 'i.time_remaining is null',
}
/** History search (spec 0602): the six fields Jira searches by history, as the history names them (spec 0601), and each's value now. */
const HISTORY: Record<string, { field: string; now: string }> = {
  status: { field: 'statusId', now: 'select i.status_id::text as v, st.name as s' },
  assignee: { field: 'assigneeId', now: 'select i.assignee_id::text as v, (select u.name from users u where u.id = i.assignee_id) as s' },
  reporter: { field: 'reporterId', now: 'select i.reporter_id::text as v, (select u.name from users u where u.id = i.reporter_id) as s' },
  priority: { field: 'priority', now: 'select i.priority as v, (select pr.name from priorities pr where pr.workspace_id = i.workspace_id and pr.key = i.priority) as s' },
  resolution: { field: 'resolution', now: 'select i.resolution as v, i.resolution as s' },
  fixVersion: { field: 'fixReleaseIds', now: 'select r.id::text as v, r.name as s from releases r where r.id = any(i.fix_release_ids)' },
}
export const ORDER: Record<string, string> = {
  created: 'i.created_at', updated: 'i.updated_at', priority: PRIORITY_RANK, due: 'i.due_date', key: 'p.key, i.number', rank: 'i.rank',
  status: `case st.category when 'todo' then 0 when 'in-progress' then 1 else 2 end, st.position`, resolved: 'i.resolved_at', summary: 'lower(i.title)', estimate: 'i.estimate',
  votes: '(select count(*) from issue_votes vv where vv.issue_id = i.id)',
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
/** Worked out before the query too (spec 0603): one item's links, and the people some functions name. */
const PREPARED = new Set([...TEST_FNS, 'linkedissues', 'updatedby', 'componentsleadbyuser', 'projectsleadbyuser'])
const fnKey = (v: Extract<Value, { kind: 'fn' }>) => `${v.name}(${(v.args ?? (v.arg ? [v.arg] : [])).join('\u0000')})`
async function prepareTestFns(d: Db, me: Me, n: Node | null): Promise<Map<string, string[]>> {
  const fns: Extract<Value, { kind: 'fn' }>[] = []
  const walk = (x: Node) => { if (x.kind === 'clause') { for (const v of x.values) if (v.kind === 'fn' && PREPARED.has(v.name)) fns.push(v) } else if (x.kind === 'not') walk(x.item); else x.items.forEach(walk) }
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
    if (v.name === 'updatedby' || v.name === 'componentsleadbyuser' || v.name === 'projectsleadbyuser') {   // a person (you when left out)
      if (v.name === 'updatedby' ? !args.length || args.length > 3 : args.length > 1) throw new HttpError(400, `JQL: ${v.name === 'updatedby' ? 'updatedBy(person[, from[, to]])' : `${v.name}([person])`} takes ${v.name === 'updatedby' ? 'a person and up to two dates' : 'at most one person'}`, { jql: 'Wrong arguments' })
      if (!args.length) { out.set(key, [me.id]); continue }
      const [u] = await d.query<{ id: string }>('select id from users where lower(email) = lower($1) or lower(name) = lower($1) or id::text = $1 limit 1', [args[0]])
      if (!u) throw new HttpError(400, `JQL: there is no person “${args[0]}”`, { jql: `Unknown person ${args[0]}` })
      out.set(key, [u.id]); continue
    }
    if (v.name === 'linkedissues') {                 // linkedIssues(KEY[, link type]): by the type's name, or one of its directions
      if (!args.length || args.length > 2) throw new HttpError(400, 'JQL: linkedIssues(KEY[, link type])', { jql: 'Wrong arguments' })
      const [it] = await items(args.slice(0, 1))
      let outTypes: string[] | null = null, inTypes: string[] | null = null   // null: any type
      if (args[1]) {
        const lt = await d.query<{ id: string; name: string; outward: string; inward: string }>('select id, name, outward, inward from link_types where workspace_id = $1', [me.workspaceId])
        const t = args[1].toLowerCase(), named = lt.filter(l => l.name.toLowerCase() === t || l.id === t).map(l => l.id)
        outTypes = [...named, ...lt.filter(l => l.outward.toLowerCase() === t).map(l => l.id)]
        inTypes = [...named, ...lt.filter(l => l.inward.toLowerCase() === t).map(l => l.id)]
        if (!outTypes.length && !inTypes.length) throw new HttpError(400, `JQL: there is no link type “${args[1]}”`, { jql: `Unknown link type ${args[1]}` })
      }
      ids = (await d.query<{ id: string }>(`select target_id as id from issue_links where issue_id = $1 and ($2::text[] is null or type = any($2::text[]))
        union select issue_id from issue_links where target_id = $1 and ($3::text[] is null or type = any($3::text[]))`, [it!.id, outTypes, inTypes])).map(r => r.id)
      out.set(key, ids); continue
    }
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
      if (v.name === 'now') return put(now.toISOString())
      // when you signed in this time and the time before (spec 0603 R1)
      if (v.name === 'currentlogin') return `(select coalesce(last_sign_in_at, now()) from users where id = ${put(me.id)})`
      if (v.name === 'lastlogin') return `(select previous_sign_in_at from users where id = ${put(me.id)})`
      try { const b = periodBound(v.name, v.arg, now); if (b) return put(b.toISOString()) }
      catch (e) { if (e instanceof JqlError) throw new HttpError(400, `JQL: ${e.message}`, { jql: e.message }); throw e }
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
    if (c.field === 'key' && v.kind === 'fn' && v.name === 'remotelinksbyglobalid') {   // spec 0507
      const ids = v.args ?? (v.arg ? [v.arg] : [])
      return `i.id in (select issue_id from remote_links where global_id = any(${put(ids)}::text[]))`
    }
    if (c.field === 'key' && v.kind === 'fn' && v.name === 'votedissues') return `i.id in (select issue_id from issue_votes where user_id = ${put(me.id)})`   // spec 0506
    if (v.kind === 'fn') {                                                         // spec 0603
      const args = v.args ?? (v.arg ? [v.arg] : [])
      const inProject = (col: string) => args[0] ? ` and ${col} in (select pj.id from projects pj where pj.workspace_id = i.workspace_id and (pj.key = upper(${put(args[0])}) or lower(pj.name) = lower(${put(args[0])})))` : ''
      const version = c.field === 'fixVersion' ? 'i.fix_release_ids' : c.field === 'affectedVersion' ? 'i.affects_release_ids' : null
      if (c.field === 'key' && v.name === 'issuehistory') return `i.id in (select issue_id from issue_views where user_id = ${put(me.id)} order by viewed_at desc limit 60)`
      if (c.field === 'key' && v.name === 'watchedissues') return `i.id in (select issue_id from issue_watchers where user_id = ${put(me.id)})`
      if (c.field === 'key' && v.name === 'issueswithremotelinksbyglobalid') {
        if (!args.length || args.length > 100) throw new HttpError(400, 'JQL: issuesWithRemoteLinksByGlobalId takes 1 to 100 global ids', { jql: '1 to 100 global ids' })
        return `i.id in (select issue_id from remote_links where global_id = any(${put(args)}::text[]))`
      }
      if (c.field === 'key' && v.name === 'linkedissues') return `i.id = any(${put(testFnIds.get(fnKey(v)))}::uuid[])`
      if (c.field === 'key' && v.name === 'updatedby') {
        const u = put(testFnIds.get(fnKey(v))![0]), day = (x: string) => when({ kind: 'text', text: x.replace(/\//g, '-') })
        const from = args[1] ? `(${day(args[1])})::timestamptz::date` : null, to = args[2] ? `(${day(args[2])})::timestamptz::date + 1` : null   // whole days, as Jira's
        const within = (col: string) => `${from ? ` and ${col} >= ${from}` : ''}${to ? ` and ${col} < ${to}` : ''}`
        return `(i.reporter_id = ${u}::uuid${within('i.created_at')} or exists (select 1 from activity a where a.issue_id = i.id and a.actor_id = ${u}::uuid${within('a.created_at')})
          or exists (select 1 from comments cm where cm.issue_id = i.id and cm.author_id = ${u}::uuid${within('coalesce(cm.edited_at, cm.created_at)')}))`
      }
      if (version && (v.name === 'releasedversions' || v.name === 'unreleasedversions'))
        return `exists (select 1 from releases r where r.id = any(${version}) and ${v.name === 'releasedversions' ? '' : 'not '}r.released${inProject('r.project_id')})`
      if (version && (v.name === 'earliestunreleasedversion' || v.name === 'latestreleasedversion')) {
        if (args.length !== 1) throw new HttpError(400, `JQL: ${v.name === 'latestreleasedversion' ? 'latestReleasedVersion' : 'earliestUnreleasedVersion'}(project)`, { jql: 'Name a project' })
        // in the order the Releases page lists them: by release date, then name
        const pick = v.name === 'latestreleasedversion' ? 'r.released order by r.release_date desc nulls last, lower(r.name) desc' : 'not r.released order by r.release_date nulls last, lower(r.name)'
        return `(select r.id from releases r where true${inProject('r.project_id')} and ${pick} limit 1) = any(${version})`
      }
      if (c.field === 'component' && v.name === 'componentsleadbyuser')
        return `exists (select 1 from components cl where cl.id = any(i.component_ids) and cl.lead_id = ${put(testFnIds.get(fnKey(v))![0])}::uuid)`
      if (c.field === 'project' && v.name === 'projectsleadbyuser') return `p.lead_id = ${put(testFnIds.get(fnKey(v))![0])}::uuid`
      if (c.field === 'project' && (v.name === 'projectswhereuserhaspermission' || v.name === 'projectswhereuserhasrole')) {
        if (args.length !== 1) throw new HttpError(400, `JQL: ${v.name === 'projectswhereuserhasrole' ? 'projectsWhereUserHasRole(role)' : 'projectsWhereUserHasPermission(permission)'}`, { jql: 'Wrong arguments' })
        const a = args[0]!.toLowerCase()
        let roles: Role[]
        if (v.name === 'projectswhereuserhasrole') {
          const r = ({ admin: 'admin', admins: 'admin', administrators: 'admin', member: 'member', members: 'member', developers: 'member', users: 'member', viewer: 'viewer', viewers: 'viewer' } as Record<string, Role>)[a]
          if (!r) throw new HttpError(400, `JQL: there is no project role “${args[0]}” (Admin, Member or Viewer)`, { jql: `Unknown role ${args[0]}` })
          roles = (['viewer', 'member', 'admin'] as Role[]).slice((['viewer', 'member', 'admin'] as Role[]).indexOf(r))   // a role includes the ones above it
        } else {
          const perm = (Object.keys(PERMISSIONS) as Permission[]).find(k => k.toLowerCase() === a || PERMISSIONS[k].name.toLowerCase() === a || PERMISSIONS[k].name.toUpperCase().replace(/ /g, '_') === args[0])
          if (!perm) throw new HttpError(400, `JQL: there is no permission “${args[0]}”`, { jql: `Unknown permission ${args[0]}` })
          roles = rolesWith(perm)
        }
        return me.admin && roles.length ? 'true' : `p.id in (select pa.project_id from project_access pa where pa.user_id = ${put(me.id)} and pa.role = any(${put(roles)}::text[]))`
      }
      if (c.field === 'type' && (v.name === 'standardissuetypes' || v.name === 'subtaskissuetypes'))   // Strand's types serve both: a sub-item is one whose parent isn't an epic
        return `${v.name === 'standardissuetypes' ? 'not ' : ''}exists (select 1 from issues sp where sp.id = i.parent_id and sp.type <> 'epic')`
      if (c.field === 'sprint' && v.name === 'futuresprints') return `i.sprint_id in (select id from sprints where state = 'planned')`
    }
    switch (c.field) {
      // a project's earlier keys still find it (spec 0703 R2)
      case 'project': { const t = put(text(v, 'project')); return `(p.key = upper(${t}) or lower(p.name) = lower(${t}) or p.id in (select h.project_id from project_key_history h where h.workspace_id = p.workspace_id and h.key = upper(${t})))` }
      case 'key': { const t = put(text(v, 'key')); return `((p.key || '-' || i.number) = upper(${t}) or exists (select 1 from project_key_history h where h.project_id = i.project_id and h.key || '-' || i.number = upper(${t}))
        or exists (select 1 from moved_issue_keys mk join projects op on op.id = mk.project_id where mk.issue_id = i.id and (op.key || '-' || mk.number = upper(${t})
          or exists (select 1 from project_key_history oh where oh.project_id = op.id and oh.key || '-' || mk.number = upper(${t})))))` }   // keys it had before a move (spec 0501)
      case 'category': return `p.category_id in (select c.id from project_categories c where c.workspace_id = p.workspace_id and lower(c.name) = lower(${put(text(v, 'category'))}))`
      case 'type': { const t = put(text(v, 'type')); return `(i.type = lower(${t}) or exists (select 1 from work_types wt where wt.project_id = i.project_id and wt.key = i.type and lower(wt.name) = lower(${t})))` }
      case 'status': return `lower(st.name) = lower(${put(text(v, 'status'))})`
      case 'statusCategory': {
        const cat = CATEGORY[text(v, 'statusCategory').toLowerCase()]
        if (!cat) throw new HttpError(400, 'JQL: statusCategory is "To Do", "In Progress" or Done', { jql: 'Unknown status category' })
        return `st.category = ${put(cat)}`
      }
      case 'priority': { const t = put(text(v, 'priority')); return `i.priority in (select pr.key from priorities pr where pr.workspace_id = i.workspace_id and (lower(pr.name) = lower(${t}) or pr.key = lower(${t})))` }
      case 'assignee': return person('i.assignee_id', v)
      case 'voter': return `exists (select 1 from issue_votes vv where vv.issue_id = i.id and ${person('vv.user_id', v)})`
      case 'watcher': return `exists (select 1 from issue_watchers ww where ww.issue_id = i.id and ${person('ww.user_id', v)})`
      case 'reporter': return person('i.reporter_id', v)
      case 'labels': return `${put(text(v, 'labels'))} = any(i.labels)`
      case 'flagged': {                                                // Jira's Flagged field has one value: Impediment (spec 0408)
        if (text(v, 'flagged').toLowerCase() !== 'impediment') throw new HttpError(400, 'JQL: flagged is Impediment, as in Jira (flagged = Impediment)', { jql: 'flagged = Impediment' })
        return 'i.flagged'
      }
      case 'component': return `exists (select 1 from components c where c.id = any(i.component_ids) and lower(c.name) = lower(${put(text(v, 'component'))}))`
      case 'fixVersion': return `exists (select 1 from releases r where r.id = any(i.fix_release_ids) and lower(r.name) = lower(${put(text(v, 'fixVersion'))}))`   // any of its fix versions (spec 0301)
      case 'affectedVersion': return `exists (select 1 from releases r where r.id = any(i.affects_release_ids) and lower(r.name) = lower(${put(text(v, 'affectedVersion'))}))`
      case 'sprint':
        if (v.kind === 'fn' && (v.name === 'opensprints' || v.name === 'closedsprints')) return `i.sprint_id in (select id from sprints where state = '${v.name === 'opensprints' ? 'active' : 'closed'}')`
        return `i.sprint_id in (select s.id from sprints s where s.workspace_id = i.workspace_id and lower(s.name) = lower(${put(text(v, 'sprint'))}))`   // a sprint may hold other projects' work
      case 'devPrStatus': {
        const s = PR_STATES[text(v, 'development[pullrequests].status').toLowerCase()]
        if (!s) throw new HttpError(400, 'JQL: development[pullrequests].status is open, merged or declined', { jql: 'open, merged or declined' })
        return `${dev(`de.kind = 'pull_request' and de.state = ${put(s)}`)} > 0`
      }
      case 'devNoneText': return 'false'
      case 'epicStatus': return `lower(i.epic_status) = lower(${put(text(v, 'Epic Status'))})`
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
    return custom(c, customEq(v, c.field))
  }
  /** "custom field = value" for every kind (spec 0502 R4): any of a list's values; people by email, name or currentUser();
   *  groups, projects and versions by name; membersOf(); cascadeOption(parent[, child]). Reads f (the field) and i. */
  const customEq = (v: Value, field: string): string => {
    const val = `(i.custom -> (f.id::text))`
    const each = (match: (col: string) => string) =>
      `(case when jsonb_typeof(${val}) = 'array' then exists (select 1 from jsonb_array_elements_text(${val}) e(x) where ${match('e.x')}) else ${match(`(i.custom ->> (f.id::text))`)} end)`
    if (v.kind === 'fn' && v.name === 'cascadeoption') {
      const parts = v.args ?? (v.arg ? [v.arg] : [])
      if (!parts.length) throw new HttpError(400, 'JQL: cascadeOption needs an option', { jql: 'cascadeOption("Parent", "Child")' })
      return `(f.kind = 'cascading' and lower(${val} ->> 0) = lower(${put(parts[0])})${parts[1] ? ` and lower(${val} ->> 1) = lower(${put(parts[1])})` : ''})`
    }
    if (v.kind === 'fn' && v.name === 'currentuser') { const me1 = put(me.id); return each(col => `${col} = ${me1}::text`) }
    if (v.kind === 'fn' && v.name === 'membersof' && v.arg) {
      const g = put(v.arg)
      return each(col => `${col} in (select gm.user_id::text from group_members gm join groups g on g.id = gm.group_id where lower(g.display_name) = lower(${g}))`)
    }
    const t = put(text(v, field))
    return each(col => `(lower(${col}) = lower(${t})
      or (f.kind in ('user', 'users') and ${col} in (select u.id::text from users u where lower(u.email) = lower(${t}) or lower(u.name) = lower(${t})))
      or (f.kind in ('group', 'groups') and ${col} in (select g.id::text from groups g where lower(g.display_name) = lower(${t})))
      or (f.kind = 'project' and ${col} in (select pj.id::text from projects pj where pj.workspace_id = i.workspace_id and (pj.key = upper(${t}) or lower(pj.name) = lower(${t}))))
      or (f.kind in ('version', 'versions') and ${col} in (select r.id::text from releases r where r.project_id = i.project_id and lower(r.name) = lower(${t}))))`)
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
        const t = put(text(v, 'priority'))   // compared by place in the list; an unknown name matches nothing
        return `(${PRIORITY_RANK}) ${c.op} (select -pr.position from priorities pr where pr.workspace_id = i.workspace_id and (lower(pr.name) = lower(${t}) or pr.key = lower(${t})))`
      }
      if (isCustom(c.field)) {
        const v0 = c.values[0]!
        const cmp = v0.kind === 'text' && Number.isFinite(Number(v0.text)) ? `(i.custom->>(f.id::text)) ~ '^-?[0-9.]+$' and (i.custom->>(f.id::text))::numeric ${c.op} ${number(v0)}`
          : `(i.custom->>(f.id::text)) ~ '^[0-9]{4}-' and (case when f.kind = 'datetime' then (i.custom->>(f.id::text))::timestamptz ${c.op} (${when(v0)})::timestamptz
              else (i.custom->>(f.id::text))::date ${c.op} (${when(v0)})::timestamptz::date end)`   // a date-time field compares the time too (spec 0502)
        return custom(c, cmp)
      }
      throw new HttpError(400, `JQL: ${c.op} compares dates, numbers and priority, not ${c.field}`, { jql: `${c.op} not allowed with ${c.field}` })
    }
    if (c.op.startsWith('was') || c.op === 'changed') return history(c)
    const any = c.values.map(v => eq(c, v))
    const cond = any.length === 1 ? any[0]! : `(${any.join(' or ')})`
    if (c.op === '=' || c.op === 'in') return cond
    // as in Jira, an empty field matches neither = nor != (a list field, such as fix versions, is empty when it has none)
    return `(not ${cond.startsWith('(') ? cond : `(${cond})`}${EMPTY[c.field] ? ` and not (${EMPTY[c.field]})` : ''})`
  }
  /** WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED (spec 0602), over the history of spec 0601. A single-valued field's
   *  periods: each change starts one (its new value, set by whoever changed it), the first change's old value runs from
   *  creation (set by the reporter), and a field never changed has its value now since creation. A fix version's: from when
   *  it was put on to when it was taken off; "no fix version" while none was on. */
  const history = (c: Clause): string => {
    const h = HISTORY[c.field]
    if (!h) throw new HttpError(400, 'JQL: WAS and CHANGED search the history of assignee, fixVersion, priority, reporter, resolution and status', { jql: `No history search on ${c.field}` })
    if (c.values.length > 3000) throw new HttpError(400, 'JQL: WAS IN and WAS NOT IN take at most 3,000 values', { jql: 'Too many values' })
    const F = put(h.field), list = c.field === 'fixVersion', p0 = c.history ?? {}
    const isEmpty = (v: Value) => v.kind === 'text' && ['empty', 'null'].includes(v.text.toLowerCase())
    /** Does a value (its id or key `id`, its name then `s`) match v? */
    const match = (v: Value, id: string, s: string): string => {
      if (isEmpty(v)) return `${id} is null`
      if (c.field === 'assignee' || c.field === 'reporter') {
        if (v.kind === 'fn' && v.name === 'currentuser') return `${id} = ${put(me.id)}::text`
        if (v.kind === 'fn' && v.name === 'membersof' && v.arg) return `${id} in (select gm.user_id::text from group_members gm join groups g on g.id = gm.group_id where lower(g.display_name) = lower(${put(v.arg)}))`
        const t = put(text(v, c.field))
        return `(lower(${s}) = lower(${t}) or ${id} in (select u.id::text from users u where lower(u.email) = lower(${t}) or lower(u.name) = lower(${t}) or u.id::text = ${t}))`
      }
      const t = put(text(v, c.field))
      return c.field === 'resolution' ? `lower(${id}) = lower(${t})` : `(lower(${s}) = lower(${t}) or ${id} = ${c.field === 'priority' ? `lower(${t})` : t})`
    }
    const anyOf = (vs: Value[], id: string, s: string) => `(${vs.map(v => match(v, id, s)).join(' or ')})`
    const by = (col: string) => p0.by ? `(${p0.by.map(v => person(col, v)).join(' or ')})` : 'true'
    const day = (v: Value) => `(${when(v)})::timestamptz::date`
    if (c.op === 'changed') {
      const at = 'a.created_at'
      const same = (side: 'from' | 'to', v: Value) =>   // in the same change (a list's change is one row per value)
        `exists (select 1 from activity b where b.issue_id = a.issue_id and b.field = ${F} and b.created_at = a.created_at and ${match(v, `b.${side}_value`, `b.${side}_string`)})`
      const conds = [`a.issue_id = i.id`, `a.field = ${F}`,
        p0.after ? `${at} > (${when(p0.after)})::timestamptz` : '', p0.before ? `${at} < (${when(p0.before)})::timestamptz` : '',
        p0.on ? `${at}::date = ${day(p0.on)}` : '', p0.during ? `${at} between (${when(p0.during[0])})::timestamptz and (${when(p0.during[1])})::timestamptz` : '',
        p0.by ? by('a.actor_id') : '', p0.from ? same('from', p0.from) : '', p0.to ? same('to', p0.to) : ''].filter(Boolean)
      return `exists (select 1 from activity a where ${conds.join(' and ')})`
    }
    const neg = c.op === 'was not' || c.op === 'was not in'
    const plain = !p0.after && !p0.before && !p0.on && !p0.during && !p0.by
    let found: string
    if (plain && !(list && c.values.some(isEmpty))) {
      // no predicates: any value it had is its value now or one side of a change (the indexes of spec 0601)
      found = `(exists (select 1 from (${h.now}) n where ${anyOf(c.values, 'n.v', 'n.s')})
        or i.id in (select a.issue_id from activity a where a.field = ${F} and (${anyOf(c.values, 'a.to_value', 'a.to_string')} or ${anyOf(c.values, 'a.from_value', 'a.from_string')})))`
    } else {
      // a list's changes are one value each; a single value's change takes one value off and puts another on
      const ev = `select a.to_value as v, a.to_string as s, true as added, a.created_at as at, a.id, a.actor_id as by from activity a where a.issue_id = i.id and a.field = ${F}${list ? ' and a.to_value is not null' : ''}
        union all select a.from_value, a.from_string, false, a.created_at, a.id, a.actor_id from activity a where a.issue_id = i.id and a.field = ${F}${list ? ' and a.from_value is not null' : ''}`
      const w = `select ev.*, lead(at) over (partition by v order by at, added, id) as next_at, row_number() over (partition by v order by at, added, id) as n from ev`
      let periods = `select v, s, at as start, next_at as stop, by from w where added
        union all select v, s, i.created_at, at, i.reporter_id from w where n = 1 and not added
        union all select nw.v, nw.s, i.created_at, null, i.reporter_id from (${h.now}) nw where not exists (select 1 from ev where ev.v is not distinct from nw.v)`
      if (list) {   // no fix version: before the first one went on, and after each change that left none
        const k = `select ev.*, cardinality(i.fix_release_ids) - (select coalesce(sum(case when added then 1 else -1 end), 0) from ev)
            + sum(case when added then 1 else -1 end) over (order by at, added, id) as left_on, lead(at) over (order by at, added, id) as next_at from ev`
        periods += `
        union all select null, null, i.created_at, (select min(at) from ev), i.reporter_id
          where cardinality(i.fix_release_ids) - (select coalesce(sum(case when added then 1 else -1 end), 0) from ev) = 0
        union all select null, null, at, next_at, by from k where left_on = 0 and next_at is distinct from at`   // not the instant one version replaced another
        periods = `with ev as (${ev}), w as (${w}), k as (${k}) ${periods}`
      } else periods = `with ev as (${ev}), w as (${w}) ${periods}`
      const conds = [anyOf(c.values, 'h.v', 'h.s'),
        p0.after ? `(h.stop is null or h.stop > (${when(p0.after)})::timestamptz)` : '', p0.before ? `h.start < (${when(p0.before)})::timestamptz` : '',
        p0.on ? `h.start < ${day(p0.on)} + 1 and (h.stop is null or h.stop > ${day(p0.on)})` : '',
        p0.during ? `h.start <= (${when(p0.during[1])})::timestamptz and (h.stop is null or h.stop >= (${when(p0.during[0])})::timestamptz)` : '',
        p0.by ? by('h.by') : ''].filter(Boolean)
      found = `exists (select 1 from (${periods}) h where ${conds.join(' and ')})`
    }
    return neg ? `not ${found}` : found
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
