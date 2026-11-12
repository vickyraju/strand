import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJql, relative, filtersToJql, filterProjects, periodBound, JqlError } from '../src/shared/jql.ts'

test('[0018.R1][0018.R5] jql: clauses, AND binds tighter than OR, parentheses, NOT, lists, functions, sorting', () => {
  const q = parseJql('project = PAY AND (status = "In progress" OR priority in (high, urgent)) AND NOT assignee = currentUser() ORDER BY created DESC, priority')
  assert.deepEqual(q.orderBy, [{ field: 'created', dir: 'desc' }, { field: 'priority', dir: 'asc' }])
  assert.deepEqual(q.where, { kind: 'and', items: [
    { kind: 'clause', field: 'project', op: '=', values: [{ kind: 'text', text: 'PAY' }] },
    { kind: 'or', items: [
      { kind: 'clause', field: 'status', op: '=', values: [{ kind: 'text', text: 'In progress' }] },
      { kind: 'clause', field: 'priority', op: 'in', values: [{ kind: 'text', text: 'high' }, { kind: 'text', text: 'urgent' }] }] },
    { kind: 'not', item: { kind: 'clause', field: 'assignee', op: '=', values: [{ kind: 'fn', name: 'currentuser' }] } },
  ] })
  const w = parseJql('a = 1 OR b = 2 AND c = 3').where as any
  assert.equal(w.kind, 'or'); assert.equal(w.items[1].kind, 'and')
})

test('[0018.R2][0018.R3][0018.R5] jql: Jira names for fields, custom fields by name or cf[id], empty checks, dates', () => {
  const fields = (src: string) => { const w = parseJql(src).where as any; return (w.items ?? [w]).map((c: any) => [c.field, c.op]) }
  assert.deepEqual(fields('issuetype = Bug and fixVersion = "1.0" and duedate < -7d and "Story Points" > 3 and Team ~ core and cf[abc] is not empty and resolution is EMPTY'), [
    ['type', '='], ['fixVersion', '='], ['due', '<'], ['estimate', '>'], ['custom:Team', '~'], ['cf:abc', 'is not empty'], ['resolution', 'is empty']])
  assert.deepEqual(parseJql('').where, null)
  assert.deepEqual(parseJql('order by rank').orderBy, [{ field: 'rank', dir: 'asc' }])
  assert.equal(relative('-7d'), -7 * 86_400_000); assert.equal(relative('2w'), 14 * 86_400_000); assert.equal(relative('soon'), null)
})

test('[0018.R6] jql: mistakes say what and where', () => {
  const err = (src: string) => { try { parseJql(src); return null } catch (e) { return [(e as JqlError).message, (e as JqlError).at] } }
  assert.deepEqual(err('status = '), ['Expected a value', 8])
  assert.match(err('status "Done"')![0] as string, /Expected an operator after status/)
  assert.match(err('status = Done priority = high')![0] as string, /join clauses with AND or OR/)
  assert.match(err('priority in high')![0] as string, /Expected “\(”/)
  assert.match(err('(status = Done')![0] as string, /Expected “\)”/)
  assert.match(err('status = "Done')![0] as string, /quote is not closed/)
  assert.match(err('order by colour')![0] as string, /Can’t sort by colour/)
})

test('[0018.R9] jql: simple filters become the same JQL', () => {
  assert.equal(filtersToJql({ projectKey: 'PAY', assignee: 'me', priority: 'high', resolution: 'open', q: 'login page' }),
    'project = PAY AND assignee = currentUser() AND priority = high AND statusCategory != Done AND text ~ "login page"')
  assert.equal(filtersToJql({ assignee: '', label: 'ui', resolution: 'all' }), 'assignee is empty AND labels = ui')
})

test('[0018.R4] jql: a function that stands for a list (issue in testPlanTests("PAY-9", "FAIL"), sprint in openSprints())', () => {
  const q = parseJql('issue in testPlanTests("PAY-9", "FAIL", PASS) AND sprint in openSprints() AND key not in requirementTests(PAY-1)')
  assert.deepEqual(q.where, { kind: 'and', items: [
    { kind: 'clause', field: 'key', op: 'in', values: [{ kind: 'fn', name: 'testplantests', arg: 'PAY-9', args: ['PAY-9', 'FAIL', 'PASS'] }] },
    { kind: 'clause', field: 'sprint', op: 'in', values: [{ kind: 'fn', name: 'opensprints' }] },
    { kind: 'clause', field: 'key', op: 'not in', values: [{ kind: 'fn', name: 'requirementtests', arg: 'PAY-1' }] },
  ] })
})

test('[0101.R1] a board filter’s projects: named by project = / in, narrowed by AND, joined by OR only when every branch names projects; otherwise open', () => {
  const p = (q: string) => { const r = filterProjects(q); return r && r.sort() }
  assert.deepEqual(p('project = A'), ['a'])
  assert.deepEqual(p('project in (A, B)'), ['a', 'b'])
  assert.deepEqual(p('project = A AND type = Bug'), ['a'])
  assert.deepEqual(p('project in (A, B) AND project = B'), ['b'])
  assert.deepEqual(p('project = A OR project = B'), ['a', 'b'])
  assert.deepEqual(p('"Payments Platform" = x OR project = "Payments Platform"'), null)   // a branch without a project clause
  assert.deepEqual(p('project = "Payments Platform" ORDER BY rank'), ['payments platform'])  // names count as written
  for (const open of ['project = A OR type = Bug', 'assignee = x', 'project != A', 'project not in (A)', 'NOT project = A',
    '(project = A OR assignee = x) AND (project = B OR assignee = y)'])
    assert.equal(p(open), null, open)
})

test('[0602.R1][0602.R3] jql: WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED with their predicates', () => {
  const w = (src: string) => parseJql(src).where
  assert.deepEqual(w('status WAS "In Progress"'), { kind: 'clause', field: 'status', op: 'was', values: [{ kind: 'text', text: 'In Progress' }], history: {} })
  assert.deepEqual(w('status was in (Done, Closed)'), { kind: 'clause', field: 'status', op: 'was in', values: [{ kind: 'text', text: 'Done' }, { kind: 'text', text: 'Closed' }], history: {} })
  assert.equal((w('assignee WAS NOT EMPTY') as any).op, 'was not')
  assert.equal((w('fixVersion WAS NOT IN ("1.0")') as any).op, 'was not in')
  assert.deepEqual((w('status WAS Done AFTER "2026-01-01" BEFORE -1d ON 2026-01-05 DURING ("2026-01-01", now()) BY (ann, currentUser())') as any).history, {
    after: { kind: 'text', text: '2026-01-01' }, before: { kind: 'text', text: '-1d' }, on: { kind: 'text', text: '2026-01-05' },
    during: [{ kind: 'text', text: '2026-01-01' }, { kind: 'fn', name: 'now' }], by: [{ kind: 'text', text: 'ann' }, { kind: 'fn', name: 'currentuser' }] })
  assert.deepEqual(w('status CHANGED FROM "To Do" TO Done BY ann AND priority = high'), { kind: 'and', items: [
    { kind: 'clause', field: 'status', op: 'changed', values: [], history: { from: { kind: 'text', text: 'To Do' }, to: { kind: 'text', text: 'Done' }, by: [{ kind: 'text', text: 'ann' }] } },
    { kind: 'clause', field: 'priority', op: '=', values: [{ kind: 'text', text: 'high' }] }] })
  assert.equal((w('NOT status WAS Done') as any).kind, 'not')
  const err = (src: string) => { try { parseJql(src); return null } catch (e) { return (e as JqlError).message } }
  assert.match(err('status WAS Done DURING ("2026-01-01")')!, /DURING takes two dates/)
  assert.match(err('status WAS Done FROM x')!, /join clauses with AND or OR/)   // FROM and TO only follow CHANGED
  assert.match(err('status WAS IN Done')!, /Expected “\(”/)
})

test('[0603.R1] jql: the start and end of a day, week, month or year, moved by Jira\'s increment', () => {
  const now = new Date(2026, 10, 11, 15, 30)                     // Wednesday 11 Nov 2026, 15:30 local
  const at = (name: string, inc?: string) => { const d = periodBound(name, inc, now)!; return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()] }
  assert.deepEqual(at('startOfDay'), [2026, 11, 11, 0, 0])
  assert.deepEqual(at('startOfDay', '-1'), [2026, 11, 10, 0, 0])
  assert.deepEqual(at('startOfDay', '+8h'), [2026, 11, 11, 8, 0])
  assert.deepEqual(at('endOfDay'), [2026, 11, 11, 23, 59])
  assert.deepEqual(at('startOfWeek'), [2026, 11, 9, 0, 0])        // Monday
  assert.deepEqual(at('endOfWeek', '1'), [2026, 11, 22, 23, 59])
  assert.deepEqual(at('startOfMonth', '-1'), [2026, 10, 1, 0, 0])
  assert.deepEqual(at('endOfMonth', '-1M'), [2026, 10, 31, 23, 59])
  assert.deepEqual(at('endOfMonth', '+3'), [2027, 2, 28, 23, 59])
  assert.deepEqual(at('startOfYear', '-1y'), [2025, 1, 1, 0, 0])
  assert.deepEqual(at('endOfYear'), [2026, 12, 31, 23, 59])
  assert.deepEqual(at('startOfMonth', '2w'), [2026, 11, 15, 0, 0])
  assert.equal(periodBound('now', undefined, now), null)
  assert.throws(() => periodBound('startOfDay', 'soon', now), /isn’t an increment/)
})


test('[0609.R2] text queries: words joined by AND, phrases, wildcards, fuzzy, operators in capitals, parentheses; mistakes say where', async () => {
  const { parseTextQuery: t, wildcardRegex } = await import('../src/shared/textQuery.ts')
  assert.deepEqual(t('login page'), { k: 'and', items: [{ k: 'word', w: 'login' }, { k: 'word', w: 'page' }] })
  assert.deepEqual(t('"full screen"~10^2 OR roam~ OR win* OR te?t^4'), { k: 'or', items: [{ k: 'phrase', w: 'full screen' }, { k: 'fuzzy', w: 'roam' }, { k: 'wild', w: 'win*' }, { k: 'wild', w: 'te?t' }] })
  assert.deepEqual(t('bugs AND (atlassian || jira) -legacy NOT old !gone +must'), { k: 'and', items: [{ k: 'word', w: 'bugs' },
    { k: 'or', items: [{ k: 'word', w: 'atlassian' }, { k: 'word', w: 'jira' }] }, { k: 'not', item: { k: 'word', w: 'legacy' } },
    { k: 'not', item: { k: 'word', w: 'old' } }, { k: 'not', item: { k: 'word', w: 'gone' } }, { k: 'word', w: 'must' }] })
  assert.deepEqual(t('jira-software and [x]'), { k: 'and', items: [{ k: 'word', w: 'jira-software' }, { k: 'word', w: 'and' }, { k: 'word', w: 'x' }] })   // lower-case and is a word
  assert.equal(t('   '), null)
  for (const [q, msg, at] of [['"open', /quote is not closed/, 0], ['(a OR b', /Expected “\)”/, 0], ['a)', /has no “\(”/, 1], ['a AND', /word after/, 2], ['OR a', /needs a word before/, 0]] as const) {
    assert.throws(() => t(q), (e: any) => msg.test(e.message) && e.at === at, q)
  }
  assert.equal(wildcardRegex('*cula*'), '\\m\\w*cula\\w*\\M')
  assert.equal(wildcardRegex('te?t'), '\\mte\\wt\\M')
  // in JQL: the mistake's place in the whole query
  assert.throws(() => parseJql('summary ~ "a AND"'), (e: any) => e instanceof JqlError && /word after/.test(e.message) && e.at === 13)
  assert.equal(parseJql('comment ~ "deploy"').where!.kind, 'clause')
})
