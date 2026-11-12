// Notification emails. The database decides who gets one (notifications_route: the person's preference and the workspace's
// Email setting) and queues a job; this sends it. How mail leaves is the platform's choice (environment):
//   EMAIL_TRANSPORT=ses     Amazon SES (region from AWS_REGION; credentials from the pod's role)
//   EMAIL_TRANSPORT=log     written to the server log (development)
//   EMAIL_TRANSPORT=memory  kept in `sentEmails` (tests)
// Unset: emails stay queued as failed jobs with "no email transport", so nothing is lost silently.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { db } from './db.ts'
import { registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'

export interface Email { to: string; from: string; subject: string; text: string; html: string }
export const sentEmails: Email[] = []
let ses: SESv2Client | null = null

export async function sendEmail(m: Email) {
  const transport = process.env.EMAIL_TRANSPORT
  if (transport === 'memory') { sentEmails.push(m); return }
  if (transport === 'log') { console.log(`[email] to ${m.to}: ${m.subject}\n${m.text}`); return }
  if (transport === 'ses') {
    ses ??= new SESv2Client({})
    await ses.send(new SendEmailCommand({
      FromEmailAddress: m.from, Destination: { ToAddresses: [m.to] },
      Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' }, Html: { Data: m.html, Charset: 'UTF-8' } } } },
    }))
    return
  }
  throw new Error('No email transport is set up (EMAIL_TRANSPORT)')
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** One notification as an email: "Ann assigned you PAY-12 Login fails", with a link to it. */
registerJob('email.notification', async (p: { userId: string; actorId: string | null; issueId: string; kind: string; text: string }, job) => {
  const [row] = await db.query<{ email: string; active: boolean; actor: string | null; key: string; title: string; projectName: string }>(
    `select u.email, u.active, a.name as actor, pr.key || '-' || i.number as key, i.title, pr.name as project_name
       from users u, issues i join projects pr on pr.id = i.project_id left join users a on a.id = $3
      where u.id = $1 and i.id = $2`, [p.userId, p.issueId, p.actorId])
  if (!row || !row.active) return { skipped: 'the person or the work item is gone' }
  const s = await getSetting(job.workspaceId!, 'email')
  if (!s.enabled || !s.from) return { skipped: 'email is off' }
  const what = `${row.actor ? `${row.actor} ` : ''}${p.text}`
  const link = s.appUrl ? `${s.appUrl.replace(/\/$/, '')}/i/${row.key}` : ''
  const subject = `[${row.key}] ${row.title}`.slice(0, 200)
  const footer = 'You get this because of your notification settings in Jira Build POC. Change what you get in Settings › Notifications.'
  await sendEmail({
    to: row.email, from: s.from, subject,
    text: `${what}\n\n${row.key} ${row.title} (${row.projectName})\n${link ? `${link}\n` : ''}\n${footer}`,
    html: `<p>${esc(what)}</p><p><b>${esc(row.key)}</b> ${link ? `<a href="${esc(link)}">${esc(row.title)}</a>` : esc(row.title)} <span style="color:#78716c">(${esc(row.projectName)})</span></p><p style="color:#78716c;font-size:12px">${esc(footer)}</p>`,
  })
  return { sent: row.email }
})

/** Jira 8's batched notifications (spec 0606 R1): everything one person heard about one work item in the window, as one email. */
registerJob('email.batch', async (p: { userId: string; issueId: string }, job) => {
  const items = await db.query<{ id: string; actor: string | null; text: string; createdAt: Date }>(
    `select b.id, a.name as actor, b.text, b.created_at from email_batch_items b left join users a on a.id = b.actor_id
      where b.user_id = $1 and b.issue_id = $2 order by b.created_at, b.id`, [p.userId, p.issueId])
  if (!items.length) return { skipped: 'nothing gathered' }
  const [row] = await db.query<{ email: string; active: boolean; key: string; title: string; projectName: string }>(
    `select u.email, u.active, pr.key || '-' || i.number as key, i.title, pr.name as project_name
       from users u, issues i join projects pr on pr.id = i.project_id where u.id = $1 and i.id = $2`, [p.userId, p.issueId])
  const done = () => db.query('delete from email_batch_items where id = any($1::uuid[])', [items.map(x => x.id)])
  if (!row || !row.active) { await done(); return { skipped: 'the person or the work item is gone' } }
  const s = await getSetting(job.workspaceId!, 'email')
  if (!s.enabled || !s.from) { await done(); return { skipped: 'email is off' } }
  const link = s.appUrl ? `${s.appUrl.replace(/\/$/, '')}/i/${row.key}` : ''
  const line = (x: typeof items[number]) => `${x.actor ?? 'Automation'} ${x.text} (${new Date(x.createdAt).toISOString().slice(11, 16)} UTC)`
  const footer = 'You get this because of your notification settings in Jira Build POC. Change what you get in Settings › Notifications.'
  await sendEmail({
    to: row.email, from: s.from, subject: `[${row.key}] ${row.title}`.slice(0, 200),
    text: `${items.length} change${items.length === 1 ? '' : 's'} to ${row.key} ${row.title} (${row.projectName})\n\n${items.map(line).join('\n')}\n${link ? `\n${link}\n` : ''}\n${footer}`,
    html: `<p><b>${esc(row.key)}</b> ${link ? `<a href="${esc(link)}">${esc(row.title)}</a>` : esc(row.title)} <span style="color:#78716c">(${esc(row.projectName)})</span></p>`
      + `<ul>${items.map(x => `<li>${esc(line(x))}</li>`).join('')}</ul><p style="color:#78716c;font-size:12px">${esc(footer)}</p>`,
  })
  await done()
  return { sent: row.email, changes: items.length }
})

