// Jira DC importer (spec 0802): reads a Jira Data Center through its REST (GET only, an administrator's token) and writes
// its projects into the app, keeping keys, people, dates and history. A dry run reads the same and writes nothing. What was
// imported is remembered (jira_import_map), so a run can be repeated: nothing is imported twice, links wait for their items.
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { checkedLookup } from './checkedLookup.ts'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { db, tx, type Db } from './db.ts'
import { registerJob } from './jobs.ts'
import { unseal } from './secrets.ts'
import { getSetting } from './settings.ts'
import { s3, filesBucket } from './storage.ts'
import { applyScheme } from './workflows.ts'
import { firstBoard } from './boards.ts'
import { withOptionIds } from './fields.ts'
import { ipv6Groups } from './webhooks.ts'
import { wikiToMarkdown } from './shared/jiraWiki.ts'

export interface Conn { url: string; token: string }
type J = any

/** Cloud metadata services (link-local, fd00:ec2::254, 100.100.100.200), in any spelling, IPv4-mapped too: never a Jira.
 *  A company's Jira DC is usually on its private network, so private addresses are allowed: an administrator chooses it. */
export function metadataAddress(a: string): boolean {
  const v4 = (x: string) => x.startsWith('169.254.') || x === '100.100.100.200'
  if (isIP(a) === 4) return v4(a)
  const g = ipv6Groups(a.toLowerCase())
  if (!g) return true                                                          // can't be read: refused
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`)
  return (g[0]! & 0xffc0) === 0xfe80 || (g[0] === 0xfd00 && g[1] === 0xec2 && g.slice(2, 7).every(x => x === 0) && g[7] === 0x254)
}
export async function checkJiraUrl(url: string) {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Jira’s address must be http or https')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host.toLowerCase() === 'metadata.google.internal' || (isIP(host) && metadataAddress(host))) throw new Error('That address isn’t a Jira')
}

/** A GET to Jira, connecting only to an address checked as it's resolved (so a name can't change between check and call);
 *  redirects aren't followed. */
const pinnedFetch = (url: string, init: { headers: Record<string, string> }): Promise<Response> => new Promise((ok, fail) => {
  const u = new URL(url)
  const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', headers: init.headers, timeout: 60_000,
    lookup: checkedLookup((address, name) => metadataAddress(address) ? `${name} resolves to a cloud metadata address` : null) as any,
  }, res => {
    const parts: Buffer[] = []
    res.on('data', c => parts.push(c)); res.on('error', fail)
    res.on('end', () => ok(new Response([204, 304].includes(res.statusCode ?? 0) ? null : Buffer.concat(parts), { status: res.statusCode ?? 0 })))
  })
  req.on('timeout', () => req.destroy(new Error('Jira didn’t answer within 60 seconds')))
  req.on('error', fail)
  req.end()
})

/** Jira's REST, read-only. Only ever to the configured Jira: a URL in an answer from another origin is refused, and
 *  redirects aren't followed, so the token goes nowhere else. */
export function jira(c: Conn, fetchImpl: (url: string, init: any) => Promise<Response> = pinnedFetch) {
  const base = c.url.replace(/\/+$/, ''), origin = new URL(base).origin
  const headers = { authorization: `Bearer ${c.token}`, accept: 'application/json' }
  const at = (path: string) => {
    if (!/^https?:\/\//i.test(path)) return `${base}${path}`
    if (new URL(path).origin !== origin) throw new Error(`Jira pointed to another address (${new URL(path).origin}): not followed`)
    return path
  }
  const send = async (path: string, h: Record<string, string>) => {
    const r = await fetchImpl(at(path), { headers: h, redirect: 'manual' })
    if (r.status >= 300 && r.status < 400) throw new Error(`Jira redirected ${path.split('?')[0]} elsewhere: not followed`)
    if (!r.ok) throw new Error(`Jira answered ${r.status} for ${path.split('?')[0]}`)
    return r
  }
  const get = async (path: string): Promise<J> => (await send(path, headers)).json()
  const bytes = async (url: string) => Buffer.from(await (await send(url, { authorization: headers.authorization })).arrayBuffer())
  /** An issue search, a page at a time. */
  async function* issues(key: string, fields: string, expand = '') {
    for (let at = 0; ; at += 100) {
      const page = await get(`/rest/api/2/search?jql=${encodeURIComponent(`project = "${key}" ORDER BY key ASC`)}&startAt=${at}&maxResults=100&fields=${fields}${expand ? `&expand=${expand}` : ''}`)
      yield* page.issues as J[]
      if (at + page.issues.length >= page.total || !page.issues.length) break
    }
  }
  return { get, bytes, issues }
}
type Jira = ReturnType<typeof jira>

export async function testConnection(c: Conn, fetchImpl?: (url: string, init: any) => Promise<Response>) {
  await checkJiraUrl(c.url)
  const j = jira(c, fetchImpl)
  const [s, me] = await Promise.all([j.get('/rest/api/2/serverInfo'), j.get('/rest/api/2/myself')])
  return { version: s.version as string, title: (s.serverTitle ?? '') as string, user: (me.displayName ?? me.name) as string }
}

// —— Mapping ——

const CATEGORY: Record<string, 'todo' | 'in-progress' | 'done'> = { new: 'todo', indeterminate: 'in-progress', done: 'done' }
const COLOR = { todo: '#64748b', 'in-progress': '#2563eb', done: '#16a34a' }
const BUILTIN_TYPES: Record<string, string> = { epic: 'epic', story: 'story', task: 'task', bug: 'bug', 'sub-task': 'task', subtask: 'task', initiative: 'initiative' }
/** Jira's custom field types the app has (spec 0801's map), and Jira Software's fields the app keeps as its own. */
const KIND: Record<string, string> = Object.fromEntries(Object.entries({
  textfield: 'text', textarea: 'textarea', float: 'number', datepicker: 'date', datetime: 'datetime', select: 'select', multiselect: 'multiselect', radiobuttons: 'radio',
  multicheckboxes: 'checkboxes', cascadingselect: 'cascading', labels: 'labels', url: 'url', userpicker: 'user', multiuserpicker: 'users', grouppicker: 'group',
  multigrouppicker: 'groups', project: 'project', version: 'version', multiversion: 'versions', readonlyfield: 'readonly',
}).map(([k, v]) => [`com.atlassian.jira.plugin.system.customfieldtypes:${k}`, v]))
const SOFTWARE: Record<string, string> = {
  'com.pyxis.greenhopper.jira:gh-sprint': 'sprint', 'com.pyxis.greenhopper.jira:gh-epic-link': 'epicLink', 'com.pyxis.greenhopper.jira:gh-epic-status': 'epicStatus',
  'com.pyxis.greenhopper.jira:gh-epic-color': 'epicColor', 'com.pyxis.greenhopper.jira:gh-lexo-rank': 'rank', 'com.pyxis.greenhopper.jira:gh-epic-label': 'epicName',
  'com.atlassian.jira.plugin.system.customfieldtypes:jira-story-points': 'storyPoints',
  // Advanced Roadmaps (spec 0803 R7): the Parent Link, and its target dates as Start and Due date
  'com.atlassian.jpo:jpo-custom-field-parent': 'parentLink', 'com.atlassian.jpo:jpo-custom-field-baseline-start': 'targetStart', 'com.atlassian.jpo:jpo-custom-field-baseline-end': 'targetEnd',
}
/** Jira's field names for its own fields that live as custom fields (Story Points and Flagged are named, not typed, in Jira DC). */
const NAMED: Record<string, string> = { 'story points': 'storyPoints', flagged: 'flagged' }

interface Field { id: string; name: string; type: string; kind?: string; software?: string }
async function fieldsOf(j: Jira): Promise<Field[]> {
  return (await j.get('/rest/api/2/field')).filter((f: J) => f.custom).map((f: J) => {
    const type = f.schema?.custom ?? ''
    return { id: f.id, name: f.name, type, kind: KIND[type], software: SOFTWARE[type] ?? NAMED[String(f.name).toLowerCase()] }
  })
}

/** What a dry run and an import both read about a project. */
async function readProject(j: Jira, key: string) {
  const p = await j.get(`/rest/api/2/project/${encodeURIComponent(key)}?expand=lead,description`)
  const statusesByType = await j.get(`/rest/api/2/project/${encodeURIComponent(key)}/statuses`)
  const statuses = new Map<string, { id: string; name: string; category: 'todo' | 'in-progress' | 'done' }>()
  for (const t of statusesByType) for (const s of t.statuses) statuses.set(String(s.id), { id: String(s.id), name: s.name, category: CATEGORY[s.statusCategory?.key] ?? 'todo' })
  const issueTypes = (p.issueTypes ?? []).map((t: J) => ({ id: String(t.id), name: String(t.name), subtask: !!t.subtask }))
  const versions = await j.get(`/rest/api/2/project/${encodeURIComponent(key)}/versions`)
  const components = await j.get(`/rest/api/2/project/${encodeURIComponent(key)}/components`)
  const boards: J[] = []; const sprints = new Map<string, J>()
  try {
    for (let at = 0; ; at += 50) {
      const page = await j.get(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(key)}&startAt=${at}&maxResults=50`)
      boards.push(...page.values)
      if (page.isLast || !page.values.length) break
    }
    for (const b of boards.filter(b => b.type === 'scrum'))
      for (let at = 0; ; at += 50) {
        const page = await j.get(`/rest/agile/1.0/board/${b.id}/sprint?startAt=${at}&maxResults=50`)
        for (const s of page.values) if (!s.originBoardId || s.originBoardId === b.id) sprints.set(String(s.id), s)
        if (page.isLast || !page.values.length) break
      }
  } catch { /* Jira without Jira Software: no boards or sprints */ }
  let roles: { name: string; actors: J[] }[] = []
  try {
    const urls = await j.get(`/rest/api/2/project/${encodeURIComponent(key)}/role`)
    roles = await Promise.all(Object.entries(urls).map(async ([name, url]) => ({ name, actors: (await j.get(String(url))).actors ?? [] })))
  } catch { /* the token can't read roles: the importer joins the project alone */ }
  const total = (await j.get(`/rest/api/2/search?jql=${encodeURIComponent(`project = "${key}"`)}&maxResults=0`)).total as number
  return { project: p, statuses: [...statuses.values()], issueTypes, versions, components, boards, sprints: [...sprints.values()], roles, total }
}

// —— The id map ——

const mapped = async (d: Db, ws: string, kind: string, jiraId: string | number | null | undefined) =>
  jiraId == null ? null : (await d.query<{ localId: string }>('select local_id from jira_import_map where workspace_id = $1 and kind = $2 and jira_id = $3', [ws, kind, String(jiraId)]))[0]?.localId ?? null
const remember = (d: Db, ws: string, kind: string, jiraId: string | number, localId: string) =>
  d.query('insert into jira_import_map (workspace_id, kind, jira_id, local_id) values ($1, $2, $3, $4) on conflict (workspace_id, kind, jira_id) do update set local_id = excluded.local_id', [ws, kind, String(jiraId), localId])

/** R5: a Jira user as a local person: matched by email, else made deactivated in the internal directory. */
async function personFor(d: Db, ws: string, u: J | null | undefined, make = true): Promise<string | null> {
  if (!u) return null
  const jid = String(u.key ?? u.name ?? u.accountId ?? '')
  if (!jid) return null
  const known = await mapped(d, ws, 'user', jid)
  if (known) return known
  const email = String(u.emailAddress ?? '').trim().toLowerCase()
  const [match] = email ? await d.query<{ id: string }>('select id from users where lower(email) = $1', [email]) : []
  if (match) { await remember(d, ws, 'user', jid, match.id); await d.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [ws, match.id]); return match.id }
  if (!make) return null
  const name = String(u.displayName ?? u.name ?? 'Jira user')
  const initials = name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'
  const [made] = await d.query<{ id: string }>(`insert into users (email, name, initials, username, active) values ($1, $2, $3, $4, false) returning id`,
    [email || `${jid.replace(/[^a-z0-9._-]/gi, '_')}@jira-import.invalid`, name, initials, u.name ?? null])
  await d.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [ws, made!.id])
  await remember(d, ws, 'user', jid, made!.id)
  return made!.id
}

/** Jira's wiki markup as the app's Markdown (spec 0805), a mention [~username] named after the person as imported. */
async function markdownOf(d: Db, ws: string, wiki: string): Promise<string> {
  if (!wiki) return ''
  const names = [...new Set([...wiki.matchAll(/\[~([^\]|]+)\]/g)].map(m => m[1]!))]
  const people = names.length ? await d.query<{ u: string; name: string }>(
    `select x.u, coalesce((select u.name from jira_import_map m join users u on u.id::text = m.local_id where m.workspace_id = $1 and m.kind = 'user' and m.jira_id = x.u),
                          (select u.name from users u where lower(u.username) = lower(x.u) limit 1)) as name
       from unnest($2::text[]) x(u)`, [ws, names]) : []
  const known = new Map(people.filter(p => p.name).map(p => [p.u, p.name]))
  return wikiToMarkdown(wiki, { person: u => known.get(u) })
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'type'
const ymd = (t: string | null | undefined) => (t ? String(t).slice(0, 10) : null)

// —— Dry run (R2) ——

export async function dryRun(d: Db, ws: string, j: Jira, keys: string[]) {
  const fields = await fieldsOf(j)
  const report: J = { projects: [], people: { matched: 0, new: 0, examples: [] as string[] }, leftOut: [] as string[] }
  const people = new Map<string, J>()
  const known = async (sql: string, args: unknown[]) => (await d.query(sql, args)).length > 0
  for (const key of keys) {
    try {
      const r = await readProject(j, key)
      const [taken] = await d.query<{ id: string }>('select p.id from projects p where p.workspace_id = $1 and p.key = $2', [ws, key])
      const ours = taken && (await mapped(d, ws, 'project', r.project.id)) === taken.id
      const entry: J = { key, name: r.project.name, workItems: r.total, versions: r.versions.length, components: r.components.length, sprints: r.sprints.length,
        stop: taken && !ours ? `${key} is already a Jira Build POC project` : null, statuses: [], issueTypes: [], priorities: new Set(), resolutions: new Set(), customFields: new Set() }
      for (const s of r.statuses) entry.statuses.push({ name: s.name, existing: await known('select 1 from wf_statuses where workspace_id = $1 and lower(name) = lower($2)', [ws, s.name]) })
      for (const t of r.issueTypes) entry.issueTypes.push({ name: t.name, existing: !!BUILTIN_TYPES[t.name.toLowerCase()] })
      for await (const i of j.issues(key, 'assignee,reporter,priority,resolution,comment,' + fields.map(f => f.id).join(','))) {
        for (const u of [i.fields.assignee, i.fields.reporter, ...(i.fields.comment?.comments ?? []).map((c: J) => c.author)]) if (u) people.set(String(u.key ?? u.name), u)
        if (i.fields.priority) entry.priorities.add(i.fields.priority.name)
        if (i.fields.resolution) entry.resolutions.add(i.fields.resolution.name)
        for (const f of fields) if (i.fields[f.id] != null) entry.customFields.add(f.id)
      }
      const prio = [...entry.priorities] as string[], res = [...entry.resolutions] as string[]
      entry.priorities = await Promise.all(prio.map(async n => ({ name: n, existing: await known('select 1 from priorities where workspace_id = $1 and lower(name) = lower($2)', [ws, n]) })))
      entry.resolutions = await Promise.all(res.map(async n => ({ name: n, existing: await known('select 1 from resolutions where workspace_id = $1 and lower(name) = lower($2)', [ws, n]) })))
      entry.customFields = await Promise.all([...entry.customFields as Set<string>].map(async id => {
        const f = fields.find(x => x.id === id)!
        if (f.software) return { name: f.name, as: 'Jira Build POC’s own' }
        if (!f.kind) { report.leftOut.push(`${key}: ${f.name} (${f.type || 'unknown type'})`); return { name: f.name, as: 'left out' } }
        return { name: f.name, as: (await known('select 1 from custom_fields where workspace_id = $1 and lower(name) = lower($2) and kind = $3', [ws, f.name, f.kind])) ? 'existing' : 'new' }
      }))
      report.projects.push(entry)
    } catch (e) { report.projects.push({ key, stop: e instanceof Error ? e.message : String(e) }) }
  }
  for (const u of people.values()) {
    const email = String(u.emailAddress ?? '').toLowerCase()
    if (email && (await d.query('select 1 from users where lower(email) = $1', [email])).length) report.people.matched++
    else { report.people.new++; if (report.people.examples.length < 20) report.people.examples.push(u.displayName ?? u.name) }
  }
  return report
}

// —— Import (R3–R7) ——

interface Ctx { d: Db; ws: string; by: string | null; j: Jira; fields: Field[]; progress: (n: string) => Promise<void> }

/** R3: the project, its workflow and scheme, statuses, types, versions, components, sprints and members. */
async function importProject(c: Ctx, key: string) {
  const { d, ws } = c
  const r = await readProject(c.j, key)
  const existing = await mapped(d, ws, 'project', r.project.id)
  if (existing) return { r, projectId: existing }
  if ((await d.query('select 1 from projects where workspace_id = $1 and key = $2', [ws, key])).length) throw new Error(`${key} is already a Jira Build POC project`)
  // statuses (the app's of the same name, or new), one workflow with each reachable from any, in a scheme of its own
  const ids: string[] = []
  for (const [n, s] of r.statuses.entries()) {
    let [g] = await d.query<{ id: string }>('select id from wf_statuses where workspace_id = $1 and lower(name) = lower($2)', [ws, s.name])
    if (!g) [g] = await d.query<{ id: string }>('insert into wf_statuses (workspace_id, name, color, category, position) values ($1, $2, $3, $4, $5) returning id', [ws, s.name, COLOR[s.category], s.category, 100 + n])
    ids.push(g!.id); await remember(d, ws, `status:${key}`, s.id, g!.id)
  }
  const todoFirst = [...ids].sort((a, b) => Number(r.statuses[ids.indexOf(b)]!.category === 'todo') - Number(r.statuses[ids.indexOf(a)]!.category === 'todo'))
  const transitions = todoFirst.map(id => ({ id: randomUUID(), name: r.statuses[ids.indexOf(id)]!.name, fromIds: null, toId: id, rules: {} }))
  const [wf] = await d.query<{ id: string }>(`insert into workflows (workspace_id, name, description, statuses, transitions) values ($1, $2, $3, $4, $5) returning id`,
    [ws, `${key} workflow (imported)`, `Jira’s statuses for ${key}; every status reachable from any (spec 0802)`, todoFirst, JSON.stringify(transitions)])
  const [sc] = await d.query<{ id: string }>(`insert into workflow_schemes (workspace_id, name, description, default_workflow_id) values ($1, $2, $3, $4) returning id`,
    [ws, `${key} scheme (imported)`, `Imported from Jira (spec 0802)`, wf!.id])
  const template = r.boards.some(b => b.type === 'scrum') ? 'scrum' : 'kanban'
  const lead = await personFor(d, ws, r.project.lead)
  const [p] = await d.query<{ id: string }>(`insert into projects (workspace_id, key, name, description, template, lead_id, workflow_scheme_id) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [ws, key, r.project.name, r.project.description ?? '', template, lead ?? c.by, sc!.id])
  const pid = p!.id
  await remember(d, ws, 'project', r.project.id, pid)
  // members: Jira's roles (Administrators: admin, others: member), people and groups by name
  for (const u of new Set([c.by, lead].filter(Boolean) as string[])) await d.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, 'admin', $3) on conflict do nothing`, [pid, u, c.by])
  for (const role of r.roles) {
    const as = /administrator/i.test(role.name) ? 'admin' : 'member'
    for (const a of role.actors) {
      if (a.type === 'atlassian-group-role-actor') {
        const [g] = await d.query<{ id: string }>('select id from groups where lower(display_name) = lower($1)', [a.name])
        if (g) await d.query(`insert into project_group_roles (project_id, group_id, role, added_by) values ($1, $2, $3, $4) on conflict do nothing`, [pid, g.id, as, c.by])
      } else {
        // a role's people come without their email: Jira says it, so they're matched rather than made
        const full = await c.j.get(`/rest/api/2/user?username=${encodeURIComponent(a.name)}`).catch(() => null)
        const u = await personFor(d, ws, full ?? { key: a.name, name: a.name, displayName: a.displayName })
        if (u) await d.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, $3, $4) on conflict (project_id, user_id) do nothing`, [pid, u, as, c.by])
      }
    }
  }
  if (r.issueTypes.some((t: { name: string }) => t.name.toLowerCase() === 'initiative')) {             // Jira's Initiative type: the project's initiatives on (spec 0803)
    await d.query('select seed_initiative_type($1)', [pid]); await d.query('update projects set initiatives = true where id = $1', [pid])
  }
  await applyScheme(d, { me: { id: c.by ?? '', email: 'jira-import', workspaceId: ws } as any, ip: undefined } as any, pid)
  await firstBoard(d, { id: pid, workspaceId: ws, key, template }, c.by)
  // work types: the app's for Epic, Story, Task, Bug and Sub-task; the project's own for the rest
  for (const t of r.issueTypes) {
    const builtin = BUILTIN_TYPES[t.name.toLowerCase()]
    if (builtin) { await remember(d, ws, `type:${key}`, t.id, builtin); continue }
    const [have] = await d.query<{ key: string }>('select key from work_types where project_id = $1 and lower(name) = lower($2)', [pid, t.name])
    const tk = have?.key ?? `t-${slug(t.name).replace(/-/g, '').slice(0, 20).padEnd(6, '0')}${randomUUID().slice(0, 4)}`
    if (!have) await d.query(`insert into work_types (project_id, key, name, color, icon, position) values ($1, $2, $3, '#64748b', 'square', 100) on conflict do nothing`, [pid, tk, t.name])
    await remember(d, ws, `type:${key}`, t.id, tk)
  }
  for (const v of r.versions) {
    const [row] = await d.query<{ id: string }>(`insert into releases (workspace_id, project_id, name, description, start_date, release_date, released, released_at, archived)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [ws, pid, v.name, v.description ?? '', ymd(v.startDate), ymd(v.releaseDate), !!v.released, v.released ? ymd(v.releaseDate) : null, !!v.archived])
    await remember(d, ws, 'version', v.id, row!.id)
  }
  for (const k of r.components) {
    const [row] = await d.query<{ id: string }>('insert into components (project_id, name, description, lead_id) values ($1, $2, $3, $4) returning id',
      [pid, k.name, k.description ?? '', await personFor(d, ws, k.lead)])
    await remember(d, ws, 'component', k.id, row!.id)
  }
  const [board] = await d.query<{ id: string }>('select id from boards where project_id = $1 order by created_at limit 1', [pid])
  let active = false
  const { parallel } = await getSetting(ws, 'sprints')
  for (const s of [...r.sprints].sort((a, b) => (a.state === 'active' ? -1 : 0) - (b.state === 'active' ? -1 : 0))) {
    const state = s.state === 'active' && (!active || parallel) ? 'active' : s.state === 'future' ? 'planned' : 'closed'   // one active per board unless parallel sprints are on (spec 0414)
    if (state === 'active') active = true
    const [row] = await d.query<{ id: string }>(`insert into sprints (workspace_id, project_id, board_id, name, goal, state, started_at, ends_at, completed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ws, pid, board?.id ?? null, s.name, s.goal ?? '', state, s.startDate ?? null, s.endDate ?? null, s.completeDate ?? (state === 'closed' && s.state === 'active' ? new Date().toISOString() : null)])
    await remember(d, ws, 'sprint', s.id, row!.id)
  }
  return { r, projectId: pid }
}

/** A custom field for this project: the app's of the same name and kind, or a new one with a context for the project. */
async function fieldFor(c: Ctx, f: Field, projectId: string, values: J[]) {
  const known = await mapped(c.d, c.ws, `field:${projectId}`, f.id)
  if (known) return known
  const options = ['select', 'multiselect', 'radio', 'checkboxes', 'cascading'].includes(f.kind!)
  const names = new Map<string, { name: string; parent?: string }>()
  if (options) for (const v of values.flat()) if (v?.value) { names.set(v.value, { name: v.value }); if (v.child?.value) names.set(`${v.value}|${v.child.value}`, { name: v.child.value, parent: v.value }) }
  let [cf] = await c.d.query<{ id: string }>('select id from custom_fields where workspace_id = $1 and lower(name) = lower($2) and kind = $3', [c.ws, f.name, f.kind])
  if (!cf) [cf] = await c.d.query<{ id: string }>('insert into custom_fields (workspace_id, name, kind, description, created_by) values ($1, $2, $3, $4, $5) returning id', [c.ws, f.name, f.kind, `Imported from Jira (${f.id})`, c.by])
  if (!(await c.d.query('select 1 from field_contexts where field_id = $1 and (project_ids is null or $2 = any(project_ids))', [cf!.id, projectId])).length) {
    const tops = withOptionIds([...names.values()].filter(o => !o.parent).map(o => ({ name: o.name })))
    const kids = withOptionIds([...names.values()].filter(o => o.parent).map(o => ({ name: o.name, parentId: tops.find(t => t.name === o.parent)!.id })))
    await c.d.query('insert into field_contexts (field_id, name, project_ids, options) values ($1, $2, $3, $4)', [cf!.id, `Imported for ${f.name}`, [projectId], options ? JSON.stringify([...tops, ...kids]) : null])
  }
  await remember(c.d, c.ws, `field:${projectId}`, f.id, cf!.id)
  return cf!.id
}

/** A Jira value as the app stores it for this kind (spec 0502). */
async function valueFor(c: Ctx, kind: string, v: J): Promise<unknown> {
  if (v == null) return null
  const many = async (xs: J[], one: (x: J) => Promise<unknown>) => (await Promise.all(xs.map(one))).filter(x => x != null)
  switch (kind) {
    case 'number': return typeof v === 'number' ? v : Number(v)
    case 'date': return ymd(v)
    case 'datetime': return new Date(v).toISOString()
    case 'select': case 'radio': return v.value ?? null
    case 'multiselect': case 'checkboxes': return (v as J[]).map(x => x.value).filter(Boolean)
    case 'cascading': return v.child?.value ? [v.value, v.child.value] : [v.value]
    case 'labels': return v
    case 'user': return personFor(c.d, c.ws, v)
    case 'users': return many(v, x => personFor(c.d, c.ws, x))
    case 'group': return (await c.d.query<{ id: string }>('select id from groups where lower(display_name) = lower($1)', [v.name]))[0]?.id ?? null
    case 'groups': return many(v, async x => (await c.d.query<{ id: string }>('select id from groups where lower(display_name) = lower($1)', [x.name]))[0]?.id ?? null)
    case 'project': return mapped(c.d, c.ws, 'project', v.id)
    case 'version': return mapped(c.d, c.ws, 'version', v.id)
    case 'versions': return many(v, x => mapped(c.d, c.ws, 'version', x.id))
    default: return typeof v === 'string' ? v : String(v.value ?? v.name ?? JSON.stringify(v))
  }
}

/** Jira's changelog field → the app's history field, and how to read its values. */
const HISTORY: Record<string, string> = {
  status: 'statusId', assignee: 'assigneeId', reporter: 'reporterId', priority: 'priority', resolution: 'resolution', summary: 'title', description: 'description',
  issuetype: 'type', duedate: 'dueDate', labels: 'labels', 'fix version': 'fixReleaseIds', version: 'affectsReleaseIds', component: 'componentIds', sprint: 'sprintId',
  'story points': 'estimate', timeoriginalestimate: 'timeEstimate', timeestimate: 'timeRemaining', 'epic link': 'parentId', parent: 'parentId', key: 'key', flagged: 'flagged',
}

/** R4: one work item with everything that belongs to it. */
async function importIssue(c: Ctx, key: string, pid: string, i: J, ranks: [string, string][]) {
  const { d, ws } = c
  if (await mapped(d, ws, 'issue', i.id)) return false
  const f = i.fields
  const soft = (name: string) => c.fields.find(x => x.software === name && f[x.id] != null)
  const typeKey = (await mapped(d, ws, `type:${key}`, f.issuetype?.id)) ?? 'task'
  const statusGlobal = await mapped(d, ws, `status:${key}`, f.status?.id)
  const [st] = await d.query<{ id: string }>('select id from statuses where project_id = $1 and global_status_id = $2', [pid, statusGlobal])
  const [first] = st ? [st] : await d.query<{ id: string }>('select id from statuses where project_id = $1 order by position limit 1', [pid])
  const priority = f.priority ? await priorityFor(d, ws, f.priority.name) : null
  const resolution = f.resolution ? await resolutionFor(d, ws, f.resolution.name) : null
  const sprintField = soft('sprint'), sprints = sprintField ? (f[sprintField.id] as J[]).map(s => (typeof s === 'string' ? /id=(\d+)/.exec(s)?.[1] : s.id)).filter(Boolean) : []
  const sprint = sprints.length ? await mapped(d, ws, 'sprint', sprints.at(-1)) : null
  const custom: Record<string, unknown> = {}
  for (const fld of c.fields.filter(x => x.kind && f[x.id] != null && !x.software)) {
    const id = await fieldFor(c, fld, pid, [f[fld.id]])
    const raw = await valueFor(c, fld.kind!, f[fld.id])
    const v = fld.kind === 'textarea' && typeof raw === 'string' ? await markdownOf(d, ws, raw) : raw      // Jira's wiki markup (spec 0805)
    if (v != null && !(Array.isArray(v) && !v.length)) {
      custom[id] = v
      // an option seen for the first time joins the field's options
      if (['select', 'radio', 'multiselect', 'checkboxes', 'cascading'].includes(fld.kind!)) await addOptions(d, id, pid, fld.kind!, v)
    }
  }
  const num = Number(String(i.key).split('-').pop())
  const sp = soft('storyPoints'), flagged = soft('flagged'), epicStatus = soft('epicStatus'), epicColor = soft('epicColor'), rank = soft('rank')
  const tStart = soft('targetStart'), tEnd = soft('targetEnd'), pLink = soft('parentLink')
  const [row] = await d.query<{ id: string }>(`insert into issues (workspace_id, project_id, number, type, title, description, status_id, priority, resolution, resolved_at, assignee_id, reporter_id,
      labels, estimate, time_estimate, time_remaining, due_date, sprint_id, component_ids, fix_release_ids, affects_release_ids, custom, flagged, epic_status, epic_color, rank, created_at, updated_at, start_date)
    values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, (select key from priorities where workspace_id = $1 and is_default)), $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, 0, $26, $27, $28) returning id`, [
    ws, pid, num, typeKey, String(f.summary ?? '').slice(0, 500), await markdownOf(d, ws, f.description ?? ''), first!.id, priority, resolution, resolution ? f.resolutiondate ?? null : null,
    await personFor(d, ws, f.assignee), await personFor(d, ws, f.reporter ?? f.creator), f.labels ?? [], sp ? Number(f[sp.id]) : null,
    f.timeoriginalestimate != null ? Math.round(f.timeoriginalestimate / 60) : null, f.timeestimate != null ? Math.round(f.timeestimate / 60) : null, ymd(f.duedate) ?? (tEnd ? ymd(f[tEnd.id]) : null), sprint,
    (await Promise.all((f.components ?? []).map((x: J) => mapped(d, ws, 'component', x.id)))).filter(Boolean),
    (await Promise.all((f.fixVersions ?? []).map((x: J) => mapped(d, ws, 'version', x.id)))).filter(Boolean),
    (await Promise.all((f.versions ?? []).map((x: J) => mapped(d, ws, 'version', x.id)))).filter(Boolean),
    JSON.stringify(custom), !!(flagged && f[flagged.id]?.length), typeKey === 'epic' ? (epicStatus ? f[epicStatus.id]?.value ?? 'To Do' : 'To Do') : null,
    typeKey === 'epic' && epicColor ? String(f[epicColor.id] ?? '') || null : null, f.created ?? new Date().toISOString(), f.updated ?? f.created ?? new Date().toISOString(),
    tStart ? ymd(f[tStart.id]) : null])
  const id = row!.id
  await remember(d, ws, 'issue', i.id, id)
  // its Parent Link: made once the initiative is in (it may be in a project imported later)
  const link = pLink ? f[pLink.id] : null, target = link?.data?.id ?? link?.id ?? (typeof link === 'string' || typeof link === 'number' ? link : null)
  if (typeKey === 'epic' && target != null) await remember(d, ws, 'parent-link-wanted', id, String(target))
  await remember(d, ws, 'issue-key', i.key, id)
  if (rank) ranks.push([id, String(f[rank.id])])
  else ranks.push([id, String(num).padStart(12, '0')])
  // history: created, then each change as the app's own field where it has one (reports read them)
  await d.query(`insert into activity (issue_id, actor_id, text, created_at) values ($1, $2, 'Created this work item', $3)`, [id, await personFor(d, ws, f.creator ?? f.reporter), f.created ?? new Date().toISOString()])
  for (const h of i.changelog?.histories ?? []) {
    const who = await personFor(d, ws, h.author)
    for (const it of h.items ?? []) {
      const field = HISTORY[String(it.field).toLowerCase()] ?? null
      const val = async (raw: string | null, str: string | null) => {
        if (field === 'statusId') { const g = await mapped(d, ws, `status:${key}`, raw); return g ? (await d.query<{ id: string }>('select id from statuses where project_id = $1 and global_status_id = $2', [pid, g]))[0]?.id ?? null : null }
        if (field === 'assigneeId' || field === 'reporterId') return raw ? personFor(d, ws, { key: raw, name: raw, displayName: str ?? raw }) : null
        if (field === 'priority') return str ? priorityFor(d, ws, str) : null
        if (field === 'fixReleaseIds' || field === 'affectsReleaseIds') return raw ? mapped(d, ws, 'version', raw) : null
        if (field === 'componentIds') return raw ? mapped(d, ws, 'component', raw) : null
        if (field === 'sprintId') return raw ? mapped(d, ws, 'sprint', String(raw).split(',').pop()!.trim()) : null
        if (field === 'parentId') return raw ? mapped(d, ws, 'issue', raw) : null
        if (field === 'timeEstimate' || field === 'timeRemaining') return raw != null ? String(Math.round(Number(raw) / 60)) : null
        if (field === 'type') return raw ? mapped(d, ws, `type:${key}`, raw) : null
        return str ?? raw
      }
      await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, from_string, to_string, text, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, who, field, await val(it.from, it.fromString), await val(it.to, it.toString), it.fromString ?? null, it.toString ?? null, `Changed ${String(it.field).toLowerCase()}`, h.created])
    }
  }
  // comments (author, dates, visibility), work logs, watchers, votes, web links, attachments
  const comments = f.comment && f.comment.total > (f.comment.comments ?? []).length ? (await c.j.get(`/rest/api/2/issue/${i.key}/comment?maxResults=1000`)).comments : f.comment?.comments ?? []
  for (const cm of comments) {
    const vis = cm.visibility ? (cm.visibility.type === 'group'
      ? (async () => { const [g] = await d.query<{ id: string }>('select id from groups where lower(display_name) = lower($1)', [cm.visibility.value]); return g ? { kind: 'group', id: g.id } : { kind: 'role', role: 'admin' } })()
      : { kind: 'role', role: /administrator/i.test(cm.visibility.value) ? 'admin' : 'member' }) : null
    const [cr] = await d.query<{ id: string }>('insert into comments (issue_id, author_id, body, created_at, edited_at, visibility) values ($1, $2, $3, $4, $5, $6) returning id',
      [id, await personFor(d, ws, cm.author), await markdownOf(d, ws, cm.body ?? ''), cm.created, cm.updated && cm.updated !== cm.created ? cm.updated : null, vis ? JSON.stringify(await vis) : null])
    await remember(d, ws, 'comment', cm.id, cr!.id)
  }
  const worklogs = f.worklog && f.worklog.total > (f.worklog.worklogs ?? []).length ? (await c.j.get(`/rest/api/2/issue/${i.key}/worklog`)).worklogs : f.worklog?.worklogs ?? []
  for (const w of worklogs)
    await d.query('insert into worklogs (issue_id, user_id, minutes, date, note, created_at) values ($1, $2, $3, $4, $5, $6)',
      [id, await personFor(d, ws, w.author), Math.max(1, Math.round((w.timeSpentSeconds ?? 0) / 60)), ymd(w.started), w.comment ?? '', w.created ?? w.started])
  if (f.watches?.watchCount) for (const u of (await c.j.get(`/rest/api/2/issue/${i.key}/watchers`)).watchers ?? [])
    await d.query('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [id, await personFor(d, ws, u)])
  if (f.votes?.votes) for (const u of (await c.j.get(`/rest/api/2/issue/${i.key}/votes`)).voters ?? [])
    await d.query('insert into issue_votes (issue_id, user_id) values ($1, $2) on conflict do nothing', [id, await personFor(d, ws, u)])
  for (const l of await c.j.get(`/rest/api/2/issue/${i.key}/remotelink`).catch(() => []))
    if (/^https?:\/\//i.test(String(l.object?.url ?? '')))                         // web links only (as remote links take them)
      await d.query(`insert into remote_links (issue_id, global_id, url, title, summary, relationship, application, icon, status, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
        [id, l.globalId ?? null, l.object?.url, String(l.object?.title ?? l.object?.url ?? '').slice(0, 255), l.object?.summary ?? null, l.relationship ?? null,
          l.application ? JSON.stringify(l.application) : null, l.object?.icon ? JSON.stringify(l.object.icon) : null, l.object?.status ? JSON.stringify(l.object.status) : null, c.by])
  if ((f.attachment ?? []).length && filesBucket()) {
    const max = (await getSetting(ws, 'attachments')).maxSizeMb * 1024 * 1024
    for (const a of f.attachment) {
      if (a.size > max) continue
      const objectKey = `${ws}/${id}/${randomUUID()}`
      await s3().send(new PutObjectCommand({ Bucket: filesBucket(), Key: objectKey, Body: await c.j.bytes(a.content), ContentType: a.mimeType }))
      await d.query('insert into attachments (issue_id, name, size, type, object_key, added_by, added_at, uploaded_at) values ($1, $2, $3, $4, $5, $6, $7, now())',
        [id, String(a.filename).slice(0, 255), a.size, a.mimeType ?? 'application/octet-stream', objectKey, await personFor(d, ws, a.author), a.created])
    }
  }
  // links: made now if the other item is in, else when it comes (R6)
  for (const l of f.issuelinks ?? []) if (l.outwardIssue) {
    const type = await linkTypeFor(d, ws, l.type)
    const other = await mapped(d, ws, 'issue', l.outwardIssue.id)
    if (other) await d.query('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing', [id, other, type])
    else await d.query('insert into jira_import_links (workspace_id, issue_id, jira_target, type_id) values ($1, $2, $3, $4) on conflict do nothing', [ws, id, String(l.outwardIssue.id), type])
  }
  return true
}

async function addOptions(d: Db, fieldId: string, projectId: string, kind: string, v: unknown) {
  const [ctx] = await d.query<{ id: string; options: { id: string; name: string; parentId?: string }[] | null }>('select id, options from field_contexts where field_id = $1 and (project_ids is null or $2 = any(project_ids)) order by project_ids is null limit 1', [fieldId, projectId])
  if (!ctx) return
  const opts = [...(ctx.options ?? [])]
  const add = (name: string, parentId?: string) => {
    const have = opts.find(o => o.name === name && (o.parentId ?? null) === (parentId ?? null))
    if (have) return have.id
    const o = { id: randomUUID(), name, disabled: false, ...(parentId ? { parentId } : {}) }
    opts.push(o); return o.id
  }
  if (kind === 'cascading') { const [p, ch] = v as string[]; const pid = add(p!); if (ch) add(ch, pid) }
  else for (const n of (Array.isArray(v) ? v : [v]) as string[]) add(n)
  if (opts.length !== (ctx.options ?? []).length) await d.query('update field_contexts set options = $2 where id = $1', [ctx.id, JSON.stringify(opts)])
}

async function priorityFor(d: Db, ws: string, name: string) {
  const [p] = await d.query<{ key: string }>('select key from priorities where workspace_id = $1 and lower(name) = lower($2)', [ws, name])
  if (p) return p.key
  const key = `p-${randomUUID().replace(/-/g, '').slice(0, 10)}`
  await d.query(`insert into priorities (workspace_id, key, name, color, icon, position) values ($1, $2, $3, '#64748b', 'minus', (select coalesce(max(position), 0) + 1 from priorities where workspace_id = $1))`, [ws, key, name])
  return key
}
async function resolutionFor(d: Db, ws: string, name: string) {
  if (!(await d.query('select 1 from resolutions where workspace_id = $1 and lower(name) = lower($2)', [ws, name])).length)
    await d.query(`insert into resolutions (workspace_id, name, position) values ($1, $2, (select coalesce(max(position), 0) + 1 from resolutions where workspace_id = $1))`, [ws, name])
  return (await d.query<{ name: string }>('select name from resolutions where workspace_id = $1 and lower(name) = lower($2)', [ws, name]))[0]!.name
}
async function linkTypeFor(d: Db, ws: string, t: J) {
  const [have] = await d.query<{ id: string }>('select id from link_types where workspace_id = $1 and lower(name) = lower($2)', [ws, t.name])
  if (have) return have.id
  const id = `j-${slug(t.name)}`.slice(0, 40)
  await d.query(`insert into link_types (workspace_id, id, name, outward, inward, position) values ($1, $2, $3, $4, $5, 100) on conflict do nothing`, [ws, id, t.name, t.outward ?? t.name, t.inward ?? t.name])
  return id
}

/** R6: links whose other item has been imported since are made now. */
const linkWaiting = async (ws: string) => {
  // Parent Links (spec 0803 R7) whose initiative is in now
  await db.query(`with ready as (delete from jira_import_map w using jira_import_map m where w.workspace_id = $1 and w.kind = 'parent-link-wanted'
      and m.workspace_id = w.workspace_id and m.kind = 'issue' and m.jira_id = w.local_id returning w.jira_id::uuid as epic, m.local_id::uuid as initiative)
    update issues i set parent_link_id = ready.initiative from ready, issues t where i.id = ready.epic and t.id = ready.initiative and t.type = 'initiative'`, [ws])
  return linkWaitingLinks(ws)
}
const linkWaitingLinks = (ws: string) => db.query(`with ready as (delete from jira_import_links l using jira_import_map m where l.workspace_id = $1 and m.workspace_id = l.workspace_id and m.kind = 'issue' and m.jira_id = l.jira_target
    returning l.issue_id, m.local_id::uuid as target_id, l.type_id)
  insert into issue_links (issue_id, target_id, type) select issue_id, target_id, type_id from ready on conflict do nothing`, [ws])

/** R7: Jira's counts and the app's, side by side (links waiting for an item not imported yet count as accounted for). */
async function reconcile(d: Db, ws: string, pid: string, jira: Record<string, number>) {
  const one = async (sql: string) => (await d.query<{ n: number }>(sql, [pid]))[0]!.n
  const ours: Record<string, number> = {
    workItems: await one('select count(*)::int as n from issues where project_id = $1'),
    comments: await one('select count(*)::int as n from comments c join issues i on i.id = c.issue_id where i.project_id = $1'),
    worklogs: await one('select count(*)::int as n from worklogs w join issues i on i.id = w.issue_id where i.project_id = $1'),
    attachments: await one('select count(*)::int as n from attachments a join issues i on i.id = a.issue_id where i.project_id = $1'),
    links: await one(`select (select count(*) from issue_links l join issues i on i.id = l.issue_id where i.project_id = $1)
      + (select count(*) from jira_import_links w join issues i on i.id = w.issue_id where i.project_id = $1)::int as n`),
    versions: await one('select count(*)::int as n from releases where project_id = $1'),
    components: await one('select count(*)::int as n from components where project_id = $1'),
    sprints: await one('select count(*)::int as n from sprints where project_id = $1'),
  }
  const waiting = (await d.query<{ n: number }>('select count(*)::int as n from jira_import_links w join issues i on i.id = w.issue_id where i.project_id = $1', [pid]))[0]!.n
  return Object.keys(ours).map(k => ({ what: k, jira: jira[k] ?? null, ours: ours[k], same: jira[k] == null || jira[k] === ours[k],
    ...(k === 'links' && waiting ? { note: `${waiting} waiting for items in projects not imported yet` } : {}) }))
}

/** One run: a dry run's report, or an import, project after project (R6). */
export async function runImport(runId: string, progress: (s: string) => Promise<void> = async () => {}) {
  const [run] = await db.query<any>('select * from jira_imports where id = $1', [runId])
  if (!run) return { skipped: 'gone' }
  await db.query(`update jira_imports set status = 'running' where id = $1`, [runId])
  const j = jira({ url: run.url, token: unseal(run.tokenEnc, run.id) })
  try {
    await checkJiraUrl(run.url)
    let report: J
    if (run.dryRun) report = await dryRun(db, run.workspaceId, j, run.projectKeys)
    else {
      const fields = await fieldsOf(j)
      report = { projects: [] }
      for (const key of run.projectKeys) {
        const entry: J = { key }
        try {
          const counts = { workItems: 0, comments: 0, worklogs: 0, attachments: 0, links: 0, versions: 0, components: 0, sprints: 0 }
          const { r, projectId } = await tx(d => importProject({ d, ws: run.workspaceId, by: run.createdBy, j, fields, progress }, key))
          Object.assign(counts, { workItems: r.total, versions: r.versions.length, components: r.components.length, sprints: r.sprints.length })
          const ranks: [string, string][] = []
          let n = 0, added = 0
          for await (const i of j.issues(key, '*all', 'changelog')) {
            counts.comments += i.fields.comment?.total ?? 0; counts.worklogs += i.fields.worklog?.total ?? 0
            counts.attachments += filesBucket() ? (i.fields.attachment ?? []).length : 0
            counts.links += (i.fields.issuelinks ?? []).filter((l: J) => l.outwardIssue).length
            if (await tx(d => importIssue({ d, ws: run.workspaceId, by: run.createdBy, j, fields, progress }, key, projectId, i, ranks))) added++
            if (++n % 50 === 0) await progress(`${key}: ${n} of ${r.total}`)
          }
          await tx(async d => {
            // sub-tasks under their parent, epics' items under their epic (Epic Link), in Jira's order
            for await (const i of j.issues(key, `parent,${fields.filter(f => f.software === 'epicLink').map(f => f.id).join(',')}`)) {
              const epicLink = fields.find(f => f.software === 'epicLink' && i.fields[f.id])
              const parent = i.fields.parent ? await mapped(d, run.workspaceId, 'issue', i.fields.parent.id)
                : epicLink ? await mapped(d, run.workspaceId, 'issue-key', i.fields[epicLink.id]) : null
              if (parent) await d.query('update issues set parent_id = $2 where id = $1 and parent_id is null', [await mapped(d, run.workspaceId, 'issue', i.id), parent])
            }
            const base = (await d.query<{ m: number }>('select coalesce(max(rank), 0) as m from issues where workspace_id = $1', [run.workspaceId]))[0]!.m
            for (const [k, [id]] of ranks.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).entries()) await d.query('update issues set rank = $2 where id = $1', [id, base + (k + 1) * 1024])
            await d.query('update projects set next_number = greatest(next_number, (select coalesce(max(number), 0) + 1 from issues where project_id = $1)) where id = $1', [projectId])
          })
          await linkWaiting(run.workspaceId)
          entry.added = added
          entry.reconciliation = await reconcile(db, run.workspaceId, projectId, counts)
        } catch (e) { entry.error = e instanceof Error ? e.message : String(e) }
        report.projects.push(entry)
      }
      report.waitingLinks = (await db.query<{ n: number }>('select count(*)::int as n from jira_import_links where workspace_id = $1', [run.workspaceId]))[0]!.n
    }
    await db.query(`update jira_imports set status = 'done', report = $2, finished_at = now() where id = $1`, [runId, JSON.stringify(report)])
    return { done: true }
  } catch (e) {
    await db.query(`update jira_imports set status = 'failed', report = $2, finished_at = now() where id = $1`, [runId, JSON.stringify({ error: e instanceof Error ? e.message : String(e) })])
    return { failed: e instanceof Error ? e.message : String(e) }
  }
}

registerJob('jira.import', async (p: { runId: string }, job) =>
  runImport(p.runId, async s => { await db.query('update jobs set progress = $2 where id = $1', [job.id, JSON.stringify({ text: s })]).catch(() => {}) }))
