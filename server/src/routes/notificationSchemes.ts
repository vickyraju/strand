// Notification schemes (spec 0605), as Jira's: for each of Jira's events on a work item, who hears about it. Every project
// has a scheme (or None). Events reach here from emit() (webhooks.ts), the one place every change to a work item passes.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireJiraAdmin } from './globalPermissions.ts'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { projectByKey } from './projects.ts'

export const SCHEME_EVENTS = ['issue_created', 'issue_updated', 'issue_assigned', 'issue_resolved', 'issue_closed', 'issue_commented', 'issue_comment_edited',
  'issue_comment_deleted', 'issue_reopened', 'issue_deleted', 'issue_moved', 'issue_worklogged', 'issue_work_started', 'issue_work_stopped',
  'issue_worklog_updated', 'issue_worklog_deleted', 'issue_generic'] as const
export type SchemeEvent = typeof SCHEME_EVENTS[number]
const RECIPIENTS = ['current_assignee', 'reporter', 'current_user', 'project_lead', 'component_lead', 'user', 'group', 'project_role', 'all_watchers', 'user_field', 'group_field'] as const

/** Each event as a kind people choose Inbox and email for (Settings › Notifications), and what it says. */
const KIND: Partial<Record<SchemeEvent, string>> = {
  issue_assigned: 'assigned', issue_commented: 'commented', issue_comment_edited: 'commented', issue_comment_deleted: 'commented',
  issue_resolved: 'status', issue_reopened: 'status', issue_closed: 'status', issue_generic: 'status',
}
const TEXT: Record<SchemeEvent, string> = {
  issue_created: 'created a work item', issue_updated: 'updated a work item', issue_assigned: 'assigned a work item', issue_resolved: 'resolved a work item',
  issue_closed: 'closed a work item', issue_commented: 'commented on a work item', issue_comment_edited: 'edited a comment', issue_comment_deleted: 'deleted a comment',
  issue_reopened: 'reopened a work item', issue_deleted: 'deleted a work item', issue_moved: 'moved a work item', issue_worklogged: 'logged work',
  issue_work_started: 'started work', issue_work_stopped: 'stopped work', issue_worklog_updated: 'changed a work log', issue_worklog_deleted: 'deleted a work log',
  issue_generic: 'changed the status',
}

/** R3, R5: tell the recipients the item's project scheme gives this event: once each, not the actor, only active people who can
 *  see the item (a restricted comment: who may read it), and nobody when a bulk change was made without notifications. */
export async function notifyEvent(d: Db, event: SchemeEvent, issueId: string, actorId: string | null, o: { visibility?: { kind: string; id?: string; role?: string } | null; except?: string[] } = {}) {
  const [{ quiet }] = await d.query<{ quiet: boolean }>(`select coalesce(current_setting('strand.quiet', true), '') = 'on' as quiet`) as any
  if (quiet) return
  const v = o.visibility
  const [{ ws }] = await d.query<{ ws: string }>('select workspace_id as ws from issues where id = $1', [issueId]) as any
  const own = (await getSetting(ws, 'userDefaults')).notifyOwnChanges
  await d.query(
    `with i as (select i.*, p.lead_id, p.notification_scheme_id from issues i join projects p on p.id = i.project_id where i.id = $1),
          e as (select ne.* from notification_scheme_entries ne join i on ne.scheme_id = i.notification_scheme_id where ne.event = $2),
          ids(v) as (select i.custom -> e.value from i, e where e.recipient in ('user_field', 'group_field')),
          r(id) as (
            select i.assignee_id from i, e where e.recipient = 'current_assignee'
      union select i.reporter_id from i, e where e.recipient = 'reporter'
      union select $3::uuid from e where e.recipient = 'current_user'
      union select i.lead_id from i, e where e.recipient = 'project_lead'
      union select c.lead_id from i, e, components c where e.recipient = 'component_lead' and c.id = any(i.component_ids)
      union select u.id from e join users u on u.id::text = e.value where e.recipient = 'user'
      union select gm.user_id from e join group_members gm on gm.group_id::text = e.value where e.recipient = 'group'
      union select pa.user_id from i, e, project_access pa where e.recipient = 'project_role' and pa.project_id = i.project_id and pa.role = e.value
      union select w.user_id from i, e, issue_watchers w where e.recipient = 'all_watchers' and w.issue_id = i.id
      union select u.id from i, e, users u where e.recipient = 'user_field' and (i.custom -> e.value = to_jsonb(u.id::text) or i.custom -> e.value @> to_jsonb(array[u.id::text]))
      union select gm.user_id from i, e, group_members gm where e.recipient = 'group_field'
              and (i.custom -> e.value = to_jsonb(gm.group_id::text) or i.custom -> e.value @> to_jsonb(array[gm.group_id::text])))
     insert into notifications (user_id, actor_id, issue_id, kind, text)
     select distinct u.id, $3, $1, $4, case when $2 = 'issue_assigned' and u.id = i.assignee_id then 'assigned you a work item' else $5 end from r join users u on u.id = r.id, i
      where u.active and not (u.id = any($6::uuid[]))
        and (u.id is distinct from $3 or coalesce((select up.notify_own_changes from user_preferences up where up.user_id = u.id), $10))   -- My changes (spec 0606 R4)
        and (exists (select 1 from project_access pa where pa.project_id = i.project_id and pa.user_id = u.id) or is_system_admin(u.id))
        and issue_visible(i.security_level_id, i.reporter_id, i.assignee_id, i.project_id, u.id, is_system_admin(u.id))   -- its security level, as note() checks
        and ($7::text is null
          or $7 = 'group' and exists (select 1 from group_members gm where gm.group_id::text = $8 and gm.user_id = u.id)
          or $7 = 'role' and (exists (select 1 from project_access pa where pa.project_id = i.project_id and pa.user_id = u.id and pa.role = $9) or ($9 = 'admin' and is_system_admin(u.id))))`,
    [issueId, event, actorId, KIND[event] ?? 'updated', TEXT[event], o.except ?? [], v?.kind ?? null, v?.id ?? null, v?.role ?? null, own])
}

/** R5: a bulk change made without notifications: nothing this transaction does notifies (webhooks still go). */
export const withoutNotifications = (d: Db) => d.query(`select set_config('strand.quiet', 'on', true)`)

const uuid = z.string().uuid()
const idP = z.object({ id: uuid })
const entry = z.object({ event: z.enum(SCHEME_EVENTS), recipient: z.enum(RECIPIENTS), value: z.string().max(100).nullable().default(null)
  .describe('The person or group (id), the project role (admin, member, viewer) or the custom field (id); none for the others') })
const LIST = `select s.id, s.name, s.description, s.is_default,
    (select count(*)::int from projects p where p.notification_scheme_id = s.id and p.deleting_at is null) as projects
  from notification_schemes s`

const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Notification schemes']
  const scheme = async (d: Db, me: Me, id: string) => {
    const [s] = await d.query<any>(`${LIST} where s.id = $1 and s.workspace_id = $2`, [id, me.workspaceId])
    if (!s) throw new HttpError(404, 'Notification scheme not found')
    s.entries = await d.query(`select e.id, e.event, e.recipient, e.value, coalesce(u.name, g.display_name, f.name) as value_name from notification_scheme_entries e
        left join users u on e.recipient = 'user' and u.id::text = e.value left join groups g on e.recipient = 'group' and g.id::text = e.value
        left join custom_fields f on e.recipient in ('user_field', 'group_field') and f.id::text = e.value
       where e.scheme_id = $1 order by e.event, e.recipient, value_name`, [s.id])
    return s
  }
  const checkValue = async (d: Db, me: Me, b: z.infer<typeof entry>) => {
    const needs = ['user', 'group', 'project_role', 'user_field', 'group_field'].includes(b.recipient)
    if (!needs) { if (b.value) throw new HttpError(400, `${b.recipient} takes no value`, { value: 'Not used' }); return }
    const ok = !b.value ? false
      : b.recipient === 'project_role' ? ['admin', 'member', 'viewer'].includes(b.value)
      : !/^[0-9a-f-]{36}$/i.test(b.value) ? false
      : b.recipient === 'user' ? (await d.query('select 1 from memberships where user_id = $1 and workspace_id = $2', [b.value, me.workspaceId])).length > 0
      : b.recipient === 'group' ? (await d.query('select 1 from groups where id = $1', [b.value])).length > 0
      : (await d.query(`select 1 from custom_fields where id = $1 and workspace_id = $2 and kind in (${b.recipient === 'user_field' ? `'user', 'users'` : `'group', 'groups'`})`, [b.value, me.workspaceId])).length > 0
    if (!ok) throw new HttpError(400, `Choose a ${b.recipient.replace('_', ' ')} for this recipient`, { value: 'Unknown' })
  }

  app.get('/admin/notification-schemes', { schema: { tags: T, summary: 'Notification schemes, with how many projects use each (system administrators)' } }, async req => {
    await requireJiraAdmin(req)
    return db.query(`${LIST} where s.workspace_id = $1 order by s.is_default desc, lower(s.name)`, [req.me.workspaceId])
  })
  app.get('/admin/notification-schemes/:id', { schema: { tags: T, summary: 'A scheme and its events’ recipients', params: idP } }, async req => { await requireJiraAdmin(req); return scheme(db, req.me, req.params.id) })
  const head = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(2000).default('') })
  app.post('/admin/notification-schemes', { schema: { tags: T, summary: 'A new, empty scheme', body: head } }, async (req, reply) => {
    await requireJiraAdmin(req)
    const s = await tx(async d => {
      const [{ id }] = await d.query<{ id: string }>('insert into notification_schemes (workspace_id, name, description) values ($1, $2, $3) returning id', [req.me.workspaceId, req.body.name, req.body.description]) as any
      await audit(d, req, { action: 'notification_scheme.created', type: 'notification_scheme', id, name: req.body.name })
      return scheme(d, req.me, id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A scheme already has that name'); throw e })
    reply.code(201); return s
  })
  app.post('/admin/notification-schemes/:id/copy', { schema: { tags: T, summary: 'Copy a scheme with its recipients', params: idP, body: head.partial() } }, async (req, reply) => {
    await requireJiraAdmin(req)
    const s = await tx(async d => {
      const from = await scheme(d, req.me, req.params.id)
      const name = req.body.name ?? `Copy of ${from.name}`
      const [{ id }] = await d.query<{ id: string }>('insert into notification_schemes (workspace_id, name, description) values ($1, $2, $3) returning id', [req.me.workspaceId, name, req.body.description ?? from.description]) as any
      await d.query('insert into notification_scheme_entries (scheme_id, event, recipient, value) select $2, event, recipient, value from notification_scheme_entries where scheme_id = $1', [from.id, id])
      await audit(d, req, { action: 'notification_scheme.created', type: 'notification_scheme', id, name, after: { copiedFrom: from.id } })
      return scheme(d, req.me, id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A scheme already has that name'); throw e })
    reply.code(201); return s
  })
  app.patch('/admin/notification-schemes/:id', { schema: { tags: T, summary: 'Rename a scheme, or make it the default for new projects', params: idP, body: head.extend({ isDefault: z.literal(true) }).partial() } }, async req => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const s = await scheme(d, req.me, req.params.id)
      if (req.body.isDefault) await d.query('update notification_schemes set is_default = false where workspace_id = $1 and is_default', [req.me.workspaceId])
      await d.query('update notification_schemes set name = coalesce($2, name), description = coalesce($3, description), is_default = is_default or coalesce($4, false) where id = $1',
        [s.id, req.body.name ?? null, req.body.description ?? null, req.body.isDefault ?? null])
      await audit(d, req, { action: 'notification_scheme.updated', type: 'notification_scheme', id: s.id, name: s.name, before: { name: s.name, isDefault: s.isDefault }, after: req.body })
      return scheme(d, req.me, s.id)
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'A scheme already has that name'); throw e })
  })
  app.delete('/admin/notification-schemes/:id', { schema: { tags: T, summary: 'Delete a scheme no project uses (not the default)', params: idP } }, async (req, reply) => {
    await requireJiraAdmin(req)
    await tx(async d => {
      const s = await scheme(d, req.me, req.params.id)
      if (s.isDefault) throw new HttpError(409, 'The default scheme can’t be deleted: make another the default first')
      if ((await d.query('select 1 from projects where notification_scheme_id = $1 limit 1', [s.id])).length) throw new HttpError(409, `${s.projects} project${s.projects === 1 ? ' uses' : 's use'} this scheme: give ${s.projects === 1 ? 'it' : 'them'} another first`)
      await d.query('delete from notification_schemes where id = $1', [s.id])
      await audit(d, req, { action: 'notification_scheme.deleted', type: 'notification_scheme', id: s.id, name: s.name })
    })
    reply.code(204).send()
  })
  app.post('/admin/notification-schemes/:id/entries', { schema: { tags: T, summary: 'Add a recipient to an event', params: idP, body: entry } }, async (req, reply) => {
    await requireJiraAdmin(req)
    const s = await tx(async d => {
      const s = await scheme(d, req.me, req.params.id)
      await checkValue(d, req.me, req.body)
      await d.query('insert into notification_scheme_entries (scheme_id, event, recipient, value) values ($1, $2, $3, $4) on conflict do nothing', [s.id, req.body.event, req.body.recipient, req.body.value])
      await audit(d, req, { action: 'notification_scheme.updated', type: 'notification_scheme', id: s.id, name: s.name, after: { added: req.body } })
      return scheme(d, req.me, s.id)
    })
    reply.code(201); return s
  })
  app.delete('/admin/notification-schemes/:id/entries/:entryId', { schema: { tags: T, summary: 'Remove a recipient from an event', params: idP.extend({ entryId: uuid }) } }, async req => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const s = await scheme(d, req.me, req.params.id)
      const [gone] = await d.query('delete from notification_scheme_entries where id = $1 and scheme_id = $2 returning event, recipient, value', [req.params.entryId, s.id])
      if (!gone) throw new HttpError(404, 'Not in this scheme')
      await audit(d, req, { action: 'notification_scheme.updated', type: 'notification_scheme', id: s.id, name: s.name, before: { removed: gone } })
      return scheme(d, req.me, s.id)
    })
  })

  // R2: a project's scheme (project admins see it; system administrators change it)
  const keyP = z.object({ key: z.string() })
  const ofProject = async (d: Db, projectId: string) =>
    (await d.query<any>('select s.id, s.name from projects p left join notification_schemes s on s.id = p.notification_scheme_id where p.id = $1', [projectId]))[0]
  app.get('/projects/:key/notification-scheme', { schema: { tags: T, summary: 'The project’s notification scheme (null: None)', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key, 'administer')
    const s = await ofProject(db, p.id)
    return { scheme: s?.id ? { id: s.id, name: s.name } : null }
  })
  app.put('/projects/:key/notification-scheme', { schema: { tags: T, summary: 'Give the project a notification scheme, or None (system administrators)', params: keyP,
    body: z.object({ schemeId: uuid.nullable() }) } }, async req => {
    await requireJiraAdmin(req)
    return tx(async d => {
      const p = await projectByKey(d, req, req.params.key, 'administer')
      if (req.body.schemeId && !(await d.query('select 1 from notification_schemes where id = $1 and workspace_id = $2', [req.body.schemeId, req.me.workspaceId])).length)
        throw new HttpError(400, 'No such notification scheme', { schemeId: 'Unknown scheme' })
      const before = await ofProject(d, p.id)
      await d.query('update projects set notification_scheme_id = $2 where id = $1', [p.id, req.body.schemeId])
      await audit(d, req, { action: 'project.notification_scheme_changed', type: 'project', id: p.id, name: p.key, project: { id: p.id, key: p.key }, before: { schemeId: before?.id ?? null }, after: { schemeId: req.body.schemeId } })
      const s = await ofProject(d, p.id)
      return { scheme: s?.id ? { id: s.id, name: s.name } : null }
    })
  })
}
export default plugin
