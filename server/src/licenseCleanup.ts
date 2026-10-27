// License cleanup (resolution's User Deactivator and License Optimizer, built in): people who haven't used Strand for the
// number of days an admin chooses are taken out of users-access (they rejoin at their next sign-in, as License Optimizer
// does), out of chosen groups, or deactivated. They are warned by email some days before, admins get a report, and every
// run is kept. A preview shows the same without changing anything.
// Never touched: system administrators, members of excluded groups, and (unless forced) project and component leads.
import { db, tx, type Db } from './db.ts'
import { audit } from './audit.ts'
import { enqueue, registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'
import { sendEmail } from './email.ts'

export interface Person { userId: string; email: string; name: string; lastActiveAt: string | null }
type Rule = Awaited<ReturnType<typeof getSetting<'licenseCleanup'>>>

/** Someone's last sign of use: their last request, or (never used) when their account was made. */
const LAST = `coalesce(u.last_active_at, u.created_at)`
/** The people a rule applies to, in the workspace: active accounts, not protected. */
function eligible(rule: Rule) {
  return `u.active and is_system_admin(u.id) = false
    and not exists (select 1 from group_members gm where gm.user_id = u.id and gm.group_id = any($2::uuid[]))
    ${rule.protectLeads ? `and not exists (select 1 from projects p where p.lead_id = u.id and p.workspace_id = $1 and p.deleting_at is null)
      and not exists (select 1 from components c join projects p on p.id = c.project_id where c.lead_id = u.id and p.workspace_id = $1)` : ''}`
}
/** …and who the action would still change (in users-access, in a chosen group, or active). */
function stillApplies(rule: Rule) {
  return rule.action === 'remove-access' ? `exists (select 1 from group_members gm join groups g on g.id = gm.group_id where gm.user_id = u.id and g.system_role = 'default-users') and cardinality($4::uuid[]) >= 0`
    : rule.action === 'remove-groups' ? `exists (select 1 from group_members gm where gm.user_id = u.id and gm.group_id = any($4::uuid[]))`
    : 'cardinality($4::uuid[]) >= 0'      // (deactivate: no group condition; $4 is still bound)
}
const people = (d: Db, ws: string, rule: Rule, days: number, extra: string) => d.query<Person>(
  `select u.id as user_id, u.email, u.name, u.last_active_at from users u join memberships m on m.user_id = u.id and m.workspace_id = $1
    where ${eligible(rule)} and ${stillApplies(rule)} and ${LAST} < now() - make_interval(days => $3) ${extra}
    order by ${LAST}, lower(u.name)`, [ws, rule.excludedGroupIds, days, rule.groupIds])

/** Who a run would change now, and who it would warn (due within the warning days, not warned yet). */
export async function preview(d: Db, ws: string, rule: Rule) {
  const change = await people(d, ws, rule, rule.inactiveDays, '')
  const warn = rule.warnDays > 0 && rule.warnDays < rule.inactiveDays
    ? await people(d, ws, rule, rule.inactiveDays - rule.warnDays, `and u.cleanup_warned_at is null and ${LAST} >= now() - make_interval(days => ${rule.inactiveDays})`)
    : []
  return { change, warn }
}

/** Seats (Jira's license count: people in users-access), and how recently they were active. */
export async function seats(d: Db, ws: string) {
  const [s] = await d.query<{ total: number; active30: number; active90: number; never: number }>(
    `select count(*)::int as total,
            count(*) filter (where u.last_active_at > now() - interval '30 days')::int as active30,
            count(*) filter (where u.last_active_at > now() - interval '90 days')::int as active90,
            count(*) filter (where u.last_active_at is null)::int as never
       from group_members gm join groups g on g.id = gm.group_id and g.system_role = 'default-users'
       join users u on u.id = gm.user_id join memberships m on m.user_id = u.id and m.workspace_id = $1 where u.active`, [ws])
  return s!
}

/** One run: apply the rule, record it, and afterwards send the warnings and the report. */
export async function runCleanup(ws: string, trigger: 'schedule' | 'manual', who: { me?: any; system?: string; ip?: string }) {
  const rule = await getSetting(ws, 'licenseCleanup')
  const { run, warned } = await tx(async d => {
    const { change, warn } = await preview(d, ws, rule)
    for (const p of change) {
      if (rule.action === 'deactivate') await d.query('update users set active = false where id = $1', [p.userId])
      else if (rule.action === 'remove-access')
        await d.query(`delete from group_members where user_id = $1 and group_id = (select id from groups where system_role = 'default-users')`, [p.userId])
      else await d.query(`delete from group_members gm using groups g where g.id = gm.group_id and gm.user_id = $1 and gm.group_id = any($2::uuid[]) and g.system_role is null`, [p.userId, rule.groupIds])
      await audit(d, who, { workspaceId: ws, action: `license_cleanup.${rule.action === 'deactivate' ? 'deactivated' : 'removed_from_groups'}`, type: 'user', id: p.userId, name: p.email,
        before: { lastActiveAt: p.lastActiveAt }, after: { action: rule.action, inactiveDays: rule.inactiveDays } })
    }
    if (warn.length) await d.query('update users set cleanup_warned_at = now() where id = any($1::uuid[])', [warn.map(w => w.userId)])
    const [run] = await d.query<{ id: string; startedAt: string }>(
      `insert into license_cleanup_runs (workspace_id, trigger, action, finished_at, changed, warned, started_by)
       values ($1, $2, $3, now(), $4, $5, $6) returning id, started_at`, [ws, trigger, rule.action, JSON.stringify(change), JSON.stringify(warn), who.me?.id ?? null])
    return { run: { ...run!, change }, warned: warn }
  })
  // emails go after the change is saved: a mail problem never undoes a cleanup, and is noted on the run
  const notes: string[] = []
  const email = await getSetting(ws, 'email')
  if ((warned.length || (rule.reportTo.length && run.change.length)) && !(email.enabled && email.from)) notes.push('Email is off (System settings › Email notifications): no warnings or report sent')
  else {
    const what = rule.action === 'deactivate' ? 'your Strand account will be deactivated' : rule.action === 'remove-access' ? 'your Strand access will be removed until you next sign in' : 'you will be taken out of some Strand groups'
    for (const w of warned) {
      await sendEmail({ to: w.email, from: email.from, subject: 'You haven’t used Strand for a while',
        text: `Hello ${w.name},\n\nYou haven’t used Strand for some time. In about ${rule.warnDays} days ${what}.\nSigning in to Strand before then keeps everything as it is.${email.appUrl ? `\n\n${email.appUrl}` : ''}`,
        html: `<p>Hello ${esc(w.name)},</p><p>You haven’t used Strand for some time. In about ${rule.warnDays} days ${what}.</p><p>Signing in to Strand before then keeps everything as it is.</p>` })
        .catch(e => notes.push(`Warning to ${w.email} not sent: ${e.message}`))
    }
    if (rule.reportTo.length && run.change.length) {
      const list = run.change.map(p => `- ${p.name} <${p.email}> (last active ${p.lastActiveAt ? new Date(p.lastActiveAt).toISOString().slice(0, 10) : 'never'})`).join('\n')
      for (const to of rule.reportTo)
        await sendEmail({ to, from: email.from, subject: `Strand license cleanup: ${run.change.length} ${run.change.length === 1 ? 'person' : 'people'} (${rule.action})`,
          text: `License cleanup (${trigger}) ${rule.action} for people inactive for ${rule.inactiveDays} days:\n\n${list}\n\nWarned: ${warned.length}.`,
          html: `<p>License cleanup (${trigger}): <b>${esc(rule.action)}</b> for people inactive for ${rule.inactiveDays} days.</p><ul>${run.change.map(p => `<li>${esc(p.name)} &lt;${esc(p.email)}&gt;</li>`).join('')}</ul><p>Warned: ${warned.length}.</p>` })
          .catch(e => notes.push(`Report to ${to} not sent: ${e.message}`))
    }
  }
  if (notes.length) await db.query('update license_cleanup_runs set notes = $2 where id = $1', [run.id, notes.join('\n')])
  return { id: run.id, changed: run.change.length, warned: warned.length, notes: notes.join('\n') }
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The next daily run (02:00 UTC), queued once per day per workspace. */
export async function scheduleCleanup(d: Db, ws: string) {
  const next = new Date(); next.setUTCHours(2, 0, 0, 0)
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1)
  await enqueue(d, 'license.cleanup', { workspaceId: ws }, { workspaceId: ws, runAt: next, dedupeKey: `license.cleanup:${ws}:${next.toISOString().slice(0, 10)}` })
}
registerJob('license.cleanup', async (p: { workspaceId: string }) => {
  const rule = await getSetting(p.workspaceId, 'licenseCleanup')
  if (!rule.enabled) return { skipped: 'turned off' }
  const result = await runCleanup(p.workspaceId, 'schedule', { system: 'License cleanup' })
  await scheduleCleanup(db, p.workspaceId)
  return result
})
