import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, requireWrite, type Me } from '../auth.ts'
import { publish } from '../events.ts'
import { runRules } from '../rules.ts'
import { projectByKey } from './projects.ts'

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const type = z.enum(['epic', 'story', 'task', 'bug'])
const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])

const ISSUE = `
  select i.id, p.key || '-' || i.number as key, i.project_id, i.number, i.type, i.title, i.description,
         i.status_id, i.priority, i.assignee_id, i.reporter_id, i.labels, i.estimate, i.time_estimate,
         i.due_date, i.start_date, i.sprint_id, i.release_id, i.parent_id, i.custom, i.rank, i.version,
         i.created_at, i.updated_at
    from issues i join projects p on p.id = i.project_id`

const patchBody = z.object({
  title: z.string().min(1).max(500), description: z.string(), type, priority, statusId: uuid,
  assigneeId: uuid.nullable(), labels: z.array(z.string().max(50)).max(50), estimate: z.number().nonnegative().nullable(),
  timeEstimate: z.number().int().nonnegative().nullable(), dueDate: date.nullable(), startDate: date.nullable(),
  sprintId: uuid.nullable(), releaseId: uuid.nullable(), parentId: uuid.nullable(),
  custom: z.record(z.string(), z.union([z.string(), z.number()])), rank: z.number(),
}).partial()
const FIELDS = Object.keys(patchBody.shape)

/** "PAY-12" → issue row scoped to the caller's workspace, or 404. */
async function issueByKey(d: Db, ws: string, key: string, includeDeleted = false) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key)
  if (!m) throw new HttpError(404, 'Issue not found')
  const [i] = await d.query<any>(
    `${ISSUE} where i.workspace_id = $1 and p.key = $2 and i.number = $3 ${includeDeleted ? '' : 'and i.deleted_at is null'}`,
    [ws, m[1]!.toUpperCase(), Number(m[2])])
  if (!i) throw new HttpError(404, 'Issue not found')
  return i
}

const note = (d: Db, to: string, me: Me, issueId: string, kind: string, text: string) =>
  to === me.id ? null : d.query(
    'insert into notifications (user_id, actor_id, issue_id, kind, text) values ($1, $2, $3, $4, $5)', [to, me.id, issueId, kind, text])

async function watchersOf(d: Db, issue: { id: string; assigneeId: string | null; reporterId: string | null }) {
  const w = await d.query<{ userId: string }>('select user_id from issue_watchers where issue_id = $1', [issue.id])
  return [...new Set([...w.map(x => x.userId), issue.assigneeId, issue.reporterId].filter((x): x is string => !!x))]
}

async function checkTransition(d: Db, projectId: string, from: string, to: string) {
  const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from transitions where project_id = $1', [projectId]) as any
  if (!n || from === to) return
  const ok = await d.query(
    'select 1 from transitions where project_id = $1 and to_id = $2 and (from_ids is null or $3 = any(from_ids))', [projectId, to, from])
  if (!ok.length) throw new HttpError(409, 'That move is not allowed by the workflow')
}

const keyP = z.object({ key: z.string().describe('Issue key, e.g. PAY-12') })
const projKeyP = z.object({ key: z.string().describe('Project key, e.g. PAY') })
const idP = z.object({ id: uuid })
const TAG = ['Issues']

const listQuery = z.object({
  status: uuid.optional(), assignee: uuid.optional(), type: type.optional(), sprint: z.union([uuid, z.literal('none')]).optional().describe('Sprint id, or "none" for the backlog'),
  release: uuid.optional(), parent: uuid.optional(), cursor: z.string().optional().describe('`next` from the previous page'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

const plugin: FastifyPluginAsyncZod = async app => {
  // Board/list page of a project, in backlog order. Keyset-paginated: pass `next` back as `cursor`.
  app.get('/projects/:key/issues', { schema: { tags: TAG, summary: 'List a project\'s issues in backlog order (keyset-paginated)', params: projKeyP, querystring: listQuery } }, async req => {
    const q = req.query
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    const args: unknown[] = [p.id]
    const where = ['i.project_id = $1', 'i.deleted_at is null']
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)) }
    if (q.status) add('i.status_id = ?', q.status)
    if (q.assignee) add('i.assignee_id = ?', q.assignee)
    if (q.type) add('i.type = ?', q.type)
    if (q.release) add('i.release_id = ?', q.release)
    if (q.parent) add('i.parent_id = ?', q.parent)
    if (q.sprint === 'none') where.push('i.sprint_id is null')
    else if (q.sprint) add('i.sprint_id = ?', q.sprint)
    if (q.cursor) {
      const [r, id] = Buffer.from(q.cursor, 'base64url').toString().split('|')
      args.push(Number(r), id)
      where.push(`(i.rank, i.id) > ($${args.length - 1}, $${args.length})`)
    }
    args.push(q.limit + 1)
    const rows = await db.query<any>(`${ISSUE} where ${where.join(' and ')} order by i.rank, i.id limit $${args.length}`, args)
    const more = rows.length > q.limit
    const items = more ? rows.slice(0, q.limit) : rows
    const last = items.at(-1)
    return { items, next: more && last ? Buffer.from(`${last.rank}|${last.id}`).toString('base64url') : null }
  })

  const createBody = patchBody.required({ title: true }).extend({ labels: z.array(z.string()).default([]) })
  app.post('/projects/:key/issues', { schema: { tags: TAG, summary: 'Create an issue (key and rank are assigned by the server)', params: projKeyP, body: createBody } }, async req => {
    requireWrite(req)
    const b = req.body
    const p = await projectByKey(db, req.me.workspaceId, req.params.key)
    return tx(async d => {
      const [pr] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [p.id])
      let statusId = b.statusId
      if (!statusId) {
        const [s] = await d.query<{ id: string }>('select id from statuses where project_id = $1 order by position limit 1', [p.id])
        if (!s) throw new HttpError(409, 'Project has no statuses')
        statusId = s.id
      }
      const [{ number }] = await d.query<{ number: number }>('select next_issue_number($1) as number', [p.id]) as any
      const [{ rank }] = await d.query<{ rank: number }>(
        'select coalesce(max(rank), 0) + 1000 as rank from issues where project_id = $1', [p.id]) as any
      const w = pick({ ...b, statusId, rank: b.rank ?? rank }, FIELDS, ['custom'])
      const cols = ['workspace_id', 'project_id', 'number', 'reporter_id', ...w.cols]
      const vals = [req.me.workspaceId, p.id, number, req.me.id, ...w.vals]
      const [row] = await d.query<{ id: string }>(
        `insert into issues (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals)
      await d.query(`insert into activity (issue_id, actor_id, text) values ($1, $2, 'Created this work item')`, [row!.id, req.me.id])
      if (b.assigneeId) await note(d, b.assigneeId, req.me, row!.id, 'assigned', 'assigned you a work item')
      await runRules(d, { projectId: p.id, issueId: row!.id, reporterId: req.me.id, leadId: pr!.leadId }, { kind: 'created' })
      await publish(d, p.id, { type: 'issue.created', id: row!.id })
      const [issue] = await d.query<any>(`${ISSUE} where i.id = $1`, [row!.id])
      return issue
    })
  })

  app.get('/issues/:key', { schema: { tags: TAG, summary: 'Issue with links, watchers, comments, activity, work logs, attachments and children', params: keyP } }, async req => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const [links, watchers, comments, activity, worklogs, attachments, children] = await Promise.all([
      db.query(`select l.type, 'out' as dir, t.id as issue_id, p.key || '-' || t.number as key, t.title
                  from issue_links l join issues t on t.id = l.target_id join projects p on p.id = t.project_id where l.issue_id = $1 and t.deleted_at is null
                union all
                select l.type, 'in', t.id, p.key || '-' || t.number, t.title
                  from issue_links l join issues t on t.id = l.issue_id join projects p on p.id = t.project_id where l.target_id = $1 and t.deleted_at is null`, [i.id]),
      db.query('select user_id from issue_watchers where issue_id = $1', [i.id]),
      db.query('select * from comments where issue_id = $1 order by created_at', [i.id]),
      db.query('select * from activity where issue_id = $1 order by created_at desc limit 200', [i.id]),
      db.query('select * from worklogs where issue_id = $1 order by date desc, created_at desc', [i.id]),
      db.query('select id, name, size, type, added_by, added_at from attachments where issue_id = $1 order by added_at', [i.id]),
      db.query(`${ISSUE} where i.parent_id = $1 and i.deleted_at is null order by i.rank`, [i.id]),
    ])
    return { ...i, links, watcherIds: watchers.map((w: any) => w.userId), comments, activity, worklogs, attachments, children }
  })

  app.patch('/issues/:key', { schema: {
    tags: TAG, summary: 'Update issue fields. Send If-Match: <version> to reject stale edits (409). Workflow transitions are enforced.',
    params: keyP, body: patchBody, headers: z.object({ 'if-match': z.string().optional().describe('Issue version you last read') }),
  } }, async req => {
    requireWrite(req)
    const patch = req.body
    const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/"/g, '')) : null
    return tx(async d => {
      const cur = await issueByKey(d, req.me.workspaceId, req.params.key)
      if (ifMatch !== null && ifMatch !== cur.version) throw new HttpError(409, `Edited elsewhere (current version ${cur.version})`)
      if (patch.statusId) await checkTransition(d, cur.projectId, cur.statusId, patch.statusId)
      if (patch.parentId === cur.id) throw new HttpError(400, 'An item cannot be its own parent')

      const changed = Object.keys(patch).filter(k => k !== 'rank' && JSON.stringify((patch as any)[k]) !== JSON.stringify(cur[k]))
      const w = pick(patch, FIELDS, ['custom'])
      if (!w.keys.length) return cur
      const [{ n }] = await d.query<{ n: number }>(
        `update issues set ${w.cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now()
          where id = $1 and version = $2 returning 1 as n`, [cur.id, cur.version, ...w.vals]) as any
      if (!n) throw new HttpError(409, 'Edited elsewhere')

      for (const f of changed) {
        const to = (patch as any)[f], from = cur[f]
        await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, $2, $3, $4, $5, $6)',
          [cur.id, req.me.id, f, from == null ? null : String(from), to == null ? null : String(to), `Changed ${f.replace(/([A-Z])/g, ' $1').toLowerCase()}`])
      }
      const [pr] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [cur.projectId])
      const ctx = { projectId: cur.projectId, issueId: cur.id, reporterId: cur.reporterId, leadId: pr!.leadId }
      if (changed.includes('assigneeId') && patch.assigneeId) {
        await note(d, patch.assigneeId, req.me, cur.id, 'assigned', 'assigned you a work item')
        await runRules(d, ctx, { kind: 'assigned' })
      }
      if (changed.includes('statusId')) {
        for (const u of await watchersOf(d, cur)) await note(d, u, req.me, cur.id, 'status', 'changed the status')
        await runRules(d, ctx, { kind: 'status', to: patch.statusId! })
      }
      await publish(d, cur.projectId, { type: 'issue.updated', id: cur.id, key: cur.key })
      return (await d.query<any>(`${ISSUE} where i.id = $1`, [cur.id]))[0]
    })
  })

  // Soft delete + restore back the client's Undo
  app.delete('/issues/:key', { schema: { tags: TAG, summary: 'Soft-delete an issue (restorable)', params: keyP } }, async (req, reply) => {
    requireWrite(req)
    await tx(async d => {
      const i = await issueByKey(d, req.me.workspaceId, req.params.key)
      await d.query('update issues set deleted_at = now(), version = version + 1 where id = $1', [i.id])
      await publish(d, i.projectId, { type: 'issue.deleted', id: i.id, key: i.key })
    })
    reply.code(204).send()
  })
  app.post('/issues/:key/restore', { schema: { tags: TAG, summary: 'Restore a soft-deleted issue (Undo)', params: keyP } }, async req => {
    requireWrite(req)
    return tx(async d => {
      const i = await issueByKey(d, req.me.workspaceId, req.params.key, true)
      await d.query('update issues set deleted_at = null, version = version + 1 where id = $1', [i.id])
      await publish(d, i.projectId, { type: 'issue.created', id: i.id })
      return (await d.query<any>(`${ISSUE} where i.id = $1`, [i.id]))[0]
    })
  })

  // ── Links & watchers ──
  const linkBody = z.object({ type: z.enum(['blocks', 'relates']), targetKey: z.string() })
  app.post('/issues/:key/links', { schema: { tags: ['Links & watchers'], summary: 'Link two issues (blocks / relates)', params: keyP, body: linkBody } }, async (req, reply) => {
    requireWrite(req)
    const b = req.body
    const [a, t] = await Promise.all([issueByKey(db, req.me.workspaceId, req.params.key), issueByKey(db, req.me.workspaceId, b.targetKey)])
    if (a.id === t.id) throw new HttpError(400, 'Cannot link an item to itself')
    await db.query('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing', [a.id, t.id, b.type])
    reply.code(204).send()
  })
  app.delete('/issues/:key/links', { schema: {
    tags: ['Links & watchers'], summary: 'Remove a link', params: keyP,
    querystring: z.object({ type: z.enum(['blocks', 'relates']), target: z.string().describe('Key of the linked issue') }),
  } }, async (req, reply) => {
    requireWrite(req)
    const q = { type: req.query.type, targetKey: req.query.target }
    const [a, t] = await Promise.all([issueByKey(db, req.me.workspaceId, req.params.key), issueByKey(db, req.me.workspaceId, q.targetKey)])
    await db.query('delete from issue_links where issue_id = $1 and target_id = $2 and type = $3', [a.id, t.id, q.type])
    reply.code(204).send()
  })
  app.put('/issues/:key/watch', { schema: { tags: ['Links & watchers'], summary: 'Watch an issue', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    await db.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, req.me.id])
    reply.code(204).send()
  })
  app.delete('/issues/:key/watch', { schema: { tags: ['Links & watchers'], summary: 'Stop watching an issue', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    await db.query('delete from issue_watchers where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    reply.code(204).send()
  })

  // ── Comments (authors edit/delete their own) ──
  const body = z.object({ body: z.string().min(1).max(20000) })
  app.post('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Add a comment (notifies watchers)', params: keyP, body } }, async req => {
    requireWrite(req)
    const b = req.body
    return tx(async d => {
      const i = await issueByKey(d, req.me.workspaceId, req.params.key)
      const [c] = await d.query('insert into comments (issue_id, author_id, body) values ($1, $2, $3) returning *', [i.id, req.me.id, b.body])
      for (const u of await watchersOf(d, i)) await note(d, u, req.me, i.id, 'commented', 'commented on a work item')
      await publish(d, i.projectId, { type: 'comment.created', key: i.key })
      return c
    })
  })
  app.patch('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Edit your own comment', params: idP, body } }, async req => {
    requireWrite(req)
    const [c] = await db.query(
      `update comments set body = $3, edited_at = now() where id = $1 and author_id = $2 returning *`,
      [req.params.id, req.me.id, req.body.body])
    if (!c) throw new HttpError(404, 'Not found, or not yours')
    return c
  })
  app.delete('/comments/:id', { schema: { tags: ['Comments & work logs'], summary: 'Delete your own comment', params: idP } }, async (req, reply) => {
    requireWrite(req)
    const r = await db.query('delete from comments where id = $1 and author_id = $2 returning id', [req.params.id, req.me.id])
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })

  // ── Work logs ──
  app.post('/issues/:key/worklogs', { schema: {
    tags: ['Comments & work logs'], summary: 'Log time on an issue', params: keyP,
    body: z.object({ minutes: z.number().int().positive(), date, note: z.string().default('') }),
  } }, async req => {
    requireWrite(req)
    const b = req.body
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const [w] = await db.query('insert into worklogs (issue_id, user_id, minutes, date, note) values ($1, $2, $3, $4, $5) returning *',
      [i.id, req.me.id, b.minutes, b.date, b.note])
    return w
  })
  app.delete('/worklogs/:id', { schema: { tags: ['Comments & work logs'], summary: 'Delete your own work log', params: idP } }, async (req, reply) => {
    requireWrite(req)
    const r = await db.query('delete from worklogs where id = $1 and user_id = $2 returning id', [req.params.id, req.me.id])
    if (!r.length) throw new HttpError(404, 'Not found, or not yours')
    reply.code(204).send()
  })
}

export default plugin
