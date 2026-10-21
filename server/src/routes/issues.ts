import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, pick, type Db } from '../db.ts'
import { HttpError, isAdmin, requireWrite, type Me } from '../auth.ts'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** "PAY-12" or the issue's uuid → issue row scoped to the caller's workspace, or 404 (Jira calls this issueIdOrKey). */
async function issueByKey(d: Db, ws: string, ref: string, includeDeleted = false) {
  const live = includeDeleted ? '' : 'and i.deleted_at is null'
  const byId = UUID.test(ref)
  const m = byId ? null : /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref)
  if (!byId && !m) throw new HttpError(404, 'Issue not found')
  const [i] = byId
    ? await d.query<any>(`${ISSUE} where i.workspace_id = $1 and i.id = $2 ${live}`, [ws, ref])
    : await d.query<any>(`${ISSUE} where i.workspace_id = $1 and p.key = $2 and i.number = $3 ${live}`, [ws, m![1]!.toUpperCase(), Number(m![2])])
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

const keyP = z.object({ key: z.string().describe('Issue key (PAY-12) or id (uuid)') })
const projKeyP = z.object({ key: z.string().describe('Project key, e.g. PAY') })
const idP = z.object({ id: uuid })
const TAG = ['Issues']

const listQuery = z.object({
  status: uuid.optional(), assignee: uuid.optional(), type: type.optional(), sprint: z.union([uuid, z.literal('none')]).optional().describe('Sprint id, or "none" for the backlog'),
  release: uuid.optional(), parent: uuid.optional(), cursor: z.string().optional().describe('`next` from the previous page'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

/** Who has this issue open for editing right now, with the user's name for display (heartbeat < 90 s). */
async function editorsOf(d: Db, issueId: string) {
  const rows = await d.query<{ userId: string; name: string; initials: string; color: string }>(
    `select e.user_id as user_id, u.name, u.initials, u.color
       from issue_editors e join users u on u.id = e.user_id
      where e.issue_id = $1 and e.last_heartbeat > now() - interval '90 seconds'
      order by e.last_heartbeat desc`, [issueId])
  return rows
}

/** One issue edit: version check, workflow check, history, notifications, automation, live event. Shared by the single and bulk edits. */
async function applyPatch(d: Db, me: Me, cur: any, patch: z.infer<typeof patchBody>, o: { ifMatch: number | null; override: boolean }) {
  if (o.ifMatch !== null && o.ifMatch !== cur.version) throw new HttpError(409, `Edited elsewhere (current version ${cur.version})`)
  const [lead] = await d.query<{ leadId: string | null }>('select lead_id from projects where id = $1', [cur.projectId])
  const override = o.override && (isAdmin(me.role) || lead?.leadId === me.id)
  if (patch.statusId && !override) await checkTransition(d, cur.projectId, cur.statusId, patch.statusId)
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
      [cur.id, me.id, f, from == null ? null : String(from), to == null ? null : String(to), `Changed ${f.replace(/([A-Z])/g, ' $1').toLowerCase()}`])
  }
  const ctx = { projectId: cur.projectId, issueId: cur.id, reporterId: cur.reporterId, leadId: lead?.leadId ?? null }
  if (changed.includes('assigneeId') && patch.assigneeId) {
    await note(d, patch.assigneeId, me, cur.id, 'assigned', 'assigned you a work item')
    await runRules(d, ctx, { kind: 'assigned' })
  }
  if (changed.includes('statusId')) {
    for (const u of await watchersOf(d, cur)) await note(d, u, me, cur.id, 'status', 'changed the status')
    await runRules(d, ctx, { kind: 'status', to: patch.statusId! })
  }
  await publish(d, cur.projectId, { type: 'issue.updated', id: cur.id, key: cur.key, editors: await editorsOf(d, cur.id) })
  return (await d.query<any>(`${ISSUE} where i.id = $1`, [cur.id]))[0]
}

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

  const createBody = patchBody.required({ title: true }).extend({
    labels: z.array(z.string()).default([]),
    id: uuid.optional().describe('Client-chosen id: lets the app keep its local id, and makes a retried create a conflict instead of a duplicate'),
  })
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
      const cols = ['workspace_id', 'project_id', 'number', 'reporter_id', ...(b.id ? ['id'] : []), ...w.cols]
      const vals = [req.me.workspaceId, p.id, number, req.me.id, ...(b.id ? [b.id] : []), ...w.vals]
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

  const EXPAND = ['links', 'watchers', 'comments', 'activity', 'worklogs', 'attachments', 'children'] as const
  app.get('/issues/:key', { schema: {
    tags: TAG, summary: 'Issue, with its related records. `expand` picks which; omit it for all (comments and history have their own paginated endpoints).',
    params: keyP, querystring: z.object({ expand: z.string().optional().describe(`Comma-separated: ${EXPAND.join(', ')}`) }),
  } }, async req => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const want = new Set(req.query.expand ? req.query.expand.split(',').map(x => x.trim()).filter(Boolean) : EXPAND)
    for (const w of want) if (!(EXPAND as readonly string[]).includes(w)) throw new HttpError(400, `Unknown expand value: ${w}`)
    const out: Record<string, unknown> = { ...i }
    const jobs: Promise<void>[] = []
    const load = (name: string, sql: string, map?: (rows: any[]) => unknown) => { if (want.has(name)) jobs.push(db.query(sql, [i.id]).then(r => { out[name === 'watchers' ? 'watcherIds' : name] = map ? map(r) : r })) }
    load('links', `select l.type, 'out' as dir, t.id as issue_id, p.key || '-' || t.number as key, t.title
                  from issue_links l join issues t on t.id = l.target_id join projects p on p.id = t.project_id where l.issue_id = $1 and t.deleted_at is null
                union all
                select l.type, 'in', t.id, p.key || '-' || t.number, t.title
                  from issue_links l join issues t on t.id = l.issue_id join projects p on p.id = t.project_id where l.target_id = $1 and t.deleted_at is null`)
    load('watchers', 'select user_id from issue_watchers where issue_id = $1', rows => rows.map((w: any) => w.userId))
    load('comments', 'select * from comments where issue_id = $1 order by created_at, id limit 200')
    load('activity', 'select * from activity where issue_id = $1 order by created_at desc, id desc limit 200')
    load('worklogs', 'select * from worklogs where issue_id = $1 order by date desc, created_at desc limit 200')
    load('attachments', 'select id, name, size, type, added_by, added_at from attachments where issue_id = $1 order by added_at')
    load('children', `${ISSUE} where i.parent_id = $1 and i.deleted_at is null order by i.rank limit 500`)
    await Promise.all(jobs)
    return out
  })

  // Comments and history, paged (the detail call embeds only the first 200)
  const page = z.object({ cursor: z.string().optional().describe('`next` from the previous page'), limit: z.coerce.number().int().min(1).max(200).default(50) })
  // Cursors carry the timestamp as the database printed it (microseconds); a JS Date would cut it to milliseconds and repeat or skip rows
  const cursorOf = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url')
  const readCursor = (c?: string) => { if (!c) return null; const [t, id] = Buffer.from(c, 'base64url').toString().split('|'); if (!t || !id || !UUID.test(id) || isNaN(Date.parse(t))) throw new HttpError(400, 'Invalid cursor'); return [t, id] as const }
  app.get('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Comments on an issue, oldest first (keyset-paginated)', params: keyP, querystring: page } }, async req => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const cur = readCursor(req.query.cursor)
    const rows = await db.query<any>(
      `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts from comments where issue_id = $1 ${cur ? 'and (created_at, id) > ($3::timestamptz, $4::uuid)' : ''} order by created_at, id limit $2`,
      cur ? [i.id, req.query.limit + 1, cur[0], cur[1]] : [i.id, req.query.limit + 1])
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).cursorTs, items.at(-1).id) : null }
  })
  app.get('/issues/:key/activity', { schema: { tags: TAG, summary: 'Change history of an issue, newest first (keyset-paginated)', params: keyP, querystring: page } }, async req => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const cur = readCursor(req.query.cursor)
    const rows = await db.query<any>(
      `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts from activity where issue_id = $1 ${cur ? 'and (created_at, id) < ($3::timestamptz, $4::uuid)' : ''} order by created_at desc, id desc limit $2`,
      cur ? [i.id, req.query.limit + 1, cur[0], cur[1]] : [i.id, req.query.limit + 1])
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, next: more ? cursorOf(items.at(-1).cursorTs, items.at(-1).id) : null }
  })

  app.patch('/issues/:key', { schema: {
    tags: TAG, summary: 'Update issue fields. Send If-Match: <version> to reject stale edits (409). Workflow transitions are enforced.',
    params: keyP, body: patchBody, headers: z.object({
      'if-match': z.string().optional().describe('Issue version you last read'),
      'x-workflow-override': z.string().optional().describe('Send 1 to skip the workflow check. Honored only for workspace admins and the project lead (used when moving work off a status that is being deleted).'),
    }),
  } }, async req => {
    requireWrite(req)
    const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/"/g, '')) : null
    return tx(async d => applyPatch(d, req.me, await issueByKey(d, req.me.workspaceId, req.params.key), req.body, { ifMatch, override: req.headers['x-workflow-override'] === '1' }))
  })

  // ── Bulk (up to 200 issues, all or nothing: nothing changes if any issue is missing or refuses the change) ──
  const refs = z.array(z.string()).min(1).max(200).describe('Issue keys (PAY-12) or ids')
  const bulkResult = (n: number) => ({ count: n })
  app.post('/issues/bulk/edit', { schema: { tags: ['Issues: bulk'], summary: 'Apply the same field changes to many issues (workflow rules apply to each)', body: z.object({ issues: refs, patch: patchBody }) } }, async req => {
    requireWrite(req)
    return tx(async d => {
      const out: any[] = []
      for (const ref of [...new Set(req.body.issues)]) out.push(await applyPatch(d, req.me, await issueByKey(d, req.me.workspaceId, ref), req.body.patch, { ifMatch: null, override: false }))
      return { count: out.length, issues: out }
    })
  })
  app.post('/issues/bulk/delete', { schema: { tags: ['Issues: bulk'], summary: 'Soft-delete many issues (restorable)', body: z.object({ issues: refs }) } }, async req => {
    requireWrite(req)
    return tx(async d => {
      const rows = []
      for (const ref of [...new Set(req.body.issues)]) rows.push(await issueByKey(d, req.me.workspaceId, ref))
      await d.query('update issues set deleted_at = now(), version = version + 1 where id = any($1::uuid[])', [rows.map(r => r.id)])
      for (const pid of new Set(rows.map(r => r.projectId))) await publish(d, pid, { type: 'issue.deleted' })
      return bulkResult(rows.length)
    })
  })
  app.post('/issues/bulk/restore', { schema: { tags: ['Issues: bulk'], summary: 'Restore many soft-deleted issues (Undo)', body: z.object({ issues: refs }) } }, async req => {
    requireWrite(req)
    return tx(async d => {
      const rows = []
      for (const ref of [...new Set(req.body.issues)]) rows.push(await issueByKey(d, req.me.workspaceId, ref, true))
      await d.query('update issues set deleted_at = null, version = version + 1 where id = any($1::uuid[])', [rows.map(r => r.id)])
      for (const pid of new Set(rows.map(r => r.projectId))) await publish(d, pid, { type: 'issue.created' })
      return bulkResult(rows.length)
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

  // ── Edit presence (soft lock, Jira/monday.com style: others can still edit, they just see who is here) ──
  app.post('/issues/:key/presence', { schema: {
    tags: TAG, summary: 'Heartbeat: I am editing this issue. Broadcasts `issue.editing` to the project stream; prunes stale rows.',
    params: keyP,
  } }, async req => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    await db.query(
      `insert into issue_editors (issue_id, user_id) values ($1, $2)
         on conflict (issue_id, user_id) do update set last_heartbeat = now()`, [i.id, req.me.id])
    await db.query('delete from issue_editors where last_heartbeat < now() - interval \'90 seconds\'')
    await publish(db, i.projectId, { type: 'issue.editing', key: i.key, editors: await editorsOf(db, i.id) })
    reply.code(204).send()
  })
  app.delete('/issues/:key/presence', { schema: { tags: TAG, summary: 'I stopped editing this issue (panel closed).', params: keyP } }, async (req, reply) => {
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    await db.query('delete from issue_editors where issue_id = $1 and user_id = $2', [i.id, req.me.id])
    await publish(db, i.projectId, { type: 'issue.editing', key: i.key, editors: await editorsOf(db, i.id) })
    reply.code(204).send()
  })

  // ── Comments (authors edit/delete their own) ──
  const body = z.object({ body: z.string().min(1).max(20000) })
  const commentCreate = body.extend({ id: uuid.optional().describe('Client-chosen id') })
  app.post('/issues/:key/comments', { schema: { tags: ['Comments & work logs'], summary: 'Add a comment (notifies watchers)', params: keyP, body: commentCreate } }, async req => {
    requireWrite(req)
    const b = req.body
    return tx(async d => {
      const i = await issueByKey(d, req.me.workspaceId, req.params.key)
      const [c] = await d.query('insert into comments (id, issue_id, author_id, body) values (coalesce($4::uuid, uuid_v7()), $1, $2, $3) returning *', [i.id, req.me.id, b.body, b.id ?? null])
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
    body: z.object({ id: uuid.optional().describe('Client-chosen id'), minutes: z.number().int().positive(), date, note: z.string().default('') }),
  } }, async req => {
    requireWrite(req)
    const b = req.body
    const i = await issueByKey(db, req.me.workspaceId, req.params.key)
    const [w] = await db.query('insert into worklogs (id, issue_id, user_id, minutes, date, note) values (coalesce($6::uuid, uuid_v7()), $1, $2, $3, $4, $5) returning *',
      [i.id, req.me.id, b.minutes, b.date, b.note, b.id ?? null])
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
