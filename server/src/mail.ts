// Incoming mail (spec 0607), as Jira's: mail handlers read a mail server every few minutes and turn what arrives into work
// items and comments. Sources: IMAP, a Microsoft 365 mailbox (Graph), or a folder of message files under STRAND_MAIL_DIR
// (Jira's Local files). Each gives raw messages; one parser and one set of handlers deal with them all.
import { randomUUID } from 'node:crypto'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db, pool, tx, type Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { enqueue, registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'
import { unseal } from './secrets.ts'
import { s3, filesBucket } from './storage.ts'
import { sendEmail } from './email.ts'
import { addComment, insertIssue } from './routes/issues.ts'
import { projectByKey } from './routes/projects.ts'
import { canJoinWork } from './access.ts'

export interface MailServer { id: string; workspaceId: string; name: string; kind: 'imap' | 'graph' | 'files'; config: Record<string, any>; secretEnc: Buffer | null }
export interface MailHandler { id: string; workspaceId: string; serverId: string; name: string; kind: Kind; enabled: boolean; delayMinutes: number; params: Params }
export type Kind = 'create_or_comment' | 'comment_non_quoted' | 'comment_entire' | 'create_each' | 'comment_before_marker'
export interface Params {
  project?: string; issueType?: string; stripQuotes?: boolean; catchEmail?: string; bulk?: 'ignore' | 'forward' | 'delete' | 'accept'
  forwardEmail?: string; defaultReporter?: string; ccAssignee?: boolean; ccWatchers?: boolean; splitRegex?: string
  /** Trust a sender only when the receiving mail server verified them (on unless turned off) */
  verifiedSenders?: boolean
}
/** A message from a source, and how to say it was dealt with (marked read, or removed). */
interface Raw { id: string; raw: Buffer; done: () => Promise<void> }

// —— Sources ——

/** The folder of message files (Jira's Local files): only under STRAND_MAIL_DIR, which the platform sets. */
export function mailDir(folder = '') {
  const base = process.env.STRAND_MAIL_DIR
  if (!base) throw new HttpError(400, 'Message files need STRAND_MAIL_DIR set on the server', { kind: 'Not set up' })
  const dir = resolve(base, folder)
  if (dir !== resolve(base) && !dir.startsWith(resolve(base) + sep)) throw new HttpError(400, 'The folder must be inside the server’s mail folder', { folder: 'Outside the mail folder' })
  return dir
}

const secretOf = (s: MailServer) => (s.secretEnc ? unseal(s.secretEnc, s.id) : '')

async function graphToken(s: MailServer) {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(s.config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.config.clientId, client_secret: secretOf(s), scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  })
  const j = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`Microsoft sign-in failed: ${j.error_description ?? j.error ?? r.status}`)
  return j.access_token as string
}

/** Unread messages, at most `max`, from a mail server. `close` ends the connection. */
export async function unread(s: MailServer, max = 50): Promise<{ messages: Raw[]; close: () => Promise<void> }> {
  if (s.kind === 'files') {
    const dir = mailDir(s.config.folder)
    const names = (await readdir(dir)).filter(n => !n.startsWith('.')).sort().slice(0, max)
    return { messages: await Promise.all(names.map(async n => ({ id: n, raw: await readFile(join(dir, n)), done: () => unlink(join(dir, n)) }))), close: async () => {} }
  }
  if (s.kind === 'graph') {
    const token = await graphToken(s)
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s.config.mailbox)}`
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
    const list = await call(`/mailFolders/${encodeURIComponent(s.config.folder || 'inbox')}/messages?$filter=isRead eq false&$select=id&$orderby=receivedDateTime&$top=${max}`)
    if (!list.ok) throw new Error(`Microsoft Graph refused the mailbox: ${list.status}`)
    const ids = ((await list.json()) as any).value.map((m: any) => m.id as string)
    return {
      messages: await Promise.all(ids.map(async (id: string) => ({
        id, raw: Buffer.from(await (await call(`/messages/${id}/$value`)).arrayBuffer()),
        done: async () => { await call(`/messages/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isRead: true }) }) },
      }))),
      close: async () => {},
    }
  }
  const c = new ImapFlow({ host: s.config.host, port: s.config.port, secure: s.config.secure !== false, auth: { user: s.config.username, pass: secretOf(s) }, logger: false })
  await c.connect()
  const lock = await c.getMailboxLock(s.config.folder || 'INBOX')
  const uids = ((await c.search({ seen: false }, { uid: true })) || []).slice(0, max)
  const messages: Raw[] = []
  for (const uid of uids) {
    const m = await c.fetchOne(String(uid), { source: true }, { uid: true })
    if (m && m.source) messages.push({ id: String(uid), raw: m.source, done: async () => { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } })   // Jira marks IMAP mail read
  }
  return { messages, close: async () => { lock.release(); await c.logout() } }
}

/** R1: Test: connect, sign in, and count what's waiting. */
export async function testServer(s: MailServer) {
  try { const u = await unread(s, 200); const n = u.messages.length; await u.close(); return { ok: true, unread: n } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

// —— Handling one message ——

const KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/g
const addresses = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a : a ? [a] : []).flatMap(x => x.value.map(v => (v.address ?? '').toLowerCase())).filter(Boolean)

/** R4: the text of a message for its handler: quoted lines out, or what comes before the marker. */
export function bodyFor(kind: Kind, p: Params, text: string) {
  const t = text.replace(/\r\n/g, '\n').trim()
  if (kind === 'comment_non_quoted' || (kind === 'create_or_comment' && p.stripQuotes)) return t.split('\n').filter(l => !/^\s*[>|]/.test(l)).join('\n').trim()
  if (kind === 'comment_before_marker' && p.splitRegex) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(p.splitRegex)
    try { const at = m ? t.search(new RegExp(m[1]!, m[2])) : -1; if (at > 0) return t.slice(0, at).trim() } catch { /* a broken regex: the whole body, as Jira's */ }
  }
  return t
}

/** An Authentication-Results header (RFC 8601) as its authserv-id and method results: comments in parentheses dropped,
 *  then `authserv-id; method=result prop=value …; …`. Microsoft 365 leaves the authserv-id out. */
export function parseAuthResults(line: string) {
  let v = line.replace(/^[^:]*:\s*/, ''), prev = ''
  while (prev !== v) { prev = v; v = v.replace(/\([^()]*\)/g, ' ') }   // nested comments, innermost first
  const parts = v.split(';').map(p => p.trim()).filter(Boolean)
  const authservId = parts[0] && !/^[a-z0-9.-]+\s*=/i.test(parts[0]) ? parts.shift()!.split(/\s+/)[0]!.toLowerCase() : ''
  const results = parts.map(p => {
    const [head, ...props] = p.split(/\s+/)
    const [method, result] = (head ?? '').toLowerCase().split('=')
    return { method: method ?? '', result: result ?? '', props: Object.fromEntries(props.map(x => x.split('=')).filter(x => x.length === 2).map(([k, val]) => [k!.toLowerCase(), val!.toLowerCase()])) }
  })
  return { authservId, results }
}

/** Spoofing guard (spec 0607 R3): does the receiving mail server vouch for the From address? Only its own verdict counts:
 *  for IMAP and message files, the topmost Authentication-Results whose authserv-id is the one the server is set to trust
 *  (none set: nobody is verified); in a Microsoft 365 mailbox, Exchange's own (the topmost), or its internal mark (Exchange
 *  strips that from outside mail). Verified: DMARC pass for the From domain, or DKIM pass for it or a domain it's under. */
export function senderVerified(m: Pick<ParsedMail, 'headerLines'>, from: string, server: Pick<MailServer, 'kind' | 'config'>) {
  const lines = (m.headerLines ?? []).filter(l => l.key === 'authentication-results').map(l => parseAuthResults(l.line))
  if (server.kind === 'graph' && /:\s*internal\s*$/i.test((m.headerLines ?? []).find(l => l.key === 'x-ms-exchange-organization-authas')?.line ?? '')) return true
  const trusted = server.kind === 'graph' ? lines[0] : server.config.authservId ? lines.find(l => l.authservId === String(server.config.authservId).toLowerCase()) : undefined
  const domain = (from.split('@')[1] ?? '').toLowerCase()
  if (!trusted || !domain) return false
  return trusted.results.some(r => r.result === 'pass' && (
    (r.method === 'dmarc' && r.props['header.from'] === domain) ||
    (r.method === 'dkim' && !!r.props['header.d'] && (domain === r.props['header.d'] || domain.endsWith(`.${r.props['header.d']}`)))))
}

type Outcome = { messageId: string; subject: string; from: string; result: 'created' | 'commented' | 'ignored' | 'forwarded' | 'failed'; key?: string; reason?: string }

/** A person of the workspace by address or username. Never with system administrator rights: email acts only with the
 *  sender's project roles (spec 0607 R3). */
async function meFor(d: Db, ws: string, email: string): Promise<Me | null> {
  const [u] = await d.query<any>(`select u.id, u.email, u.name, m.workspace_id, m.role, is_system_admin(u.id) as admin from users u join memberships m on m.user_id = u.id and m.workspace_id = $2
    where u.active and (lower(u.email) = lower($1) or lower(u.username) = lower($1))`, [email, ws])
  return u ? { id: u.id, email: u.email, name: u.name, workspaceId: u.workspaceId, role: u.role, admin: false, via: 'entra' } as Me : null
}

/** R2–R6: one message through one handler. Throws to leave it unread (it's tried again next run). */
export async function handleMessage(h: MailHandler, raw: Buffer, server: Pick<MailServer, 'kind' | 'config'>): Promise<Outcome> {
  const m: ParsedMail = await simpleParser(raw)
  const subject = (m.subject ?? '').trim(), from = addresses(m.from)[0] ?? ''
  const out = (result: Outcome['result'], extra: Partial<Outcome> = {}): Outcome => ({ messageId: m.messageId ?? '', subject, from, result, ...extra })
  const p = h.params
  const to = [...addresses(m.to), ...addresses(m.cc), ...addresses((m as any).bcc)]
  if (p.catchEmail && !to.includes(p.catchEmail.toLowerCase())) return out('ignored', { reason: `Not sent to ${p.catchEmail}` })
  // R5: automatic mail (bulk) as the handler says: ignore it, forward it, delete it, or take it
  const header = (n: string) => String(m.headers.get(n) ?? '').toLowerCase()
  const bulk = ['bulk', 'junk', 'list'].includes(header('precedence')) || (header('auto-submitted') !== '' && header('auto-submitted') !== 'no')
  if (bulk && (p.bulk ?? 'ignore') !== 'accept') {
    if (p.bulk === 'forward') return forward(h, m, 'Automatic mail (bulk)')
    return out('ignored', { reason: p.bulk === 'delete' ? 'Automatic mail (bulk), deleted' : 'Automatic mail (bulk)' })
  }
  return tx(async d => {
    // R3: the sender is a person of the workspace with that address (when the mail server verified it); else the default reporter
    const verified = p.verifiedSenders === false || senderVerified(m, from, server)
    let me = verified ? await meFor(d, h.workspaceId, from) : null
    let viaDefault = false
    if (!me && p.defaultReporter) { me = await meFor(d, h.workspaceId, p.defaultReporter); viaDefault = !!me }
    const who = verified ? `Nobody in Strand has the address ${from}` : `The mail server didn’t verify the sender ${from}`
    if (!me) return p.forwardEmail ? forward(h, m, who) : out('failed', { reason: who })
    const req = { me, method: 'POST' }
    const text = bodyFor(h.kind, p, m.text ?? '') + (viaDefault ? `\n\n(Sent by ${from}${verified ? '' : ', not verified'})` : '')
    // R4: which item a comment goes to: the first key in the subject (earlier keys too), else the item the replied-to email made
    const target = async () => {
      for (const k of subject.toUpperCase().match(KEY) ?? []) {
        const [i] = await d.query<{ key: string }>(`select p.key || '-' || i.number as key from issues i join projects p on p.id = i.project_id
          where p.workspace_id = $1 and i.deleted_at is null and ((p.key || '-' || i.number) = $2
            or exists (select 1 from project_key_history h where h.project_id = p.id and h.key || '-' || i.number = $2)
            or i.id in (select mk.issue_id from moved_issue_keys mk join projects op on op.id = mk.project_id where op.key || '-' || mk.number = $2))`, [h.workspaceId, k])
        if (i) return k
      }
      const refs = [m.inReplyTo, ...[m.references ?? []].flat()].filter((x): x is string => !!x)
      if (refs.length) {
        const [i] = await d.query<{ key: string }>(`select p.key || '-' || i.number as key from mail_message_ids x join issues i on i.id = x.issue_id join projects p on p.id = i.project_id
          where x.message_id = any($1::text[]) and p.workspace_id = $2 and i.deleted_at is null limit 1`, [refs, h.workspaceId])
        if (i) return i.key
      }
      return null
    }
    const comments = h.kind !== 'create_each'
    const key = comments ? await target() : null
    if (key) {
      if (!text) return out('failed', { reason: 'The email has no text to add' })
      const c = await addComment(d, req, key, { body: text })
      const [{ issueId }] = await d.query<{ issueId: string }>('select issue_id from comments where id = $1', [c.id]) as any
      await attach(d, me, issueId, m)
      return out('commented', { key })
    }
    if (h.kind !== 'create_or_comment' && h.kind !== 'create_each') return out('failed', { reason: 'No work item key in the subject, and not a reply to one' })
    if (!subject) return out('failed', { reason: 'An email without a subject can’t become a work item' })
    const proj = await projectByKey(d, req, p.project ?? '', 'createIssues')
    const prio = header('priority') === 'high' ? 'high' : undefined          // mailparser reads X-Priority 1–2 and Importance: high as priority: high
    const assignee = p.ccAssignee ? await firstAssignable(d, h.workspaceId, proj.id, to) : undefined
    const issueId = await insertIssue(d, me, proj.id, {
      title: subject.slice(0, 500), description: text, ...(p.issueType ? { type: p.issueType } : {}), ...(prio && await hasPriority(d, h.workspaceId, prio) ? { priority: prio } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
    }, 'Created this work item from an email')
    if (m.messageId) await d.query('insert into mail_message_ids (message_id, issue_id) values ($1, $2) on conflict do nothing', [m.messageId, issueId])
    if (p.ccWatchers) for (const e of to) {
      const w = await meFor(d, h.workspaceId, e)
      if (w && await canJoinWork(d, proj.id, w.id)) await d.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [issueId, w.id])
    }
    await attach(d, me, issueId, m)
    const [{ k }] = await d.query<{ k: string }>(`select p.key || '-' || i.number as k from issues i join projects p on p.id = i.project_id where i.id = $1`, [issueId]) as any
    return out('created', { key: k })
  }).catch(async e => {
    if (!(e instanceof HttpError)) throw e                                     // trouble on our side: leave the message for next time
    return p.forwardEmail ? forward(h, m, e.message) : out('failed', { reason: e.message })
  })
}

const hasPriority = async (d: Db, ws: string, key: string) => (await d.query('select 1 from priorities where workspace_id = $1 and key = $2', [ws, key])).length > 0
async function firstAssignable(d: Db, ws: string, projectId: string, emails: string[]) {
  for (const e of emails) { const u = await meFor(d, ws, e); if (u && await canJoinWork(d, projectId, u.id)) return u.id }
  return undefined
}

/** R6: the email's files, when attachments are on and each fits the size limit (others are left out). */
async function attach(d: Db, me: Me, issueId: string, m: ParsedMail) {
  if (!m.attachments?.length || !filesBucket()) return
  const policy = await getSetting(me.workspaceId, 'attachments')
  if (!policy.enabled) return
  for (const a of m.attachments) {
    if (a.related || a.size > policy.maxSizeMb * 1024 * 1024) continue          // pictures inside the email's own HTML aren't attachments
    const name = (a.filename ?? 'attachment').replace(/[\\/"%:$?*<|>]/g, '_').slice(0, 255)
    const objectKey = `${me.workspaceId}/${issueId}/${randomUUID()}`
    await s3().send(new PutObjectCommand({ Bucket: filesBucket(), Key: objectKey, Body: a.content, ContentType: a.contentType }))
    await d.query('insert into attachments (issue_id, name, size, type, object_key, added_by, uploaded_at) values ($1, $2, $3, $4, $5, $6, now())',
      [issueId, name, a.size, a.contentType || 'application/octet-stream', objectKey, me.id])
  }
}

/** R5: tell the Forward Email address why a message wasn't handled. */
async function forward(h: MailHandler, m: ParsedMail, why: string): Promise<Outcome> {
  const s = await getSetting(h.workspaceId, 'email')
  const base = { messageId: m.messageId ?? '', subject: m.subject ?? '', from: addresses(m.from)[0] ?? '' }
  if (!h.params.forwardEmail || !s.enabled || !s.from) return { ...base, result: 'failed', reason: why }
  await sendEmail({ to: h.params.forwardEmail, from: s.from, subject: `[Strand] Couldn’t handle: ${m.subject ?? '(no subject)'}`.slice(0, 200),
    text: `The mail handler “${h.name}” couldn’t handle an email from ${base.from}: ${why}.\n\n${m.text ?? ''}`,
    html: `<p>The mail handler “${h.name}” couldn’t handle an email from ${base.from}: ${why}.</p><pre>${(m.text ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>` })
  return { ...base, result: 'forwarded', reason: why }
}

// —— Running a handler ——

const SHOWN = 50
/** R7: one run of a handler: every unread message, each dealt with once; one run per handler at a time, across servers. */
export async function runHandler(id: string) {
  const lock = await pool.connect()
  try {
    const { rows: [l] } = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [`mail.handler:${id}`])
    if (!l!.ok) return { skipped: 'This handler is running already' }
    try {
      const [h] = await db.query<MailHandler>('select * from mail_handlers where id = $1', [id])
      if (!h) return { skipped: 'gone' }
      const [s] = await db.query<MailServer>('select * from mail_servers where id = $1', [h.serverId])
      const outcomes: Outcome[] = []
      let error: string | null = null
      try {
        const box = await unread(s!)
        try {
          for (const msg of box.messages) {
            // as Jira's: a message that failed stays in the mailbox (unread) and is tried again next run
            try { const o = await handleMessage(h, msg.raw, s!); outcomes.push(o); if (o.result !== 'failed') await msg.done() }
            catch (e) { outcomes.push({ messageId: msg.id, subject: '', from: '', result: 'failed', reason: `Left for next time: ${e instanceof Error ? e.message : e}` }) }
          }
        } finally { await box.close() }
      } catch (e) { error = e instanceof Error ? e.message : String(e) }
      const result = { at: new Date().toISOString(), error, counts: Object.fromEntries(['created', 'commented', 'ignored', 'forwarded', 'failed'].map(k => [k, outcomes.filter(o => o.result === k).length])), messages: outcomes.slice(0, SHOWN) }
      await db.query('update mail_handlers set last_run_at = now(), last_result = $2 where id = $1', [id, JSON.stringify(result)])
      return result
    } finally { await lock.query('select pg_advisory_unlock(hashtext($1))', [`mail.handler:${id}`]) }
  } finally { lock.release() }
}

export async function scheduleHandler(d: Db, h: Pick<MailHandler, 'id' | 'workspaceId' | 'delayMinutes'>, now = false) {
  const runAt = new Date(Date.now() + (now ? 0 : h.delayMinutes * 60_000))
  return enqueue(d, 'mail.handler', { handlerId: h.id, scheduled: true }, { workspaceId: h.workspaceId, runAt, dedupeKey: `mail.handler:${h.id}`, maxAttempts: 1 })
}
export const runHandlerNow = (d: Db, h: Pick<MailHandler, 'id' | 'workspaceId'>, by: string) =>
  enqueue(d, 'mail.handler', { handlerId: h.id }, { workspaceId: h.workspaceId, createdBy: by, dedupeKey: `mail.handler-now:${h.id}`, maxAttempts: 1 })

registerJob('mail.handler', async (p: { handlerId: string; scheduled?: boolean }, job) => {
  if (p.scheduled) await db.query('update jobs set dedupe_key = null where id = $1', [job.id])   // so the next one can be queued
  const r = await runHandler(p.handlerId)
  const [h] = await db.query<MailHandler>('select id, workspace_id, delay_minutes from mail_handlers where id = $1 and enabled', [p.handlerId])
  if (p.scheduled && h) await scheduleHandler(db, h)
  return r
})

/** At start: every enabled handler has its next run queued. */
export async function startMailHandlers() {
  for (const h of await db.query<MailHandler>('select id, workspace_id, delay_minutes from mail_handlers where enabled')) await scheduleHandler(db, h)
}
