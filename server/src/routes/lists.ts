// Priorities and resolutions, as Jira's Administration › Issues › Priorities and Resolutions (spec 0305): everyone reads
// the lists; global admins add, rename, reorder, choose the default, and delete them, moving what used them to another.
import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError, requireAdmin } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { priorities, resolutions } from '../lists.ts'

const T = ['Priorities and resolutions']
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const PRIORITY_ICONS = ['chevrons-up', 'chevron-up', 'equal', 'chevron-down', 'chevrons-down', 'minus', 'flame', 'alert-triangle', 'arrow-up', 'arrow-down'] as const
const priorityBody = z.object({
  name: z.string().trim().min(1).max(60), description: z.string().max(500).default(''), color, icon: z.enum(PRIORITY_ICONS),
  position: z.number().int().min(0).optional().describe('Place in the list (0 is the highest); default: last'), isDefault: z.boolean().default(false).describe('New work gets it when none is chosen'),
})
const resolutionBody = z.object({
  name: z.string().trim().min(1).max(60), description: z.string().max(500).default(''),
  position: z.number().int().min(0).optional(), isDefault: z.boolean().default(false).describe('Set on reaching Done when the workflow resolves on its own'),
})
const taken = (what: string) => (e: any) => {
  if (e?.code === '23505' && /name/.test(e.constraint ?? '')) throw new HttpError(409, `A ${what} with that name already exists`, { name: 'Already used' })
  throw e
}

const lists: FastifyPluginAsyncZod = async app => {
  app.get('/priorities', { schema: { tags: T, summary: 'Priorities, highest first; one is the default for new work' } }, async req => priorities(db, req.me.workspaceId))
  app.get('/resolutions', { schema: { tags: T, summary: 'Resolutions, in order; one is set on reaching Done when a workflow resolves on its own' } }, async req => resolutions(db, req.me.workspaceId))

  // ── Priorities ──
  app.post('/admin/priorities', { schema: { tags: T, summary: 'Add a priority (global admins)', body: priorityBody } }, async (req, reply) => {
    requireAdmin(req)
    const b = req.body, ws = req.me.workspaceId
    return tx(async d => {
      const key = `p-${randomBytes(6).toString('hex')}`
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from priorities where workspace_id = $1', [ws]) as any
      if (b.isDefault) await d.query('update priorities set is_default = false where workspace_id = $1', [ws])
      await d.query('insert into priorities (workspace_id, key, name, description, color, icon, position, is_default) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [ws, key, b.name, b.description, b.color, b.icon, n, b.isDefault]).catch(taken('priority'))
      if (b.position !== undefined) await place(d, 'priorities', 'key', ws, key, b.position)
      await audit(d, req, { action: 'priority.created', type: 'priority', id: key, name: b.name })
      reply.code(201)
      return (await priorities(d, ws)).find(p => p.key === key)
    })
  })
  app.patch('/admin/priorities/:key', { schema: { tags: T, summary: 'Rename, recolour, move or make a priority the default (global admins)', params: z.object({ key: z.string().max(40) }),
    body: priorityBody.partial().omit({ isDefault: true }).extend({ isDefault: z.literal(true).optional().describe('Make it the default (another one is chosen by making it the default)') }) } }, async req => {
    requireAdmin(req)
    const ws = req.me.workspaceId, b = req.body
    return tx(async d => {
      const [before] = await d.query<any>('select key, name, description, color, icon, position, is_default from priorities where workspace_id = $1 and key = $2 for update', [ws, req.params.key])
      if (!before) throw new HttpError(404, 'No such priority')
      if (b.isDefault) await d.query('update priorities set is_default = (key = $2) where workspace_id = $1', [ws, before.key])
      await d.query('update priorities set name = coalesce($3, name), description = coalesce($4, description), color = coalesce($5, color), icon = coalesce($6, icon) where workspace_id = $1 and key = $2',
        [ws, before.key, b.name ?? null, b.description ?? null, b.color ?? null, b.icon ?? null]).catch(taken('priority'))
      if (b.position !== undefined) await place(d, 'priorities', 'key', ws, before.key, b.position)
      const after = (await priorities(d, ws)).find(p => p.key === before.key)!
      const c = changes(before, { ...b })
      if (c.changed) await audit(d, req, { action: 'priority.updated', type: 'priority', id: before.key, name: after.name, before: c.before, after: c.after })
      return after
    })
  })
  app.delete('/admin/priorities/:key', { schema: { tags: T, summary: 'Remove a priority: work items, templates and rules that have it get `moveTo` (global admins)',
    params: z.object({ key: z.string().max(40) }), querystring: z.object({ moveTo: z.string().max(40).describe('The priority that replaces it') }) } }, async (req, reply) => {
    requireAdmin(req)
    const ws = req.me.workspaceId, { moveTo } = req.query
    await tx(async d => {
      const [p] = await d.query<{ key: string; name: string; isDefault: boolean }>('select key, name, is_default from priorities where workspace_id = $1 and key = $2 for update', [ws, req.params.key])
      if (!p) throw new HttpError(404, 'No such priority')
      if (moveTo === p.key || !(await d.query('select 1 from priorities where workspace_id = $1 and key = $2', [ws, moveTo])).length)
        throw new HttpError(400, 'Choose another priority for its work items', { moveTo: 'Unknown priority' })
      const items = await d.query('update issues set priority = $3, version = version + 1, updated_at = now() where workspace_id = $1 and priority = $2 returning id', [ws, p.key, moveTo])
      await d.query('update item_templates set priority = $3 where priority = $2 and project_id in (select id from projects where workspace_id = $1)', [ws, p.key, moveTo])
      await d.query(`update rules set actions = (select jsonb_agg(case when a->>'kind' = 'priority' and a->>'value' = $2 then jsonb_set(a, '{value}', to_jsonb($3::text)) else a end) from jsonb_array_elements(actions) a)
        where project_id in (select id from projects where workspace_id = $1) and actions @> jsonb_build_array(jsonb_build_object('kind', 'priority', 'value', $2::text))`, [ws, p.key, moveTo])
      await d.query('delete from priorities where workspace_id = $1 and key = $2', [ws, p.key])
      if (p.isDefault) await d.query('update priorities set is_default = true where workspace_id = $1 and key = $2', [ws, moveTo])   // the replacement takes over as default
      await reorder(d, 'priorities', 'key', ws)
      await audit(d, req, { action: 'priority.deleted', type: 'priority', id: p.key, name: p.name, after: { moveTo, items: items.length } })
    })
    reply.code(204).send()
  })

  // ── Resolutions ──
  app.post('/admin/resolutions', { schema: { tags: T, summary: 'Add a resolution (global admins)', body: resolutionBody } }, async (req, reply) => {
    requireAdmin(req)
    const b = req.body, ws = req.me.workspaceId
    return tx(async d => {
      const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from resolutions where workspace_id = $1', [ws]) as any
      if (b.isDefault) await d.query('update resolutions set is_default = false where workspace_id = $1', [ws])
      const [r] = await d.query<{ id: string }>('insert into resolutions (workspace_id, name, description, position, is_default) values ($1, $2, $3, $4, $5) returning id',
        [ws, b.name, b.description, n, b.isDefault]).catch(taken('resolution'))
      if (b.position !== undefined) await place(d, 'resolutions', 'id', ws, r!.id, b.position)
      await audit(d, req, { action: 'resolution.created', type: 'resolution', id: r!.id, name: b.name })
      reply.code(201)
      return (await resolutions(d, ws)).find(x => x.id === r!.id)
    })
  })
  app.patch('/admin/resolutions/:id', { schema: { tags: T, summary: 'Rename (work items follow), describe, move or make a resolution the default (global admins)', params: z.object({ id: z.string().uuid() }),
    body: resolutionBody.partial().omit({ isDefault: true }).extend({ isDefault: z.literal(true).optional() }) } }, async req => {
    requireAdmin(req)
    const ws = req.me.workspaceId, b = req.body
    return tx(async d => {
      const [before] = await d.query<any>('select id, name, description, position, is_default from resolutions where workspace_id = $1 and id = $2 for update', [ws, req.params.id])
      if (!before) throw new HttpError(404, 'No such resolution')
      if (b.isDefault) await d.query('update resolutions set is_default = (id = $2) where workspace_id = $1', [ws, before.id])
      await d.query('update resolutions set name = coalesce($3, name), description = coalesce($4, description) where workspace_id = $1 and id = $2',
        [ws, before.id, b.name ?? null, b.description ?? null]).catch(taken('resolution'))
      // work items hold the name: a rename carries to them, as Jira's do (they hold its id)
      if (b.name && b.name !== before.name) await d.query('update issues set resolution = $3 where workspace_id = $1 and resolution = $2', [ws, before.name, b.name])
      if (b.position !== undefined) await place(d, 'resolutions', 'id', ws, before.id, b.position)
      const after = (await resolutions(d, ws)).find(x => x.id === before.id)!
      const c = changes(before, { ...b })
      if (c.changed) await audit(d, req, { action: 'resolution.updated', type: 'resolution', id: before.id, name: after.name, before: c.before, after: c.after })
      return after
    })
  })
  app.delete('/admin/resolutions/:id', { schema: { tags: T, summary: 'Remove a resolution: work items that have it get `moveTo` (global admins)',
    params: z.object({ id: z.string().uuid() }), querystring: z.object({ moveTo: z.string().uuid().describe('The resolution that replaces it') }) } }, async (req, reply) => {
    requireAdmin(req)
    const ws = req.me.workspaceId, { moveTo } = req.query
    await tx(async d => {
      const [r] = await d.query<{ id: string; name: string; isDefault: boolean }>('select id, name, is_default from resolutions where workspace_id = $1 and id = $2 for update', [ws, req.params.id])
      if (!r) throw new HttpError(404, 'No such resolution')
      const [to] = await d.query<{ name: string }>('select name from resolutions where workspace_id = $1 and id = $2', [ws, moveTo])
      if (!to || moveTo === r.id) throw new HttpError(400, 'Choose another resolution for its work items', { moveTo: 'Unknown resolution' })
      const items = await d.query('update issues set resolution = $3, version = version + 1, updated_at = now() where workspace_id = $1 and resolution = $2 returning id', [ws, r.name, to.name])
      await d.query(`update transitions set rules = jsonb_set(rules, '{actions}', (select jsonb_agg(case when a->>'field' = 'resolution' and a->>'value' = $2 then jsonb_set(a, '{value}', to_jsonb($3::text)) else a end) from jsonb_array_elements(rules->'actions') a))
        where project_id in (select id from projects where workspace_id = $1) and rules->'actions' @> jsonb_build_array(jsonb_build_object('field', 'resolution', 'value', $2::text))`, [ws, r.name, to.name])
      await d.query('delete from resolutions where id = $1', [r.id])
      if (r.isDefault) await d.query('update resolutions set is_default = true where id = $1', [moveTo])
      await reorder(d, 'resolutions', 'id', ws)
      await audit(d, req, { action: 'resolution.deleted', type: 'resolution', id: r.id, name: r.name, after: { moveTo: to.name, items: items.length } })
    })
    reply.code(204).send()
  })
}

/** Move one entry to a place in its list (0 is the first); the others close up around it. */
async function place(d: { query: typeof db.query }, table: 'priorities' | 'resolutions', idCol: 'key' | 'id', ws: string, id: string, position: number) {
  await d.query(`update ${table} t set position = r.n + (r.n >= $3)::int
    from (select ${idCol}, row_number() over (order by position, ${idCol}) - 1 as n from ${table} where workspace_id = $1 and ${idCol}::text <> $2) r
    where t.workspace_id = $1 and t.${idCol} = r.${idCol}`, [ws, id, position])
  await d.query(`update ${table} set position = $3 where workspace_id = $1 and ${idCol}::text = $2`, [ws, id, position])
  await reorder(d, table, idCol, ws)
}
/** Number the list 0, 1, 2… in its current order. */
async function reorder(d: { query: typeof db.query }, table: 'priorities' | 'resolutions', idCol: 'key' | 'id', ws: string) {
  await d.query(`update ${table} t set position = r.n from (select ${idCol}, row_number() over (order by position, ${idCol}) - 1 as n from ${table} where workspace_id = $1) r
    where t.workspace_id = $1 and t.${idCol} = r.${idCol}`, [ws])
}

export default lists
