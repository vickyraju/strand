import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { inventory, report } from './inventory.mjs'

/** A made-up Jira (no one's real data): what its REST answers. */
const JIRA = {
  '/rest/api/2/serverInfo': { version: '9.12.4', deploymentType: 'Server', serverTitle: 'Acme Jira' },
  '/rest/api/2/project?includeArchived=true&expand=lead': [
    { key: 'PAY', name: 'Payments', projectTypeKey: 'software', lead: { displayName: 'Ann' } },
    { key: 'HELP', name: 'Help desk', projectTypeKey: 'service_desk', lead: { displayName: 'Bob' } },
    { key: 'OLD', name: 'Old | stuff', projectTypeKey: 'business', archived: true },
  ],
  [`/rest/api/2/search?jql=${encodeURIComponent('project = "PAY"')}&maxResults=0`]: { total: 1200 },
  [`/rest/api/2/search?jql=${encodeURIComponent('project = "HELP"')}&maxResults=0`]: { total: 30 },
  '/rest/api/2/search?jql=&maxResults=0': { total: 1230 },
  '/rest/api/2/project/PAY/versions': [{}, {}], '/rest/api/2/project/PAY/components': [{}],
  '/rest/api/2/project/HELP/versions': [], '/rest/api/2/project/HELP/components': [],
  '/rest/api/2/issuetype': [{ name: 'Bug' }, { name: 'Sub-task', subtask: true }],
  '/rest/api/2/status': [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }],
  '/rest/api/2/priority': [{ name: 'High' }, { name: 'Low' }], '/rest/api/2/resolution': [{ name: 'Done' }],
  '/rest/api/2/issueLinkType': { issueLinkTypes: [{ name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }] },
  '/rest/api/2/field': [
    { id: 'summary', name: 'Summary', custom: false },
    { id: 'customfield_10001', name: 'Team', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: 'customfield_10002', name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    { id: 'customfield_10003', name: 'Parent Link', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-custom-field-parent' } },
    { id: 'customfield_10007', name: 'Team', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-custom-field-team' } },
    { id: 'customfield_10004', name: 'Test Steps', custom: true, schema: { custom: 'com.xpandit.plugins.xray:manual-test-steps-custom-field' } },
    { id: 'customfield_10005', name: 'Mood', custom: true, schema: { custom: 'com.example.mood:smiley' } },
  ],
  '/rest/api/2/workflow': [{ name: 'jira' }, { name: 'Software Simplified Workflow' }],
  '/rest/api/2/permissionscheme': { permissionSchemes: [{}, {}] },
  '/rest/api/2/notificationscheme?maxResults=1': { total: 3, values: [{}] },
  '/rest/api/2/user/search?username=.&includeInactive=true&startAt=0&maxResults=1000': [{ active: true }, { active: false }, { active: true }],
  '/rest/api/2/groups/picker?maxResults=100000': { total: 7, groups: [] },
  '/rest/agile/1.0/board?startAt=0&maxResults=50': { isLast: false, values: [{ type: 'scrum' }, { type: 'kanban' }] },
  '/rest/agile/1.0/board?startAt=50&maxResults=50': { isLast: true, values: [{ type: 'scrum' }] },
  '/rest/plugins/1.0/': { plugins: [
    { key: 'com.xpandit.plugins.xray', name: 'Xray', version: '7.1', enabled: true, userInstalled: true },
    { key: 'com.example.timesheets', name: 'Timesheets', version: '2.0', enabled: true, userInstalled: true },
    { key: 'com.atlassian.jira.core', name: 'Core', version: '9', enabled: true, userInstalled: false },
  ] },
  // issue security schemes: this token isn't allowed (403), the rest carries on
}

test('[0801.R1][0801.R2][0801.R3] the inventory reads a Jira (only GETs, with the token), counts it and lists what needs a decision', async () => {
  const seen = []
  const server = createServer((q, r) => {
    seen.push([q.method, q.headers.authorization])
    const body = JIRA[q.url]
    if (!body) { r.statusCode = q.url.startsWith('/rest/api/2/issuesecurityschemes') ? 403 : 404; r.end('{}'); return }
    r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body))
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  try {
    const inv = await inventory({ baseUrl: `http://127.0.0.1:${server.address().port}/`, headers: { authorization: 'Bearer secret-token' } })
    assert.ok(seen.every(([m, a]) => m === 'GET' && a === 'Bearer secret-token'))
    assert.deepEqual([inv.jira.version, inv.totals.projects, inv.totals.issues, inv.totals.users, inv.totals.activeUsers, inv.totals.groups], ['9.12.4', 3, 1230, 3, 2, 7])
    assert.deepEqual(inv.boards, { total: 3, scrum: 2, kanban: 1 })
    assert.deepEqual(inv.projects.map(p => [p.key, p.issues, p.versions]), [['PAY', 1200, 2], ['HELP', 30, 0], ['OLD', null, null]])
    assert.deepEqual(inv.customFields.map(f => f.mapsTo), ['select', 'Jira Build POC: Sprint', 'Jira Build POC: Parent Link (plans, spec 0803)', 'Not yet: teams and capacity (spec 0803)', 'Jira Build POC: testing (Xray)', null])
    assert.deepEqual(inv.unreadable, { 'issue security schemes': '403 Forbidden' })
    assert.deepEqual(inv.gaps.map(g => g.kind), ['Custom field type', 'Advanced Roadmaps', 'Service project', 'App', 'Not read'])
    assert.match(inv.gaps.find(g => g.kind === 'Advanced Roadmaps').what, /Teams and capacity/)
    const md = report(inv)
    assert.match(md, /^# Jira inventory\n\nAcme Jira 9\.12\.4/)
    assert.match(md, /\| Work items \| 1,230 \|/)
    assert.match(md, /\| OLD \| Old \\\| stuff \| business \| — \|/)
    assert.match(md, /\| Mood \| smiley \| \*\*not yet\*\* \|/)
    assert.match(md, /\| Timesheets \| 2\.0 \| yes \| \*\*to review\*\* \|/)
    assert.ok(!JSON.stringify(inv).includes('secret-token') && !md.includes('secret-token'))   // the token is never written down
  } finally { server.close() }
})
