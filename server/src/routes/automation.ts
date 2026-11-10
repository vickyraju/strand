// Global automation (spec 0709 R3): rules over every project, a project category (including projects added to it later),
// or chosen projects. System administrators, signed in themselves. Statuses are named, since each project has its own.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx } from '../db.ts'
import { HttpError } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { checkRule, scheduleRule } from '../rules.ts'
import { projectByKey } from './projects.ts'
import { checkPriority } from '../lists.ts'
import { need } from '../access.ts'
import { requireNoToken } from './authentication.ts'

const T = ['Automation']
const idP = z.object({ id: z.string().uuid() })
const scopeIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('category'), categoryId: z.string().uuid() }),
  z.object({ kind: z.literal('projects'), projectKeys: z.array(z.string().trim().min(1).max(20)).min(1).max(1000) }),
])
const body = z.object({
  name: z.string().trim().min(1).max(200), enabled: z.boolean().default(true), scope: scopeIn,
  trigger: z.object({ kind: z.enum(['created', 'status', 'assigned', 'scheduled']), toName: z.string().trim().min(1).max(100).optional().describe('Status: its name'),
    everyMinutes: z.number().int().min(1).max(525_600).optional(), jql: z.string().trim().max(2000).optional(), changedSinceLastRun: z.boolean().optional() })
    .refine(t => t.kind !== 'status' || !!t.toName, 'Name the status'),
  actions: z.array(z.object({ kind: z.enum(['assign', 'priority', 'label', 'status', 'comment']) }).passthrough()
    .refine(a => a.kind !== 'status' || typeof a.name === 'string', 'A status action names its status')).min(1).max(20),
  condition: z.string().trim().max(2000).nullable().default(null),
})
/** A global rule as the API shows it: its scope with project keys and the category's name. */
const VIEW = `select r.id, r.name, r.enabled, r.trigger, r.actions, r.condition, r.runs, r.failures, r.owner_id, r.last_run_at,
  case r.scope->>'kind' when 'projects' then jsonb_build_object('kind', 'projects', 'projectKeys',
         (select coalesce(jsonb_agg(p.key order by p.key), '[]') from projects p where p.id::text in (select jsonb_array_elements_text(r.scope->'projectIds'))))
       when 'category' then r.scope || jsonb_build_object('categoryName', (select c.name from project_categories c where c.id::text = r.scope->>'categoryId'))
       else r.scope end as scope
  from rules r`

const plugin: FastifyPluginAsyncZod = async app => {
  /** The stored scope: project keys become ids; a category must be the workspace's. */
  const scopeOf = async (ws: string, s: z.infer<typeof scopeIn>) => {
    if (s.kind === 'category') {
      if (!(await db.query('select 1 from project_categories where workspace_id = $1 and id = $2', [ws, s.categoryId])).length) throw new HttpError(400, 'No such project category', { scope: 'Unknown category' })
      return s
    }
    if (s.kind === 'projects') {
      const keys = [...new Set(s.projectKeys.map(k => k.toUpperCase()))]
      const found = await db.query<{ id: string; key: string }>('select id, key from projects where workspace_id = $1 and key = any($2::text[])', [ws, keys])
      const unknown = keys.filter(k => !found.some(p => p.key === k))
      if (unknown.length) throw new HttpError(400, `No project with the key ${unknown.join(', ')}`, { scope: `Unknown: ${unknown.join(', ')}` })
      return { kind: 'projects', projectIds: found.map(p => p.id) }
    }
    return s
  }
  const check = async (req: any, b: z.infer<typeof body>) => {
    await checkRule(db, req.me, b)
    for (const a of b.actions as { kind: string; value?: string }[]) if (a.kind === 'priority') await checkPriority(db, req.me.workspaceId, a.value ?? '', 'actions')
    return scopeOf(req.me.workspaceId, b.scope)
  }
  const one = async (ws: string, id: string) => {
    const [r] = await db.query<any>(`${VIEW} where r.workspace_id = $1 and r.id = $2 and r.project_id is null`, [ws, id])
    if (!r) throw new HttpError(404, 'Rule not found')
    return r
  }

  app.get('/admin/automation/rules', { schema: { tags: T, summary: 'Global automation rules (system administrators)' } }, async req => {
    requireNoToken(req)
    return db.query(`${VIEW} where r.workspace_id = $1 and r.project_id is null order by lower(r.name)`, [req.me.workspaceId])
  })
  app.post('/admin/automation/rules', { schema: { tags: T, summary: 'Add a global automation rule', body } }, async req => {
    requireNoToken(req)
    const b = req.body
    const scope = await check(req, b)
    const id = await tx(async d => {
      const [r] = await d.query<{ id: string; enabled: boolean; trigger: unknown }>(
        `insert into rules (workspace_id, scope, name, enabled, trigger, actions, condition, owner_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, enabled, trigger`,
        [req.me.workspaceId, JSON.stringify(scope), b.name, b.enabled, JSON.stringify(b.trigger), JSON.stringify(b.actions), b.condition || null, req.me.id])
      await audit(d, req, { action: 'automation.global.created', type: 'rule', id: r!.id, name: b.name, after: { ...b } })
      await scheduleRule(d, r!, req.me.workspaceId)
      return r!.id
    })
    return one(req.me.workspaceId, id)
  })
  app.put('/admin/automation/rules/:id', { schema: { tags: T, summary: 'Change a global automation rule', params: idP, body } }, async req => {
    requireNoToken(req)
    const before = await one(req.me.workspaceId, req.params.id)
    const b = req.body
    const scope = await check(req, b)
    await tx(async d => {
      const [r] = await d.query<{ id: string; enabled: boolean; trigger: unknown }>(
        `update rules set scope = $2, name = $3, enabled = $4, trigger = $5, actions = $6, condition = $7 where id = $1 returning id, enabled, trigger`,
        [req.params.id, JSON.stringify(scope), b.name, b.enabled, JSON.stringify(b.trigger), JSON.stringify(b.actions), b.condition || null])
      const c = changes(before, b as Record<string, unknown>)
      if (c.changed) await audit(d, req, { action: 'automation.global.updated', type: 'rule', id: req.params.id, name: b.name, before: c.before, after: c.after })
      await scheduleRule(d, r!, req.me.workspaceId)
    })
    return one(req.me.workspaceId, req.params.id)
  })
  app.delete('/admin/automation/rules/:id', { schema: { tags: T, summary: 'Remove a global automation rule (changes it made stay)', params: idP } }, async (req, reply) => {
    requireNoToken(req)
    const r = await one(req.me.workspaceId, req.params.id)
    await tx(async d => {
      await d.query('delete from rules where id = $1', [r.id])
      await d.query(`delete from jobs where dedupe_key = $1 and status = 'queued'`, [`automation.scheduled:${r.id}`])
      await audit(d, req, { action: 'automation.global.deleted', type: 'rule', id: r.id, name: r.name })
    })
    return reply.code(204).send()
  })
  app.get('/admin/automation/runs', { schema: { tags: T, summary: 'Recent runs of global rules, newest first (90 days)',
    querystring: z.object({ rule: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async req => {
    requireNoToken(req)
    const args: unknown[] = [req.me.workspaceId]
    const byRule = req.query.rule ? `and r.rule_id = $${args.push(req.query.rule)}` : ''
    args.push(req.query.limit)
    return db.query(`select r.id, r.rule_id, ru.name as rule, r.issue_id, case when i.id is null then null else pr.key || '-' || i.number end as issue_key,
                            r.trigger, r.result, r.steps, r.error, r.at
                       from rule_runs r join rules ru on ru.id = r.rule_id left join issues i on i.id = r.issue_id left join projects pr on pr.id = i.project_id
                      where ru.workspace_id = $1 and ru.project_id is null ${byRule} order by r.at desc, r.id desc limit $${args.length}`, args)
  })

  // A project's admins see the global rules that apply to it, read-only
  app.get('/projects/:key/automation/global', { schema: { tags: T, summary: 'Global automation rules that apply to this project (read-only; project admins)',
    params: z.object({ key: z.string() }) } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    need(p.role, 'administer', p.key)
    return db.query(`${VIEW}, projects p where p.id = $1 and r.project_id is null and r.workspace_id = p.workspace_id and (r.scope->>'kind' = 'all'
        or (r.scope->>'kind' = 'category' and r.scope->>'categoryId' = p.category_id::text) or (r.scope->>'kind' = 'projects' and r.scope->'projectIds' ? p.id::text))
      order by lower(r.name)`, [p.id])
  })
}
export default plugin
