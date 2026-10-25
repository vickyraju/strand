// Test management (what Xray adds to Jira): which tests a Test Set, Test Plan or Pre-Condition holds, each project's test
// repository folders, and running tests (Test Executions, their runs, and the statuses runs and steps can have). Tests and their containers are work items, so access is theirs: you see a container's
// tests only where you could see them yourself (project and security level), and change it as you would edit the item.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { canJoinWork, levelOk, visibleAs } from '../access.ts'
import { publish } from '../events.ts'
import { audit, changes } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { ISSUE_ROW, issueByKey } from './issues.ts'
import { projectByKey } from './projects.ts'
import { searchWhere } from './misc.ts'
import { runFromSteps, testStatus, type RunStatus, type StepStatus } from '../shared/testStatus.ts'

const uuid = z.string().uuid()
const T = ['Testing']
const keyP = z.object({ key: z.string() })
const memberP = keyP.extend({ test: z.string() })
const CONTAINERS = ['test_set', 'test_plan', 'precondition']
const what = (type: string) => type === 'test_set' ? 'Test Set' : type === 'test_plan' ? 'Test Plan' : 'Pre-Condition'

/** The container, which must be a Test Set, Test Plan or Pre-Condition. */
async function containerOf(d: Db, req: { me: Me; method: string }, key: string) {
  const c = await issueByKey(d, req, key)
  if (!CONTAINERS.includes(c.type)) throw new HttpError(400, 'Only Test Sets, Test Plans and Pre-Conditions hold tests')
  return c
}

/** A container's tests that I can see, in order (plans: by folder, then order). */
const membersOf = (d: Db, me: Me, containerId: string) => d.query<any>(
  `${ISSUE_ROW.replace('select i.id,', 'select ti.folder, ti.position as item_position, i.id,')}
     join test_items ti on ti.member_id = i.id
    where ti.container_id = $1 and i.deleted_at is null and ${visibleAs(me, 'i.project_id', 2)} and ${levelOk(me, 2)}
    order by ti.folder, ti.position, i.number`, [containerId, me.id])

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/issues/:key/tests', { schema: { tags: T, summary: 'The tests a Test Set, Test Plan or Pre-Condition holds (those you can see)', params: keyP } }, async req => {
    const c = await containerOf(db, req, req.params.key)
    return (await membersOf(db, req.me, c.id)).filter((m: any) => m.type === 'test')
  })

  app.post('/issues/:key/tests', { schema: {
    tags: T, summary: 'Add tests to a Test Set, Test Plan or Pre-Condition, by key or by JQL (up to the bulk-change limit in System settings)', params: keyP,
    body: z.object({ keys: z.array(z.string().max(40)).max(5000).optional(), jql: z.string().max(5000).optional(), folder: z.string().max(500).optional() })
      .refine(b => !!b.keys?.length || !!b.jql?.trim(), 'Give keys or a JQL query'),
  } }, async req => {
    return tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const args: unknown[] = []
      const { where } = await searchWhere(req.me, { q: '', resolution: 'all', jql: req.body.jql }, args)
      if (req.body.keys?.length) {
        args.push(req.body.keys.map(k => k.toUpperCase()))
        where.push(`(p.key || '-' || i.number) = any($${args.length}::text[])`)
      }
      const { bulkMaxItems } = await getSetting(req.me.workspaceId, 'searchAndBulk')
      args.push(bulkMaxItems + 1)
      const found = await d.query<{ id: string; key: string; type: string }>(
        `select i.id, p.key || '-' || i.number as key, i.type from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
          where ${where.join(' and ')} order by i.number limit $${args.length}`, args)
      if (found.length > bulkMaxItems) throw new HttpError(400, `At most ${bulkMaxItems} tests at a time (the bulk-change limit in System settings)`)
      const notTests = found.filter(f => f.type !== 'test')
      if (req.body.keys?.length) {
        const missing = req.body.keys.filter(k => !found.some(f => f.key === k.toUpperCase()))
        if (missing.length) throw new HttpError(400, `Not found: ${missing.slice(0, 10).join(', ')}`, { keys: 'Unknown work items' })
        if (notTests.length) throw new HttpError(400, `Not tests: ${notTests.slice(0, 10).map(f => f.key).join(', ')}`, { keys: 'Only Tests can be added' })
      }
      const tests = found.filter(f => f.type === 'test')
      const [{ max }] = await d.query<{ max: number }>('select coalesce(max(position), 0) as max from test_items where container_id = $1', [c.id]) as any
      const added = await d.query<{ memberId: string }>(
        `insert into test_items (container_id, member_id, position, folder)
         select $1, t.id, $3 + t.n, $4 from unnest($2::uuid[]) with ordinality t(id, n)
         on conflict do nothing returning member_id`, [c.id, tests.map(t => t.id), max, req.body.folder ?? ''])
      if (added.length) {
        await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [c.id, req.me.id, `Added ${added.length} test${added.length === 1 ? '' : 's'}`])
        await publish(d, c.projectId, { type: 'tests.changed', id: c.id })
      }
      return { added: added.length, already: tests.length - added.length, items: (await membersOf(d, req.me, c.id)).filter((m: any) => m.type === 'test') }
    })
  })

  app.patch('/issues/:key/tests/:test', { schema: { tags: T, summary: 'Move a test within a Test Plan (its folder, its place)', params: memberP,
    body: z.object({ folder: z.string().max(500), position: z.number() }).partial() } }, async req => {
    return tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const t = await issueByKey(d, { me: req.me, method: 'GET' }, req.params.test)
      const folder = req.body.folder?.split('/').map(s => s.trim()).filter(Boolean).join('/')
      const [row] = await d.query('update test_items set folder = coalesce($3, folder), position = coalesce($4, position) where container_id = $1 and member_id = $2 returning 1',
        [c.id, t.id, folder ?? null, req.body.position ?? null])
      if (!row) throw new HttpError(404, `${t.key} isn’t in this ${what(c.type)}`)
      return (await membersOf(d, req.me, c.id)).filter((m: any) => m.type === 'test')
    })
  })

  app.delete('/issues/:key/tests/:test', { schema: { tags: T, summary: 'Take a test out of a Test Set, Test Plan or Pre-Condition', params: memberP } }, async (req, reply) => {
    await tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const t = await issueByKey(d, { me: req.me, method: 'GET' }, req.params.test)
      const r = await d.query('delete from test_items where container_id = $1 and member_id = $2 returning 1', [c.id, t.id])
      if (!r.length) throw new HttpError(404, `${t.key} isn’t in this ${what(c.type)}`)
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [c.id, req.me.id, `Removed test ${t.key}`])
      await publish(d, c.projectId, { type: 'tests.changed', id: c.id })
    })
    reply.code(204).send()
  })

  // A test's side: the sets, plans and pre-conditions it is in
  app.get('/issues/:key/test-containers', { schema: { tags: T, summary: 'The Test Sets, Test Plans and Pre-Conditions a test is in (those you can see)', params: keyP } }, async req => {
    const t = await issueByKey(db, req, req.params.key)
    return db.query(
      `select i.id, p.key || '-' || i.number as key, i.type, i.title, i.project_id from test_items ti
         join issues i on i.id = ti.container_id join projects p on p.id = i.project_id
        where ti.member_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)}
        order by i.type, i.number`, [t.id, req.me.id])
  })

  // ── Running tests (stage 3): statuses, executions and their runs ──

  // Statuses (Xray's test and step statuses): everyone reads them; global admins add and change them
  const STATUS_COLS = 'kind, key, name, description, color, final, maps_to, rank, builtin'
  app.get('/test-statuses', { schema: { tags: T, summary: 'Statuses a test run or a step can have' } }, async req =>
    db.query(`select ${STATUS_COLS} from test_statuses where workspace_id = $1 order by kind, rank, name`, [req.me.workspaceId]))
  const statusBody = z.object({
    kind: z.enum(['run', 'step']), name: z.string().trim().min(1).max(40), description: z.string().max(200).default(''),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/), final: z.boolean().default(true),
    mapsTo: z.string().max(40).describe('Run status: ok, nok, notrun or unknown (what it means for a requirement). Step status: a run status key'),
    rank: z.number().int().min(0).max(1000).default(5),
  })
  const statusP = z.object({ kind: z.enum(['run', 'step']), key: z.string().max(40) })
  async function checkMapsTo(d: Db, ws: string, kind: 'run' | 'step', mapsTo: string) {
    const ok = kind === 'run' ? ['ok', 'nok', 'notrun', 'unknown'].includes(mapsTo)
      : (await d.query(`select 1 from test_statuses where workspace_id = $1 and kind = 'run' and key = $2`, [ws, mapsTo])).length > 0
    if (!ok) throw new HttpError(400, kind === 'run' ? 'A run status means ok, nok, notrun or unknown' : 'A step status maps to a run status', { mapsTo: 'Not valid' })
  }
  app.post('/admin/test-statuses', { schema: { tags: T, summary: 'Add a test run or step status (global admins)', body: statusBody } }, async (req, reply) => {
    requireAdmin(req)
    const b = req.body
    return tx(async d => {
      await checkMapsTo(d, req.me.workspaceId, b.kind, b.mapsTo)
      if ((await d.query('select 1 from test_statuses where workspace_id = $1 and kind = $2 and lower(name) = lower($3)', [req.me.workspaceId, b.kind, b.name])).length)
        throw new HttpError(409, 'A status with that name already exists', { name: 'Already used' })
      const key = 'c-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      const [row] = await d.query(`insert into test_statuses (workspace_id, kind, key, name, description, color, final, maps_to, rank)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${STATUS_COLS}`, [req.me.workspaceId, b.kind, key, b.name, b.description, b.color, b.kind === 'step' ? true : b.final, b.mapsTo, b.rank])
      await audit(d, req, { action: 'test_status.created', type: 'test status', id: key, name: b.name, after: b })
      reply.code(201)
      return row
    })
  })
  app.patch('/admin/test-statuses/:kind/:key', { schema: { tags: T, summary: 'Change a test status (global admins). Built-in ones keep what they mean: only their name, colour, description and rank change', params: statusP, body: statusBody.omit({ kind: true }).partial() } }, async req => {
    requireAdmin(req)
    return tx(async d => {
      const [cur] = await d.query<any>(`select ${STATUS_COLS} from test_statuses where workspace_id = $1 and kind = $2 and key = $3 for update`, [req.me.workspaceId, req.params.kind, req.params.key])
      if (!cur) throw new HttpError(404, 'No such status')
      const b = req.body
      if (cur.builtin && (b.final !== undefined && b.final !== cur.final || b.mapsTo !== undefined && b.mapsTo !== cur.mapsTo))
        throw new HttpError(400, `${cur.name} is built in: what it means can’t change`)
      if (b.mapsTo) await checkMapsTo(d, req.me.workspaceId, req.params.kind, b.mapsTo)
      const next = { ...cur, ...b }
      const [row] = await d.query(`update test_statuses set name = $4, description = $5, color = $6, final = $7, maps_to = $8, rank = $9
        where workspace_id = $1 and kind = $2 and key = $3 returning ${STATUS_COLS}`,
        [req.me.workspaceId, req.params.kind, req.params.key, next.name, next.description, next.color, next.final, next.mapsTo, next.rank])
      const c = changes(cur, next)
      if (c.changed) await audit(d, req, { action: 'test_status.updated', type: 'test status', id: cur.key, name: next.name, before: c.before, after: c.after })
      return row
    })
  })
  app.delete('/admin/test-statuses/:kind/:key', { schema: { tags: T, summary: 'Remove a status you added (global admins); not one that runs or steps use', params: statusP } }, async (req, reply) => {
    requireAdmin(req)
    await tx(async d => {
      const [cur] = await d.query<any>('select * from test_statuses where workspace_id = $1 and kind = $2 and key = $3 for update', [req.me.workspaceId, req.params.kind, req.params.key])
      if (!cur) throw new HttpError(404, 'No such status')
      if (cur.builtin) throw new HttpError(409, `${cur.name} is built in`)
      const [{ n }] = await d.query<{ n: number }>(req.params.kind === 'run'
        ? `select count(*)::int as n from test_runs r join issues i on i.id = r.execution_id where i.workspace_id = $1 and r.status = $2`
        : `select count(*)::int as n from test_runs r join issues i on i.id = r.execution_id, jsonb_array_elements(r.steps) s where i.workspace_id = $1 and s->>'status' = $2`,
        [req.me.workspaceId, cur.key]) as any
      const [{ m }] = await d.query<{ m: number }>(`select count(*)::int as m from test_statuses where workspace_id = $1 and kind = 'step' and maps_to = $2`, [req.me.workspaceId, cur.key]) as any
      if (n || (req.params.kind === 'run' && m)) throw new HttpError(409, n ? `${n} ${req.params.kind === 'run' ? 'runs' : 'steps'} have this status` : 'Step statuses map to it: change them first')
      await d.query('delete from test_statuses where workspace_id = $1 and kind = $2 and key = $3', [req.me.workspaceId, cur.kind, cur.key])
      await audit(d, req, { action: 'test_status.deleted', type: 'test status', id: cur.key, name: cur.name })
    })
    reply.code(204).send()
  })

  /** A run, as the API shows it: with its test and execution, and whether the test has changed since the run was made. */
  const RUN_ROW = `
    select r.id, r.execution_id, ep.key || '-' || e.number as execution_key, e.title as execution_title, e.test_environments as environments,
           r.test_id, tp.key || '-' || t.number as test_key, t.title as test_title, r.status, r.assignee_id, r.executed_by,
           r.started_at, r.finished_at, r.spec, r.steps, r.comment, r.defect_ids, r.evidence_ids, r.version, r.created_at, r.updated_at,
           (r.spec is distinct from t.test_spec) as spec_changed
      from test_runs r join issues e on e.id = r.execution_id join projects ep on ep.id = e.project_id
                       join issues t on t.id = r.test_id join projects tp on tp.id = t.project_id`
  /** Runs I may see: both the execution and the test must be visible to me. `p` is the parameter holding my id. */
  const runVisible = (me: Me, p: number) =>
    `e.deleted_at is null and t.deleted_at is null and ${visibleAs(me, 'e.project_id', p)} and ${levelOk(me, p, 'e')} and ${visibleAs(me, 't.project_id', p)} and ${levelOk(me, p, 't')}`
  const freshSteps = (spec: any) => (spec?.kind === 'manual' ? spec.steps : []).map((s: any) => ({ id: s.id, status: 'TODO', actual: '', comment: '', defectIds: [], evidenceIds: [] }))
  const statusesOf = async (d: Db, ws: string) => {
    const rows = await d.query<any>('select kind, key, final, maps_to, rank from test_statuses where workspace_id = $1', [ws])
    return { run: rows.filter(r => r.kind === 'run') as RunStatus[], step: rows.filter(r => r.kind === 'step') as StepStatus[] }
  }

  /** Runs one test each in an execution (those not already in it), in a transaction. */
  async function addRuns(d: Db, me: Me, executionId: string, tests: { id: string }[]) {
    if (!tests.length) return 0
    const rows = await d.query(
      `insert into test_runs (execution_id, test_id, spec, steps)
       select $1, t.id, t.test_spec,
              coalesce((select jsonb_agg(jsonb_build_object('id', s->>'id', 'status', 'TODO', 'actual', '', 'comment', '', 'defectIds', '[]'::jsonb, 'evidenceIds', '[]'::jsonb))
                          from jsonb_array_elements(case when t.test_spec->>'kind' = 'manual' then t.test_spec->'steps' else '[]' end) s), '[]')
         from issues t where t.id = any($2::uuid[])
       on conflict (execution_id, test_id) do nothing returning id`, [executionId, tests.map(t => t.id)])
    if (rows.length) await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [executionId, me.id, `Added ${rows.length} test${rows.length === 1 ? '' : 's'} to run`])
    return rows.length
  }
  /** Tests to run: by key, by JQL, or every test of a Test Set or Test Plan I can see. */
  async function testsFor(d: Db, req: any, b: { keys?: string[]; jql?: string; from?: string }) {
    if (b.from) {
      const c = await containerOf(d, { me: req.me, method: 'GET' }, b.from)
      return (await membersOf(d, req.me, c.id)).filter((m: any) => m.type === 'test')
    }
    const args: unknown[] = []
    const { where } = await searchWhere(req.me, { q: '', resolution: 'all', jql: b.jql }, args)
    if (b.keys?.length) { args.push(b.keys.map(k => k.toUpperCase())); where.push(`(p.key || '-' || i.number) = any($${args.length}::text[])`) }
    const { bulkMaxItems } = await getSetting(req.me.workspaceId, 'searchAndBulk')
    args.push(bulkMaxItems + 1)
    const found = await d.query<{ id: string; key: string; type: string }>(
      `select i.id, p.key || '-' || i.number as key, i.type from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
        where ${where.join(' and ')} order by i.number limit $${args.length}`, args)
    if (found.length > bulkMaxItems) throw new HttpError(400, `At most ${bulkMaxItems} tests at a time (the bulk-change limit in System settings)`)
    if (b.keys?.length) {
      const missing = b.keys.filter(k => !found.some(f => f.key === k.toUpperCase()))
      if (missing.length) throw new HttpError(400, `Not found: ${missing.slice(0, 10).join(', ')}`, { keys: 'Unknown work items' })
      const notTests = found.filter(f => f.type !== 'test')
      if (notTests.length) throw new HttpError(400, `Not tests: ${notTests.slice(0, 10).map(f => f.key).join(', ')}`, { keys: 'Only Tests can be run' })
    }
    return found.filter(f => f.type === 'test')
  }
  const testsBody = z.object({ keys: z.array(z.string().max(40)).max(5000).optional(), jql: z.string().max(5000).optional(), from: z.string().max(40).optional().describe('A Test Set or Test Plan: run all its tests') })
    .refine(b => !!b.keys?.length || !!b.jql?.trim() || !!b.from, 'Give keys, a JQL query or a Test Set or Test Plan')

  // An execution's runs, or a test's runs in every execution
  app.get('/issues/:key/runs', { schema: { tags: T, summary: 'A Test Execution’s runs, or a Test’s runs in every execution (those you can see)', params: keyP } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    if (i.type !== 'test_execution' && i.type !== 'test') throw new HttpError(400, 'Only Test Executions and Tests have runs')
    return db.query(`${RUN_ROW} where r.${i.type === 'test' ? 'test_id' : 'execution_id'} = $1 and ${runVisible(req.me, 2)} order by ${i.type === 'test' ? 'r.created_at desc' : 't.number'}`, [i.id, req.me.id])
  })
  app.post('/issues/:key/runs', { schema: { tags: T, summary: 'Add tests to a Test Execution (by key, JQL, or all of a Test Set or Test Plan); each gets a run', params: keyP, body: testsBody } }, async req => {
    return tx(async d => {
      const e = await issueByKey(d, req, req.params.key)
      if (e.type !== 'test_execution') throw new HttpError(400, 'Only a Test Execution runs tests')
      const tests = await testsFor(d, req, req.body)
      const added = await addRuns(d, req.me, e.id, tests)
      await publish(d, e.projectId, { type: 'runs.changed', id: e.id })
      return { added, already: tests.length - added }
    })
  })
  app.delete('/issues/:key/runs/:test', { schema: { tags: T, summary: 'Take a test (and its run) out of a Test Execution', params: memberP } }, async (req, reply) => {
    await tx(async d => {
      const e = await issueByKey(d, req, req.params.key)
      const t = await issueByKey(d, { me: req.me, method: 'GET' }, req.params.test)
      if (!(await d.query('delete from test_runs where execution_id = $1 and test_id = $2 returning 1', [e.id, t.id])).length) throw new HttpError(404, `${t.key} isn’t in this execution`)
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [e.id, req.me.id, `Removed test ${t.key}`])
      await publish(d, e.projectId, { type: 'runs.changed', id: e.id })
    })
    reply.code(204).send()
  })

  // A plan's executions: list them, make a new one with the plan's tests, or add an existing one
  app.get('/issues/:key/executions', { schema: { tags: T, summary: 'A Test Plan’s Test Executions (those you can see)', params: keyP } }, async req => {
    const c = await containerOf(db, req, req.params.key)
    return (await membersOf(db, req.me, c.id)).filter((m: any) => m.type === 'test_execution')
  })
  app.post('/issues/:key/executions', { schema: {
    tags: T, summary: 'Make a Test Execution for a Test Plan or Test Set with its tests (or add an existing execution to a plan, with `key`)', params: keyP,
    body: z.object({ key: z.string().max(40).optional(), title: z.string().trim().min(1).max(500).optional(), environments: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      releaseId: uuid.nullable().optional(), revision: z.string().max(200).optional(), assigneeId: uuid.nullable().optional() }),
  } }, async (req, reply) => {
    return tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      if (c.type === 'precondition') throw new HttpError(400, 'Make executions from a Test Plan or Test Set')
      let execId: string
      if (req.body.key) {
        if (c.type !== 'test_plan') throw new HttpError(400, 'Only a Test Plan holds executions')
        const e = await issueByKey(d, req, req.body.key)
        if (e.type !== 'test_execution') throw new HttpError(400, `${e.key} isn’t a Test Execution`, { key: 'Not a Test Execution' })
        execId = e.id
      } else {
        const { insertIssue } = await import('./issues.ts')
        execId = await insertIssue(d, req.me, c.projectId, {
          type: 'test_execution', title: req.body.title ?? `Run of ${c.key} ${c.title}`.slice(0, 500), testEnvironments: req.body.environments ?? [],
          ...(req.body.releaseId !== undefined ? { releaseId: req.body.releaseId } : {}), ...(req.body.revision ? { revision: req.body.revision } : {}),
          ...(req.body.assigneeId !== undefined ? { assigneeId: req.body.assigneeId } : {}),
        }, `Created from ${c.key}`)
        await addRuns(d, req.me, execId, (await membersOf(d, req.me, c.id)).filter((m: any) => m.type === 'test'))
      }
      if (c.type === 'test_plan')
        await d.query(`insert into test_items (container_id, member_id, position) values ($1, $2, (select coalesce(max(position), 0) + 1 from test_items where container_id = $1)) on conflict do nothing`, [c.id, execId])
      await publish(d, c.projectId, { type: 'tests.changed', id: c.id })
      reply.code(201)
      return (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [execId]))[0]
    })
  })

  // Progress: an execution by its runs; a plan by each test's status in the plan (Xray's rules: its executions' runs)
  app.get('/issues/:key/test-progress', { schema: { tags: T, summary: 'How far a Test Execution or Test Plan has got: tests by status', params: keyP } }, async req => {
    const i = await issueByKey(db, req, req.params.key)
    const st = await statusesOf(db, req.me.workspaceId)
    const count = (keys: string[]) => keys.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})
    if (i.type === 'test_execution') {
      const rows = await db.query<{ status: string }>(`select r.status from test_runs r join issues e on e.id = r.execution_id join issues t on t.id = r.test_id where r.execution_id = $1 and ${runVisible(req.me, 2)}`, [i.id, req.me.id])
      return { total: rows.length, byStatus: count(rows.map(r => r.status)) }
    }
    if (i.type !== 'test_plan') throw new HttpError(400, 'Only Test Executions and Test Plans have progress')
    const tests = (await membersOf(db, req.me, i.id)).filter((m: any) => m.type === 'test')
    const runs = await db.query<any>(
      `select r.test_id, r.status, r.finished_at, r.created_at, e.test_environments as environments
         from test_runs r join issues e on e.id = r.execution_id join issues t on t.id = r.test_id
        where r.execution_id in (select member_id from test_items where container_id = $1) and ${runVisible(req.me, 2)}`, [i.id, req.me.id])
    const { finalStatusesHavePrecedence } = await getSetting(req.me.workspaceId, 'testing')
    const iso = (v: any) => (v ? new Date(v).toISOString() : null)
    const keys = tests.map((t: any) => testStatus(runs.filter(r => r.testId === t.id).map(r => ({ status: r.status, finishedAt: iso(r.finishedAt), createdAt: iso(r.createdAt)!, environments: r.environments })),
      st.run, finalStatusesHavePrecedence) ?? 'TODO')
    return { total: tests.length, byStatus: count(keys) }
  })

  // One run: read it, record results, reset it, its defects and evidence
  async function runFor(d: Db, req: any, id: string, write: boolean) {
    const [r] = await d.query<any>(`${RUN_ROW} where r.id = $1 and ${runVisible(req.me, 2)}`, [id, req.me.id])
    if (!r) throw new HttpError(404, 'Test run not found')
    const e = await issueByKey(d, { me: req.me, method: write ? 'PATCH' : 'GET' }, r.executionId)       // members record results; viewers read
    return { r, e }
  }
  const runP = z.object({ id: uuid })
  app.get('/test-runs/:id', { schema: { tags: T, summary: 'One test run: the test as it was, each step’s result, defects and evidence', params: runP } }, async req => (await runFor(db, req, req.params.id, false)).r)

  app.patch('/test-runs/:id', { schema: {
    tags: T, summary: 'Record results. Step results set the run’s status (Xray’s rules) unless you give one; reaching a final status records who finished it and when', params: runP,
    body: z.object({
      status: z.string().max(40).optional(), assigneeId: uuid.nullable().optional(), comment: z.string().max(20000).optional(),
      steps: z.array(z.object({ id: z.string().max(40), status: z.string().max(40).optional(), actual: z.string().max(10000).optional(), comment: z.string().max(10000).optional() })).max(200).optional(),
      version: z.number().int().optional().describe('The version you last saw: an older one is refused (409)'),
    }),
  } }, async req => {
    return tx(async d => {
      const { r, e } = await runFor(d, req, req.params.id, true)
      await d.query('select 1 from test_runs where id = $1 for update', [r.id])
      const [{ version }] = await d.query<{ version: number }>('select version from test_runs where id = $1', [r.id]) as any
      const b = req.body
      if (b.version !== undefined && b.version !== version) throw new HttpError(409, 'Someone else changed this run: reload it')
      const st = await statusesOf(d, req.me.workspaceId)
      let steps = r.steps as any[]
      if (b.steps) {
        for (const s of b.steps) {
          const i = steps.findIndex(x => x.id === s.id)
          if (i < 0) throw new HttpError(400, 'No such step in this run', { steps: `Unknown step ${s.id}` })
          if (s.status && !st.step.some(x => x.key === s.status)) throw new HttpError(400, 'No such step status', { steps: `Unknown status ${s.status}` })
          steps = steps.map((x, n) => (n === i ? { ...x, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) } : x))
        }
      }
      if (b.status && !st.run.some(x => x.key === b.status)) throw new HttpError(400, 'No such run status', { status: 'Unknown status' })
      if (b.assigneeId && !(await canJoinWork(d, e.projectId, b.assigneeId))) throw new HttpError(400, 'The assignee must be a member of this project')
      const status = b.status ?? (b.steps && steps.length ? runFromSteps(steps.map(s => s.status), st.step, st.run) : r.status)
      const final = st.run.find(x => x.key === status)?.final ?? false
      const began = r.startedAt ?? (status !== 'TODO' ? new Date() : null)
      const [row] = await d.query<any>(
        `update test_runs set status = $2, steps = $3, comment = coalesce($4, comment), assignee_id = case when $5 then $6::uuid else assignee_id end,
                started_at = $7, finished_at = case when $8 then coalesce(case when status = $2 then finished_at end, now()) else null end,
                executed_by = case when $8 then $9::uuid else executed_by end, version = version + 1, updated_at = now()
          where id = $1 returning id`,
        [r.id, status, JSON.stringify(steps), b.comment ?? null, b.assigneeId !== undefined, b.assigneeId ?? null, began, final, req.me.id])
      if (status !== r.status) await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [r.executionId, req.me.id, `${r.testKey}: ${r.status} → ${status}`])
      await publish(d, e.projectId, { type: 'runs.changed', id: r.executionId })
      return (await runFor(d, req, row.id, false)).r
    })
  })

  app.post('/test-runs/:id/reset', { schema: { tags: T, summary: 'Start a run again from the test as it is now (its results are cleared)', params: runP } }, async req => {
    return tx(async d => {
      const { r, e } = await runFor(d, req, req.params.id, true)
      const [t] = await d.query<any>('select test_spec from issues where id = $1', [r.testId])
      await d.query(`update test_runs set spec = $2, steps = $3, status = 'TODO', started_at = null, finished_at = null, executed_by = null,
                     version = version + 1, updated_at = now() where id = $1`, [r.id, t.testSpec, JSON.stringify(freshSteps(t.testSpec))])
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [r.executionId, req.me.id, `${r.testKey}: run reset`])
      await publish(d, e.projectId, { type: 'runs.changed', id: r.executionId })
      return (await runFor(d, req, r.id, false)).r
    })
  })

  // A defect found by a run: a new bug (in the execution's project), or an existing item; linked to the test
  app.post('/test-runs/:id/defects', { schema: {
    tags: T, summary: 'Raise a defect from a run (a new bug, or an existing item by key), for the run or one step; it is linked to the test', params: runP,
    body: z.object({ stepId: z.string().max(40).optional(), key: z.string().max(40).optional(), title: z.string().trim().min(1).max(500).optional(), description: z.string().max(20000).optional() })
      .refine(b => !!b.key || !!b.title, 'Give the key of an existing item or a title for a new bug'),
  } }, async (req, reply) => {
    return tx(async d => {
      const { r, e } = await runFor(d, req, req.params.id, true)
      const b = req.body
      if (b.stepId && !(r.steps as any[]).some(s => s.id === b.stepId)) throw new HttpError(400, 'No such step in this run', { stepId: 'Unknown step' })
      let defectId: string
      if (b.key) defectId = (await issueByKey(d, { me: req.me, method: 'GET' }, b.key)).id
      else {
        const { insertIssue } = await import('./issues.ts')
        const step = b.stepId ? (r.spec?.steps ?? []).findIndex((s: any) => s.id === b.stepId) : -1
        const context = `Found running ${r.testKey} ${r.testTitle} in ${r.executionKey}${step >= 0 ? `, step ${step + 1}` : ''}.`
        const type = (await d.query('select 1 from work_types where project_id = $1 and key = $2', [e.projectId, 'bug'])).length ? 'bug' : 'task'
        defectId = await insertIssue(d, req.me, e.projectId, { type, title: b.title, description: [b.description?.trim(), context].filter(Boolean).join('\n\n') }, `Raised from a test run (${r.testKey})`)
      }
      await d.query(`insert into issue_links (issue_id, target_id, type) values ($1, $2, 'defect') on conflict do nothing`, [r.testId, defectId])
      const steps = (r.steps as any[]).map(s => (s.id === b.stepId && !s.defectIds.includes(defectId) ? { ...s, defectIds: [...s.defectIds, defectId] } : s))
      await d.query(`update test_runs set steps = $2, defect_ids = case when $3::uuid = any(defect_ids) then defect_ids else defect_ids || $3::uuid end,
                     version = version + 1, updated_at = now() where id = $1`, [r.id, JSON.stringify(steps), defectId])
      await publish(d, e.projectId, { type: 'runs.changed', id: r.executionId })
      reply.code(201)
      return { defect: (await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [defectId]))[0], run: (await runFor(d, req, r.id, false)).r }
    })
  })
  app.delete('/test-runs/:id/defects/:defect', { schema: { tags: T, summary: 'Take a defect off a run (the item itself stays)', params: runP.extend({ defect: uuid }) } }, async req => {
    return tx(async d => {
      const { r, e } = await runFor(d, req, req.params.id, true)
      const steps = (r.steps as any[]).map(s => ({ ...s, defectIds: s.defectIds.filter((x: string) => x !== req.params.defect) }))
      await d.query('update test_runs set steps = $2, defect_ids = array_remove(defect_ids, $3::uuid), version = version + 1, updated_at = now() where id = $1', [r.id, JSON.stringify(steps), req.params.defect])
      await publish(d, e.projectId, { type: 'runs.changed', id: r.executionId })
      return (await runFor(d, req, r.id, false)).r
    })
  })

  // Evidence: a file attached to the execution, recorded against the run or one of its steps
  app.post('/test-runs/:id/evidence', { schema: { tags: T, summary: 'Record a file attached to the execution as evidence for the run or one step', params: runP,
    body: z.object({ attachmentId: uuid, stepId: z.string().max(40).optional() }) } }, async req => {
    return tx(async d => {
      const { r, e } = await runFor(d, req, req.params.id, true)
      const b = req.body
      if (!(await d.query('select 1 from attachments where id = $1 and issue_id = $2 and uploaded_at is not null', [b.attachmentId, r.executionId])).length)
        throw new HttpError(400, 'Attach the file to the execution first', { attachmentId: 'Not an attachment of this execution' })
      if (b.stepId && !(r.steps as any[]).some(s => s.id === b.stepId)) throw new HttpError(400, 'No such step in this run', { stepId: 'Unknown step' })
      const steps = (r.steps as any[]).map(s => (s.id === b.stepId && !s.evidenceIds.includes(b.attachmentId) ? { ...s, evidenceIds: [...s.evidenceIds, b.attachmentId] } : s))
      await d.query(`update test_runs set steps = $2, evidence_ids = case when $4 or $3::uuid = any(evidence_ids) then evidence_ids else evidence_ids || $3::uuid end,
                     version = version + 1, updated_at = now() where id = $1`, [r.id, JSON.stringify(steps), b.attachmentId, !!b.stepId])
      await publish(d, e.projectId, { type: 'runs.changed', id: r.executionId })
      return (await runFor(d, req, r.id, false)).r
    })
  })

  // ── Test repository folders ──
  const folderBody = z.object({ name: z.string().trim().min(1).max(100).refine(n => !n.includes('/'), 'A folder name can’t contain “/”'), parentId: uuid.nullable().optional(), position: z.number().optional() })
  const folderP = keyP.extend({ folderId: uuid })
  const folders = (d: Db, projectId: string) => d.query(
    `select f.id, f.parent_id, f.name, f.position, (select count(*)::int from issues i where i.test_folder_id = f.id and i.deleted_at is null) as tests
       from test_folders f where f.project_id = $1 order by f.position, lower(f.name)`, [projectId])
  /** The parent must be one of the project's folders, and not the folder itself or inside it. */
  async function checkParent(d: Db, projectId: string, parentId: string | null | undefined, self?: string) {
    if (!parentId) return
    const [ok] = await d.query<{ n: number; loops: boolean }>(
      `with recursive up as (select id, parent_id from test_folders where id = $2 and project_id = $1
                             union all select f.id, f.parent_id from test_folders f join up on f.id = up.parent_id)
       select count(*)::int as n, coalesce(bool_or(id = $3::uuid), false) as loops from up`, [projectId, parentId, self ?? null])
    if (!ok?.n) throw new HttpError(400, 'No such folder in this project', { parentId: 'Unknown folder' })
    if (ok.loops) throw new HttpError(400, 'A folder can’t go inside itself', { parentId: 'Inside itself' })
  }
  const nameTaken = (e: any) => { if (e?.code === '23505') throw new HttpError(409, 'There is already a folder with that name here', { name: 'Already used' }); throw e }

  app.get('/projects/:key/test-folders', { schema: { tags: T, summary: 'The project’s test repository folders, with how many tests each holds', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return folders(db, p.id)
  })
  app.post('/projects/:key/test-folders', { schema: { tags: T, summary: 'Add a test repository folder', params: keyP, body: folderBody } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      await checkParent(d, p.id, req.body.parentId)
      const [row] = await d.query<{ id: string }>(
        `insert into test_folders (project_id, parent_id, name, position)
         values ($1, $2, $3, coalesce($4, (select coalesce(max(position), 0) + 1 from test_folders where project_id = $1))) returning id`,
        [p.id, req.body.parentId ?? null, req.body.name, req.body.position ?? null]).catch(nameTaken)
      await publish(d, p.id, { type: 'test-folders.changed' })
      reply.code(201)
      return (await folders(d, p.id)).find((f: any) => f.id === row!.id)
    })
  })
  app.patch('/projects/:key/test-folders/:folderId', { schema: { tags: T, summary: 'Rename or move a test repository folder', params: folderP, body: folderBody.partial() } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      const [cur] = await d.query<any>('select * from test_folders where id = $1 and project_id = $2 for update', [req.params.folderId, p.id])
      if (!cur) throw new HttpError(404, 'No such folder')
      if (req.body.parentId !== undefined) await checkParent(d, p.id, req.body.parentId, cur.id)
      await d.query('update test_folders set name = $2, parent_id = $3, position = $4 where id = $1',
        [cur.id, req.body.name ?? cur.name, req.body.parentId !== undefined ? req.body.parentId : cur.parentId, req.body.position ?? cur.position]).catch(nameTaken)
      await publish(d, p.id, { type: 'test-folders.changed' })
      return (await folders(d, p.id)).find((f: any) => f.id === cur.id)
    })
  })
  app.delete('/projects/:key/test-folders/:folderId', { schema: { tags: T, summary: 'Remove a test repository folder: its tests and folders move up to its parent', params: folderP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await tx(async d => {
      const [cur] = await d.query<any>('select * from test_folders where id = $1 and project_id = $2 for update', [req.params.folderId, p.id])
      if (!cur) throw new HttpError(404, 'No such folder')
      await d.query('update test_folders set parent_id = $2 where parent_id = $1', [cur.id, cur.parentId]).catch(nameTaken)
      await d.query('update issues set test_folder_id = $2, version = version + 1, updated_at = now() where test_folder_id = $1', [cur.id, cur.parentId])
      await d.query('delete from test_folders where id = $1', [cur.id])
      await audit(d, req, { action: 'project.test_folder.deleted', type: 'test folder', id: cur.id, name: cur.name, project: p })
      await publish(d, p.id, { type: 'test-folders.changed' })
    })
    reply.code(204).send()
  })
}
export default plugin
