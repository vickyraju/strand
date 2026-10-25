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
  const footer = 'You get this because of your notification settings in Strand. Change what you get in Settings › Notifications.'
  await sendEmail({
    to: row.email, from: s.from, subject,
    text: `${what}\n\n${row.key} ${row.title} (${row.projectName})\n${link ? `${link}\n` : ''}\n${footer}`,
    html: `<p>${esc(what)}</p><p><b>${esc(row.key)}</b> ${link ? `<a href="${esc(link)}">${esc(row.title)}</a>` : esc(row.title)} <span style="color:#78716c">(${esc(row.projectName)})</span></p><p style="color:#78716c;font-size:12px">${esc(footer)}</p>`,
  })
  return { sent: row.email }
})
