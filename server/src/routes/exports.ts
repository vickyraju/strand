// Print and XML export (spec 0608), as Jira's: a search, or one work item, as Jira's XML (RSS 0.92 with an item per work
// item), RSS (with or without comments), a printable list, Full content, or Word. Items are read as webhooks read them
// (Jira's REST shape), then only what the person may read is kept: comments limited to a role or group they're not in go.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { jiraIssue, lookups } from '../jiraShapes.ts'
import { issueByKey } from './issues.ts'
import { commentShown } from '../access.ts'
import { searchWhere, searchFilters, type SearchFilters } from './misc.ts'

const x = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Jira's XML dates: RFC 822, as "Wed, 11 Nov 2026 10:00:00 +0000". */
const rfc822 = (t: string | null | undefined) => (t ? new Date(t.replace('+0000', 'Z')).toUTCString().replace('GMT', '+0000') : '')

interface Item { id: string; key: string; fields: Record<string, any>; history: { at: string; who: string | null; field: string | null; from: string | null; to: string | null; text: string }[]; webLinks: { url: string; title: string }[]; customNames: Record<string, string> }

/** The items, in this order, as `me` may read them. */
async function load(d: Db, me: Me, ids: string[], full: boolean): Promise<Item[]> {
  const L = lookups(d)
  const out: Item[] = []
  for (const id of ids) {
    const j = await jiraIssue(d, L, id)
    if (!j) continue
    const f = j.fields as Record<string, any>
    // a comment limited to a role or group is kept only for those who may read it, as the API shows them (spec 0203 R4)
    const shown = new Set((await d.query<{ id: string }>(`select c.id from comments c where c.issue_id = $1 and ${commentShown(me, f.project.id, 2)}`, [id, me.id])).map(r => r.id))
    const keep = (f.comment?.comments ?? []).filter((c: any) => shown.has(c.id))
    f.comment = { ...f.comment, comments: keep, total: keep.length, maxResults: keep.length }
    const customNames = Object.fromEntries((await d.query<{ id: string; name: string }>('select f.id, f.name from field_defs f join issues i on i.project_id = f.project_id where i.id = $1', [id])).map(r => [`customfield_${r.id}`, r.name]))
    const history = full ? await d.query<any>(`select a.created_at as at, u.name as who, a.field, coalesce(a.from_string, a.from_value) as from, coalesce(a.to_string, a.to_value) as to, a.text
        from activity a left join users u on u.id = a.actor_id where a.issue_id = $1 order by a.created_at, a.id limit 500`, [id]) : []
    const webLinks = full ? await d.query<any>('select url, title from remote_links where issue_id = $1 order by created_at limit 200', [id]) : []
    out.push({ id: j.id, key: j.key, fields: f, history: history.map(r => ({ ...r, at: new Date(r.at).toISOString() })), webLinks, customNames })
  }
  return out
}

const person = (tag: string, u: any) => (u ? `<${tag} username="${x(u.name)}">${x(u.displayName)}</${tag}>` : `<${tag} username="-1">Unassigned</${tag}>`)
const time = (tag: string, s: number | null | undefined) => (s != null ? `<${tag} seconds="${s}">${Math.round(s / 60)}m</${tag}>` : '')

/** R2: Jira's XML (`rss` 0.92, an item per work item). */
export function toXml(items: Item[], base: string, title: string, total: number) {
  const link = (k: string) => (base ? `${base}/i/${k}` : '')
  const item = (i: Item) => {
    const f = i.fields
    const links = (f.issuelinks ?? []).reduce((m: Record<string, any>, l: any) => { (m[l.type.id] ??= { type: l.type, out: [], in: [] })[l.outwardIssue ? 'out' : 'in'].push(l.outwardIssue ?? l.inwardIssue); return m }, {})
    return `<item>
<title>[${x(i.key)}] ${x(f.summary)}</title>
<link>${x(link(i.key))}</link>
<project id="${x(f.project.id)}" key="${x(f.project.key)}">${x(f.project.name)}</project>
<description>${x(f.description ?? '')}</description>
<environment></environment>
<key id="${x(i.id)}">${x(i.key)}</key>
<summary>${x(f.summary)}</summary>
<type id="${x(f.issuetype.id)}">${x(f.issuetype.name)}</type>
${f.parent ? `<parent id="${x(f.parent.id)}">${x(f.parent.key)}</parent>\n` : ''}<priority id="${x(f.priority.id)}">${x(f.priority.name)}</priority>
<status id="${x(f.status.id)}" description="">${x(f.status.name)}</status>
<statusCategory id="${f.status.statusCategory.id}" key="${x(f.status.statusCategory.key)}" colorName="${x(f.status.statusCategory.colorName)}"/>
${f.resolution ? `<resolution id="${x(f.resolution.id)}">${x(f.resolution.name)}</resolution>` : '<resolution id="-1">Unresolved</resolution>'}
${person('assignee', f.assignee)}
${person('reporter', f.reporter)}
<labels>${(f.labels ?? []).map((l: string) => `<label>${x(l)}</label>`).join('')}</labels>
<created>${rfc822(f.created)}</created>
<updated>${rfc822(f.updated)}</updated>
${f.resolutiondate ? `<resolved>${rfc822(f.resolutiondate)}</resolved>\n` : ''}${(f.versions ?? []).map((v: any) => `<version>${x(v.name)}</version>\n`).join('')}${(f.fixVersions ?? []).map((v: any) => `<fixVersion>${x(v.name)}</fixVersion>\n`).join('')}${(f.components ?? []).map((c: any) => `<component>${x(c.name)}</component>\n`).join('')}<due>${f.duedate ? rfc822(f.duedate) : ''}</due>
<votes>${f.votes?.votes ?? 0}</votes>
<watches>${f.watches?.watchCount ?? 0}</watches>
${time('timeoriginalestimate', f.timeoriginalestimate)}${time('timeestimate', f.timeestimate)}${time('timespent', f.timespent)}${time('aggregatetimeoriginalestimate', f.aggregatetimeoriginalestimate)}${time('aggregatetimeremainingestimate', f.aggregatetimeestimate)}${time('aggregatetimespent', f.aggregatetimespent)}
<comments>${(f.comment?.comments ?? []).map((c: any) => `<comment id="${x(c.id)}" author="${x(c.author?.name)}" created="${rfc822(c.created)}">${x(c.body)}</comment>`).join('')}</comments>
<issuelinks>${Object.values(links).map((g: any) => `<issuelinktype id="${x(g.type.id)}"><name>${x(g.type.name)}</name>${g.out.length ? `<outwardlinks description="${x(g.type.outward)}">${g.out.map((o: any) => `<issuelink><issuekey id="${x(o.id)}">${x(o.key)}</issuekey></issuelink>`).join('')}</outwardlinks>` : ''}${g.in.length ? `<inwardlinks description="${x(g.type.inward)}">${g.in.map((o: any) => `<issuelink><issuekey id="${x(o.id)}">${x(o.key)}</issuekey></issuelink>`).join('')}</inwardlinks>` : ''}</issuelinktype>`).join('')}</issuelinks>
<subtasks>${(f.subtasks ?? []).map((s: any) => `<subtask id="${x(s.id)}">${x(s.key)}</subtask>`).join('')}</subtasks>
<customfields>${Object.entries(i.customNames).filter(([k]) => f[k] != null).map(([k, name]) => `<customfield id="${x(k)}" key="${x(k)}"><customfieldname>${x(name)}</customfieldname><customfieldvalues>${(Array.isArray(f[k]) ? f[k] : [f[k]]).map((v: any) => `<customfieldvalue>${x(typeof v === 'object' ? v.value ?? v.name ?? v.displayName ?? JSON.stringify(v) : v)}</customfieldvalue>`).join('')}</customfieldvalues></customfield>`).join('')}</customfields>
</item>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
<title>${x(title)}</title>
<link>${x(base)}</link>
<description>An XML representation of a search request</description>
<language>en-us</language>
<issue start="0" end="${items.length}" total="${total}"/>
<build-info><version>Strand</version></build-info>
${items.map(item).join('\n')}
</channel>
</rss>
`
}

/** R2: RSS: title, link, description, date; with comments, their comments. */
export function toRss(items: Item[], base: string, title: string, comments: boolean) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="0.92">
<channel>
<title>${x(title)}</title>
<link>${x(base)}</link>
<description>${x(title)}</description>
<language>en-us</language>
${items.map(i => `<item>
<title>[${x(i.key)}] ${x(i.fields.summary)}</title>
<link>${x(base ? `${base}/i/${i.key}` : '')}</link>
<description>${x(i.fields.description ?? '')}</description>
<pubDate>${rfc822(i.fields.created)}</pubDate>
<guid>${x(i.key)}</guid>
<author>${x(i.fields.reporter?.displayName ?? '')}</author>
${comments ? `<comments>${(i.fields.comment?.comments ?? []).map((c: any) => `<comment author="${x(c.author?.displayName)}" created="${rfc822(c.created)}">${x(c.body)}</comment>`).join('')}</comments>\n` : ''}</item>`).join('\n')}
</channel>
</rss>
`
}

const STYLE = `body{font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#1c1917;margin:24px}h1{font-size:18px}h2{font-size:15px;margin:24px 0 4px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d6d3d1;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f5f5f4}.muted{color:#78716c}pre{white-space:pre-wrap;font:inherit}.item{page-break-inside:avoid;margin-bottom:28px}`

/** R3, R4: Printable (a list) or Full content (each item whole), as one HTML page; Word gets the same as a .doc. */
export function toHtml(items: Item[], title: string, full: boolean, word = false) {
  const head = word ? `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${h(title)}</title><style>${STYLE}</style></head>`
    : `<!doctype html><html><head><meta charset="utf-8"><title>${h(title)}</title><style>${STYLE}</style></head>`
  const name = (u: any) => (u ? u.displayName : 'Unassigned')
  const list = `<table><tr><th>Key</th><th>Summary</th><th>Type</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr>${items.map(i =>
    `<tr><td>${h(i.key)}</td><td>${h(i.fields.summary)}</td><td>${h(i.fields.issuetype.name)}</td><td>${h(i.fields.status.name)}</td><td>${h(i.fields.priority.name)}</td><td>${h(name(i.fields.assignee))}</td><td>${h(rfc822(i.fields.updated))}</td></tr>`).join('')}</table>`
  const whole = items.map(i => {
    const f = i.fields
    const rows: [string, string][] = [['Type', f.issuetype.name], ['Status', f.status.name], ['Priority', f.priority.name], ['Resolution', f.resolution?.name ?? 'Unresolved'],
      ['Assignee', name(f.assignee)], ['Reporter', name(f.reporter)], ['Labels', (f.labels ?? []).join(', ')], ['Fix versions', (f.fixVersions ?? []).map((v: any) => v.name).join(', ')],
      ['Affects versions', (f.versions ?? []).map((v: any) => v.name).join(', ')], ['Components', (f.components ?? []).map((c: any) => c.name).join(', ')],
      ['Due', f.duedate ?? ''], ['Created', rfc822(f.created)], ['Updated', rfc822(f.updated)],
      ...Object.entries(i.customNames).filter(([k]) => f[k] != null).map(([k, n]) => [n, (Array.isArray(f[k]) ? f[k] : [f[k]]).map((v: any) => (typeof v === 'object' ? v.value ?? v.name ?? v.displayName ?? JSON.stringify(v) : v)).join(', ')] as [string, string])]
    return `<div class="item"><h2>${h(i.key)} ${h(f.summary)}</h2>
<table>${rows.filter(([, v]) => v !== '').map(([k, v]) => `<tr><th style="width:25%">${h(k)}</th><td>${h(v)}</td></tr>`).join('')}</table>
${f.description ? `<h3>Description</h3><pre>${h(f.description)}</pre>` : ''}
${(f.issuelinks ?? []).length ? `<h3>Links</h3><ul>${f.issuelinks.map((l: any) => `<li>${h(l.outwardIssue ? l.type.outward : l.type.inward)} ${h((l.outwardIssue ?? l.inwardIssue).key)} ${h((l.outwardIssue ?? l.inwardIssue).fields?.summary ?? '')}</li>`).join('')}</ul>` : ''}
${i.webLinks.length ? `<h3>Web links</h3><ul>${i.webLinks.map(w => `<li>${h(w.title)} <span class="muted">${h(w.url)}</span></li>`).join('')}</ul>` : ''}
${(f.comment?.comments ?? []).length ? `<h3>Comments</h3>${f.comment.comments.map((c: any) => `<p><b>${h(c.author?.displayName)}</b> <span class="muted">${h(rfc822(c.created))}</span></p><pre>${h(c.body)}</pre>`).join('')}` : ''}
${i.history.length ? `<h3>History</h3><table><tr><th>When</th><th>Who</th><th>What</th></tr>${i.history.map(r => `<tr><td>${h(rfc822(r.at))}</td><td>${h(r.who ?? 'Automation')}</td><td>${h(r.text)}${r.from != null || r.to != null ? `: ${h(r.from ?? 'None')} → ${h(r.to ?? 'None')}` : ''}</td></tr>`).join('')}</table>` : ''}
</div>`
  }).join('\n')
  return `${head}<body><h1>${h(title)}</h1><p class="muted">${items.length} work item${items.length === 1 ? '' : 's'}</p>${full ? whole : list}</body></html>`
}

const plugin: FastifyPluginAsyncZod = async app => {
  const T = ['Search & work']
  const base = async (me: Me) => ((await getSetting(me.workspaceId, 'email')).appUrl ?? '').replace(/\/$/, '')
  const send = (reply: any, body: string, type: string, file: string) =>
    reply.header('content-type', `${type}; charset=utf-8`).header('content-disposition', `attachment; filename="${file}"`).send(body)

  app.get('/search/export.:format', { schema: { tags: T, summary: 'A search as Jira’s XML, RSS (comments=1: with comments), Word (doc), or a printable page (html; full=1: Full content); at most the System settings limit',
    params: z.object({ format: z.enum(['xml', 'rss', 'doc', 'html']) }),
    querystring: z.object({ ...searchFilters, comments: z.enum(['0', '1']).default('0'), full: z.enum(['0', '1']).default('0') }) } }, async (req, reply) => {
    const { format } = req.params, q = req.query
    const args: unknown[] = []
    const { where, order } = await searchWhere(req.me, q as SearchFilters, args)
    const max = (await getSetting(req.me.workspaceId, 'searchAndBulk')).viewsMaxItems
    args.push(max + 1)
    const ids = (await db.query<{ id: string }>(`select i.id from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
      where ${where.join(' and ')} order by ${order ? `${order}, i.id` : 'i.updated_at desc, i.id desc'} limit $${args.length}`, args)).map(r => r.id)
    if (ids.length > max) throw new HttpError(400, `More than ${max.toLocaleString('en')} items match. Narrow the search and export again.`)
    const full = format === 'doc' || (format === 'html' && q.full === '1')
    const items = await load(db, req.me, ids, full)
    const title = q.jql ? `Strand: ${q.jql}` : 'Strand search'
    await audit(db, req, { action: `export.${format === 'html' ? (full ? 'full-content' : 'printable') : format}`, type: 'search', name: q.q || q.jql || null, after: { items: items.length, filters: q } })
    const day = new Date().toISOString().slice(0, 10)
    if (format === 'xml') return send(reply, toXml(items, await base(req.me), title, items.length), 'application/xml', `strand-search-${day}.xml`)
    if (format === 'rss') return send(reply, toRss(items, await base(req.me), title, q.comments === '1'), 'application/rss+xml', `strand-search-${day}.xml`)
    if (format === 'doc') return send(reply, toHtml(items, title, true, true), 'application/msword', `strand-search-${day}.doc`)
    return reply.header('content-type', 'text/html; charset=utf-8').send(toHtml(items, title, full))
  })

  app.get('/issues/:key/export.:format', { schema: { tags: T, summary: 'One work item as Jira’s XML, Word (doc), or its printable page (html)',
    params: z.object({ key: z.string(), format: z.enum(['xml', 'doc', 'html']) }) } }, async (req, reply) => {
    const i = await issueByKey(db, req, req.params.key, false, 'browse')
    const items = await load(db, req.me, [i.id], req.params.format !== 'xml')
    await audit(db, req, { action: `export.${req.params.format === 'html' ? 'printable' : req.params.format}`, type: 'issue', id: i.id, name: i.key, project: { id: i.projectId, key: i.key.split('-')[0]! } })
    const title = `${i.key} ${items[0]!.fields.summary}`
    if (req.params.format === 'xml') return send(reply, toXml(items, await base(req.me), title, 1), 'application/xml', `${i.key}.xml`)
    if (req.params.format === 'doc') return send(reply, toHtml(items, title, true, true), 'application/msword', `${i.key}.doc`)
    return reply.header('content-type', 'text/html; charset=utf-8').send(toHtml(items, title, true))
  })
}
export default plugin
