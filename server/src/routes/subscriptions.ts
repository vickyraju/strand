// Filter subscriptions (spec 0604), as Jira's: a saved view emailed on a schedule (Quartz cron, as Jira stores them) to its
// creator, or to each member of a group who can see the view, each getting what they may see. A run queues one email job
// per recipient, so a large group never makes one long job.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { needGlobal } from './globalPermissions.ts'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { enqueue, registerJob } from '../jobs.ts'
import { getSetting } from '../settings.ts'
import { CronError, nextRun, parseCron } from '../shared/cron.ts'
import { sendEmail } from '../email.ts'
import { searchWhere, viewSeenBy } from './misc.ts'

const uuid = z.string().uuid()
const ROW = `select s.id, s.view_id, s.created_by, cu.name as created_by_name, s.group_id, g.display_name as group_name, s.cron, s.email_when_empty, s.only_when_changed,
    s.next_run_at, s.last_run_at, s.created_at
  from filter_subscriptions s join users cu on cu.id = s.created_by left join groups g on g.id = s.group_id`

/** A cron that runs: 400 with Jira's reason otherwise. */
function checkCron(cron: string) {
  try { parseCron(cron) } catch (e) { if (e instanceof CronError) throw new HttpError(400, `Schedule: ${e.message}`, { cron: e.message }); throw e }
  if (!nextRun(cron, new Date())) throw new HttpError(400, 'Schedule: it never runs', { cron: 'Never runs' })
}

/** Queue the next run (an edit queues a new one; the old one finds the time changed and does nothing). */
async function schedule(d: Db, id: string) {
  const [s] = await d.query<{ cron: string; workspaceId: string }>('select cron, workspace_id from filter_subscriptions where id = $1', [id])
  const next = s && nextRun(s.cron, new Date())
  if (!s || !next) return
  await d.query('update filter_subscriptions set next_run_at = $2 where id = $1', [id, next])
  await enqueue(d, 'filter-subscription.run', { id, at: next.toISOString() }, { workspaceId: s.workspaceId, runAt: next, dedupeKey: `filter-subscription:${id}:${next.toISOString()}` })
}

/** At start-up: every subscription without a queued run gets one (a lost job never stops a schedule for good). */
export async function startSubscriptions() {
  const lost = await db.query<{ id: string }>(`select s.id from filter_subscriptions s where not exists (select 1 from jobs j
      where j.dedupe_key like 'filter-subscription:' || s.id || ':%' and j.status in ('queued', 'running'))`)
  for (const s of lost) await tx(d => schedule(d, s.id))
}

/** R3: who gets this run, once each: the creator, or a group's active members who can see the view. */
registerJob('filter-subscription.run', async (p: { id: string; at?: string; now?: boolean }) => {
  const [s] = await db.query<any>(`select s.*, u.active as creator_active, (s.next_run_at = $2::timestamptz) as due from filter_subscriptions s join users u on u.id = s.created_by where s.id = $1`, [p.id, p.at ?? null])
  if (!s || (!p.now && !s.due)) return { skipped: 'changed or gone' }
  let sent = 0
  if (s.creatorActive) {
    const people = s.groupId
      ? await db.query<{ id: string }>('select gm.user_id as id from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1 and u.active', [s.groupId])
      : [{ id: s.createdBy as string }]
    for (const u of people) {
      await enqueue(db, 'email.filter-subscription', { id: s.id, userId: u.id }, { workspaceId: s.workspaceId, dedupeKey: `filter-subscription:${s.id}:${p.at ?? 'now'}:${u.id}` })
      sent++
    }
  }
  await tx(async d => {
    await d.query('update filter_subscriptions set last_run_at = now() where id = $1', [s.id])
    if (!p.now) await schedule(d, s.id)
  })
  return { recipients: sent }
})

const esc = (x: string) => x.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** R4: one recipient's email: the view as they see it, the first items in its order. */
registerJob('email.filter-subscription', async (p: { id: string; userId: string }, job) => {
  const [s] = await db.query<any>('select s.*, v.name as view_name, v.filters from filter_subscriptions s join saved_views v on v.id = s.view_id where s.id = $1', [p.id])
  const [u] = await db.query<any>(`select u.id, u.email, u.name, u.active, m.workspace_id, m.role, is_system_admin(u.id) as admin
      from users u join memberships m on m.user_id = u.id where u.id = $1 and m.workspace_id = $2`, [p.userId, job.workspaceId])
  if (!s || !u?.active) return { skipped: 'the subscription or the person is gone' }
  const me = { id: u.id, email: u.email, name: u.name, workspaceId: u.workspaceId, role: u.role, admin: u.admin, via: 'entra' } as Me
  if (!(await viewSeenBy(db, me, s.viewId))) return { skipped: 'they can’t see the view' }
  const mail = await getSetting(job.workspaceId!, 'email')
  if (!mail.enabled || !mail.from) return { skipped: 'email is off' }
  const { maxItems } = await getSetting(job.workspaceId!, 'filterSubscriptions')
  const f = s.filters ?? {}
  const args: unknown[] = []
  const { where, order } = await searchWhere(me, {
    q: f.q ?? '', project: f.projectId, assignee: f.assignee == null ? undefined : f.assignee === '' ? 'none' : f.assignee,
    type: f.type, priority: f.priority, label: f.label, resolution: f.resolution ?? 'open', jql: f.jql,
  }, args)
  const [{ total }] = await db.query<{ total: number }>(`select count(*)::int as total from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where ${where.join(' and ')}`, args) as any
  if (!total && !s.emailWhenEmpty) return { skipped: 'no work items' }
  // R7: only when this person's results changed since their last email (which items, and when each last changed)
  let fingerprint: string | null = null
  if (s.onlyWhenChanged) {
    ;[{ fingerprint }] = await db.query<{ fingerprint: string }>(`select md5(coalesce(string_agg(i.id::text || ':' || i.updated_at::text, ',' order by i.id), '')) as fingerprint
      from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where ${where.join(' and ')}`, args) as [{ fingerprint: string }]
    const [last] = await db.query<{ fingerprint: string }>('select fingerprint from filter_subscription_sent where subscription_id = $1 and user_id = $2', [s.id, u.id])
    if (last?.fingerprint === fingerprint) return { skipped: 'unchanged since the last email' }
  }
  args.push(maxItems)
  const rows = await db.query<{ key: string; title: string; status: string; assignee: string | null; priority: string | null }>(
    `select p.key || '-' || i.number as key, i.title, st.name as status, a.name as assignee,
            coalesce((select pr.name from priorities pr where pr.workspace_id = i.workspace_id and pr.key = i.priority), i.priority) as priority
       from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id left join users a on a.id = i.assignee_id
      where ${where.join(' and ')} order by ${order ? `${order}, i.id` : 'i.updated_at desc, i.id desc'} limit $${args.length}`, args)
  const base = mail.appUrl ? mail.appUrl.replace(/\/$/, '') : ''
  const more = total - rows.length
  const head = `${total.toLocaleString('en')} work item${total === 1 ? '' : 's'} in “${s.viewName}”`
  const footer = 'You get this because of a subscription to this view in Strand. Its creator, or a system administrator, can change or remove it.'
  await sendEmail({
    to: u.email, from: mail.from, subject: `[Strand] Subscription: ${s.viewName}`.slice(0, 200),
    text: [head, '', ...rows.map(r => `${r.key}  ${r.title}  [${r.status}]  ${r.assignee ?? 'Unassigned'}  ${r.priority ?? ''}`), ...(more > 0 ? [`… and ${more.toLocaleString('en')} more`] : []),
      ...(base ? ['', `${base}/search?view=${s.viewId}`] : []), '', footer].join('\n'),
    html: `<p>${esc(head)}</p><table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr style="text-align:left;color:#78716c"><th>Key</th><th>Summary</th><th>Status</th><th>Assignee</th><th>Priority</th></tr>`
      + rows.map(r => `<tr><td>${base ? `<a href="${esc(`${base}/i/${r.key}`)}">${esc(r.key)}</a>` : esc(r.key)}</td><td>${esc(r.title)}</td><td>${esc(r.status)}</td><td>${esc(r.assignee ?? 'Unassigned')}</td><td>${esc(r.priority ?? '')}</td></tr>`).join('')
      + `</table>${more > 0 ? `<p>… and ${more.toLocaleString('en')} more${base ? ` in <a href="${esc(`${base}/search?view=${s.viewId}`)}">the view</a>` : ''}</p>` : ''}<p style="color:#78716c;font-size:12px">${esc(footer)}</p>`,
  })
  if (fingerprint !== null) await db.query(`insert into filter_subscription_sent (subscription_id, user_id, fingerprint) values ($1, $2, $3)
    on conflict (subscription_id, user_id) do update set fingerprint = excluded.fingerprint, sent_at = now()`, [s.id, u.id, fingerprint])
  return { sent: u.email, items: rows.length }
})

const idP = z.object({ id: uuid })
const body = z.object({
  groupId: uuid.nullable().default(null).describe('A group: each member who can see the view gets it (null: just you)'),
  cron: z.string().trim().min(1).max(200).describe('Quartz cron, as Jira stores schedules: seconds minutes hours day-of-month month day-of-week [year]'),
  emailWhenEmpty: z.boolean().default(false).describe('Email even when nothing matches'),
  onlyWhenChanged: z.boolean().default(false).describe('Email each person only when their results changed since their last email (spec 0604 R7)'),
})

const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Saved views']
  /** R1: the subscription, if mine (or I'm a system administrator); 404 otherwise. */
  const mine = async (d: Db, me: Me, id: string) => {
    const [s] = await d.query<any>(`${ROW} where s.id = $1 and s.workspace_id = $2 and (s.created_by = $3 or $4)`, [id, me.workspaceId, me.id, me.admin])
    if (!s) throw new HttpError(404, 'Subscription not found')
    return s
  }
  const checkGroup = async (d: Db, me: Me, groupId: string | null) => {
    if (!groupId) return
    await needGlobal(me, 'group-subscriptions', d)                          // Jira's Manage group filter subscriptions (spec 0717)
    if (!(await d.query('select 1 from groups where id = $1', [groupId])).length) throw new HttpError(400, 'No such group', { groupId: 'Unknown group' })
  }
  const seen = async (d: Db, me: Me, viewId: string) => { if (!(await viewSeenBy(d, me, viewId))) throw new HttpError(404, 'View not found') }

  app.get('/views/:id/subscriptions', { schema: { tags: T, summary: 'A view’s subscriptions: yours (system administrators: everyone’s)', params: idP } }, async req => {
    await seen(db, req.me, req.params.id)
    return db.query(`${ROW} where s.view_id = $1 and (s.created_by = $2 or $3) order by s.created_at`, [req.params.id, req.me.id, req.me.admin])
  })
  app.post('/views/:id/subscriptions', { schema: { tags: T, summary: 'Subscribe yourself or a group to a view', params: idP, body } }, async (req, reply) => {
    const b = req.body
    checkCron(b.cron)
    const row = await tx(async d => {
      await seen(d, req.me, req.params.id)
      await checkGroup(d, req.me, b.groupId)
      const [s] = await d.query<{ id: string }>('insert into filter_subscriptions (workspace_id, view_id, created_by, group_id, cron, email_when_empty, only_when_changed) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [req.me.workspaceId, req.params.id, req.me.id, b.groupId, b.cron, b.emailWhenEmpty, b.onlyWhenChanged])
      await schedule(d, s!.id)
      if (b.groupId) await audit(d, req, { action: 'subscription.group_added', type: 'view', id: req.params.id, after: { groupId: b.groupId, cron: b.cron } })
      return mine(d, req.me, s!.id)
    })
    reply.code(201)
    return row
  })
  app.patch('/subscriptions/:id', { schema: { tags: T, summary: 'Change a subscription (its creator or a system administrator)', params: idP, body: body.partial() } }, async req => {
    const b = req.body
    if (b.cron) checkCron(b.cron)
    return tx(async d => {
      const s = await mine(d, req.me, req.params.id)
      if (b.groupId !== undefined && b.groupId !== s.groupId) await checkGroup(d, req.me, b.groupId)
      await d.query('update filter_subscriptions set group_id = $2, cron = $3, email_when_empty = $4, only_when_changed = $5 where id = $1',
        [s.id, b.groupId === undefined ? s.groupId : b.groupId, b.cron ?? s.cron, b.emailWhenEmpty ?? s.emailWhenEmpty, b.onlyWhenChanged ?? s.onlyWhenChanged])
      await schedule(d, s.id)
      if (s.createdBy !== req.me.id || (b.groupId && b.groupId !== s.groupId))
        await audit(d, req, { action: 'subscription.changed', type: 'view', id: s.viewId, before: { createdBy: s.createdBy, groupId: s.groupId, cron: s.cron }, after: b })
      return mine(d, req.me, s.id)
    })
  })
  app.delete('/subscriptions/:id', { schema: { tags: T, summary: 'Remove a subscription (its creator or a system administrator)', params: idP } }, async (req, reply) => {
    await tx(async d => {
      const s = await mine(d, req.me, req.params.id)
      await d.query('delete from filter_subscriptions where id = $1', [s.id])
      if (s.createdBy !== req.me.id) await audit(d, req, { action: 'subscription.deleted', type: 'view', id: s.viewId, before: { createdBy: s.createdBy, groupId: s.groupId, cron: s.cron } })
    })
    reply.code(204).send()
  })
  app.post('/subscriptions/:id/run', { schema: { tags: T, summary: 'Run now: send it straight away (the schedule carries on)', params: idP } }, async (req, reply) => {
    const jobId = await tx(async d => {
      const s = await mine(d, req.me, req.params.id)
      return enqueue(d, 'filter-subscription.run', { id: s.id, now: true }, { workspaceId: req.me.workspaceId, createdBy: req.me.id })
    })
    reply.code(202)
    return { jobId }
  })
}
export default plugin
