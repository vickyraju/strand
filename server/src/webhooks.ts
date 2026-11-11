// Outgoing webhooks (spec 0705), as Jira's: events in Jira's names and body shape, a JQL filter, URL variables, Exclude
// body. Better than Jira's: a change only queues its event (matching and sending are background jobs), failed calls are
// retried and shown, calls are signed, and a webhook can never reach the server's own network.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { db, type Db } from './db.ts'
import type { Me } from './auth.ts'
import { enqueue, registerJob } from './jobs.ts'
import { unseal } from './secrets.ts'
import { jqlToSql, parseOr400 } from './jqlSql.ts'
import { notifyEvent } from './routes/notificationSchemes.ts'
import { briefIssue, jiraChangelog, jiraComment, jiraIssue, jiraSprint, jiraUser, jiraVersion, jiraWorklog, lookups, type Change } from './jiraShapes.ts'

/** Every event Jira DC's webhooks offer (spec 0715 R1). */
export const EVENTS = [
  'jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'jira:worklog_updated',
  'comment_created', 'comment_updated', 'comment_deleted',
  'worklog_created', 'worklog_updated', 'worklog_deleted',
  'issuelink_created', 'issuelink_deleted',
  'project_created', 'project_updated', 'project_deleted',
  'jira:version_created', 'jira:version_updated', 'jira:version_released', 'jira:version_unreleased', 'jira:version_moved', 'jira:version_deleted',
  'user_created', 'user_updated', 'user_deleted',
  'option_voting_changed', 'option_watching_changed', 'option_unassigned_issues_changed', 'option_subtasks_changed', 'option_attachments_changed',
  'option_issuelinks_changed', 'option_timetracking_changed',
  'sprint_created', 'sprint_started', 'sprint_closed', 'sprint_updated', 'sprint_deleted',
  'board_created', 'board_updated', 'board_deleted', 'board_configuration_changed',
] as const
export type WebhookEvent = typeof EVENTS[number] | 'ping'
/** Events Strand never sends: nothing in Strand makes these changes (versions are ordered by date; these options can't be switched off). */
export const NEVER_SENT = new Set<string>(['jira:version_moved', 'option_watching_changed', 'option_unassigned_issues_changed',
  'option_subtasks_changed', 'option_issuelinks_changed', 'option_timetracking_changed'])
/** Events about one work item: the JQL filter applies to them all (R4; Jira's filter misses comments and work logs). */
const ISSUE_EVENTS = new Set<string>(['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'jira:worklog_updated', 'comment_created', 'comment_updated', 'comment_deleted',
  'worklog_created', 'worklog_updated', 'worklog_deleted', 'issuelink_created', 'issuelink_deleted'])
/** Jira's event behind an issue webhook (spec 0715 R3). */
export type IssueEventType = 'issue_created' | 'issue_updated' | 'issue_assigned' | 'issue_generic' | 'issue_commented' | 'issue_comment_edited' | 'issue_comment_deleted'
  | 'issue_worklogged' | 'issue_worklog_updated' | 'issue_worklog_deleted' | 'issue_deleted' | 'issue_moved' | 'issue_resolved' | 'issue_reopened'
const ATTEMPTS = 6                                                                   // the first and 5 retries (R6)

/** What an event is about: ids, loaded when the body is built. */
export interface Ref {
  issueId?: string; projectId?: string; commentId?: string; worklogId?: string; linkId?: string; versionId?: string; sprintId?: string; boardId?: string; userId?: string
  entity?: unknown
  /** What it was before (sprint_updated's oldValue) */
  old?: unknown
  /** The version a deleted one was merged into */
  mergedToId?: string
  /** Jira's event behind an issue webhook */
  type?: IssueEventType
  /** A transition's post function (Jira's `transition`), and the one webhook it triggers */
  transition?: Record<string, unknown>
  /** A setting switched (Jira's option events) */
  property?: { key: string; value: string }
  /** People this event doesn't notify (a comment's @mentioned, who hear about the mention instead) */
  notifyExcept?: string[]
}
export type ChangeItem = Change

// Most changes happen where nobody has a webhook: knowing that saves queueing a job per change (cached per server)
const any = new Map<string, { at: number; on: boolean }>()
export const forgetWebhookCache = () => any.clear()
async function hasWebhooks(d: Db, ws: string) {
  const c = any.get(ws)
  if (c && Date.now() - c.at < 10_000) return c.on
  const on = (await d.query('select 1 from webhooks where workspace_id = $1 and enabled limit 1', [ws])).length > 0
  any.set(ws, { at: Date.now(), on })
  return on
}

/** Queues an event, in the caller's transaction: a change that fails sends nothing (R6). The body is taken now, as the
 *  item is at this moment (as Jira's); matching webhooks and sending happen in background jobs. */
export async function emit(d: Db, ws: string, event: WebhookEvent, ref: Ref, actorId: string | null, changelog?: ChangeItem[], only?: string) {
  // the project's notification scheme hears every work item event too (spec 0605 R3); a post function's webhook is no new event
  if (ref.issueId && event.startsWith('jira:') && !only) {
    const type = ref.type ?? (event === 'jira:issue_created' ? 'issue_created' : event === 'jira:issue_deleted' ? 'issue_deleted' : 'issue_updated')
    const visibility = ref.commentId ? ((ref.entity as any)?.visibility ?? (await d.query<{ visibility: any }>('select visibility from comments where id = $1', [ref.commentId]))[0]?.visibility ?? null) : null
    await notifyEvent(d, type, ref.issueId, actorId, { visibility, except: ref.notifyExcept })
  }
  if (!(await hasWebhooks(d, ws))) return
  const at = Date.now()
  await enqueue(d, 'webhooks.event', { ws, event, ref, only, body: await body(d, ws, event, ref, actorId, changelog ?? null, at) }, { workspaceId: ws, maxAttempts: 3 })
}

/** A transition's "Trigger a webhook" post function (spec 0715 R6): that one webhook, as jira:issue_updated with Jira's `transition`. */
export async function triggerWebhook(d: Db, ws: string, webhookId: string, issueId: string, projectId: string, actorId: string | null, transition: Record<string, unknown>, changelog: ChangeItem[]) {
  await emit(d, ws, 'jira:issue_updated', { issueId, projectId, type: 'issue_generic', transition }, actorId, changelog, webhookId)
}

/** Configuration changes reach webhooks through their audit entries. */
const BOARD_CONFIG = new Set(['jql', 'columns', 'swimlanes', 'quickFilters', 'cardFields', 'estimation', 'kanbanBacklog', 'doneDays', 'workingDays'])
const FROM_AUDIT: Record<string, (after: any, before: any) => WebhookEvent[]> = {
  'project.created': () => ['project_created'], 'project.updated': () => ['project_updated'], 'project.key_changed': () => ['project_updated'],
  'project.category_changed': () => ['project_updated'], 'project.deleted': () => ['project_deleted'],
  'project.release.created': () => ['jira:version_created'], 'project.release.released': () => ['jira:version_released'],
  'project.release.updated': a => [a?.released === false ? 'jira:version_unreleased' : a?.released === true ? 'jira:version_released' : 'jira:version_updated'],
  'project.release.deleted': () => ['jira:version_deleted'],
  'board.created': () => ['board_created'], 'board.deleted': () => ['board_deleted'],
  // a board's name or admins is board_updated; its filter, columns and the rest is Jira's board_configuration_changed (spec 0715 R2)
  'board.updated': (a, b) => [
    ...(a?.name !== undefined || a?.changed?.includes('admins') ? ['board_updated' as const] : []),
    ...(a?.jql !== undefined || b?.jql !== undefined || a?.changed?.some((k: string) => BOARD_CONFIG.has(k)) ? ['board_configuration_changed' as const] : []),
  ],
  'user.created': () => ['user_created'], 'user.updated': () => ['user_updated'], 'user.anonymised': () => ['user_deleted'], 'sprint.deleted': () => ['sprint_deleted'],
  'settings.attachments.updated': (a, b) => (a?.enabled !== undefined && a.enabled !== b?.enabled ? ['option_attachments_changed'] : []),
  'settings.voting.updated': (a, b) => (a?.enabled !== undefined && a.enabled !== b?.enabled ? ['option_voting_changed'] : []),
}
export async function emitFromAudit(d: Db, ws: string | null, actorId: string | null, e: { action: string; type: string; id?: string | null; project?: { id: string } | null; before?: unknown; after?: unknown }) {
  const events = FROM_AUDIT[e.action]?.(e.after, e.before) ?? []
  if (!ws) return
  for (const event of events) {
    const ref: Ref = { projectId: e.project?.id, entity: e.before ?? e.after }
    if (event.startsWith('jira:version')) ref.versionId = e.id ?? undefined
    else if (event.startsWith('board')) ref.boardId = e.id ?? undefined
    else if (event.startsWith('user')) ref.userId = e.id ?? undefined
    else if (event.startsWith('sprint')) ref.sprintId = e.id ?? undefined
    else if (event.startsWith('project')) ref.projectId = e.id ?? e.project?.id
    else if (event === 'option_attachments_changed') ref.property = { key: 'jira.option.allowattachments', value: String((e.after as any).enabled) }
    else if (event === 'option_voting_changed') ref.property = { key: 'jira.option.voting', value: String((e.after as any).enabled) }
    await emit(d, ws, event, ref, actorId)
  }
}

// —— The body, in Jira's shape (spec 0705 R3, spec 0715 R4) ——

async function body(d: Db, ws: string, event: WebhookEvent, ref: Ref, actorId: string | null, changes: ChangeItem[] | null, at: number) {
  const L = lookups(d)
  const out: Record<string, unknown> = { timestamp: at, webhookEvent: event }
  const issueEvent = ISSUE_EVENTS.has(event) && !!ref.issueId
  if (issueEvent && (event.startsWith('jira:'))) out.issue_event_type_name = ref.type ?? (event === 'jira:issue_created' ? 'issue_created' : event === 'jira:issue_deleted' ? 'issue_deleted' : 'issue_updated')
  if (actorId) out.user = await L.user(actorId)
  // issue events carry the whole item; comment, work log and link events a short one (key, summary, status, priority, type)
  if (ref.issueId) out.issue = event.startsWith('jira:') ? await jiraIssue(d, L, ref.issueId) : await briefIssue(L, ref.issueId)
  if (changes?.length && ref.issueId) {
    const items = await jiraChangelog(d, L, ref.issueId, changes)
    if (items.length) out.changelog = { id: randomUUID(), items }
  }
  if (ref.transition) out.transition = ref.transition
  const row = async (sql: string, id?: string) => (id ? (await d.query<any>(sql, [id]))[0] ?? ref.entity ?? { id } : undefined)
  if (ref.commentId) out.comment = await jiraComment(L, await row('select * from comments where id = $1', ref.commentId), d)
  if (ref.worklogId) out.worklog = await jiraWorklog(L, await row('select * from worklogs where id = $1', ref.worklogId))
  if (ref.linkId) {
    const [from, to, type] = ref.linkId.split(':')
    const [t] = await d.query<any>('select id, name, inward, outward from link_types where workspace_id = $1 and id = $2', [ws, type])
    out.issueLink = { id: ref.linkId, sourceIssueId: from, destinationIssueId: to,
      issueLinkType: { id: type, name: t?.name ?? type, outwardName: t?.outward ?? type, inwardName: t?.inward ?? type, isSubTaskLinkType: false, isSystemLinkType: false }, systemLink: false }
  }
  if (ref.versionId) out.version = jiraVersion(await row('select * from releases where id = $1', ref.versionId))
  if (ref.mergedToId) out.mergedTo = jiraVersion(await row('select * from releases where id = $1', ref.mergedToId))
  if (ref.sprintId) out.sprint = jiraSprint(await row('select * from sprints where id = $1', ref.sprintId))
  if (ref.old && event === 'sprint_updated') out.oldValue = jiraSprint(ref.old)
  if (ref.boardId) {
    const b = await row('select * from boards where id = $1', ref.boardId)
    out.board = { id: b.id, self: null, name: b.name, type: b.type }
    if (event === 'board_configuration_changed') out.configuration = {
      id: b.id, name: b.name, self: null, filter: { id: b.id, self: null, query: b.jql ?? '' },
      columnConfig: { columns: (b.columns ?? []).map((c: any) => ({ name: c.name, statuses: (c.statusIds ?? []).map((id: string) => ({ id, self: null })), ...(c.min != null ? { min: c.min } : {}), ...(c.max != null ? { max: c.max } : {}) })),
        constraintType: (b.columns ?? []).some((c: any) => c.min != null || c.max != null) ? 'issueCount' : 'none' },
      estimation: { type: b.estimation === 'count' ? 'issueCount' : 'field', field: b.estimation === 'time' ? { fieldId: 'timeoriginalestimate', displayName: 'Original Time Estimate' } : b.estimation === 'field' ? { fieldId: `cf[${b.estimationFieldId}]` } : { displayName: 'Story Points' } },
      ranking: { rankCustomFieldId: null },
    }
  }
  if (ref.userId) {
    const [u] = await d.query<any>('select id, name, email, username, active from users where id = $1', [ref.userId])
    out.user = jiraUser(u)
  }
  if (ref.projectId && !ref.issueId) {
    const p = await row('select * from projects where id = $1', ref.projectId)
    out.project = { self: null, id: p.id, key: p.key, name: p.name, description: p.description ?? '', projectTypeKey: 'software', assigneeType: 'UNASSIGNED',
      ...(p.lead_id ? { projectLead: await L.user(p.lead_id) } : {}) }
  }
  if (ref.property) out.property = ref.property
  return out
}

/** URL variables (R2), from the body; each value encoded so it stays inside its part of the address. */
export function fillUrl(url: string, b: any) {
  const vars: Record<string, unknown> = {
    'issue.key': b.issue?.key, 'issue.id': b.issue?.id, 'project.key': b.issue?.fields?.project?.key ?? b.project?.key, 'project.id': b.issue?.fields?.project?.id ?? b.project?.id,
    'sprint.id': b.sprint?.id, 'version.id': b.version?.id, 'board.id': b.board?.id, 'modifiedUser.name': b.user?.name,
    'modifiedUser.key': b.user?.key, 'mergedVersion.id': b.mergedTo?.id,
  }
  return url.replace(/\$?\{([a-zA-Z.]+)\}/g, (m, k: string) => (k in vars ? encodeURIComponent(String(vars[k] ?? '')) : m))
}

// —— Where a webhook may call (R2) ——

const list = (v?: string) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const v4Private = (v4: string) => {
  const [x, y] = v4.split('.').map(Number) as [number, number]
  return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
    || (x === 100 && y >= 64 && y <= 127) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224
}
/** An IPv6 address as its eight 16-bit groups (`::` expanded, a trailing dotted IPv4 turned into two groups), or null. */
export function ipv6Groups(a: string): number[] | null {
  let s = a.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null
    const [p, q, r, t] = dotted[1]!.split('.').map(Number) as [number, number, number, number]
    s = s.slice(0, -dotted[1]!.length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string) => (x ? x.split(':') : [])
  const head = part(halves[0]!), tail = halves.length === 2 ? part(halves[1]!) : []
  const fill = 8 - head.length - tail.length
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map(g => parseInt(g, 16))
}
/** Loopback, link-local (cloud metadata), private, carrier-grade NAT, multicast and other special ranges, also when an
 *  IPv4 address hides inside IPv6 (mapped ::ffff:a.b.c.d in any spelling, compatible ::a.b.c.d, NAT64, 6to4). Anything
 *  that can't be read is treated as private. */
export function privateAddress(a: string): boolean {
  if (isIP(a) === 4) return v4Private(a)
  const g = ipv6Groups(a)
  if (!g) return true
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const zero = (n: number) => g.slice(0, n).every(x => x === 0)
  if (zero(5) && g[5] === 0xffff) return v4Private(v4(g[6]!, g[7]!))                    // IPv4-mapped
  if (zero(6)) return true                                                                // ::, ::1 and IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Private(v4(g[6]!, g[7]!))   // NAT64
  if (g[0] === 0x2002) return v4Private(v4(g[1]!, g[2]!))                                 // 6to4
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0xdb8)
}

/** Why this URL can't be a webhook's, or null (R2). */
export function urlProblem(raw: string): string | null {
  let u: URL
  try { u = new URL(raw.replace(/\$?\{[a-zA-Z.]+\}/g, 'x')) } catch { return 'Not a URL' }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (u.username || u.password) return 'Put no credentials in the URL'
  if (u.protocol === 'http:' && !list(process.env.STRAND_WEBHOOK_HTTP_HOSTS).includes(host)) return 'Use https:// (http is allowed only for hosts the server lists in STRAND_WEBHOOK_HTTP_HOSTS)'
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Use https://'
  if (isIP(host) && privateAddress(host) && !list(process.env.STRAND_WEBHOOK_PRIVATE_HOSTS).includes(host)) return 'This address is in a private network: the server must allow it (STRAND_WEBHOOK_PRIVATE_HOSTS)'
  if (['localhost', 'metadata.google.internal'].includes(host) && !list(process.env.STRAND_WEBHOOK_PRIVATE_HOSTS).includes(host)) return 'This address is the server’s own'
  return null
}

/** Sends one call. The address it connects to is checked when it is resolved, so a name can't point somewhere else between
 *  the check and the call; redirects aren't followed. */
function send(url: string, payload: string | null, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(url)
  const allowed = list(process.env.STRAND_WEBHOOK_PRIVATE_HOSTS)
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // an address written in the URL is connected to without a lookup: check it here
  if (isIP(host) && privateAddress(host) && !allowed.includes(host)) return Promise.reject(new Error(`${host} is a private address`))
  return new Promise((ok, fail) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', timeout: 10_000, headers: { ...headers, ...(payload !== null ? { 'content-length': String(Buffer.byteLength(payload)) } : { 'content-length': '0' }) },
      lookup: (name, opts, cb) => lookup(name, { ...opts, all: false }, (err, address, family) => {
        if (!err && privateAddress(address as string) && !allowed.includes(host) && !allowed.includes(address as string))
          return (cb as any)(new Error(`${name} resolves to a private address (${address})`))
        ;(cb as any)(err, address, family)
      }),
    }, res => {
      let text = ''
      res.setEncoding('utf8'); res.on('data', c => { if (text.length < 2000) text += c }); res.on('end', () => ok({ status: res.statusCode ?? 0, body: text.slice(0, 2000) }))
    })
    req.on('timeout', () => req.destroy(new Error('No answer within 10 seconds')))
    req.on('error', fail)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

export const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`
export const sign = (secret: string, payload: string) => `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`

/** Records a call and queues it (R6, R7). Keeps the last 50 per webhook. */
export async function queueCall(d: Db, hook: { id: string; workspaceId: string; url: string; excludeBody: boolean }, event: WebhookEvent, b: Record<string, unknown>) {
  const [c] = await d.query<{ id: string }>(
    `insert into webhook_calls (webhook_id, event, delivery_id, url, body) values ($1, $2, $3, $4, $5) returning id`,
    [hook.id, event, randomUUID(), fillUrl(hook.url, b), hook.excludeBody ? null : JSON.stringify(b)])
  await d.query(`delete from webhook_calls where webhook_id = $1 and id not in (select id from webhook_calls where webhook_id = $1 order by created_at desc limit 50)`, [hook.id])
  await enqueue(d, 'webhook.deliver', { callId: c!.id }, { workspaceId: hook.workspaceId, maxAttempts: ATTEMPTS })
  return c!.id
}

// The event: which webhooks want it, whether each one's JQL matches, then one call each
registerJob('webhooks.event', async (p: { ws: string; event: WebhookEvent; ref: Ref; body: Record<string, unknown>; only?: string }) => {
  // a transition's post function goes to its one webhook, whatever events it subscribes to (spec 0715 R6)
  const hooks = await db.query<{ id: string; workspaceId: string; url: string; jql: string | null; excludeBody: boolean }>(p.only
    ? `select id, workspace_id, url, jql, exclude_body from webhooks where workspace_id = $1 and enabled and id = $3 and $2::text is not null`
    : `select id, workspace_id, url, jql, exclude_body from webhooks where workspace_id = $1 and enabled and (cardinality(events) = 0 or $2 = any(events))`,
    p.only ? [p.ws, p.event, p.only] : [p.ws, p.event])
  if (!hooks.length) return { calls: 0 }
  const b = p.body
  const system = { id: (b.user as any)?.id ?? '00000000-0000-0000-0000-000000000000', workspaceId: p.ws, admin: true, role: 'admin', via: 'entra', email: 'webhooks', name: 'Webhooks' } as Me
  let calls = 0
  for (const h of hooks) {
    if (h.jql?.trim() && ISSUE_EVENTS.has(p.event) && p.ref.issueId) {
      const args: unknown[] = [p.ref.issueId]
      const sql = await jqlToSql(db, system, parseOr400(h.jql), args)
      const hit = await db.query(`select 1 from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id where i.id = $1 ${sql.where ? `and (${sql.where})` : ''}`, args)
      if (!hit.length) continue
    }
    await queueCall(db, h, p.event, b); calls++
  }
  return { calls }
})

registerJob('webhook.deliver', async (p: { callId: string }, job) => {
  const [c] = await db.query<{ id: string; webhookId: string; event: string; deliveryId: string; url: string; body: string | null; enabled: boolean; secretEnc: Buffer }>(
    `select c.id, c.webhook_id, c.event, c.delivery_id, c.url, c.body::text as body, w.enabled, w.secret_enc
       from webhook_calls c join webhooks w on w.id = c.webhook_id where c.id = $1`, [p.callId])
  if (!c || (!c.enabled && c.event !== 'ping')) return { skipped: 'The webhook is gone or disabled' }   // R8
  const problem = urlProblem(c.url)
  const record = (status: number | null, error: string | null, done: boolean) => db.query(
    `update webhook_calls set attempts = $2, status_code = $3, error = $4, state = $5, finished_at = case when $5 <> 'retrying' then now() end where id = $1`,
    [c.id, job.attempts, status, error, done ? (error ? 'failed' : 'delivered') : 'retrying'])
  if (problem) { await record(null, problem, true); return { failed: problem } }
  const payload = c.body
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': 'Strand-Webhooks/1', 'x-strand-webhook-id': c.webhookId, 'x-strand-delivery': c.deliveryId, 'x-strand-event': c.event,
    'x-strand-signature': sign(unseal(c.secretEnc, c.webhookId), payload ?? ''),
  }
  try {
    const r = await send(c.url, payload, headers)
    if (r.status >= 200 && r.status < 300) { await record(r.status, null, true); return { status: r.status } }
    throw Object.assign(new Error(`Answered ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ''}`), { status: r.status })
  } catch (e) {
    const last = job.attempts >= ATTEMPTS
    await record((e as { status?: number }).status ?? null, String((e as Error).message).slice(0, 500), last)
    if (last) return { failed: (e as Error).message }
    throw e                                                                          // the job retries with growing waits
  }
})
