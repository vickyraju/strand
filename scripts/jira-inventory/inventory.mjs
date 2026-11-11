#!/usr/bin/env node
// Jira inventory (spec 0801): what a Jira Data Center holds, and what of it Strand takes as it is, by its own name, or not
// yet. The product owner runs it against their Jira; it only reads (GET), sends nothing anywhere else, and writes two files
// where it's run: jira-inventory.json (everything counted) and jira-inventory.md (the report).
//
//   JIRA_URL=https://jira.example.com JIRA_TOKEN=<personal access token> node scripts/jira-inventory/inventory.mjs [--out dir]
//   (or JIRA_USER and JIRA_PASSWORD instead of JIRA_TOKEN)
//
// A Jira administrator's token sees everything; a lesser one is fine too: what it can't read is reported as such.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Jira's custom field types → Strand's (spec 0502), or Strand's own field for Jira Software's and Xray's. */
export const FIELD_TYPES = {
  'com.atlassian.jira.plugin.system.customfieldtypes:textfield': 'text', 'com.atlassian.jira.plugin.system.customfieldtypes:textarea': 'textarea',
  'com.atlassian.jira.plugin.system.customfieldtypes:float': 'number', 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker': 'date',
  'com.atlassian.jira.plugin.system.customfieldtypes:datetime': 'datetime', 'com.atlassian.jira.plugin.system.customfieldtypes:select': 'select',
  'com.atlassian.jira.plugin.system.customfieldtypes:multiselect': 'multiselect', 'com.atlassian.jira.plugin.system.customfieldtypes:radiobuttons': 'radio',
  'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes': 'checkboxes', 'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect': 'cascading',
  'com.atlassian.jira.plugin.system.customfieldtypes:labels': 'labels', 'com.atlassian.jira.plugin.system.customfieldtypes:url': 'url',
  'com.atlassian.jira.plugin.system.customfieldtypes:userpicker': 'user', 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker': 'users',
  'com.atlassian.jira.plugin.system.customfieldtypes:grouppicker': 'group', 'com.atlassian.jira.plugin.system.customfieldtypes:multigrouppicker': 'groups',
  'com.atlassian.jira.plugin.system.customfieldtypes:project': 'project', 'com.atlassian.jira.plugin.system.customfieldtypes:version': 'version',
  'com.atlassian.jira.plugin.system.customfieldtypes:multiversion': 'versions', 'com.atlassian.jira.plugin.system.customfieldtypes:readonlyfield': 'readonly',
  'com.atlassian.jira.plugin.system.customfieldtypes:importid': 'readonly',
  'com.pyxis.greenhopper.jira:gh-sprint': 'Strand: Sprint', 'com.pyxis.greenhopper.jira:gh-epic-link': 'Strand: Parent (epic)',
  'com.pyxis.greenhopper.jira:gh-epic-label': 'Strand: the epic’s summary', 'com.pyxis.greenhopper.jira:gh-epic-status': 'Strand: Epic Status',
  'com.pyxis.greenhopper.jira:gh-epic-color': 'Strand: Epic colour', 'com.pyxis.greenhopper.jira:gh-lexo-rank': 'Strand: Rank',
  'com.atlassian.jira.plugin.system.customfieldtypes:jira-story-points': 'Strand: Story points',
  'com.atlassian.jpo:jpo-custom-field-parent': 'Strand: Parent Link (plans, spec 0803)', 'com.atlassian.jpo:jpo-custom-field-baseline-start': 'Strand: Start date',
  'com.atlassian.jpo:jpo-custom-field-baseline-end': 'Strand: Due date', 'com.atlassian.jpo:jpo-custom-field-team': 'Not yet: teams and capacity (spec 0803, B+)',
}
/** Strand's testing (Xray) covers Xray's own fields. */
const XRAY = 'com.xpandit.plugins.xray'
/** Apps whose work Strand does itself (the rest are listed for the product owner to decide). */
export const APPS_COVERED = {
  'com.xpandit.plugins.xray': 'Strand’s testing (Xray’s tests, plans and executions)', 'com.pyxis.greenhopper.jira': 'Strand’s boards, sprints and reports',
  'com.atlassian.jira.plugins.jira-development-integration-plugin': 'Strand’s development panel (spec 0707)',
}

/** Read-only calls to Jira, with paging; a section that fails is reported, the others carry on. */
export async function inventory({ baseUrl, headers, fetch = globalThis.fetch, log = () => {} }) {
  const base = baseUrl.replace(/\/+$/, '')
  const get = async path => {
    const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json', ...headers } })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''}`.trim())
    return r.json()
  }
  const out = { generatedAt: new Date().toISOString(), jira: {}, totals: {}, projects: [], issueTypes: [], statuses: [], priorities: [], resolutions: [], linkTypes: [],
    customFields: [], workflows: [], schemes: {}, boards: { total: 0, scrum: 0, kanban: 0 }, apps: [], unreadable: {} }
  const section = async (name, fn) => { log(`Reading ${name}…`); try { await fn() } catch (e) { out.unreadable[name] = e instanceof Error ? e.message : String(e) } }

  await section('server info', async () => { const s = await get('/rest/api/2/serverInfo'); out.jira = { version: s.version, deploymentType: s.deploymentType ?? 'Server', title: s.serverTitle ?? '' } })
  await section('projects', async () => {
    const ps = await get('/rest/api/2/project?includeArchived=true&expand=lead')
    for (const p of ps) {
      const row = { key: p.key, name: p.name, type: p.projectTypeKey, archived: !!p.archived, lead: p.lead?.displayName ?? null, issues: null, versions: null, components: null }
      try { row.issues = (await get(`/rest/api/2/search?jql=${encodeURIComponent(`project = "${p.key}"`)}&maxResults=0`)).total } catch { /* archived projects can't be searched */ }
      try { row.versions = (await get(`/rest/api/2/project/${encodeURIComponent(p.key)}/versions`)).length } catch { }
      try { row.components = (await get(`/rest/api/2/project/${encodeURIComponent(p.key)}/components`)).length } catch { }
      out.projects.push(row)
    }
  })
  await section('issues', async () => { out.totals.issues = (await get('/rest/api/2/search?jql=&maxResults=0')).total })
  await section('issue types', async () => { out.issueTypes = (await get('/rest/api/2/issuetype')).map(t => ({ name: t.name, subtask: !!t.subtask })) })
  await section('statuses', async () => { out.statuses = (await get('/rest/api/2/status')).map(s => ({ name: s.name, category: s.statusCategory?.key ?? null })) })
  await section('priorities', async () => { out.priorities = (await get('/rest/api/2/priority')).map(p => p.name) })
  await section('resolutions', async () => { out.resolutions = (await get('/rest/api/2/resolution')).map(r => r.name) })
  await section('link types', async () => { out.linkTypes = (await get('/rest/api/2/issueLinkType')).issueLinkTypes.map(t => ({ name: t.name, outward: t.outward, inward: t.inward })) })
  await section('fields', async () => {
    for (const f of (await get('/rest/api/2/field')).filter(f => f.custom)) {
      const type = f.schema?.custom ?? ''
      out.customFields.push({ id: f.id, name: f.name, type, strand: FIELD_TYPES[type] ?? (type.startsWith(XRAY) ? 'Strand: testing (Xray)' : null) })
    }
  })
  await section('workflows', async () => { out.workflows = (await get('/rest/api/2/workflow')).map(w => ({ name: w.name, steps: w.steps ?? null })) })
  await section('permission schemes', async () => { out.schemes.permission = (await get('/rest/api/2/permissionscheme')).permissionSchemes.length })
  await section('notification schemes', async () => { out.schemes.notification = (await get('/rest/api/2/notificationscheme?maxResults=1')).total })
  await section('issue security schemes', async () => { out.schemes.issueSecurity = (await get('/rest/api/2/issuesecurityschemes')).issueSecuritySchemes.length })
  await section('users', async () => {
    let n = 0, active = 0
    for (let at = 0; ; at += 1000) {
      const page = await get(`/rest/api/2/user/search?username=.&includeInactive=true&startAt=${at}&maxResults=1000`)
      n += page.length; active += page.filter(u => u.active).length
      if (page.length < 1000) break
    }
    out.totals.users = n; out.totals.activeUsers = active
  })
  await section('groups', async () => { out.totals.groups = (await get('/rest/api/2/groups/picker?maxResults=100000')).total })
  await section('boards', async () => {
    for (let at = 0; ; at += 50) {
      const page = await get(`/rest/agile/1.0/board?startAt=${at}&maxResults=50`)
      for (const b of page.values) { out.boards.total++; if (b.type === 'scrum') out.boards.scrum++; else out.boards.kanban++ }
      if (page.isLast || !page.values.length) break
    }
  })
  await section('apps', async () => {
    out.apps = (await get('/rest/plugins/1.0/')).plugins.filter(p => p.userInstalled).map(p => ({ key: p.key, name: p.name, version: p.version, enabled: p.enabled, strand: APPS_COVERED[p.key] ?? null }))
  })
  out.totals.projects = out.projects.length
  out.gaps = gaps(out)
  return out
}

/** What needs the product owner's decision before moving. */
export function gaps(inv) {
  const g = []
  for (const f of inv.customFields.filter(f => !f.strand)) g.push({ kind: 'Custom field type', what: `${f.name} (${f.type || 'unknown type'})`, decide: 'Strand has no such field type: map it to another, or leave it out' })
  if (inv.customFields.some(f => f.type === 'com.atlassian.jpo:jpo-custom-field-team' || /^team$/i.test(f.name))) g.push({ kind: 'Advanced Roadmaps', what: 'Teams and capacity (the Team field)', decide: 'Parent Link and Target dates come over (spec 0803); teams and capacity are the next step (B+): tell the product owner they are in use' })
  for (const p of inv.projects.filter(p => p.type === 'service_desk')) g.push({ kind: 'Service project', what: `${p.key} ${p.name}`, decide: 'Strand has no service desk: move it as a software project, or leave it' })
  for (const a of inv.apps.filter(a => a.enabled && !a.strand)) g.push({ kind: 'App', what: `${a.name} (${a.key} ${a.version})`, decide: 'Check what it does in your Jira; Strand doesn’t run Jira apps' })
  for (const [s, why] of Object.entries(inv.unreadable)) g.push({ kind: 'Not read', what: s, decide: `The token couldn’t read it (${why}): run again as a Jira administrator for the whole picture` })
  return g
}

const n = v => (v == null ? '—' : Number(v).toLocaleString('en'))
/** The report people read. */
export function report(inv) {
  const L = []
  L.push(`# Jira inventory`, '', `${inv.jira.title || 'Jira'} ${inv.jira.version ?? ''} (${inv.jira.deploymentType ?? ''}), read ${inv.generatedAt}.`, '')
  L.push('## Totals', '', '| | |', '|---|---|')
  for (const [k, v] of [['Projects', inv.totals.projects], ['Work items', inv.totals.issues], ['People (active)', inv.totals.users == null ? null : `${n(inv.totals.users)} (${n(inv.totals.activeUsers)})`], ['Groups', inv.totals.groups],
    ['Boards (scrum, kanban)', `${n(inv.boards.total)} (${n(inv.boards.scrum)}, ${n(inv.boards.kanban)})`], ['Custom fields', inv.customFields.length], ['Workflows', inv.workflows.length],
    ['Permission schemes', inv.schemes.permission], ['Notification schemes', inv.schemes.notification], ['Issue security schemes', inv.schemes.issueSecurity], ['Apps installed', inv.apps.length]])
    L.push(`| ${k} | ${typeof v === 'string' ? v : n(v)} |`)
  L.push('', `## What needs a decision (${inv.gaps.length})`, '')
  if (!inv.gaps.length) L.push('Nothing: everything read maps to Strand.')
  else { L.push('| Kind | What | Decide |', '|---|---|---|'); for (const g of inv.gaps) L.push(`| ${g.kind} | ${g.what.replace(/\|/g, '\\|')} | ${g.decide} |`) }
  L.push('', '## Projects', '', '| Key | Name | Type | Work items | Versions | Components | Archived |', '|---|---|---|---|---|---|---|')
  for (const p of [...inv.projects].sort((a, b) => (b.issues ?? 0) - (a.issues ?? 0))) L.push(`| ${p.key} | ${p.name.replace(/\|/g, '\\|')} | ${p.type} | ${n(p.issues)} | ${n(p.versions)} | ${n(p.components)} | ${p.archived ? 'yes' : ''} |`)
  L.push('', '## Custom fields', '', '| Field | Jira type | In Strand |', '|---|---|---|')
  for (const f of inv.customFields) L.push(`| ${f.name.replace(/\|/g, '\\|')} | ${f.type.split(':').pop()} | ${f.strand ?? '**not yet**'} |`)
  L.push('', '## Apps', '', '| App | Version | On | In Strand |', '|---|---|---|---|')
  for (const a of inv.apps) L.push(`| ${a.name} | ${a.version} | ${a.enabled ? 'yes' : 'no'} | ${a.strand ?? '**to review**'} |`)
  L.push('', `Issue types: ${inv.issueTypes.map(t => t.name).join(', ')}.`, '', `Statuses: ${inv.statuses.map(s => s.name).join(', ')}.`, '',
    `Priorities: ${inv.priorities.join(', ')}. Resolutions: ${inv.resolutions.join(', ')}.`, '', `Link types: ${inv.linkTypes.map(t => t.name).join(', ')}.`, '')
  return L.join('\n')
}

// —— Run it ——
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.JIRA_URL
  const headers = process.env.JIRA_TOKEN ? { authorization: `Bearer ${process.env.JIRA_TOKEN}` }
    : process.env.JIRA_USER ? { authorization: `Basic ${Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_PASSWORD ?? ''}`).toString('base64')}` } : null
  if (!url || !headers) {
    console.error('Set JIRA_URL, and JIRA_TOKEN (a personal access token) or JIRA_USER and JIRA_PASSWORD.')
    process.exit(2)
  }
  const at = process.argv.indexOf('--out'), dir = at > 0 ? process.argv[at + 1] : '.'
  const inv = await inventory({ baseUrl: url, headers, log: m => console.error(m) })
  await writeFile(join(dir, 'jira-inventory.json'), JSON.stringify(inv, null, 2))
  await writeFile(join(dir, 'jira-inventory.md'), report(inv))
  console.error(`Wrote ${join(dir, 'jira-inventory.md')} and jira-inventory.json: ${inv.totals.projects ?? 0} projects, ${inv.totals.issues ?? '?'} work items, ${inv.gaps.length} things to decide.`)
}
