import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { projectByKey } from './projects.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cursorOf = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url')
const readCursor = (c?: string) => {
  if (!c) return null
  const [t, id] = Buffer.from(c, 'base64url').toString().split('|')
  if (!t || !id || !UUID.test(id) || isNaN(Date.parse(t))) throw new HttpError(400, 'Invalid cursor')
  return [t, id] as const
}

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/audit', { schema: {
    tags: ['Admin'], summary: 'The audit log, newest first (keyset-paginated). Workspace admins see everything; project admins see their project (pass `project`)',
    querystring: z.object({
      project: z.string().optional().describe('Project key or id'),
      action: z.string().max(100).optional().describe('Action, or the start of one: "project.member" matches added, removed, role_changed…'),
      actor: z.string().max(200).optional().describe('Part of the email of who acted, or "SCIM"'),
      from: z.string().datetime().optional(), to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional(),
    }),
  } }, async req => {
    const q = req.query, cur = readCursor(q.cursor)
    const args: unknown[] = [], where: string[] = []
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)) }
    if (q.project) {
      const p = await projectByKey(db, req, q.project)
      if (p.role !== 'admin') throw new HttpError(403, 'Project admin only')
      add('a.project_id = ?', p.id)
    } else if (!req.me.admin) throw new HttpError(403, 'Only workspace admins can see the whole audit log; project admins can pass project')
    else add('(a.workspace_id = ? or a.workspace_id is null)', req.me.workspaceId)
    if (q.action) add(`a.action like ? || '%'`, q.action.replace(/[%_\\]/g, '\\$&'))
    if (q.actor) add(`a.actor ilike '%' || ? || '%'`, q.actor.replace(/[%_\\]/g, '\\$&'))
    if (q.from) add('a.at >= ?', q.from)
    if (q.to) add('a.at < ?', q.to)
    if (cur) { args.push(cur[0], cur[1]); where.push(`(a.at, a.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`) }
    args.push(q.limit + 1)
    const rows = await db.query<any>(
      `select a.id, a.at, to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts, a.actor_id, a.actor, a.action,
              a.project_id, a.project_key, a.target_type, a.target_id, a.target, a.before, a.after, a.ip
         from audit_log a where ${where.join(' and ')} order by a.at desc, a.id desc limit $${args.length}`, args)
    const more = rows.length > q.limit, items = more ? rows.slice(0, q.limit) : rows
    return { items: items.map(({ cursorTs, ...r }) => r), next: more ? cursorOf(items.at(-1).cursorTs, items.at(-1).id) : null }
  })
}

export default plugin
