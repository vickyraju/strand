// Plans (spec 0803): timelines across projects, as option B of Advanced Roadmaps. A plan's source is some projects or a
// saved view; its timeline is the initiatives, epics and items there (and the initiatives its epics belong to), with
// "blocks" links, releases and sprints. Only what each person can see; edits go straight to the items (no sandbox).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { visible, visibleAs } from '../access.ts'
import { getSetting } from '../settings.ts'
import { searchWhere, viewSeenBy } from './misc.ts'

const uuid = z.string().uuid()
const idP = z.object({ id: uuid })
/** Plans as `me` may see them: only the source projects they can see, and the source view's name only if they can see the view.
 *  `$u` is the parameter holding my id. */
const LIST = (me: Me, u: number) => `select pl.id, pl.name, pl.owner_id, u.name as owner_name, pl.view_id, v.name as view_name, pl.done_days, pl.created_at, pl.updated_at,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'key', p.key, 'name', p.name) order by p.key), '[]') from projects p where p.id = any(pl.project_ids) and ${visibleAs(me, 'p.id', u)}) as projects
  from plans pl join users u on u.id = pl.owner_id left join saved_views v on v.id = pl.view_id`
/** The view's name only for those who can see the view; project ids only the visible ones. */
async function shown(d: Db, me: Me, rows: any[]) {
  for (const r of rows) {
    r.projectIds = r.viewId ? null : r.projects.map((p: { id: string }) => p.id)
    if (r.viewId && !(await viewSeenBy(d, me, r.viewId))) r.viewName = null
  }
  return rows
}
const ROW = `i.id, p.key || '-' || i.number as key, i.project_id, p.key as project_key, i.type, i.title, i.status_id, st.name as status_name, st.category,
  i.start_date, i.due_date, i.sprint_id, i.fix_release_ids, i.assignee_id, i.estimate, live_par.id as parent_id, live_pl.id as parent_link_id, i.rank, i.resolved_at`

const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Plans']
  const plan = async (d: Db, me: Me, id: string) => {
    const [p] = await shown(d, me, await d.query<any>(`${LIST(me, 3)} where pl.id = $1 and pl.workspace_id = $2`, [id, me.workspaceId, me.id]))
    if (!p) throw new HttpError(404, 'Plan not found')
    return p
  }
  const mine = (me: Me, p: { ownerId: string }) => { if (p.ownerId !== me.id && !me.admin) throw new HttpError(403, 'Only the plan’s owner or a system administrator changes it') }
  const body = z.object({
    name: z.string().trim().min(1).max(255),
    projectKeys: z.array(z.string().trim().toUpperCase()).max(500).nullable().default(null).describe('The source: these projects…'),
    viewId: uuid.nullable().default(null).describe('…or a saved view'),
    doneDays: z.number().int().min(0).max(3650).default(30).describe('How long finished work stays on the plan (Jira’s default: 30 days)'),
  })
  /** The source as stored: project ids I can see, or a saved view I can see; one of the two. */
  const source = async (d: Db, me: Me, b: { projectKeys?: string[] | null; viewId?: string | null }) => {
    if (!!b.projectKeys?.length === !!b.viewId) throw new HttpError(400, 'Choose some projects or a saved view', { projectKeys: 'Projects or a view' })
    if (b.viewId) { if (!(await viewSeenBy(d, me, b.viewId))) throw new HttpError(400, 'No such saved view', { viewId: 'Unknown view' }); return { projectIds: null, viewId: b.viewId } }
    const args: unknown[] = [me.workspaceId, [...new Set(b.projectKeys)]]
    const rows = await d.query<{ id: string; key: string }>(`select p.id, p.key from projects p where p.workspace_id = $1 and p.key = any($2::text[]) and ${visible(me, 'p.id', args)}`, args)
    const missing = b.projectKeys!.find(k => !rows.some(r => r.key === k))
    if (missing) throw new HttpError(400, `No such project ${missing}`, { projectKeys: `Unknown project ${missing}` })
    return { projectIds: rows.map(r => r.id), viewId: null }
  }
  const unique = (e: any) => { if (e.code === '23505') throw new HttpError(409, 'A plan already has that name', { name: 'Already used' }); throw e }

  app.get('/plans', { schema: { tags: T, summary: 'Every plan of the workspace, by name (its sources as far as I can see them)' } }, async req =>
    shown(db, req.me, await db.query(`${LIST(req.me, 2)} where pl.workspace_id = $1 order by lower(pl.name)`, [req.me.workspaceId, req.me.id])))
  app.post('/plans', { schema: { tags: T, summary: 'Make a plan from some projects or a saved view', body } }, async (req, reply) => {
    const b = req.body
    const p = await tx(async d => {
      const s = await source(d, req.me, b)
      const [row] = await d.query<{ id: string }>('insert into plans (workspace_id, name, owner_id, project_ids, view_id, done_days) values ($1, $2, $3, $4, $5, $6) returning id',
        [req.me.workspaceId, b.name, req.me.id, s.projectIds, s.viewId, b.doneDays])
      return plan(d, req.me, row!.id)
    }).catch(unique)
    reply.code(201); return p
  })
  app.get('/plans/:id', { schema: { tags: T, summary: 'A plan', params: idP } }, async req => plan(db, req.me, req.params.id))
  const patch = z.object({ name: z.string().trim().min(1).max(255), projectKeys: z.array(z.string().trim().toUpperCase()).max(500).nullable(), viewId: uuid.nullable(),
    doneDays: z.number().int().min(0).max(3650) }).partial()
  app.patch('/plans/:id', { schema: { tags: T, summary: 'Change a plan (its owner or a system administrator)', params: idP, body: patch } }, async req => {
    const b = req.body
    return tx(async d => {
      const p = await plan(d, req.me, req.params.id)
      mine(req.me, p)
      const s = b.projectKeys !== undefined || b.viewId !== undefined ? await source(d, req.me, { projectKeys: b.projectKeys ?? null, viewId: b.viewId ?? null }) : null
      await d.query('update plans set name = coalesce($2, name), project_ids = case when $3 then $4 else project_ids end, view_id = case when $3 then $5 else view_id end, done_days = coalesce($6, done_days), updated_at = now() where id = $1',
        [p.id, b.name ?? null, !!s, s?.projectIds ?? null, s?.viewId ?? null, b.doneDays ?? null])
      if (p.ownerId !== req.me.id) await audit(d, req, { action: 'plan.updated', type: 'plan', id: p.id, name: p.name, after: b })
      return plan(d, req.me, p.id)
    }).catch(unique)
  })
  app.delete('/plans/:id', { schema: { tags: T, summary: 'Delete a plan (its owner or a system administrator)', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const p = await plan(d, req.me, req.params.id)
      mine(req.me, p)
      await d.query('delete from plans where id = $1', [p.id])
      if (p.ownerId !== req.me.id) await audit(d, req, { action: 'plan.deleted', type: 'plan', id: p.id, name: p.name })
    })
    reply.code(204).send()
  })

  // R3, R4: the timeline: the plan's work as the person sees it, with dependencies, releases and sprints
  app.get('/plans/:id/timeline', { schema: { tags: T, summary: 'A plan’s timeline: its initiatives, epics and items (and the initiatives its epics belong to), “blocks” dependencies, releases and sprints', params: idP } }, async req => {
    const p = await plan(db, req.me, req.params.id)
    const [{ projectIds: allIds }] = await db.query<{ projectIds: string[] | null }>('select project_ids from plans where id = $1', [p.id]) as any   // the visible() filter below still applies
    const { maxItems } = await getSetting(req.me.workspaceId, 'plans')
    const args: unknown[] = []
    let where: string[]
    if (p.viewId) {
      const [v] = await db.query<{ filters: any }>('select filters from saved_views where id = $1', [p.viewId])
      if (!v || !(await viewSeenBy(db, req.me, p.viewId))) throw new HttpError(404, 'The plan’s saved view is gone or not shared with you')
      const f = v.filters ?? {}
      where = (await searchWhere(req.me, { q: f.q ?? '', project: f.projectId, assignee: f.assignee == null ? undefined : f.assignee === '' ? 'none' : f.assignee,
        type: f.type, priority: f.priority, label: f.label, resolution: 'all', jql: f.jql }, args)).where
    } else {
      args.push(req.me.workspaceId)
      where = [`i.workspace_id = $${args.length}`, 'i.deleted_at is null', 'i.archived_at is null', visible(req.me, 'i.project_id', args)]
      args.push(allIds ?? []); where.push(`i.project_id = any($${args.length}::uuid[])`)
    }
    args.push(p.doneDays); where.push(`(st.category <> 'done' or coalesce(i.resolved_at, i.updated_at) > now() - make_interval(days => $${args.length}))`)
    where.push(`not exists (select 1 from issues sp where sp.id = i.parent_id and sp.type <> 'epic')`)           // sub-items aren't shown
    args.push(maxItems + 1)
    const FROM = `from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
      left join issues live_par on live_par.id = i.parent_id and live_par.deleted_at is null left join issues live_pl on live_pl.id = i.parent_link_id and live_pl.deleted_at is null`
    let items = await db.query<any>(`select ${ROW} ${FROM} where ${where.join(' and ')} order by i.rank, i.id limit $${args.length}`, args)
    const truncated = items.length > maxItems
    if (truncated) items = items.slice(0, maxItems)
    // the initiatives the plan's epics belong to, wherever they are (if I can see them)
    const have = new Set(items.map(i => i.id))
    const wanted = [...new Set(items.map(i => i.parentLinkId).filter((x: string | null) => x && !have.has(x)))]
    if (wanted.length) {
      const a2: unknown[] = [wanted]
      items.push(...await db.query<any>(`select ${ROW} ${FROM} where i.id = any($1::uuid[]) and i.deleted_at is null and i.archived_at is null and ${visible(req.me, 'i.project_id', a2)}`, a2))
    }
    const ids = items.map(i => i.id), projectIds = [...new Set(items.map(i => i.projectId))]
    const [dependencies, releases, sprints] = await Promise.all([
      db.query(`select issue_id as from_id, target_id as to_id from issue_links where type = 'blocks' and issue_id = any($1::uuid[]) and target_id = any($1::uuid[])`, [ids]),
      db.query(`select r.id, r.name, p.key as project_key, r.release_date, r.released from releases r join projects p on p.id = r.project_id
        where r.project_id = any($1::uuid[]) and not r.archived and r.release_date is not null order by r.release_date`, [projectIds]),
      db.query(`select s.id, s.name, p.key as project_key, s.state, s.started_at, s.ends_at, s.completed_at from sprints s join projects p on p.id = s.project_id
        where s.project_id = any($1::uuid[]) and (s.state <> 'closed' or s.completed_at > now() - interval '90 days') order by s.started_at nulls last`, [projectIds]),
    ])
    return { items, dependencies, releases, sprints, truncated, maxItems }
  })

  // the Parent Link picker (R1): initiatives I can see, by key or title
  app.get('/initiatives', { schema: { tags: T, summary: 'Initiatives I can see, by key or title (the first 50)', querystring: z.object({ query: z.string().max(100).default('') }) } }, async req => {
    const args: unknown[] = [req.me.workspaceId, `%${req.query.query.replace(/[%_\\]/g, '\\$&')}%`]
    return db.query(`select i.id, p.key || '-' || i.number as key, i.title, p.key as project_key from issues i join projects p on p.id = i.project_id
      where i.workspace_id = $1 and i.type = 'initiative' and i.deleted_at is null and i.archived_at is null and ${visible(req.me, 'i.project_id', args)}
        and (i.title ilike $2 or p.key || '-' || i.number ilike $2) order by lower(i.title), i.id limit 50`, args)
  })
}
export default plugin
