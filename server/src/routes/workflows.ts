// Administration › Workflows (Jira's statuses, workflows and workflow schemes): system administrators keep them, and a
// change applies to every project that uses it. Projects only choose a scheme (projects.ts).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireJiraAdmin } from './globalPermissions.ts'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { rulesSchema } from '../transitions.ts'
import { kickJobs } from '../jobs.ts'
import { countUsing, enqueueApply, itemsIn, nothing, pageUsing, previewing, runningApply, someOf, summarize } from '../workflows.ts'

const T = ['Workflows']
const uuid = z.string().uuid()
const idP = z.object({ id: uuid })
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const category = z.enum(['todo', 'in-progress', 'done'])
const name = z.string().trim().min(1).max(60)
const statusFields = { name, description: z.string().max(500), color, category }
const statusBody = z.object({ ...statusFields, description: statusFields.description.default('') })
const statusMap = z.record(uuid, uuid).default({}).describe('Where items go from a status they can no longer be in: global status id → global status id (else the first of the same category)')
const dryRun = z.boolean().default(false).describe('Report what would change, and change nothing')
const taken = (what: string) => (e: any) => { if (e?.code === '23505') throw new HttpError(409, `A ${what} with that name already exists`, { name: 'Already used' }); throw e }

const STATUS_ROW = `s.id, s.name, s.description, s.color, s.category, s.position,
  (select coalesce(jsonb_agg(w.name order by lower(w.name)), '[]') from workflows w where s.id = any(w.statuses)) as workflows`
const statusesOf = (d: Db, ids: string[]) => d.query<any>(
  `select s.id, s.name, s.description, s.color, s.category from unnest($1::uuid[]) with ordinality x(id, n) join wf_statuses s on s.id = x.id order by x.n`, [ids])

/** One workflow in full, with the schemes that use it and how many projects that makes (which projects: page through
 *  GET /admin/workflows/:id/projects, for system administrators). */
async function workflowOut(d: Db, ws: string, id: string) {
  const [w] = await d.query<any>('select id, name, description, statuses, transitions, layout, version, updated_at, resolution_on_done from workflows where id = $1 and workspace_id = $2', [id, ws])
  if (!w) throw new HttpError(404, 'No such workflow')
  return {
    ...w, statuses: await statusesOf(d, w.statuses),
    schemes: await d.query(`select id, name from workflow_schemes where default_workflow_id = $1 or exists (select 1 from jsonb_each_text(mappings) m where m.value = $1::text) order by lower(name)`, [id]),
    projectCount: await countUsing(d, ws, { workflowId: id }),
  }
}

/** One change at a time: a change that reaches projects waits for the last one to finish applying. */
async function notWhileApplying(d: Db, ws: string) {
  const j = await runningApply(d, ws)
  if (j) throw new HttpError(409, `The last workflow change is still being applied (${(j.progress?.done ?? 0).toLocaleString('en')} of ${(j.progress?.total ?? 0).toLocaleString('en')} projects). Try again when it has finished.`)
}

const pageQ = z.object({ query: z.string().max(100).optional(), cursor: z.string().max(40).optional().describe('`next` from the previous page'), limit: z.coerce.number().int().min(1).max(200).default(50) })

const transitionIn = z.object({
  id: z.string().min(1).max(64).describe('Stable within the workflow'), name: z.string().trim().min(1).max(100),
  fromIds: z.array(uuid).nullable().describe('null: from any status'), toId: uuid.nullable().describe('null: a loop'), rules: rulesSchema.default({}),
})
const publishBody = z.object({
  statuses: z.array(z.object({ id: uuid.describe('A global status, or a new id to add one'), ...statusBody.shape })).min(1).max(100)
    .describe('In order: new work starts in the first. A new status whose name matches a global one uses it'),
  transitions: z.array(transitionIn).max(500),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
  note: z.string().max(500).default(''), dryRun,
  statusMap: z.unknown().optional().describe('Not accepted (spec 0103): a status with work items can’t leave an active workflow; move them first, or copy the workflow and switch the projects’ scheme'),
})

const schemeFields = {
  name: z.string().trim().min(1).max(100), description: z.string().max(500), defaultWorkflowId: uuid,
  mappings: z.record(z.string().max(40), uuid).describe('Work type key → workflow id; other types use the default'),
}
const schemeBody = z.object({ ...schemeFields, description: schemeFields.description.default(''), mappings: schemeFields.mappings.default({}) })

const plugin: FastifyPluginAsyncZod = async app => {
  // Anyone signed in reads the library: projects choose a scheme, and see the workflows they get
  app.get('/workflow-schemes', { schema: { tags: T, summary: 'Workflow schemes: the default workflow, and the workflow for each work type it names' } }, async req =>
    db.query(`select sc.id, sc.name, sc.description, sc.default_workflow_id, sc.mappings, w.name as default_workflow,
                     (select count(*)::int from projects p where p.workflow_scheme_id = sc.id and p.deleting_at is null) as projects
                from workflow_schemes sc join workflows w on w.id = sc.default_workflow_id where sc.workspace_id = $1 order by lower(sc.name)`, [req.me.workspaceId]))
  app.get('/workflows', { schema: { tags: T, summary: 'Workflows, with how many schemes and projects use each' } }, async req =>
    db.query(`select w.id, w.name, w.description, w.version, w.updated_at, cardinality(w.statuses) as statuses, jsonb_array_length(w.transitions) as transitions,
                     (select count(*)::int from workflow_schemes sc where sc.default_workflow_id = w.id or exists (select 1 from jsonb_each_text(sc.mappings) m where m.value = w.id::text)) as schemes,
                     (select count(*)::int from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id
                       where p.deleting_at is null and (sc.default_workflow_id = w.id or exists (select 1 from jsonb_each_text(sc.mappings) m where m.value = w.id::text))) as projects
                from workflows w where w.workspace_id = $1 order by lower(w.name)`, [req.me.workspaceId]))
  app.get('/workflows/:id', { schema: { tags: T, summary: 'One workflow: its statuses in order, transitions, diagram layout, the schemes using it and how many projects', params: idP } }, async req =>
    workflowOut(db, req.me.workspaceId, req.params.id))

  // Which projects a workflow or scheme reaches: a count, and the projects a page at a time (there can be thousands)
  for (const [path, what] of [['/admin/workflows/:id/projects', 'workflow'], ['/admin/workflow-schemes/:id/projects', 'scheme']] as const)
    app.get(path, { schema: { tags: T, summary: `Projects using a ${what}, by key, a page at a time; with query, those whose key or name contains it (system administrators)`, params: idP, querystring: pageQ } }, async req => {
      await requireJiraAdmin(req)
      const r = what === 'workflow' ? { workflowId: req.params.id } : { schemeId: req.params.id }
      const page = await pageUsing(db, req.me.workspaceId, r, { query: req.query.query, after: req.query.cursor, limit: req.query.limit })
      return { ...page, total: await countUsing(db, req.me.workspaceId, r) }
    })
  app.get('/admin/workflows/applying', { schema: { tags: T, summary: 'The workflow change being applied to projects right now, if any, and how far it has got (system administrators)' } }, async req => {
    await requireJiraAdmin(req)
    const j = await runningApply(db, req.me.workspaceId)
    return j && { jobId: j.id, workflowId: j.payload.workflowId ?? null, schemeId: j.payload.schemeId ?? null, name: j.payload.name ?? null,
      done: j.progress?.done ?? 0, total: j.progress?.total ?? 0, startedAt: j.createdAt }
  })

  // ── Statuses ──
  app.get('/admin/statuses', { schema: { tags: T, summary: 'Global statuses and the workflows using each (system administrators)' } }, async req => {
    await requireJiraAdmin(req)
    return db.query(`select ${STATUS_ROW} from wf_statuses s where s.workspace_id = $1 order by s.position, lower(s.name)`, [req.me.workspaceId])
  })
  app.post('/admin/statuses', { schema: { tags: T, summary: 'Add a global status (system administrators)', body: statusBody } }, async (req, reply) => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const [s] = await d.query<{ id: string }>(`insert into wf_statuses (workspace_id, name, description, color, category, position)
        values ($1, $2, $3, $4, $5, (select coalesce(max(position), -1) + 1 from wf_statuses where workspace_id = $1)) returning id`,
      [req.me.workspaceId, req.body.name, req.body.description, req.body.color, req.body.category]).catch(taken('status'))
      await audit(d, req, { action: 'workflow.status.created', type: 'status', id: s!.id, name: req.body.name, after: req.body })
      reply.code(201)
      return (await d.query(`select ${STATUS_ROW} from wf_statuses s where s.id = $1`, [s!.id]))[0]
    })
  })
  app.patch('/admin/statuses/:id', { schema: { tags: T, summary: 'Rename or restyle a global status: every workflow and project using it changes (system administrators)', params: idP, body: z.object(statusFields).partial() } }, async req => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const [before] = await d.query<any>('select name, description, color, category from wf_statuses where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!before) throw new HttpError(404, 'No such status')
      const next = { ...before, ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) }
      await d.query('update wf_statuses set name = $2, description = $3, color = $4, category = $5 where id = $1', [req.params.id, next.name, next.description, next.color, next.category]).catch(taken('status'))
      await d.query('update statuses set name = $2, description = $3, color = $4, category = $5 where global_status_id = $1', [req.params.id, next.name, next.description, next.color, next.category])
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'workflow.status.updated', type: 'status', id: req.params.id, name: next.name, before: c.before, after: c.after })
      return (await d.query(`select ${STATUS_ROW} from wf_statuses s where s.id = $1`, [req.params.id]))[0]
    })
  })
  app.delete('/admin/statuses/:id', { schema: { tags: T, summary: 'Remove a global status no workflow uses (system administrators)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req)
    await tx(async d => {
      const [s] = await d.query<any>(`select ${STATUS_ROW} from wf_statuses s where s.id = $1 and s.workspace_id = $2 for update`, [req.params.id, req.me.workspaceId])
      if (!s) throw new HttpError(404, 'No such status')
      if (s.workflows.length) throw new HttpError(409, `Workflows use this status: ${s.workflows.join(', ')}. Take it out of them first`)
      await d.query('delete from wf_statuses where id = $1', [req.params.id])
      await audit(d, req, { action: 'workflow.status.deleted', type: 'status', id: s.id, name: s.name, before: { name: s.name, category: s.category } })
    })
    reply.code(204).send()
  })

  // ── Workflows ──
  app.post('/admin/workflows', { schema: { tags: T, summary: 'Add a workflow, as a copy of another or with a first and a last status (system administrators)',
    body: z.object({ name, description: z.string().max(500).default(''), copyFrom: uuid.optional() }) } }, async (req, reply) => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const ws = req.me.workspaceId
      let from: { statuses: string[]; transitions: unknown[]; layout: unknown; resolutionOnDone?: boolean }
      if (req.body.copyFrom) {
        const [w] = await d.query<any>('select statuses, transitions, layout, resolution_on_done from workflows where id = $1 and workspace_id = $2', [req.body.copyFrom, ws])
        if (!w) throw new HttpError(400, 'No such workflow to copy', { copyFrom: 'Not found' })
        from = w
      } else {
        const ends = await d.query<{ id: string; name: string }>(`(select id, name from wf_statuses where workspace_id = $1 and category = 'todo' order by position limit 1)
          union all (select id, name from wf_statuses where workspace_id = $1 and category = 'done' order by position limit 1)`, [ws])
        if (ends.length < 2) throw new HttpError(409, 'Add a To do and a Done status first')
        from = { statuses: ends.map(s => s.id), transitions: ends.map(s => ({ id: crypto.randomUUID(), name: s.name, fromIds: null, toId: s.id, rules: {} })), layout: {} }
      }
      const [w] = await d.query<{ id: string }>(`insert into workflows (workspace_id, name, description, statuses, transitions, layout, resolution_on_done, updated_by) values ($1, $2, $3, $4, $5, $6, $8, $7) returning id`,
        [ws, req.body.name, req.body.description, from.statuses, JSON.stringify(from.transitions), JSON.stringify(from.layout), req.me.id, from.resolutionOnDone ?? true]).catch(taken('workflow'))
      await audit(d, req, { action: 'workflow.created', type: 'workflow', id: w!.id, name: req.body.name, after: { copyFrom: req.body.copyFrom ?? null } })
      reply.code(201)
      return workflowOut(d, ws, w!.id)
    })
  })
  app.patch('/admin/workflows/:id', { schema: { tags: T, summary: 'Rename a workflow, change its description, or say how its items get a resolution (system administrators)', params: idP,
    body: z.object({ name, description: z.string().max(500),
      resolutionOnDone: z.boolean().describe('true: reaching a Done status sets the default resolution (Jira Software’s simplified workflows); false: only transition rules set it (classic workflows)') }).partial() } }, async req => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const [before] = await d.query<any>('select name, description, resolution_on_done from workflows where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!before) throw new HttpError(404, 'No such workflow')
      const next = { name: req.body.name ?? before.name, description: req.body.description ?? before.description, resolutionOnDone: req.body.resolutionOnDone ?? before.resolutionOnDone }
      // As in Jira, an active workflow (one a project uses) keeps its name; its description can change (spec 0103 R2)
      if (next.name !== before.name && await countUsing(d, req.me.workspaceId, { workflowId: req.params.id }))
        throw new HttpError(400, 'A workflow’s name can’t change while projects use it. Copy it to make one with another name.', { name: 'In use' })
      await d.query('update workflows set name = $2, description = $3, resolution_on_done = $5, updated_at = now(), updated_by = $4 where id = $1', [req.params.id, next.name, next.description, req.me.id, next.resolutionOnDone]).catch(taken('workflow'))
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'workflow.updated', type: 'workflow', id: req.params.id, name: next.name, before: c.before, after: c.after })
      return workflowOut(d, req.me.workspaceId, req.params.id)
    })
  })
  app.delete('/admin/workflows/:id', { schema: { tags: T, summary: 'Remove a workflow no scheme uses (system administrators)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req)
    await tx(async d => {
      const w = await workflowOut(d, req.me.workspaceId, req.params.id)
      if (w.schemes.length) throw new HttpError(409, `Workflow schemes use this workflow: ${w.schemes.map((s: any) => s.name).join(', ')}`)
      await d.query('delete from workflows where id = $1', [w.id])
      await audit(d, req, { action: 'workflow.deleted', type: 'workflow', id: w.id, name: w.name })
    })
    reply.code(204).send()
  })

  app.post('/admin/workflows/:id/publish', { schema: { tags: T,
    summary: 'Save a workflow’s statuses, transitions and layout (system administrators). A changed workflow is recorded as a new version, and a background job applies it to every project using it (follow it at GET /jobs/:id). With dryRun, only reports what would change',
    params: idP, body: publishBody } }, async req => {
    await requireJiraAdmin(req)
    const b = req.body, ws = req.me.workspaceId
    if (b.statusMap !== undefined) throw new HttpError(400, 'Items aren’t moved by publishing a workflow: move them to another status first, or copy the workflow and switch the projects to it', { statusMap: 'Not accepted' })
    if (!b.dryRun) await notWhileApplying(db, ws)
    const out = await previewing(tx, b.dryRun, async d => {
      const [cur] = await d.query<any>('select id, name, statuses, transitions, version from workflows where id = $1 and workspace_id = $2 for update', [req.params.id, ws])
      if (!cur) throw new HttpError(404, 'No such workflow')
      // Statuses are global: one already known is updated everywhere; a new one with a known name is that one; else it's added
      const alias = new Map<string, string>()
      for (const s of b.statuses) {
        const [known] = await d.query<any>('select id, name, description, color, category from wf_statuses where workspace_id = $1 and (id = $2 or lower(name) = lower($3)) order by (id = $2) desc limit 1', [ws, s.id, s.name])
        if (known?.id === s.id) {
          if (known.name !== s.name || known.description !== s.description || known.color !== s.color || known.category !== s.category) {
            await d.query('update wf_statuses set name = $2, description = $3, color = $4, category = $5 where id = $1', [s.id, s.name, s.description, s.color, s.category]).catch(taken('status'))
            await d.query('update statuses set name = $2, description = $3, color = $4, category = $5 where global_status_id = $1', [s.id, s.name, s.description, s.color, s.category])
          }
          alias.set(s.id, s.id)
        } else if (known) alias.set(s.id, known.id)
        else {
          await d.query(`insert into wf_statuses (id, workspace_id, name, description, color, category, position)
            values ($1, $2, $3, $4, $5, $6, (select coalesce(max(position), -1) + 1 from wf_statuses where workspace_id = $2))`, [s.id, ws, s.name, s.description, s.color, s.category])
          alias.set(s.id, s.id)
        }
      }
      const statuses = b.statuses.map(s => alias.get(s.id)!)
      if (new Set(statuses).size !== statuses.length) throw new HttpError(400, 'A status is in the workflow twice', { statuses: 'Each status once' })
      const map = (id: string) => alias.get(id) ?? id
      const transitions = b.transitions.map(t => ({ ...t, fromIds: t.fromIds && t.fromIds.map(map), toId: t.toId && map(t.toId) }))
      for (const t of transitions) {
        if ([...(t.fromIds ?? []), ...(t.toId ? [t.toId] : [])].some(id => !statuses.includes(id)))
          throw new HttpError(400, `“${t.name}” uses a status that isn’t in the workflow`, { transitions: 'Unknown status' })
        // projects have their own custom fields, so a workflow they share can't name one
        if (JSON.stringify(t.rules).includes('"custom.')) throw new HttpError(400, `“${t.name}” uses a custom field: workflows are shared by projects, so their rules can only use the standard fields`, { transitions: 'Custom field' })
        for (const v of t.rules.validate ?? []) if (v.kind === 'parentStatus') v.statusIds = v.statusIds.map(map)
      }
      const parents = transitions.flatMap(t => (t.rules.validate ?? []).flatMap(v => (v.kind === 'parentStatus' ? v.statusIds : [])))
      if (parents.length && (await d.query('select id from wf_statuses where workspace_id = $1 and id = any($2)', [ws, parents])).length !== new Set(parents).size)
        throw new HttpError(400, 'A rule names a status that doesn’t exist', { transitions: 'Unknown status' })
      const layout = Object.fromEntries(Object.entries(b.layout).map(([k, v]) => [map(k), v]))
      // jsonb keeps keys in its own order, so compare with keys sorted
      const keyOf = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
      const changed = keyOf(cur.statuses) !== keyOf(statuses) || keyOf(cur.transitions) !== keyOf(transitions)
      // As in Jira, a status with work items can't leave an active workflow (spec 0103 R3)
      const blocked = await itemsIn(d, ws, cur.id, (cur.statuses as string[]).filter(g => !statuses.includes(g)))
      const why = blocked.map(x => `${x.status} has ${x.items.toLocaleString('en')} work item${x.items === 1 ? '' : 's'} in ${someOf(x.projects, x.projects.length + x.more)}`).join('; ')
      if (blocked.length && !b.dryRun) throw new HttpError(409, `${why}. Move them to another status first, or copy the workflow and switch the projects to the copy.`, { statuses: 'Work items are in a removed status' })
      const version = changed ? cur.version + 1 : cur.version
      await d.query('update workflows set statuses = $2, transitions = $3, layout = $4, version = $5, updated_at = now(), updated_by = $6 where id = $1',
        [cur.id, statuses, JSON.stringify(transitions), JSON.stringify(layout), version, req.me.id])
      if (changed) {
        await d.query('insert into workflow_versions (workflow_id, version, statuses, transitions, note, published_by) values ($1, $2, $3, $4, $5, $6)',
          [cur.id, version, JSON.stringify(await statusesOf(d, statuses)), JSON.stringify(transitions), b.note, req.me.id])
        await audit(d, req, { action: 'workflow.published', type: 'workflow', id: cur.id, name: `${cur.name} version ${version}`, after: { note: b.note, statuses: statuses.length, transitions: transitions.length } })
      }
      const summary = { ...(changed ? await summarize(d, ws, { workflowId: cur.id }) : nothing()), blocked }
      const jobId = changed && !b.dryRun && summary.projects ? await enqueueApply(d, { ...req.me, ip: req.ip }, { workflowId: cur.id, name: cur.name }, {}, summary.projects) : null
      return { workflow: await workflowOut(d, ws, cur.id), version, created: changed, summary, jobId }
    })
    if (out.jobId) kickJobs(app.log)                                     // once the job is committed
    return out
  })

  const versionP = idP.extend({ version: z.coerce.number().int().positive() })
  app.get('/workflows/:id/versions', { schema: { tags: T, summary: 'Published versions of a workflow, newest first', params: idP } }, async req =>
    db.query(`select v.version, v.note, v.published_at, u.name as published_by, jsonb_array_length(v.statuses) as statuses, jsonb_array_length(v.transitions) as transitions
                from workflow_versions v join workflows w on w.id = v.workflow_id left join users u on u.id = v.published_by
               where v.workflow_id = $1 and w.workspace_id = $2 order by v.version desc limit 200`, [req.params.id, req.me.workspaceId]))
  app.get('/workflows/:id/versions/:version', { schema: { tags: T, summary: 'One published version of a workflow, in full', params: versionP } }, async req => {
    const [v] = await db.query(`select v.version, v.note, v.published_at, u.name as published_by, v.statuses, v.transitions
                                  from workflow_versions v join workflows w on w.id = v.workflow_id left join users u on u.id = v.published_by
                                 where v.workflow_id = $1 and w.workspace_id = $2 and v.version = $3`, [req.params.id, req.me.workspaceId, req.params.version])
    if (!v) throw new HttpError(404, 'No such version')
    return v
  })

  // ── Schemes ──
  /** Every workflow a scheme names must be one of this workspace's. */
  const checkScheme = async (d: Db, ws: string, s: { defaultWorkflowId: string; mappings: Record<string, string> }) => {
    const ids = [...new Set([s.defaultWorkflowId, ...Object.values(s.mappings)])]
    if ((await d.query('select id from workflows where workspace_id = $1 and id = any($2)', [ws, ids])).length !== ids.length)
      throw new HttpError(400, 'Choose workflows that exist', { mappings: 'Unknown workflow' })
  }
  const schemeOut = async (d: Db, id: string) => (await d.query(`select sc.id, sc.name, sc.description, sc.default_workflow_id, sc.mappings, w.name as default_workflow,
      (select count(*)::int from projects p where p.workflow_scheme_id = sc.id and p.deleting_at is null) as projects
      from workflow_schemes sc join workflows w on w.id = sc.default_workflow_id where sc.id = $1`, [id]))[0]
  app.post('/admin/workflow-schemes', { schema: { tags: T, summary: 'Add a workflow scheme (system administrators)', body: schemeBody } }, async (req, reply) => {
    await requireJiraAdmin(req)
    return tx(async d => {
      await checkScheme(d, req.me.workspaceId, req.body)
      const [s] = await d.query<{ id: string }>('insert into workflow_schemes (workspace_id, name, description, default_workflow_id, mappings) values ($1, $2, $3, $4, $5) returning id',
        [req.me.workspaceId, req.body.name, req.body.description, req.body.defaultWorkflowId, JSON.stringify(req.body.mappings)]).catch(taken('workflow scheme'))
      await audit(d, req, { action: 'workflow_scheme.created', type: 'workflow scheme', id: s!.id, name: req.body.name, after: req.body })
      reply.code(201)
      return schemeOut(d, s!.id)
    })
  })
  app.patch('/admin/workflow-schemes/:id', { schema: { tags: T,
    summary: 'Change a workflow scheme (system administrators). A background job applies it to every project using it (follow it at GET /jobs/:id). With dryRun, only reports what would change',
    params: idP, body: z.object(schemeFields).partial().extend({ statusMap, dryRun }) } }, async req => {
    await requireJiraAdmin(req)
    const { statusMap: map, dryRun: dry, ...b } = req.body
    if (!dry) await notWhileApplying(db, req.me.workspaceId)
    const out = await previewing(tx, dry, async d => {
      const [before] = await d.query<any>('select name, description, default_workflow_id, mappings from workflow_schemes where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!before) throw new HttpError(404, 'No such workflow scheme')
      const next = { ...before, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) }
      await checkScheme(d, req.me.workspaceId, next)
      await d.query('update workflow_schemes set name = $2, description = $3, default_workflow_id = $4, mappings = $5, updated_at = now() where id = $1',
        [req.params.id, next.name, next.description, next.defaultWorkflowId, JSON.stringify(next.mappings)]).catch(taken('workflow scheme'))
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'workflow_scheme.updated', type: 'workflow scheme', id: req.params.id, name: next.name, before: c.before, after: c.after })
      const moved = before.defaultWorkflowId !== next.defaultWorkflowId || JSON.stringify(before.mappings) !== JSON.stringify(next.mappings)
      const summary = moved ? await summarize(d, req.me.workspaceId, { schemeId: req.params.id }, map) : nothing()
      const jobId = moved && !dry && summary.projects ? await enqueueApply(d, { ...req.me, ip: req.ip }, { schemeId: req.params.id, name: next.name }, map, summary.projects) : null
      return { scheme: await schemeOut(d, req.params.id), summary, jobId }
    })
    if (out.jobId) kickJobs(app.log)
    return out
  })
  app.delete('/admin/workflow-schemes/:id', { schema: { tags: T, summary: 'Remove a workflow scheme no project uses (system administrators)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req)
    await tx(async d => {
      const [s] = await d.query<any>('select id, name from workflow_schemes where id = $1 and workspace_id = $2 for update', [req.params.id, req.me.workspaceId])
      if (!s) throw new HttpError(404, 'No such workflow scheme')
      const used = await pageUsing(d, req.me.workspaceId, { schemeId: s.id }, { limit: 3 })
      if (used.items.length) throw new HttpError(409, `Projects use this scheme: ${someOf(used.items.map(p => p.key), await countUsing(d, req.me.workspaceId, { schemeId: s.id }))}`)
      await d.query('delete from workflow_schemes where id = $1', [s.id])
      await audit(d, req, { action: 'workflow_scheme.deleted', type: 'workflow scheme', id: s.id, name: s.name })
    })
    reply.code(204).send()
  })
}

export default plugin
