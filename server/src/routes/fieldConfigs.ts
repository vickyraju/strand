// Administration › Field configurations (spec 0504), as Jira's: configurations (each field's description, hidden, required)
// and schemes (a configuration per work type, and a default). System administrators, signed in themselves.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { requireNoToken } from './authentication.ts'
import { defaultConfigId } from '../fields.ts'
import { SYSTEM_FIELDS } from '../shared/fieldRules.ts'

const T = ['Field configurations']
const idP = z.object({ id: z.string().uuid() })
const rule = z.object({ description: z.string().max(1000).optional(), hidden: z.boolean().optional(), required: z.boolean().optional() })
const configBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''),
  items: z.record(z.string().regex(/^([a-zA-Z]+|custom\.[0-9a-f-]{36})$/), rule).default({}).describe('Field key (assigneeId, custom.<field id>…) → its description, hidden, required') })
const schemeBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''), defaultConfigId: z.string().uuid(),
  mappings: z.record(z.string().min(1).max(40), z.string().uuid()).default({}).describe('Work type key → field configuration id') })

/** A configuration's items checked: known fields, and nothing both hidden and required (Jira's rule). */
async function checkItems(d: Db, ws: string, items: Record<string, z.infer<typeof rule>>) {
  const custom = Object.keys(items).filter(k => k.startsWith('custom.')).map(k => k.slice(7))
  const known = new Set((await d.query<{ id: string }>('select id from custom_fields where workspace_id = $1 and id = any($2::uuid[])', [ws, custom])).map(r => r.id))
  for (const [k, r] of Object.entries(items)) {
    if (k.startsWith('custom.') ? !known.has(k.slice(7)) : !(k in SYSTEM_FIELDS)) throw new HttpError(400, `No field ${k}`, { items: `Unknown field ${k}` })
    if (r.hidden && r.required) throw new HttpError(400, `${SYSTEM_FIELDS[k] ?? 'A custom field'} can’t be hidden and required`, { items: 'Hidden fields can’t be required' })
  }
}
const CONFIGS = `select c.id, c.name, c.description, c.items, c.is_default,
  (select coalesce(jsonb_agg(s.name order by s.name), '[]') from field_config_schemes s where s.default_config_id = c.id or exists (select 1 from jsonb_each_text(s.mappings) m where m.value = c.id::text)) as schemes
  from field_configurations c`
const SCHEMES = `select s.id, s.name, s.description, s.default_config_id, s.mappings,
  (select coalesce(jsonb_agg(p.key order by p.key), '[]') from (select key from projects where field_config_scheme_id = s.id order by key limit 100) p) as project_keys,
  (select count(*)::int from projects where field_config_scheme_id = s.id) as projects
  from field_config_schemes s`

const plugin: FastifyPluginAsyncZod = async app => {
  const config = async (ws: string, id: string) => {
    const [c] = await db.query<any>(`${CONFIGS} where c.workspace_id = $1 and c.id = $2`, [ws, id])
    if (!c) throw new HttpError(404, 'Field configuration not found')
    return c
  }
  app.get('/admin/field-configurations', { schema: { tags: T, summary: 'Field configurations, the default first, with the schemes that use each' } }, async req => {
    requireNoToken(req)
    await defaultConfigId(db, req.me.workspaceId)
    return db.query(`${CONFIGS} where c.workspace_id = $1 order by c.is_default desc, lower(c.name)`, [req.me.workspaceId])
  })
  app.get('/admin/field-configurations/:id', { schema: { tags: T, summary: 'A field configuration', params: idP } }, async req => { requireNoToken(req); return config(req.me.workspaceId, req.params.id) })
  app.post('/admin/field-configurations', { schema: { tags: T, summary: 'Add a field configuration', body: configBody } }, async (req, reply) => {
    requireNoToken(req)
    const b = req.body
    const id = await tx(async d => {
      await checkItems(d, req.me.workspaceId, b.items)
      if ((await d.query('select 1 from field_configurations where workspace_id = $1 and lower(name) = lower($2)', [req.me.workspaceId, b.name])).length) throw new HttpError(409, `There is already a configuration ${b.name}`, { name: 'Taken' })
      const [c] = await d.query<{ id: string }>('insert into field_configurations (workspace_id, name, description, items) values ($1, $2, $3, $4) returning id', [req.me.workspaceId, b.name, b.description, JSON.stringify(b.items)])
      await audit(d, req, { action: 'field_configuration.created', type: 'field configuration', id: c!.id, name: b.name, after: b })
      return c!.id
    })
    reply.code(201)
    return config(req.me.workspaceId, id)
  })
  app.patch('/admin/field-configurations/:id', { schema: { tags: T, summary: 'Change a field configuration: its fields’ description, hidden and required', params: idP, body: configBody.partial() } }, async req => {
    requireNoToken(req)
    const before = await config(req.me.workspaceId, req.params.id)
    await tx(async d => {
      const b = req.body
      if (b.items) await checkItems(d, req.me.workspaceId, b.items)
      await d.query('update field_configurations set name = coalesce($2, name), description = coalesce($3, description), items = coalesce($4, items) where id = $1',
        [before.id, b.name ?? null, b.description ?? null, b.items ? JSON.stringify(b.items) : null])
      const c = changes(before, b)
      if (c.changed) await audit(d, req, { action: 'field_configuration.updated', type: 'field configuration', id: before.id, name: b.name ?? before.name, before: c.before, after: c.after })
    })
    return config(req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/field-configurations/:id', { schema: { tags: T, summary: 'Delete a field configuration no scheme uses (not the default)', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    const c = await config(req.me.workspaceId, req.params.id)
    if (c.isDefault) throw new HttpError(400, 'The Default Field Configuration can’t be deleted')
    if (c.schemes.length) throw new HttpError(409, `Used by ${c.schemes.join(', ')}: take it out of ${c.schemes.length === 1 ? 'that scheme' : 'those schemes'} first`)
    await tx(async d => {
      await d.query('delete from field_configurations where id = $1', [c.id])
      await audit(d, req, { action: 'field_configuration.deleted', type: 'field configuration', id: c.id, name: c.name })
    })
    reply.code(204).send()
  })

  // —— Schemes ——
  const scheme = async (ws: string, id: string) => {
    const [s] = await db.query<any>(`${SCHEMES} where s.workspace_id = $1 and s.id = $2`, [ws, id])
    if (!s) throw new HttpError(404, 'Field configuration scheme not found')
    return s
  }
  const checkScheme = async (d: Db, ws: string, b: { defaultConfigId?: string; mappings?: Record<string, string> }) => {
    const ids = [...new Set([...(b.defaultConfigId ? [b.defaultConfigId] : []), ...Object.values(b.mappings ?? {})])]
    const n = (await d.query<{ n: number }>('select count(*)::int as n from field_configurations where workspace_id = $1 and id = any($2::uuid[])', [ws, ids]))[0]!.n
    if (n !== ids.length) throw new HttpError(400, 'No such field configuration', { mappings: 'Unknown configuration' })
  }
  app.get('/admin/field-config-schemes', { schema: { tags: T, summary: 'Field configuration schemes, with the projects using each' } }, async req => {
    requireNoToken(req)
    return db.query(`${SCHEMES} where s.workspace_id = $1 order by lower(s.name)`, [req.me.workspaceId])
  })
  app.get('/admin/field-config-schemes/:id', { schema: { tags: T, summary: 'A field configuration scheme', params: idP } }, async req => { requireNoToken(req); return scheme(req.me.workspaceId, req.params.id) })
  app.post('/admin/field-config-schemes', { schema: { tags: T, summary: 'Add a field configuration scheme', body: schemeBody } }, async (req, reply) => {
    requireNoToken(req)
    const b = req.body
    const id = await tx(async d => {
      await checkScheme(d, req.me.workspaceId, b)
      const [s] = await d.query<{ id: string }>('insert into field_config_schemes (workspace_id, name, description, default_config_id, mappings) values ($1, $2, $3, $4, $5) returning id',
        [req.me.workspaceId, b.name, b.description, b.defaultConfigId, JSON.stringify(b.mappings)])
      await audit(d, req, { action: 'field_config_scheme.created', type: 'field configuration scheme', id: s!.id, name: b.name, after: b })
      return s!.id
    })
    reply.code(201)
    return scheme(req.me.workspaceId, id)
  })
  app.patch('/admin/field-config-schemes/:id', { schema: { tags: T, summary: 'Change a field configuration scheme', params: idP, body: schemeBody.partial() } }, async req => {
    requireNoToken(req)
    const before = await scheme(req.me.workspaceId, req.params.id)
    await tx(async d => {
      const b = req.body
      await checkScheme(d, req.me.workspaceId, b)
      await d.query('update field_config_schemes set name = coalesce($2, name), description = coalesce($3, description), default_config_id = coalesce($4, default_config_id), mappings = coalesce($5, mappings) where id = $1',
        [before.id, b.name ?? null, b.description ?? null, b.defaultConfigId ?? null, b.mappings ? JSON.stringify(b.mappings) : null])
      const c = changes(before, b)
      if (c.changed) await audit(d, req, { action: 'field_config_scheme.updated', type: 'field configuration scheme', id: before.id, name: b.name ?? before.name, before: c.before, after: c.after })
    })
    return scheme(req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/field-config-schemes/:id', { schema: { tags: T, summary: 'Delete a field configuration scheme; its projects go back to the Default Field Configuration', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    const s = await scheme(req.me.workspaceId, req.params.id)
    await tx(async d => {
      await d.query('delete from field_config_schemes where id = $1', [s.id])
      await audit(d, req, { action: 'field_config_scheme.deleted', type: 'field configuration scheme', id: s.id, name: s.name, before: { projects: s.projects } })
    })
    reply.code(204).send()
  })
}
export default plugin
