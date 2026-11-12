// Administration › Screens (spec 0505), as Jira's: screens (tabs and their fields), screen schemes (a screen for Create,
// Edit and View) and issue type screen schemes (a screen scheme per work type). System administrators, signed in themselves.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireJiraAdmin } from './globalPermissions.ts'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { defaultScreenScheme } from '../fields.ts'
import { SYSTEM_FIELDS } from '../shared/fieldRules.ts'

const T = ['Screens']
const idP = z.object({ id: z.string().uuid() })
const uuid = z.string().uuid()
const tab = z.object({ name: z.string().trim().min(1).max(100), fields: z.array(z.string().regex(/^([a-zA-Z]+|custom\.[0-9a-f-]{36})$/)).max(500) })
const screenBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''),
  tabs: z.array(tab).min(1).max(50).nullable().default(null).describe('Tabs with their fields in order; null: every field (the Default Screen as it comes)') })
const schemeBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''), defaultScreenId: uuid,
  createScreenId: uuid.nullable().default(null), editScreenId: uuid.nullable().default(null), viewScreenId: uuid.nullable().default(null) })
const itsBody = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(1000).default(''), defaultSchemeId: uuid,
  mappings: z.record(z.string().min(1).max(40), uuid).default({}).describe('Work type key → screen scheme id') })

/** A screen's fields: ones Strand has, each once. */
async function checkTabs(d: Db, ws: string, tabs: z.infer<typeof tab>[] | null) {
  if (!tabs) return
  const all = tabs.flatMap(t => t.fields)
  if (new Set(all).size !== all.length) throw new HttpError(400, 'A field is on a screen once', { tabs: 'A field twice' })
  const custom = all.filter(k => k.startsWith('custom.')).map(k => k.slice(7))
  const known = new Set((await d.query<{ id: string }>('select id from custom_fields where workspace_id = $1 and id = any($2::uuid[])', [ws, custom])).map(r => r.id))
  const bad = all.find(k => (k.startsWith('custom.') ? !known.has(k.slice(7)) : !(k in SYSTEM_FIELDS)))
  if (bad) throw new HttpError(400, `No field ${bad}`, { tabs: `Unknown field ${bad}` })
}
const owned = async (d: Db, table: string, ws: string, ids: (string | null | undefined)[]) => {
  const want = [...new Set(ids.filter(Boolean))] as string[]
  const n = (await d.query<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1 and id = any($2::uuid[])`, [ws, want]))[0]!.n
  if (n !== want.length) throw new HttpError(400, `No such ${table === 'screens' ? 'screen' : 'screen scheme'}`)
}

const SCREENS = `select s.id, s.name, s.description, s.tabs, s.is_default,
  (select coalesce(jsonb_agg(ss.name order by ss.name), '[]') from screen_schemes ss where s.id in (ss.default_screen_id, ss.create_screen_id, ss.edit_screen_id, ss.view_screen_id)) as schemes
  from screens s`
const SCHEMES = `select ss.id, ss.name, ss.description, ss.default_screen_id, ss.create_screen_id, ss.edit_screen_id, ss.view_screen_id, ss.is_default,
  (select coalesce(jsonb_agg(i.name order by i.name), '[]') from issue_type_screen_schemes i where i.default_scheme_id = ss.id or exists (select 1 from jsonb_each_text(i.mappings) m where m.value = ss.id::text)) as used_by
  from screen_schemes ss`
const ITS = `select i.id, i.name, i.description, i.default_scheme_id, i.mappings,
  (select coalesce(jsonb_agg(p.key order by p.key), '[]') from (select key from projects where issue_type_screen_scheme_id = i.id order by key limit 100) p) as project_keys,
  (select count(*)::int from projects where issue_type_screen_scheme_id = i.id) as projects
  from issue_type_screen_schemes i`

const plugin: FastifyPluginAsyncZod = async app => {
  const one = async (sql: string, alias: string, ws: string, id: string, what: string) => {
    const [r] = await db.query<any>(`${sql} where ${alias}.workspace_id = $1 and ${alias}.id = $2`, [ws, id])
    if (!r) throw new HttpError(404, `${what} not found`)
    return r
  }
  // —— Screens ——
  app.get('/admin/screens', { schema: { tags: T, summary: 'Screens, the default first, with the screen schemes using each' } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    await defaultScreenScheme(db, req.me.workspaceId)
    return db.query(`${SCREENS} where s.workspace_id = $1 order by s.is_default desc, lower(s.name)`, [req.me.workspaceId])
  })
  app.get('/admin/screens/:id', { schema: { tags: T, summary: 'A screen', params: idP } }, async req => { await requireJiraAdmin(req, { noToken: true }); return one(SCREENS, 's', req.me.workspaceId, req.params.id, 'Screen') })
  app.post('/admin/screens', { schema: { tags: T, summary: 'Add a screen', body: screenBody } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const b = req.body
    const id = await tx(async d => {
      await checkTabs(d, req.me.workspaceId, b.tabs)
      const [s] = await d.query<{ id: string }>('insert into screens (workspace_id, name, description, tabs) values ($1, $2, $3, $4) returning id', [req.me.workspaceId, b.name, b.description, b.tabs ? JSON.stringify(b.tabs) : null])
      await audit(d, req, { action: 'screen.created', type: 'screen', id: s!.id, name: b.name, after: b })
      return s!.id
    })
    reply.code(201)
    return one(SCREENS, 's', req.me.workspaceId, id, 'Screen')
  })
  app.patch('/admin/screens/:id', { schema: { tags: T, summary: 'Change a screen: its tabs and their fields', params: idP, body: screenBody.partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const before = await one(SCREENS, 's', req.me.workspaceId, req.params.id, 'Screen')
    await tx(async d => {
      const b = req.body
      if (b.tabs !== undefined) await checkTabs(d, req.me.workspaceId, b.tabs)
      await d.query('update screens set name = coalesce($2, name), description = coalesce($3, description), tabs = case when $5 then $4::jsonb else tabs end where id = $1',
        [before.id, b.name ?? null, b.description ?? null, b.tabs ? JSON.stringify(b.tabs) : null, b.tabs !== undefined])
      const c = changes(before, b)
      if (c.changed) await audit(d, req, { action: 'screen.updated', type: 'screen', id: before.id, name: b.name ?? before.name, before: c.before, after: c.after })
    })
    return one(SCREENS, 's', req.me.workspaceId, req.params.id, 'Screen')
  })
  app.delete('/admin/screens/:id', { schema: { tags: T, summary: 'Delete a screen no scheme uses (not the default)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const s = await one(SCREENS, 's', req.me.workspaceId, req.params.id, 'Screen')
    if (s.isDefault) throw new HttpError(400, 'The Default Screen can’t be deleted')
    if (s.schemes.length) throw new HttpError(409, `Used by ${s.schemes.join(', ')}`)
    await tx(async d => { await d.query('delete from screens where id = $1', [s.id]); await audit(d, req, { action: 'screen.deleted', type: 'screen', id: s.id, name: s.name }) })
    reply.code(204).send()
  })

  // —— Screen schemes ——
  app.get('/admin/screen-schemes', { schema: { tags: T, summary: 'Screen schemes' } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    await defaultScreenScheme(db, req.me.workspaceId)
    return db.query(`${SCHEMES} where ss.workspace_id = $1 order by ss.is_default desc, lower(ss.name)`, [req.me.workspaceId])
  })
  app.get('/admin/screen-schemes/:id', { schema: { tags: T, summary: 'A screen scheme', params: idP } }, async req => { await requireJiraAdmin(req, { noToken: true }); return one(SCHEMES, 'ss', req.me.workspaceId, req.params.id, 'Screen scheme') })
  app.post('/admin/screen-schemes', { schema: { tags: T, summary: 'Add a screen scheme', body: schemeBody } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const b = req.body
    const id = await tx(async d => {
      await owned(d, 'screens', req.me.workspaceId, [b.defaultScreenId, b.createScreenId, b.editScreenId, b.viewScreenId])
      const [s] = await d.query<{ id: string }>('insert into screen_schemes (workspace_id, name, description, default_screen_id, create_screen_id, edit_screen_id, view_screen_id) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [req.me.workspaceId, b.name, b.description, b.defaultScreenId, b.createScreenId, b.editScreenId, b.viewScreenId])
      await audit(d, req, { action: 'screen_scheme.created', type: 'screen scheme', id: s!.id, name: b.name, after: b })
      return s!.id
    })
    reply.code(201)
    return one(SCHEMES, 'ss', req.me.workspaceId, id, 'Screen scheme')
  })
  app.patch('/admin/screen-schemes/:id', { schema: { tags: T, summary: 'Change a screen scheme', params: idP, body: schemeBody.partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const before = await one(SCHEMES, 'ss', req.me.workspaceId, req.params.id, 'Screen scheme')
    await tx(async d => {
      const b = { ...before, ...req.body }
      await owned(d, 'screens', req.me.workspaceId, [b.defaultScreenId, b.createScreenId, b.editScreenId, b.viewScreenId])
      await d.query('update screen_schemes set name = $2, description = $3, default_screen_id = $4, create_screen_id = $5, edit_screen_id = $6, view_screen_id = $7 where id = $1',
        [before.id, b.name, b.description, b.defaultScreenId, b.createScreenId, b.editScreenId, b.viewScreenId])
      const c = changes(before, req.body)
      if (c.changed) await audit(d, req, { action: 'screen_scheme.updated', type: 'screen scheme', id: before.id, name: b.name, before: c.before, after: c.after })
    })
    return one(SCHEMES, 'ss', req.me.workspaceId, req.params.id, 'Screen scheme')
  })
  app.delete('/admin/screen-schemes/:id', { schema: { tags: T, summary: 'Delete a screen scheme no issue type screen scheme uses (not the default)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const s = await one(SCHEMES, 'ss', req.me.workspaceId, req.params.id, 'Screen scheme')
    if (s.isDefault) throw new HttpError(400, 'The Default Screen Scheme can’t be deleted')
    if (s.usedBy.length) throw new HttpError(409, `Used by ${s.usedBy.join(', ')}`)
    await tx(async d => { await d.query('delete from screen_schemes where id = $1', [s.id]); await audit(d, req, { action: 'screen_scheme.deleted', type: 'screen scheme', id: s.id, name: s.name }) })
    reply.code(204).send()
  })

  // —— Issue type screen schemes ——
  app.get('/admin/issue-type-screen-schemes', { schema: { tags: T, summary: 'Issue type screen schemes, with the projects using each' } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    return db.query(`${ITS} where i.workspace_id = $1 order by lower(i.name)`, [req.me.workspaceId])
  })
  app.get('/admin/issue-type-screen-schemes/:id', { schema: { tags: T, summary: 'An issue type screen scheme', params: idP } }, async req => { await requireJiraAdmin(req, { noToken: true }); return one(ITS, 'i', req.me.workspaceId, req.params.id, 'Issue type screen scheme') })
  app.post('/admin/issue-type-screen-schemes', { schema: { tags: T, summary: 'Add an issue type screen scheme', body: itsBody } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const b = req.body
    const id = await tx(async d => {
      await owned(d, 'screen_schemes', req.me.workspaceId, [b.defaultSchemeId, ...Object.values(b.mappings)])
      const [s] = await d.query<{ id: string }>('insert into issue_type_screen_schemes (workspace_id, name, description, default_scheme_id, mappings) values ($1, $2, $3, $4, $5) returning id',
        [req.me.workspaceId, b.name, b.description, b.defaultSchemeId, JSON.stringify(b.mappings)])
      await audit(d, req, { action: 'issue_type_screen_scheme.created', type: 'issue type screen scheme', id: s!.id, name: b.name, after: b })
      return s!.id
    })
    reply.code(201)
    return one(ITS, 'i', req.me.workspaceId, id, 'Issue type screen scheme')
  })
  app.patch('/admin/issue-type-screen-schemes/:id', { schema: { tags: T, summary: 'Change an issue type screen scheme', params: idP, body: itsBody.partial() } }, async req => {
    await requireJiraAdmin(req, { noToken: true })
    const before = await one(ITS, 'i', req.me.workspaceId, req.params.id, 'Issue type screen scheme')
    await tx(async d => {
      const b = { ...before, ...req.body }
      await owned(d, 'screen_schemes', req.me.workspaceId, [b.defaultSchemeId, ...Object.values(b.mappings as Record<string, string>)])
      await d.query('update issue_type_screen_schemes set name = $2, description = $3, default_scheme_id = $4, mappings = $5 where id = $1', [before.id, b.name, b.description, b.defaultSchemeId, JSON.stringify(b.mappings)])
      const c = changes(before, req.body)
      if (c.changed) await audit(d, req, { action: 'issue_type_screen_scheme.updated', type: 'issue type screen scheme', id: before.id, name: b.name, before: c.before, after: c.after })
    })
    return one(ITS, 'i', req.me.workspaceId, req.params.id, 'Issue type screen scheme')
  })
  app.delete('/admin/issue-type-screen-schemes/:id', { schema: { tags: T, summary: 'Delete an issue type screen scheme; its projects go back to the Default Screen Scheme', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req, { noToken: true })
    const s = await one(ITS, 'i', req.me.workspaceId, req.params.id, 'Issue type screen scheme')
    await tx(async d => { await d.query('delete from issue_type_screen_schemes where id = $1', [s.id]); await audit(d, req, { action: 'issue_type_screen_scheme.deleted', type: 'issue type screen scheme', id: s.id, name: s.name, before: { projects: s.projects } }) })
    reply.code(204).send()
  })
}
export default plugin
