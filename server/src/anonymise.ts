// User anonymisation (spec 0704), as Jira's: a deactivated person's personal data goes for good. Their name becomes an
// alias everywhere they appear; what they lead or own passes to someone else; what was only theirs goes. A background
// job in batches (a person with years of comments mustn't time out a request), safe to run again if it stops.
import { createHash } from 'node:crypto'
import { db, tx, type Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { audit } from './audit.ts'
import { registerJob } from './jobs.ts'
import { RECOVERY_USER } from './authConfig.ts'
import { bindPassword, findPerson, openDirectory, type Directory } from './directories.ts'

const BATCH = 1000
/** The same alias every time for a person, so running the job again changes nothing more. */
export const aliasOf = (userId: string) => `user-${createHash('sha256').update(userId).digest('hex').slice(0, 6)}`
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&')

interface Person { id: string; name: string; email: string; username: string | null; active: boolean; anonymisedAt: string | null; directoryId: string | null; owner: boolean }

/** The person, if they may be anonymised now (R1, R2); otherwise why not. */
export async function anonymisable(d: Db, ws: string, userId: string): Promise<Person> {
  const [p] = await d.query<Person>(
    `select u.id, u.name, u.email, u.username, u.active, u.anonymised_at, u.directory_id, m.role = 'owner' as owner
       from users u join memberships m on m.user_id = u.id and m.workspace_id = $1 where u.id = $2`, [ws, userId])
  if (!p) throw new HttpError(404, 'Person not found')
  if (p.username === RECOVERY_USER) throw new HttpError(409, 'recovery_admin belongs to recovery mode')
  if (p.owner) throw new HttpError(409, 'The workspace’s owner can’t be anonymised')
  if (p.active && !p.anonymisedAt) throw new HttpError(409, 'Deactivate them first: only a deactivated person can be anonymised', { userId: 'Still active' })
  if (p.directoryId && p.username && !p.anonymisedAt) {
    // R2: the directory would bring their details back at its next synchronisation
    const [dir] = await d.query<Directory>('select * from user_directories where id = $1 and enabled', [p.directoryId])
    if (dir) {
      let found = false
      try { const l = await openDirectory(dir.config, bindPassword(dir)); try { found = !!(await findPerson(l, dir.config, p.username)) } finally { await l.close() } }
      catch { throw new HttpError(503, `The user directory “${dir.name}” can’t be reached to check that it no longer has them. Try again later.`) }
      if (found) throw new HttpError(409, `The user directory “${dir.name}” still has them: remove them there first, or their details come back at the next synchronisation`)
    }
  }
  return p
}

/** R4: what anonymising them will do, without doing it. */
export async function preview(ws: string, userId: string) {
  const p = await anonymisable(db, ws, userId)
  const count = async (sql: string, args: unknown[]) => ((await db.query<{ n: number }>(sql, args))[0]?.n ?? 0)
  const mention = `%@${escapeLike(p.name)}%`
  return {
    alias: aliasOf(p.id),
    transfer: {
      projectsLed: await db.query<{ key: string; name: string }>('select key, name from projects where workspace_id = $1 and lead_id = $2 and deleting_at is null order by key', [ws, userId]),
      componentsLed: await count('select count(*)::int as n from components c join projects pr on pr.id = c.project_id where pr.workspace_id = $1 and c.lead_id = $2', [ws, userId]),
      sharedViews: await count(`select count(*)::int as n from saved_views where workspace_id = $1 and owner_id = $2 and (shared or share <> '[]')`, [ws, userId]),
      groupsAloneOwned: await db.query<{ name: string }>(
        `select g.display_name as name from group_owners o join groups g on g.id = o.group_id where o.user_id = $1
            and not exists (select 1 from group_owners x where x.group_id = o.group_id and x.user_id <> $1) order by 1`, [userId]),
    },
    change: {
      comments: await count('select count(*)::int as n from comments c join issues i on i.id = c.issue_id where i.workspace_id = $1 and c.author_id = $2', [ws, userId]),
      reported: await count('select count(*)::int as n from issues where workspace_id = $1 and reporter_id = $2', [ws, userId]),
      assigned: await count('select count(*)::int as n from issues where workspace_id = $1 and assignee_id = $2', [ws, userId]),
      mentions: await count(`select (select count(*) from comments c join issues i on i.id = c.issue_id where i.workspace_id = $1 and c.body like $2)
                                  + (select count(*) from issues where workspace_id = $1 and description like $2)::int as n`, [ws, mention]),
    },
    remove: { privateViews: await count(`select count(*)::int as n from saved_views where workspace_id = $1 and owner_id = $2 and not shared and share = '[]'`, [ws, userId]) },
    // JQL isn't rewritten (as in Jira): views whose query names them need a person to look
    actionsRequired: await db.query<{ id: string; name: string }>(
      `select id, name from saved_views where workspace_id = $1 and owner_id <> $2 and (filters::text like $3 or filters::text ilike $4) order by name limit 50`,
      [ws, userId, `%${userId}%`, `%${escapeLike(p.email)}%`]),
  }
}

/** Starts it: R5's transfer target is checked here, the work is the job's (R6). */
export async function startAnonymising(d: Db, me: Me, ip: string | undefined, userId: string, transferTo: string | null) {
  const p = await anonymisable(d, me.workspaceId, userId)
  const needs = (await d.query(
    `select 1 from projects where workspace_id = $1 and lead_id = $2 union all
     select 1 from components c join projects pr on pr.id = c.project_id where pr.workspace_id = $1 and c.lead_id = $2 union all
     select 1 from saved_views where workspace_id = $1 and owner_id = $2 and (shared or share <> '[]') union all
     select 1 from group_owners o where o.user_id = $2 and not exists (select 1 from group_owners x where x.group_id = o.group_id and x.user_id <> $2) limit 1`, [me.workspaceId, userId])).length > 0
  if (needs && !transferTo) throw new HttpError(400, 'Choose who takes over what they lead and own', { transferTo: 'Required' })
  if (transferTo) {
    if (transferTo === userId) throw new HttpError(400, 'Choose someone else', { transferTo: 'The same person' })
    const [t] = await d.query('select 1 from users u join memberships m on m.user_id = u.id and m.workspace_id = $1 where u.id = $2 and u.active', [me.workspaceId, transferTo])
    if (!t) throw new HttpError(400, 'Choose an active person of this workspace', { transferTo: 'Not active here' })
  }
  await audit(d, { me, ip }, { action: 'user.anonymise_started', type: 'user', id: userId, name: aliasOf(userId), after: { transferTo } })
  const { enqueue } = await import('./jobs.ts')
  return enqueue(d, 'user.anonymise', { workspaceId: me.workspaceId, userId, transferTo, actor: { id: me.id, email: me.email, workspaceId: me.workspaceId },
    // their details as they are now, so the job can find them again if it has to run twice
    was: { name: p.name, email: p.email, username: p.username } }, { workspaceId: me.workspaceId, createdBy: me.id, dedupeKey: `user.anonymise:${userId}`, maxAttempts: 5 })
}

/** Replaces `from` with `to` in a text column, a batch of rows at a time (R3: mentions, the audit log's strings). */
/** `where` may use $3 (the workspace) and $4 (an exact value). Table and column names are this file's own, never input. */
async function rewrite(table: string, column: string, where: string, args: [ws: string, exact: string | null], from: string, to: string, job: { id: string }, progress: { done: number }) {
  for (;;) {
    const n = await tx(async d => {
      if (table === 'audit_log') await d.query(`select set_config('app.anonymising', 'on', true)`)   // the trigger's one exception (migration 20261215)
      return (await d.query(
      `update ${table} set ${column} = replace(${column}, $1, $2) where ctid in (select ctid from ${table} where ${where} and position($1 in ${column}) > 0 limit ${BATCH}) returning 1`,
      [from, to, ...args])).length
    })
    progress.done += n
    await db.query(`update jobs set progress = $2, locked_until = now() + interval '5 minutes' where id = $1`, [job.id, JSON.stringify(progress)])
    if (n < BATCH) return
  }
}

/** The same inside the audit log's jsonb columns: only quoted JSON strings equal to `from`, so other text isn't touched. */
async function rewriteJson(column: 'before' | 'after', ws: string, from: string, to: string, job: { id: string }, progress: { done: number }) {
  const was = JSON.stringify(from), now = JSON.stringify(to)
  for (;;) {
    const n = await tx(async d => {
      await d.query(`select set_config('app.anonymising', 'on', true)`)
      return (await d.query(
        `update audit_log set ${column} = replace(${column}::text, $1, $2)::jsonb
          where ctid in (select ctid from audit_log where (workspace_id = $3::uuid or workspace_id is null) and ${column} is not null and position($1 in ${column}::text) > 0 limit ${BATCH}) returning 1`,
        [was, now, ws])).length
    })
    progress.done += n
    await db.query(`update jobs set progress = $2, locked_until = now() + interval '5 minutes' where id = $1`, [job.id, JSON.stringify(progress)])
    if (n < BATCH) return
  }
}

registerJob('user.anonymise', async (p: { workspaceId: string; userId: string; transferTo: string | null; actor: Me; was: { name: string; email: string; username: string | null } }, job) => {
  const ws = p.workspaceId, id = p.userId, alias = aliasOf(id), email = `anonymised-${alias.slice(5)}-${id.slice(0, 8)}@invalid`
  const progress = { done: 0 }
  // R5: transfers, then what was only theirs
  await tx(async d => {
    if (p.transferTo) {
      await d.query('update projects set lead_id = $3 where workspace_id = $1 and lead_id = $2', [ws, id, p.transferTo])
      await d.query('update components c set lead_id = $3 from projects pr where pr.id = c.project_id and pr.workspace_id = $1 and c.lead_id = $2', [ws, id, p.transferTo])
      await d.query(`update saved_views set owner_id = $3 where workspace_id = $1 and owner_id = $2 and (shared or share <> '[]')`, [ws, id, p.transferTo])
      await d.query(`insert into group_owners (group_id, user_id) select o.group_id, $2 from group_owners o where o.user_id = $1
                       and not exists (select 1 from group_owners x where x.group_id = o.group_id and x.user_id <> $1) on conflict do nothing`, [id, p.transferTo])
    }
    await d.query(`delete from saved_views where workspace_id = $1 and owner_id = $2 and not shared and share = '[]'`, [ws, id])
    await d.query('delete from group_owners where user_id = $1', [id])
    for (const t of ['user_sessions', 'personal_access_tokens', 'password_resets', 'notification_prefs', 'stars', 'issue_views', 'issue_editors', 'user_identities'])
      await d.query(`delete from ${t} where user_id = $1`, [id])
    if (p.was.username) await d.query('delete from login_failures where username = lower($1)', [p.was.username])
    // R3: the person themselves
    await d.query(`update users set name = $2, email = $3, initials = 'AU', color = '#8A8578', username = null, title = null, entra_oid = null,
        directory_id = null, directory_guid = null, password_hash = null, password_changed_at = null, last_active_at = null, last_sign_in_at = null,
        active = false, anonymised_at = coalesce(anonymised_at, now()) where id = $1`, [id, alias, email])
  })
  // R3: mentions of their name, and the audit log's strings naming them, a batch at a time
  if (p.was.name !== alias) {
    await rewrite('comments', 'body', 'issue_id in (select id from issues where workspace_id = $3::uuid) and $4::text is null', [ws, null], `@${p.was.name}`, `@${alias}`, job, progress)
    await rewrite('issues', 'description', 'workspace_id = $3::uuid and $4::text is null', [ws, null], `@${p.was.name}`, `@${alias}`, job, progress)
  }
  for (const col of ['actor', 'target'] as const)
    await rewrite('audit_log', col, `(workspace_id = $3::uuid or workspace_id is null) and ${col} = $4::text`, [ws, p.was.email], p.was.email, email, job, progress)
  // their details inside entries' before and after (a person created with their email, renamed, …)
  for (const [from, to] of [[p.was.email, email], [p.was.name, alias], ...(p.was.username ? [[p.was.username, alias]] : [])] as [string, string][])
    for (const col of ['before', 'after'] as const) await rewriteJson(col, ws, from, to, job, progress)
  await audit(db, { me: p.actor }, { workspaceId: ws, action: 'user.anonymised', type: 'user', id, name: alias, after: { rewritten: progress.done } })
  return { alias, rewritten: progress.done }
})
