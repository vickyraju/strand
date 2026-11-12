// Administration › Custom fields (spec 0503): every field of the workspace and its contexts, as Jira's. System
// administrators, signed in themselves. Project admins keep their own fields from Project settings (spec 0503 R5).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireJiraAdmin } from './globalPermissions.ts'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { KIND_LIST, type FieldKind } from '../shared/customFields.ts'
import { carryOptions, checkContext, clearValues, fitOptions, withOptionIds, type Opt } from '../fields.ts'

const T = ['Custom fields']
const idP = z.object({ id: z.string().uuid() })
const ctxP = idP.extend({ contextId: z.string().uuid() })
const option = z.object({ id: z.string().min(1).max(64).optional(), name: z.string().trim().min(1).max(100), disabled: z.boolean().optional(), parentId: z.string().min(1).max(64).nullable().optional() })
const context = z.object({
  name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''),
  projectKeys: z.array(z.string().min(1).max(255)).max(10_000).nullable().describe('Projects by key; null: global'),
  typeKeys: z.array(z.string().min(1).max(40)).max(200).nullable().default(null).describe('Work type keys; null: every type'),
  options: z.array(option).max(1000).nullable().default(null), defaultValue: z.union([z.string(), z.number(), z.array(z.string())]).nullable().default(null),
})
const fieldBody = z.object({
  name: z.string().trim().min(1).max(255), kind: z.enum(KIND_LIST as [FieldKind, ...FieldKind[]]), description: z.string().max(1000).default(''),
  context: context.partial({ name: true }).describe('The first context (Jira’s "Default context for <name>")'),
})

/** Project keys as ids, all of them the workspace's. */
async function projectIds(d: Db, ws: string, keys: string[] | null) {
  if (keys === null) return null
  const want = [...new Set(keys.map(k => k.toUpperCase()))]
  const rows = await d.query<{ id: string; key: string }>('select id, key from projects where workspace_id = $1 and key = any($2::text[])', [ws, want])
  const missing = want.filter(k => !rows.some(r => r.key === k))
  if (missing.length) throw new HttpError(400, `No project with the key ${missing.join(', ')}`, { projects: `Unknown: ${missing.join(', ')}` })
  return rows.map(r => r.id)
}
const CONTEXTS = `coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'typeKeys', c.type_keys, 'options', c.options,
    'defaultValue', c.default_value, 'projectKeys', (select jsonb_agg(p.key order by p.key) from projects p where p.id = any(c.project_ids))) order by c.project_ids is not null, c.name)
  from field_contexts c where c.field_id = f.id), '[]')`

const plugin: FastifyPluginAsyncZod = async app => {
  const field = async (d: Db, ws: string, id: string) => {
    const [f] = await d.query<any>(`select f.id, f.name, f.kind, f.description, f.position, f.created_at, ${CONTEXTS} as contexts,
        (select count(*)::int from issues i where i.custom ? f.id::text and i.deleted_at is null) as items
        from custom_fields f where f.workspace_id = $1 and f.id = $2`, [ws, id])
    if (!f) throw new HttpError(404, 'Custom field not found')
    return f
  }
  app.get('/admin/custom-fields', { schema: { tags: T, summary: 'Every custom field of the workspace with its contexts, by name, a page at a time (system administrators)',
    querystring: z.object({ query: z.string().max(100).default(''), cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const { query, cursor, limit } = req.query
    const args: unknown[] = [req.me.workspaceId, `%${query.replace(/[%_\\]/g, '\\$&')}%`]
    const after = cursor ? `and (lower(f.name), f.id) > (lower($${args.push(cursor.split('|')[0])}), $${args.push(cursor.split('|')[1])}::uuid)` : ''
    args.push(limit + 1)
    const rows = await db.query<any>(`select f.id, f.name, f.kind, f.description, f.position, f.created_at, ${CONTEXTS} as contexts from custom_fields f
        where f.workspace_id = $1 and f.name ilike $2 ${after} order by lower(f.name), f.id limit $${args.length}`, args)
    const more = rows.length > limit
    const items = rows.slice(0, limit)
    return { items, next: more ? `${items.at(-1)!.name}|${items.at(-1)!.id}` : null }
  })
  app.get('/admin/custom-fields/:id', { schema: { tags: T, summary: 'A custom field with its contexts and how many items have a value', params: idP } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    return field(db, req.me.workspaceId, req.params.id)
  })
  app.post('/admin/custom-fields', { schema: { tags: T, summary: 'Make a custom field with its first context', body: fieldBody } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const b = req.body
    const id = await tx(async d => {
      const [f] = await d.query<{ id: string }>('insert into custom_fields (workspace_id, name, kind, description, created_by) values ($1, $2, $3, $4, $5) returning id',
        [req.me.workspaceId, b.name, b.kind, b.description, req.me.id])
      const pids = await projectIds(d, req.me.workspaceId, b.context.projectKeys ?? null)
      const options = b.context.options ? withOptionIds(b.context.options as Opt[], b.kind) : null
      await checkContext(d, { id: f!.id, kind: b.kind, name: b.name }, { projectIds: pids, typeKeys: b.context.typeKeys ?? null, options, defaultValue: b.context.defaultValue ?? null })
      await d.query('insert into field_contexts (field_id, name, description, project_ids, type_keys, options, default_value) values ($1, $2, $3, $4, $5, $6, $7)',
        [f!.id, b.context.name ?? `Default context for ${b.name}`, b.context.description ?? '', pids, b.context.typeKeys ?? null, options ? JSON.stringify(options) : null,
          b.context.defaultValue == null ? null : JSON.stringify(b.context.defaultValue)])
      await audit(d, req, { action: 'custom_field.created', type: 'custom field', id: f!.id, name: b.name, after: b })
      return f!.id
    })
    reply.code(201)
    return field(db, req.me.workspaceId, id)
  })
  app.patch('/admin/custom-fields/:id', { schema: { tags: T, summary: 'Rename or describe a custom field (its type is fixed)', params: idP,
    body: z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000), position: z.number().int() }).partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const before = await field(db, req.me.workspaceId, req.params.id)
    await tx(async d => {
      await d.query('update custom_fields set name = coalesce($2, name), description = coalesce($3, description), position = coalesce($4, position) where id = $1',
        [before.id, req.body.name ?? null, req.body.description ?? null, req.body.position ?? null])
      const c = changes(before, req.body)
      if (c.changed) await audit(d, req, { action: 'custom_field.updated', type: 'custom field', id: before.id, name: req.body.name ?? before.name, before: c.before, after: c.after })
    })
    return field(db, req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/custom-fields/:id', { schema: { tags: T, summary: 'Delete a custom field and every value it has', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const f = await field(db, req.me.workspaceId, req.params.id)
    await tx(async d => {
      const projects = (await d.query<{ projectId: string }>('select distinct project_id from field_defs where id = $1', [f.id])).map(r => r.projectId)
      await d.query('delete from custom_fields where id = $1', [f.id])
      const cleared = await clearValues(d, f.id, projects)
      await audit(d, req, { action: 'custom_field.deleted', type: 'custom field', id: f.id, name: f.name, before: { kind: f.kind, items: cleared } })
    })
    reply.code(204).send()
  })

  // —— Contexts ——
  app.post('/admin/custom-fields/:id/contexts', { schema: { tags: T, summary: 'Add a context: projects or global, work types, options, a default value', params: idP, body: context } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const f = await field(db, req.me.workspaceId, req.params.id)
    await tx(async d => {
      const b = req.body
      const pids = await projectIds(d, req.me.workspaceId, b.projectKeys)
      const options = b.options ? withOptionIds(b.options as Opt[], f.kind) : null
      await checkContext(d, f, { projectIds: pids, typeKeys: b.typeKeys, options, defaultValue: b.defaultValue })
      const [c] = await d.query<{ id: string }>('insert into field_contexts (field_id, name, description, project_ids, type_keys, options, default_value) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [f.id, b.name, b.description, pids, b.typeKeys, options ? JSON.stringify(options) : null, b.defaultValue == null ? null : JSON.stringify(b.defaultValue)])
      await fitOptions(d, f.id, f.kind, pids ?? [])          // projects taken from the global context follow the new one's options
      await audit(d, req, { action: 'custom_field.context_created', type: 'custom field', id: f.id, name: f.name, after: { context: c!.id, ...b } })
    })
    reply.code(201)
    return field(db, req.me.workspaceId, req.params.id)
  })
  app.patch('/admin/custom-fields/:id/contexts/:contextId', { schema: { tags: T, summary: 'Change a context; renamed and deleted options carry to the items it covers; projects it leaves lose their values', params: ctxP,
    body: context.partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const f = await field(db, req.me.workspaceId, req.params.id)
    await tx(async d => {
      const [before] = await d.query<any>('select * from field_contexts where id = $1 and field_id = $2 for update', [req.params.contextId, f.id])
      if (!before) throw new HttpError(404, 'Context not found')
      const b = req.body
      const pids = b.projectKeys !== undefined ? await projectIds(d, req.me.workspaceId, b.projectKeys) : before.projectIds
      const options = b.options !== undefined ? (b.options ? withOptionIds(b.options as Opt[], f.kind) : null) : before.options
      const typeKeys = b.typeKeys !== undefined ? b.typeKeys : before.typeKeys
      const defaultValue = b.defaultValue !== undefined ? b.defaultValue : before.defaultValue
      await checkContext(d, f, { projectIds: pids, typeKeys, options, defaultValue }, before.id)
      const reachedBefore = (await d.query<{ projectId: string }>('select project_id from field_defs where context_id = $1', [before.id])).map(r => r.projectId)
      await d.query('update field_contexts set name = $2, description = $3, project_ids = $4, type_keys = $5, options = $6, default_value = $7 where id = $1',
        [before.id, b.name ?? before.name, b.description ?? before.description, pids, typeKeys, options ? JSON.stringify(options) : null, defaultValue == null ? null : JSON.stringify(defaultValue)])
      if (b.options !== undefined) await carryOptions(d, before.id, f.id, f.kind, before.options ?? [], options ?? [])
      // projects no longer covered by any context of the field lose its values (R6)
      const still = new Set((await d.query<{ projectId: string }>('select project_id from field_defs where id = $1', [f.id])).map(r => r.projectId))
      const lost = reachedBefore.filter(p => !still.has(p))
      if (lost.length) await clearValues(d, f.id, lost)
      await fitOptions(d, f.id, f.kind, [...reachedBefore.filter(p => still.has(p)), ...(pids ?? [])])
      const c = changes(before, b)
      if (c.changed) await audit(d, req, { action: 'custom_field.context_updated', type: 'custom field', id: f.id, name: f.name, before: c.before, after: { ...c.after, cleared: lost.length } })
    })
    return field(db, req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/custom-fields/:id/contexts/:contextId', { schema: { tags: T, summary: 'Delete a context: the items it covered lose their values unless another context covers them', params: ctxP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const f = await field(db, req.me.workspaceId, req.params.id)
    await tx(async d => {
      const reached = (await d.query<{ projectId: string }>('select project_id from field_defs where context_id = $1', [req.params.contextId])).map(r => r.projectId)
      const [gone] = await d.query<{ name: string }>('delete from field_contexts where id = $1 and field_id = $2 returning name', [req.params.contextId, f.id])
      if (!gone) throw new HttpError(404, 'Context not found')
      const still = new Set((await d.query<{ projectId: string }>('select project_id from field_defs where id = $1', [f.id])).map(r => r.projectId))
      const cleared = await clearValues(d, f.id, reached.filter(p => !still.has(p)))
      await fitOptions(d, f.id, f.kind, reached.filter(p => still.has(p)))      // now under another context: its options
      await audit(d, req, { action: 'custom_field.context_deleted', type: 'custom field', id: f.id, name: f.name, before: { context: gone.name, items: cleared } })
    })
    reply.code(204).send()
  })
}
export default plugin
