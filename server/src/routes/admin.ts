import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { keyFits } from '../shared/projectKeys.ts'
import { z } from 'zod'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db, tx, type Db } from '../db.ts'
import { HttpError, requireAdmin, type Me } from '../auth.ts'
import { audit, changes } from '../audit.ts'
import { priorities, resolutions } from '../lists.ts'
import { enqueue, kickJobs, registerJob } from '../jobs.ts'
import { allowedBackupBuckets, backupBucket, backupSettings } from '../backups.ts'
import { s3 } from '../storage.ts'
import { SETTINGS, getSetting, isSettingKey, setSetting, type SettingKey } from '../settings.ts'
import { previewSummary, runCleanup, scheduleCleanup, seats } from '../licenseCleanup.ts'

const idP = z.object({ id: z.string().uuid() })

const peopleQ = z.object({
  query: z.string().max(100).optional().describe('In the name or email'),
  status: z.enum(['all', 'active', 'deactivated']).default('all'),
  inactive: z.string().regex(/^(\d{1,4}|never)$/).optional().describe('Days without using Strand, or "never"'),
  group: z.string().uuid().optional().describe('Only members of this group'),
  notInGroup: z.string().uuid().optional().describe('Only people outside this group'),
})
/** The people a filter matches, as SQL over `users u` (args start with the workspace). */
const peopleWhere = (f: z.infer<typeof peopleQ>, args: unknown[]) => {
  const where = ['m.workspace_id = $1']
  if (f.query) { args.push(`%${f.query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(u.name ilike $${args.length} or u.email ilike $${args.length})`) }
  if (f.status !== 'all') where.push(f.status === 'active' ? 'u.active' : 'not u.active')
  if (f.inactive === 'never') where.push('u.last_active_at is null')
  else if (f.inactive) { args.push(Number(f.inactive)); where.push(`coalesce(u.last_active_at, u.created_at) < now() - make_interval(days => $${args.length})`) }
  if (f.group) { args.push(f.group); where.push(`exists (select 1 from group_members gm where gm.user_id = u.id and gm.group_id = $${args.length})`) }
  if (f.notInGroup) { args.push(f.notInGroup); where.push(`not exists (select 1 from group_members gm where gm.user_id = u.id and gm.group_id = $${args.length})`) }
  return where.join(' and ')
}

// Everyone a filter matched, a batch at a time, each batch in its own transaction (so a refused batch doesn't undo the
// others); the progress is kept on the job.
registerJob('users.bulk', async (payload, job) => {
  const ws = payload.actor.workspaceId as string, who = { me: payload.actor as Me, ip: payload.ip ?? undefined }
  const g = await checkGroup(db, payload.groupId ?? undefined)
  let after: [string, string] | null = null, done = 0, changed = 0
  let stopped: string | null = null
  for (;;) {
    const args: unknown[] = [ws]
    const where = peopleWhere(payload.filter, args)
    if (after) { args.push(after[0], after[1]) }
    const page: { id: string; email: string; name: string }[] = await db.query<{ id: string; email: string; name: string }>(
      `select u.id, u.email, u.name from memberships m join users u on u.id = m.user_id where ${where}${after ? ` and (lower(u.name), u.id) > ($${args.length - 1}, $${args.length}::uuid)` : ''}
        order by lower(u.name), u.id limit 200`, args)
    if (!page.length) break
    try { changed += await tx(d => bulkChange(d, who, page, payload.action, g)) }
    catch (e) { stopped = String((e as Error).message); break }
    done += page.length; after = [page.at(-1)!.name.toLowerCase(), page.at(-1)!.id]
    await db.query(`update jobs set progress = jsonb_set(coalesce(progress, '{}'), '{done}', to_jsonb($2::int)), locked_until = now() + interval '5 minutes' where id = $1`, [job.id, done])
  }
  return { changed, unchanged: done - changed, stopped }
})

/** The group a bulk change names (not one the directory manages). */
async function checkGroup(d: Db, groupId?: string) {
  if (!groupId) return null
  const [g] = await d.query<{ id: string; displayName: string; systemRole: string | null; source: string }>('select id, display_name, system_role, source from groups where id = $1', [groupId])
  if (!g) throw new HttpError(400, 'No such group', { groupId: 'Unknown group' })
  if (g.source === 'directory') throw new HttpError(400, `${g.displayName} comes from the directory (Entra): change it there`)
  return g
}

/** One bulk change to these people, audited per person; never leaves Strand without an active system administrator. */
async function bulkChange(d: Db, who: { me: Me; ip?: string }, people: { id: string; email: string }[], action: 'deactivate' | 'reactivate' | 'add-to-group' | 'remove-from-group', g: { id: string; displayName: string } | null) {
  let changed = 0
  for (const p of people) {
    let did = 0
    if (action === 'deactivate') {
      if (p.id === who.me.id) continue                                    // never yourself
      did = (await d.query('update users set active = false where id = $1 and active returning 1', [p.id])).length
    } else if (action === 'reactivate') did = (await d.query('update users set active = true, cleanup_warned_at = null where id = $1 and not active returning 1', [p.id])).length
    else if (action === 'add-to-group') did = (await d.query('insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing returning 1', [g!.id, p.id])).length
    else did = (await d.query('delete from group_members where group_id = $1 and user_id = $2 returning 1', [g!.id, p.id])).length
    if (did) { changed++; await audit(d, who, { action: `user.bulk.${action}`, type: 'user', id: p.id, name: p.email, after: g ? { group: g.displayName } : undefined }) }
  }
  const [{ n }] = await d.query<{ n: number }>(`select count(*)::int as n from group_members gm join groups g on g.id = gm.group_id join users u on u.id = gm.user_id where g.system_role = 'system-admins' and u.active`) as any
  if (!n) throw new HttpError(409, 'Strand needs at least one active system administrator')
  return changed
}
const TAG = ['Admin']

const plugin: FastifyPluginAsyncZod = async app => {
  // ── People in the workspace (system administrators). Accounts and admin rights come from Entra (sign-in and SCIM), so
  // this is a view with bulk changes, not an editor. Tens of thousands of people: searched, filtered and paged here ──
  const PERSON = `u.id, u.name, u.email, u.initials, u.color, u.title, u.active, case when m.role = 'owner' then 'owner' when is_system_admin(u.id) then 'admin' else 'member' end as role, u.created_at,
              u.last_active_at, u.last_sign_in_at,
              coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.display_name) order by g.system_role is null, lower(g.display_name))
                          from group_members gm join groups g on g.id = gm.group_id where gm.user_id = u.id), '[]') as groups,
              (select count(*)::int from project_access pm join projects p on p.id = pm.project_id
                where pm.user_id = u.id and p.workspace_id = $1 and p.deleting_at is null) as projects`
  app.get('/admin/users', { schema: { tags: TAG, summary: 'People in the workspace, by name, a page at a time, with role, status, last activity, groups and how many projects they are in; filtered (system administrators)',
    querystring: peopleQ.extend({ cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async req => {
    requireAdmin(req)
    const args: unknown[] = [req.me.workspaceId]
    const where = peopleWhere(req.query, args)
    const [{ total }] = await db.query<{ total: number }>(`select count(*)::int as total from memberships m join users u on u.id = m.user_id where ${where}`, [...args]) as any
    let keyset = ''
    if (req.query.cursor) {
      let c: [string, string]
      try { c = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString()) } catch { throw new HttpError(400, 'Invalid cursor') }
      args.push(c[0], c[1]); keyset = ` and (lower(u.name), u.id) > ($${args.length - 1}, $${args.length}::uuid)`
    }
    args.push(req.query.limit + 1)
    const rows = await db.query<any>(`select ${PERSON} from memberships m join users u on u.id = m.user_id where ${where}${keyset} order by lower(u.name), u.id limit $${args.length}`, args)
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, total, next: more ? Buffer.from(JSON.stringify([items.at(-1).name.toLowerCase(), items.at(-1).id])).toString('base64url') : null }
  })

  // People in bulk (resolution's User Deactivator): deactivate, reactivate, add to or take out of a group. Chosen people
  // (up to 1000) change at once; "everyone matching a filter" (any number) changes in the background.
  const bulkAction = z.enum(['deactivate', 'reactivate', 'add-to-group', 'remove-from-group'])
  app.post('/admin/users/bulk', { schema: { tags: TAG, summary: 'Change many people at once (system administrators): deactivate, reactivate, add to a group, remove from a group. Either `userIds`, or `filter` for everyone it matches (then a background job: 202 with its id)', body: z.object({
    userIds: z.array(z.string().uuid()).min(1).max(1000).optional(), filter: peopleQ.optional(), action: bulkAction, groupId: z.string().uuid().optional(),
  }) } }, async (req, reply) => {
    requireAdmin(req)
    const b = req.body
    if (!b.userIds === !b.filter) throw new HttpError(400, 'Send either userIds or filter', { userIds: 'Choose people, or a filter' })
    if ((b.action === 'add-to-group' || b.action === 'remove-from-group') && !b.groupId) throw new HttpError(400, 'Choose the group', { groupId: 'Required' })
    if (b.filter) {
      await checkGroup(db, b.groupId)
      const args: unknown[] = [req.me.workspaceId]
      const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from memberships m join users u on u.id = m.user_id where ${peopleWhere(b.filter, args)}`, args) as any
      const jobId = await tx(d => enqueue(d, 'users.bulk', { filter: b.filter, action: b.action, groupId: b.groupId ?? null, actor: { id: req.me.id, email: req.me.email, workspaceId: req.me.workspaceId }, ip: req.ip },
        { workspaceId: req.me.workspaceId, createdBy: req.me.id, maxAttempts: 3 }))
      await db.query('update jobs set progress = $2 where id = $1', [jobId, JSON.stringify({ total: n, done: 0 })])
      kickJobs(app.log)
      reply.code(202)
      return { jobId, matched: n }
    }
    return tx(async d => {
      const people = await d.query<{ id: string; email: string; active: boolean }>(
        'select u.id, u.email, u.active from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.id = any($2::uuid[])', [req.me.workspaceId, b.userIds])
      if (people.length !== new Set(b.userIds).size) throw new HttpError(400, 'Everyone must be in this workspace', { userIds: 'Unknown people' })
      if (b.action === 'deactivate' && b.userIds!.includes(req.me.id)) throw new HttpError(400, 'You can’t deactivate yourself')
      const g = await checkGroup(d, b.groupId)
      const changed = await bulkChange(d, { me: req.me, ip: req.ip }, people, b.action, g)
      return { changed, unchanged: people.length - changed }
    })
  })

  app.get('/admin/users/refused-sign-ins', { schema: { tags: TAG, summary: 'Deactivated people who tried to sign in, newest first (system administrators)' } }, async req => {
    requireAdmin(req)
    return db.query(`select a.at, a.target_id as user_id, a.target as email, a.ip, u.name, u.active from audit_log a left join users u on u.id::text = a.target_id
                      where a.action = 'auth.refused_deactivated' and a.workspace_id = $1 order by a.at desc limit 100`, [req.me.workspaceId])
  })

  // ── License cleanup (resolution's License Optimizer and automatic deactivation): seats, a preview, run now, history ──
  app.get('/admin/license-cleanup', { schema: { tags: TAG, summary: 'Seats (people in users-access, and how recently they were active) and the latest cleanup runs (system administrators)' } }, async req => {
    requireAdmin(req)
    return {
      seats: await seats(db, req.me.workspaceId),
      // counts only: who a run changed is read when the run is opened (GET /admin/license-cleanup/runs/:id)
      runs: await db.query(`select r.id, r.trigger, r.action, r.started_at, r.finished_at, jsonb_array_length(r.changed) as changed_count, jsonb_array_length(r.warned) as warned_count,
                                   r.notes, u.name as started_by from license_cleanup_runs r left join users u on u.id = r.started_by
                             where r.workspace_id = $1 order by r.started_at desc limit 50`, [req.me.workspaceId]),
    }
  })
  app.get('/admin/license-cleanup/runs/:id', { schema: { tags: TAG, summary: 'Who one cleanup run changed and warned (system administrators)', params: idP } }, async req => {
    requireAdmin(req)
    const [r] = await db.query(`select r.id, r.changed, r.warned from license_cleanup_runs r where r.id = $1 and r.workspace_id = $2`, [req.params.id, req.me.workspaceId])
    if (!r) throw new HttpError(404, 'No such run')
    return r
  })
  app.post('/admin/license-cleanup/preview', { schema: { tags: TAG, summary: 'Who the cleanup would change and warn now, with the saved rule or one you send (nothing changes; system administrators)', body: z.object({ rule: z.record(z.string(), z.unknown()).optional() }) } }, async req => {
    requireAdmin(req)
    let rule = await getSetting(req.me.workspaceId, 'licenseCleanup')
    if (req.body.rule) {
      const parsed = SETTINGS.licenseCleanup.schema.safeParse({ ...rule, ...req.body.rule })
      if (!parsed.success) throw new HttpError(400, 'That rule is not valid', Object.fromEntries(parsed.error.issues.map(i => [i.path.join('.') || 'rule', i.message])))
      rule = parsed.data
    }
    return previewSummary(db, req.me.workspaceId, rule)
  })
  app.post('/admin/license-cleanup/run', { schema: { tags: TAG, summary: 'Run the cleanup now with the saved rule, even if the daily run is off (system administrators)' } }, async req => {
    requireAdmin(req)
    return runCleanup(req.me.workspaceId, 'manual', req)
  })

  // ── System settings: policies a workspace admin controls (rate limiting, attachments, tokens, export and bulk sizes, due reminders) ──
  const keyP = z.object({ key: z.string().describe(`One of: ${Object.keys(SETTINGS).filter(k => !('ownRoutes' in SETTINGS[k as SettingKey])).join(', ')}`) })
  const view = async (ws: string, key: SettingKey) => {
    const s = SETTINGS[key]
    return { key, label: s.label, description: s.description, value: await getSetting(ws, key), default: s.default }
  }
  app.get('/admin/settings', { schema: { tags: TAG, summary: 'Every system setting with its current value and default (global admins)' } }, async req => {
    requireAdmin(req)
    return Promise.all((Object.keys(SETTINGS) as SettingKey[]).filter(k => !('ownRoutes' in SETTINGS[k])).map(k => view(req.me.workspaceId, k)))
  })
  app.put('/admin/settings/:key', { schema: {
    tags: TAG, summary: 'Change one system setting (global admins). Send the whole value; it is checked against the setting\'s rules', params: keyP, body: z.record(z.string(), z.unknown()),
  } }, async req => {
    requireAdmin(req)
    const key = req.params.key
    if (!isSettingKey(key) || 'ownRoutes' in SETTINGS[key]) throw new HttpError(404, 'No such setting')
    const parsed = SETTINGS[key].schema.safeParse(req.body)
    if (!parsed.success) throw new HttpError(400, 'That setting is not valid',
      Object.fromEntries(parsed.error.issues.map(i => [i.path.join('.') || 'value', i.message])))
    // License cleanup takes people out of groups made in Strand only: the directory decides who is in its groups (spec 0104 R7)
    if (key === 'licenseCleanup') {
      const ids = (parsed.data as { groupIds: string[] }).groupIds
      const dir = ids.length ? await db.query<{ displayName: string }>(`select display_name from groups where id = any($1::uuid[]) and source = 'directory'`, [ids]) : []
      if (dir.length) throw new HttpError(400, `${dir.map(g => g.displayName).join(', ')} ${dir.length === 1 ? 'comes' : 'come'} from the directory (Entra): only it changes who is in ${dir.length === 1 ? 'it' : 'them'}`, { groupIds: 'A directory group' })
    }
    // Jira: a new key pattern must still fit every existing key (spec 0308 R3)
    if (key === 'projectKeys') {
      const { pattern, maxLength } = parsed.data as { pattern: string; maxLength: number }
      const misfits = (await db.query<{ key: string }>('select key from projects where workspace_id = $1 order by key', [req.me.workspaceId])).map(p => p.key)
        .filter(k => !keyFits(k, { pattern, maxLength }))
      if (misfits.length) throw new HttpError(400, `Existing projects would not fit: ${misfits.slice(0, 10).join(', ')}${misfits.length > 10 ? ` and ${misfits.length - 10} more` : ''}`, { pattern: 'Existing keys don’t fit' })
    }
    await tx(async d => {
      const before = await getSetting(req.me.workspaceId, key, d)
      await setSetting(d, req.me.workspaceId, key, parsed.data, req.me.id)
      const c = changes(before as any, parsed.data as any)
      if (c.changed) await audit(d, req, { action: `settings.${key}.updated`, type: 'settings', name: SETTINGS[key].label, before: c.before, after: c.after })
      if (key === 'licenseCleanup' && (parsed.data as any).enabled) await scheduleCleanup(d, req.me.workspaceId)   // the next daily run
    })
    return view(req.me.workspaceId, key)
  })
  // ── Link types (Jira's issue linking): everyone reads them; workspace admins add, rename and remove them ──
  // How many links of each type: only the administration page needs it, so everyone else gets the list without counting
  const LINK = (count: boolean) => `select id, name, outward, inward, builtin, position, ${count ? '(select count(*)::int from issue_links l join issues i on i.id = l.issue_id where l.type = t.id and i.workspace_id = t.workspace_id)' : 'null::int'} as uses from link_types t`
  const linkBody = z.object({ name: z.string().trim().min(1).max(60), outward: z.string().trim().min(1).max(60), inward: z.string().trim().min(1).max(60) })
  const linkP = z.object({ id: z.string().max(40) })
  app.get('/link-types', { schema: { tags: ['Links & watchers'], summary: 'Kinds of link between work items, each with how it reads both ways; with uses=1 (system administrators), how many links each has',
    querystring: z.object({ uses: z.enum(['0', '1']).default('0') }) } }, async req => {
    if (req.query.uses === '1') requireAdmin(req)
    return db.query(`${LINK(req.query.uses === '1')} where t.workspace_id = $1 order by t.position, t.name`, [req.me.workspaceId])
  })
  app.post('/admin/link-types', { schema: { tags: TAG, summary: 'Add a link type (global admins)', body: linkBody } }, async (req, reply) => {
    requireAdmin(req)
    const slug = req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?![a-z])/, 'x-').slice(0, 40) || 'link'
    return tx(async d => {
      const taken = new Set((await d.query<{ id: string; name: string }>('select id, lower(name) as name from link_types where workspace_id = $1', [req.me.workspaceId])).flatMap(r => [r.id, r.name]))
      if (taken.has(req.body.name.toLowerCase())) throw new HttpError(409, 'A link type with that name already exists', { name: 'Already used' })
      let id = slug
      for (let n = 2; taken.has(id); n++) id = `${slug.slice(0, 36)}-${n}`
      await d.query(`insert into link_types (workspace_id, id, name, outward, inward, position)
                     values ($1, $2, $3, $4, $5, (select coalesce(max(position), 0) + 1 from link_types where workspace_id = $1))`,
        [req.me.workspaceId, id, req.body.name, req.body.outward, req.body.inward])
      await audit(d, req, { action: 'link_type.created', type: 'link_type', name: req.body.name, after: req.body })
      reply.code(201)
      return (await d.query(`${LINK(true)} where t.workspace_id = $1 and t.id = $2`, [req.me.workspaceId, id]))[0]
    })
  })
  app.patch('/admin/link-types/:id', { schema: { tags: TAG, summary: 'Rename a link type or change how it reads (global admins)', params: linkP, body: linkBody.partial() } }, async req => {
    requireAdmin(req)
    return tx(async d => {
      const [before] = await d.query<any>('select name, outward, inward from link_types where workspace_id = $1 and id = $2', [req.me.workspaceId, req.params.id])
      if (!before) throw new HttpError(404, 'No such link type')
      const next = { ...before, ...req.body }
      if (req.body.name && (await d.query('select 1 from link_types where workspace_id = $1 and id <> $2 and lower(name) = lower($3)', [req.me.workspaceId, req.params.id, req.body.name])).length)
        throw new HttpError(409, 'A link type with that name already exists', { name: 'Already used' })
      await d.query('update link_types set name = $3, outward = $4, inward = $5 where workspace_id = $1 and id = $2', [req.me.workspaceId, req.params.id, next.name, next.outward, next.inward])
      const c = changes(before, next)
      if (c.changed) await audit(d, req, { action: 'link_type.updated', type: 'link_type', name: next.name, before: c.before, after: c.after })
      return (await d.query(`${LINK(true)} where t.workspace_id = $1 and t.id = $2`, [req.me.workspaceId, req.params.id]))[0]
    })
  })
  app.delete('/admin/link-types/:id', { schema: {
    tags: TAG, summary: 'Remove a link type (global admins). Links of that type move to `moveTo`, or are removed with `removeLinks=1`; one in use needs either',
    params: linkP, querystring: z.object({ moveTo: z.string().max(40).optional(), removeLinks: z.enum(['1']).optional() }),
  } }, async (req, reply) => {
    requireAdmin(req)
    await tx(async d => {
      const [t] = await d.query<any>(`${LINK(true)} where t.workspace_id = $1 and t.id = $2`, [req.me.workspaceId, req.params.id])
      if (!t) throw new HttpError(404, 'No such link type')
      if (t.builtin) throw new HttpError(409, `${t.name} is built in: the app relies on it`)
      const { moveTo, removeLinks } = req.query
      if (t.uses && !moveTo && !removeLinks) throw new HttpError(409, `${t.uses} links use ${t.name}: choose a type to move them to, or remove them`)
      const ws = 'issue_id in (select id from issues where workspace_id = $1)'
      if (t.uses && moveTo) {
        if (moveTo === t.id || !(await d.query('select 1 from link_types where workspace_id = $1 and id = $2', [req.me.workspaceId, moveTo])).length) throw new HttpError(400, 'Choose another link type to move the links to')
        // a pair already linked by the target type keeps that link; the old one goes
        await d.query(`delete from issue_links l where l.type = $2 and ${ws} and exists (select 1 from issue_links x where x.issue_id = l.issue_id and x.target_id = l.target_id and x.type = $3)`, [req.me.workspaceId, t.id, moveTo])
        await d.query(`update issue_links set type = $3 where type = $2 and ${ws}`, [req.me.workspaceId, t.id, moveTo])
      } else if (t.uses) await d.query(`delete from issue_links where type = $2 and ${ws}`, [req.me.workspaceId, t.id])
      await d.query('delete from link_types where workspace_id = $1 and id = $2', [req.me.workspaceId, t.id])
      await audit(d, req, { action: 'link_type.deleted', type: 'link_type', name: t.name, before: { name: t.name, links: t.uses }, after: moveTo ? { movedTo: moveTo } : undefined })
    })
    reply.code(204).send()
  })

  // Rate limiting › Limited accounts: who was refused in the last 24 hours (newest first)
  app.get('/admin/rate-limits/limited', { schema: { tags: TAG, summary: 'People whose access tokens were rate limited in the last 24 hours (global admins)' } }, async req => {
    requireAdmin(req)
    return db.query(
      `select u.id as user_id, u.name, u.email, r.first_at, r.last_at, r.times
         from rate_limited_accounts r join users u on u.id = r.user_id
        where r.workspace_id = $1 and r.last_at > now() - interval '24 hours' order by r.last_at desc limit 500`, [req.me.workspaceId])
  })

  // what the web app needs to behave like the server (limits it shows or checks before sending)
  app.get('/settings/public', { schema: { tags: ['Me'], summary: 'Settings every signed-in person may see: attachment, token, export, bulk and due-date limits, and the priority and resolution lists' } }, async req => ({
    ...Object.fromEntries(await Promise.all((Object.keys(SETTINGS) as SettingKey[]).filter(k => SETTINGS[k].public).map(async k => [k, await getSetting(req.me.workspaceId, k)]))),
    priorities: await priorities(db, req.me.workspaceId), resolutions: await resolutions(db, req.me.workspaceId),   // spec 0305: the app's pickers read them
  }))

  // ── Backups taken when a project is deleted (a workspace setting, for global admins) ──
  app.get('/admin/settings/project-backups', { schema: { tags: TAG, summary: 'Whether deleting a project backs it up first, and where (global admins)' } }, async req => {
    requireAdmin(req)
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null, allowedBuckets: allowedBackupBuckets() }
  })

  app.put('/admin/settings/project-backups', { schema: {
    tags: TAG, summary: 'Turn project backups on or off and choose where they go (global admins)',
    body: z.object({
      enabled: z.boolean(),
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'An S3 bucket name').nullable().optional().describe('Empty: BACKUP_BUCKET, else the attachments bucket'),
      prefix: z.string().max(200).regex(/^[A-Za-z0-9!_.*'()/-]*$/).optional(),
    }),
  } }, async req => {
    requireAdmin(req)
    if (req.body.bucket && !allowedBackupBuckets().includes(req.body.bucket))
      throw new HttpError(400, 'That bucket is not one the operators allow for backups (BACKUP_BUCKETS)', { bucket: 'Not an allowed backup bucket' })
    const next = { enabled: req.body.enabled, ...(req.body.bucket ? { bucket: req.body.bucket } : {}), ...(req.body.prefix !== undefined ? { prefix: req.body.prefix } : {}) }
    await tx(async d => {
      const before = await backupSettings(d, req.me.workspaceId)
      await setSetting(d, req.me.workspaceId, 'projectBackups', next, req.me.id)
      const c = changes(before as any, next as any)
      if (c.changed) await audit(d, req, { action: 'settings.project_backups.updated', type: 'settings', name: 'Project backups', before: c.before, after: c.after })
    })
    const s = await backupSettings(db, req.me.workspaceId)
    return { enabled: s.enabled, bucket: s.bucket ?? null, prefix: s.prefix ?? 'project-backups/', effectiveBucket: backupBucket(s) || null, allowedBuckets: allowedBackupBuckets() }
  })

  app.get('/admin/project-backups', { schema: { tags: TAG, summary: 'Backups of deleted projects, newest first, a page at a time; with query, those whose key or name contains it (system administrators)',
    querystring: z.object({ query: z.string().max(100).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async req => {
    requireAdmin(req)
    const args: unknown[] = [req.me.workspaceId]
    const where = ['workspace_id = $1']
    if (req.query.query) { args.push(`%${req.query.query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(project_key ilike $${args.length} or project_name ilike $${args.length})`) }
    const [{ total }] = await db.query<{ total: number }>(`select count(*)::int as total from project_backups where ${where.join(' and ')}`, [...args]) as any
    if (req.query.cursor) {
      let c: [string, string]
      try { c = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString()) } catch { throw new HttpError(400, 'Invalid cursor') }
      args.push(c[0], c[1]); where.push(`(created_at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`)
    }
    args.push(req.query.limit + 1)
    const rows = await db.query<any>(
      `select id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, created_at, created_by, restored_at
         from project_backups where ${where.join(' and ')} order by created_at desc, id desc limit $${args.length}`, args)
    const more = rows.length > req.query.limit, items = more ? rows.slice(0, req.query.limit) : rows
    return { items, total, next: more ? Buffer.from(JSON.stringify([items.at(-1).createdAt, items.at(-1).id])).toString('base64url') : null }
  })

  app.get('/admin/project-backups/:id/url', { schema: { tags: TAG, summary: 'Download link for a backup document (5 min, global admins)', params: idP } }, async req => {
    requireAdmin(req)
    const [b] = await db.query<{ bucket: string; objectKey: string; projectKey: string }>(
      'select bucket, object_key, project_key from project_backups where id = $1 and workspace_id = $2', [req.params.id, req.me.workspaceId])
    if (!b) throw new HttpError(404, 'Backup not found')
    await tx(d => audit(d, req, { action: 'project.backup.downloaded', type: 'backup', id: req.params.id, name: b.projectKey }))
    return { url: await getSignedUrl(s3(), new GetObjectCommand({ Bucket: b.bucket, Key: b.objectKey, ResponseContentDisposition: `attachment; filename="${b.projectKey}-backup.json"` }), { expiresIn: 300 }) }
  })

  app.post('/admin/project-backups/:id/restore', { schema: { tags: TAG, summary: 'Restore a deleted project from its backup (runs in the background; global admins)', params: idP,
    response: { 202: z.object({ jobId: z.string().uuid().describe('Follow it at GET /jobs/{id}') }) } } }, async (req, reply) => {
    requireAdmin(req)
    const jobId = await tx(async d => {
      const [b] = await d.query<{ projectKey: string; restoredAt: string | null }>(
        'select project_key, restored_at from project_backups where id = $1 and workspace_id = $2', [req.params.id, req.me.workspaceId])
      if (!b) throw new HttpError(404, 'Backup not found')
      if (b.restoredAt) throw new HttpError(409, 'This backup has already been restored')
      const [taken] = await d.query('select 1 from projects where workspace_id = $1 and key = $2', [req.me.workspaceId, b.projectKey])
      if (taken) throw new HttpError(409, `A project with the key ${b.projectKey} already exists`)
      await audit(d, req, { action: 'project.restore_requested', type: 'backup', id: req.params.id, name: b.projectKey })
      return enqueue(d, 'project.restore', { backupId: req.params.id, actorId: req.me.id, actorEmail: req.me.email, ip: req.ip },
        { workspaceId: req.me.workspaceId, createdBy: req.me.id, dedupeKey: `project.restore:${req.params.id}`, maxAttempts: 3 })
    })
    kickJobs(app.log)
    reply.code(202)
    return { jobId }
  })

  // ── Background jobs: the person who started one, and global admins, can follow it ──
  app.get('/jobs/:id', { schema: { tags: TAG, summary: 'Progress of a background job you started', params: idP } }, async req => {
    const [j] = await db.query<any>(
      `select id, kind, status, attempts, max_attempts, last_error, result, progress, created_by, created_at, finished_at
         from jobs where id = $1 and workspace_id = $2`, [req.params.id, req.me.workspaceId])
    if (!j || (j.createdBy !== req.me.id && !req.me.admin)) throw new HttpError(404, 'Job not found')
    return j
  })
}

export default plugin
