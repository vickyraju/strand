// The main journeys, end to end in a real browser. Each one checks what a person sees and what the server keeps.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { start, stop, skip, signIn, as, url, PEOPLE, postRaw } from './harness.mjs'

const owner = as('owner@e2e.test'), maya = as('maya@e2e.test'), vic = as('vic@e2e.test')
const idOf = async email => (await as(email)('GET', '/me')).body.id
/** A new project lets every status be reached from any other; journeys that draw their own moves start without them. */
const clearMoves = async p => { for (const t of p.transitions) await owner('DELETE', `/projects/${p.key}/transitions/${t.id}`) }

before(start, { timeout: 120_000 })
after(stop)

test('create a project in the app, add a teammate as a viewer: they can read and comment but not change work', { skip, timeout: 90_000 }, async () => {
  const page = await signIn('owner@e2e.test')
  await page.click('button:has-text("Create")')
  await page.fill('#cp-name', 'Launch Plan')
  await page.fill('#cp-key', 'LCH')
  await page.click('button[form="create-project"]')
  await page.waitForURL(/\/project\/LCH/)
  const item = (await owner('POST', '/projects/LCH/issues', { title: 'Write the launch post' })).body
  assert.ok(item.key)

  // People and access: add Vic as a viewer through the dialog
  await page.goto(url('/project/LCH/settings/people'))
  await page.click('button:has-text("Add people")')
  await page.fill('#pp-search', 'Vic')
  await page.click(`.modal .picker-item:has-text("${PEOPLE['vic@e2e.test']}")`)
  await page.selectOption('.modal select', 'viewer')
  await page.click('.modal button:has-text("Add 1")')
  await page.waitForSelector(`.person:has-text("${PEOPLE['vic@e2e.test']}") select`)
  assert.equal(await page.locator(`.person:has-text("${PEOPLE['vic@e2e.test']}") select`).inputValue(), 'viewer')

  // Vic: read-only, but can comment
  const v = await signIn('vic@e2e.test')
  await v.goto(url(`/i/${item.key}`))
  await v.waitForSelector('text=view-only access')
  assert.equal(await v.$eval('.detail-title', e => e.readOnly), true)
  await v.fill('[aria-label="Add a comment"]', 'Looks good to me')
  await v.click('.compose-comment button:text-is("Comment")')
  await v.waitForSelector('text=Looks good to me')
  assert.equal((await vic('PATCH', `/issues/${item.key}`, { title: 'nope' })).status, 403)
  const comments = (await owner('GET', `/issues/${item.key}?expand=comments`)).body.comments
  assert.deepEqual(comments.map(c => c.body), ['Looks good to me'])
  assert.deepEqual([...page.problems, ...v.problems], [])
})

test('an @mention in a comment reaches that person’s Inbox', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Mentions', key: 'MNT', template: 'kanban' })
  await owner('POST', '/projects/MNT/members', { userIds: [await idOf('maya@e2e.test'), await idOf('sam@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/MNT/issues', { title: 'Pick a launch date' })).body
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${item.key}`))
  await m.fill('[aria-label="Add a comment"]', `@${PEOPLE['sam@e2e.test']} can you confirm the date?`)
  await m.click('.compose-comment button:text-is("Comment")')
  await m.waitForSelector('text=can you confirm the date?')
  const s = await signIn('sam@e2e.test')
  await s.goto(url('/inbox'))
  await s.waitForSelector(`text=${item.key}`, { timeout: 15_000 })
  assert.ok((await s.innerText('main')).includes('Pick a launch date'))
  assert.deepEqual([...m.problems, ...s.problems], [])
})

test('the workflow decides which moves are offered, and the server refuses the rest', { skip, timeout: 60_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Flow', key: 'FLW', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find(s => s.category === 'done')]
  await clearMoves(p)
  await owner('POST', '/projects/FLW/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  await owner('POST', '/projects/FLW/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/FLW/issues', { title: 'Follow the flow' })).body
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${item.key}`))
  await m.click('[title="Change status"]')
  const offered = await m.$$eval('.picker-menu .picker-item', items => items.map(i => i.textContent.trim()))
  assert.ok(offered.some(t => t.includes(doing.name)), `offered: ${offered}`)
  assert.ok(!offered.some(t => t.includes(done.name)), `offered: ${offered}`)
  assert.equal((await maya('PATCH', `/issues/${item.key}`, { statusId: done.id })).status, 409)
  assert.deepEqual(m.problems, [])
})

test('transition rules: an admin adds one in the editor; a move is hidden or asks for details; a loop acts from the Actions menu', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Rules', key: 'RLS', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find(s => s.category === 'done')]
  await clearMoves(p)
  await owner('POST', '/projects/RLS/transitions', { name: 'Start', fromIds: [todo.id], toId: doing.id })
  await owner('POST', '/projects/RLS/transitions', { name: 'Finish', fromIds: [doing.id], toId: done.id,
    rules: { validate: [{ kind: 'required', fields: ['dueDate'] }], screen: ['dueDate', 'comment'] } })
  await owner('POST', '/projects/RLS/transitions', { name: 'Log progress', fromIds: [doing.id], toId: null,
    rules: { validate: [{ kind: 'required', fields: ['comment'] }], screen: ['comment'] } })
  await owner('POST', '/projects/RLS/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/RLS/issues', { title: 'Ruled work' })).body
  await owner('PATCH', `/issues/${item.key}`, { statusId: doing.id })

  // the admin restricts Finish to project admins in the workflow editor (list view, Rules tab)
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RLS/settings/workflow'))
  await o.click('.wf-tools [role="tab"]:has-text("List")')
  await o.click('.wf-list tr:has-text("Finish")')
  await o.click('.wf-panel [role="tab"]:has-text("Rules")')
  await o.selectOption('section[aria-label="Restrict transition"] select[aria-label="Add rule"]', { label: 'Only a project role' })
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.click('.modal button:has-text("Update workflow")')
  await o.waitForSelector('text=Workflow updated')
  const saved = (await owner('GET', '/projects/RLS')).body.transitions.find(t => t.name === 'Finish')
  assert.deepEqual(saved.rules.restrict, { op: 'all', items: [{ kind: 'role', roles: ['admin'] }] })

  // Maya (a member) isn't offered Finish, and the server refuses it
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${item.key}`))
  await m.click('[title="Change status"]')
  const offered = await m.$$eval('.picker-menu .picker-item', items => items.map(i => i.textContent.trim()))
  assert.ok(!offered.some(t => t.includes(done.name)), `offered: ${offered}`)
  await m.keyboard.press('Escape')
  assert.equal((await maya('PATCH', `/issues/${item.key}`, { statusId: done.id })).status, 403)

  // the loop is in her Actions menu; its screen asks for a comment, and the item stays where it is
  await m.click('[title="More actions"]')
  await m.click('.picker-item:has-text("Log progress")')
  const dialog = m.locator('.modal')
  assert.equal(await dialog.locator('button:has-text("Log progress")').isDisabled(), true)
  await dialog.locator('#tr-comment').fill('Halfway there')
  await dialog.locator('button:has-text("Log progress")').click()
  await m.waitForSelector('text=Log progress: done')
  const after = (await owner('GET', `/issues/${item.key}`)).body
  assert.equal(after.statusId, doing.id)
  assert.ok(after.comments.some(c => c.body === 'Halfway there'))

  // the admin finishes it: the transition screen asks for the due date first
  await o.goto(url(`/i/${item.key}`))
  await o.click('[title="Change status"]')
  await o.click(`.picker-menu .picker-item:has-text("${done.name}")`)
  const finish = o.locator('.modal')
  await finish.waitFor()
  assert.match(await finish.innerText(), /Due date is required/)
  await finish.locator('#tr-dueDate').fill('2026-12-01')
  await finish.locator('button:has-text("Finish")').click()
  await o.waitForSelector(`text=${item.key} moved to ${done.name}`)
  const finished = (await owner('GET', `/issues/${item.key}`)).body
  assert.deepEqual([finished.statusId, finished.dueDate], [done.id, '2026-12-01'])
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('work types: an admin adds one in settings; items of that type follow its own transition', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Kinds', key: 'KND', template: 'kanban' })).body
  const [todo, , done] = [p.statuses[0], p.statuses[1], p.statuses.find(s => s.category === 'done')]
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/KND/settings'))
  await o.click('section[aria-label="Work types"] button:has-text("Add work type")')
  await o.fill('#wt-name', 'Incident')
  await o.click('.modal button[aria-label="shield"]')
  await o.click('.modal button:has-text("Add")')
  await o.waitForSelector('section[aria-label="Work types"] td:has-text("Incident")')
  const inc = (await owner('GET', '/projects/KND')).body.types.find(t => t.name === 'Incident')
  assert.ok(inc, 'the type was saved')
  await clearMoves(p)
  await owner('POST', '/projects/KND/transitions', { name: 'Resolve', fromIds: [todo.id], toId: done.id, typeKeys: [inc.key] })
  const outage = (await owner('POST', '/projects/KND/issues', { title: 'Outage', type: inc.key })).body
  const task = (await owner('POST', '/projects/KND/issues', { title: 'Ordinary' })).body
  await o.goto(url(`/i/${outage.key}`))
  await o.waitForSelector('.detail [aria-label="Incident"]')
  await o.click('[title="Change status"]')
  assert.ok((await o.$$eval('.picker-menu .picker-item', i => i.map(x => x.textContent))).some(t => t.includes(done.name)))
  await o.keyboard.press('Escape')
  await o.goto(url(`/i/${task.key}`))
  await o.waitForSelector('.detail')
  await o.click('[title="Change status"]')
  assert.ok(!(await o.$$eval('.picker-menu .picker-item', i => i.map(x => x.textContent))).some(t => t.includes(done.name)))
  assert.deepEqual(o.problems, [])
})

test('workflow versions: removing a status says what happens to its items; each update is a version that can be loaded back', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Releases flow', key: 'RFL', template: 'scrum' })).body
  const review = p.statuses.find(s => s.name === 'In review'), doing = p.statuses.find(s => s.name === 'In progress')
  const items = []
  for (let n = 0; n < 2; n++) items.push((await owner('POST', '/projects/RFL/issues', { title: `In review ${n}`, statusId: review.id })).body)
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RFL/settings/workflow'))
  await o.click('.wf-tools [role="tab"]:has-text("List")')
  await o.click('.wf-list tr:has-text("In review")')
  await o.click('.wf-panel button:has-text("Delete status")')
  await o.selectOption('#ds-to', { label: 'In progress' })
  await o.click('.modal button:has-text("Delete status")')
  await o.click('.wf-bar button:has-text("Update workflow")')
  const summary = await o.locator('.modal').innerText()
  assert.match(summary, /Removes the status “In review”/)
  assert.match(summary, /move to “In progress”/)
  await o.fill('#pub-note', 'No review step')
  await o.click('.modal button:has-text("Update workflow")')
  await o.waitForSelector('text=Workflow updated: version 1')
  for (const i of items) assert.equal((await owner('GET', `/issues/${i.key}`)).body.statusId, doing.id)
  // version 1 is the workflow without the review step; load the original back from the list (it was never published,
  // so publish it first by API, then load version 1 and see the editor change)
  const versions = (await owner('GET', '/projects/RFL/workflow/versions')).body
  assert.deepEqual(versions.map(v => [v.version, v.note]), [[1, 'No review step']])
  await o.click('.wf-bar button:has-text("Versions")')
  await o.click('.modal tr:has-text("No review step")')
  await o.waitForSelector('.modal >> text=Going from version 1')
  assert.match(await o.locator('.modal').innerText(), /They are the same/)
  assert.deepEqual(o.problems, [])
})

test('time tracking: logging work counts the remaining estimate down; it can be set instead', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Hours', key: 'HRS', template: 'kanban' })
  const item = (await owner('POST', '/projects/HRS/issues', { title: 'Estimated work', timeEstimate: 480 })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('.time-bar-btn')
  await o.fill('#lt-spent', '2h')
  await o.click('.modal button:has-text("Log time")')
  await o.waitForSelector('text=Logged 2h')
  await o.fill('#lt-spent', '1h')
  await o.click('.modal [role="radio"]:has-text("Set to")')
  await o.fill('.modal [aria-label="New remaining estimate"]', '1h')
  await o.click('.modal button:has-text("Log time")')
  await o.waitForSelector('text=Logged 1h')
  await o.click('.modal button:has-text("Close")')
  await o.waitForTimeout(1500)                                           // the changes reach the server
  const after = (await owner('GET', `/issues/${item.key}`)).body
  assert.deepEqual([after.timeRemaining, after.worklogs.map(w => w.minutes).sort()], [60, [120, 60].sort()])
  assert.match(await o.locator('.time-nums').innerText(), /3h logged[\s\S]*1h remaining/)
  assert.deepEqual(o.problems, [])
})

test('components: an admin adds one with a lead; new work in it goes to the lead; the item shows its components', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Parts', key: 'PTS', template: 'kanban' })
  await owner('POST', '/projects/PTS/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/PTS/settings'))
  await o.click('section[aria-label="Components"] button:has-text("Add component")')
  await o.fill('#cmp-name', 'Billing')
  await o.selectOption('.modal select[aria-label="Component lead"]', { label: PEOPLE['maya@e2e.test'] })
  await o.selectOption('#cmp-def', 'component_lead')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('section[aria-label="Components"] >> text=Billing')
  await o.waitForTimeout(1000)                                             // the new component reaches the server
  const billing = (await owner('GET', '/projects/PTS')).body.components.find(c => c.name === 'Billing')
  assert.ok(billing, 'saved')
  const item = (await owner('POST', '/projects/PTS/issues', { title: 'Invoice totals', componentIds: [billing.id] })).body
  assert.equal(item.assigneeId, await idOf('maya@e2e.test'))
  await o.goto(url(`/i/${item.key}`))
  await o.waitForSelector('.detail .chip-static:has-text("Billing")')
  assert.deepEqual(o.problems, [])
})

test('saved views: shared with a project to edit, a member of it finds the view and changes it', { skip, timeout: 60_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Shared', key: 'SHV', template: 'kanban' })).body
  await owner('POST', '/projects/SHV/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const v = (await owner('POST', '/views', { name: 'Urgent work', filters: { q: '', priority: 'urgent' } })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/search?view=${v.id}`))
  await o.click('[title="View actions"]')
  await o.click('.picker-item:has-text("Share…")')
  await o.selectOption('.modal select[aria-label="Share with a project"]', { label: 'Shared' })
  await o.selectOption('.modal select[aria-label^="What"]', 'edit')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('text=Urgent work is shared')
  await o.waitForTimeout(1000)
  assert.deepEqual((await owner('GET', '/views')).body.find(x => x.id === v.id).share, [{ kind: 'project', id: p.id, can: 'edit' }])
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/search?view=${v.id}`))
  await m.waitForSelector('h1:has-text("Urgent work")')
  await m.click('[title="View actions"]')
  assert.equal(await m.locator('.picker-item:has-text("Share…")').count(), 0)        // editing, not resharing
  await m.click('.picker-item:has-text("Rename")')
  await m.fill('#vn', 'Urgent and high')
  await m.click('.modal button:has-text("Save")')
  await m.waitForTimeout(1000)
  assert.equal((await owner('GET', '/views')).body.find(x => x.id === v.id).name, 'Urgent and high')
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('JQL search: switching keeps the filters as JQL; a query on a custom field finds its items; mistakes show where', { skip, timeout: 60_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Query', key: 'QRY', template: 'kanban' })).body
  const team = (await owner('POST', '/projects/QRY/fields', { name: 'Team', kind: 'text', options: null, position: 0 })).body
  const core = (await owner('POST', '/projects/QRY/issues', { title: 'Core work', priority: 'high', custom: { [team.id]: 'Core' } })).body
  await owner('POST', '/projects/QRY/issues', { title: 'Other work', priority: 'high', custom: { [team.id]: 'Web' } })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/search?q='))
  await o.click('.search-bar [title="Priority"]')
  await o.click('.picker-menu .picker-item:has-text("High")')
  await o.click('button:has-text("Switch to JQL")')
  assert.equal(await o.inputValue('textarea[aria-label="JQL query"]'), 'priority = high AND statusCategory != Done')
  await o.fill('textarea[aria-label="JQL query"]', 'project = QRY AND Team = core AND')
  assert.match(await o.locator('.jql .hint.error').innerText(), /Expected a field/)
  await o.fill('textarea[aria-label="JQL query"]', 'project = QRY AND Team = core ORDER BY created DESC')
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector(`text=${core.key}`)
  await o.waitForSelector('text=1 result')
  await o.click('button:has-text("Save as view")')
  await o.fill('#vn', 'Core team')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('h1:has-text("Core team")')
  await o.waitForTimeout(800)
  const saved = (await owner('GET', '/views')).body.find(v => v.name === 'Core team')
  assert.equal(saved.filters.jql, 'project = QRY AND Team = core ORDER BY created DESC')
  assert.deepEqual(o.problems, [])
})

test('automation: a dry run shows what a rule would do; the audit log shows each run and a failure', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Robots', key: 'RBT', template: 'kanban' })
  const item = (await owner('POST', '/projects/RBT/issues', { title: 'Try me', priority: 'low' })).body
  await owner('POST', '/projects/RBT/rules', { name: 'Broken one', trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'bogus' }] })
  await owner('POST', '/projects/RBT/issues', { title: 'Triggers it' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RBT/settings/automation'))
  await o.click('button:has-text("Create rule")')
  await o.fill('#rule-name', 'Label shipped')
  await o.fill('.modal input[aria-label="Label"]', 'shipped')
  await o.fill('.modal input[aria-label="Work item to try the rule on"]', item.key)
  await o.click('.modal button:has-text("Dry run")')
  await o.waitForSelector('.modal .dry-run >> text=label')
  assert.match(await o.locator('.modal .dry-run').innerText(), /label: done/)
  await o.click('.modal button:has-text("Cancel")')
  assert.deepEqual((await owner('GET', `/issues/${item.key}`)).body.labels, [])                 // nothing changed
  await o.click('.wf-bar button:has-text("Audit log")')
  await o.waitForSelector('.modal td:has-text("Broken one")')
  assert.match(await o.locator('.modal').innerText(), /failed/i)
  assert.deepEqual(o.problems, [])
})

test('CSV import: the server checks every row first, says what is wrong, then imports in the background', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Imports', key: 'IMPT', template: 'kanban' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/IMPT/settings'))
  await o.click('button:has-text("Import CSV")')
  await o.setInputFiles('.modal input[type=file]', { name: 'jira-export.csv', mimeType: 'text/csv', buffer: Buffer.from(
    'Summary,Issue Type,Priority,Due Date\nFirst imported,Bug,Highest,01/Oct/26\n,Task,Low,\nSecond imported,Story,Trivial,someday\n') })
  await o.waitForSelector('.modal >> text=will be created from')
  const text = await o.locator('.modal').innerText()
  assert.match(text, /2 work items will be created from 3 rows; 1 row will be left out/)
  assert.match(text, /Row 3: No title/)
  assert.match(text, /Row 4 .*Due date “someday” isn’t a date/)
  await o.click('.modal button:has-text("Import 2 work items")')
  await o.waitForSelector('text=Imported 2 work items into Imports', { timeout: 20_000 })
  const items = (await owner('GET', `/search?jql=${encodeURIComponent('project = IMPT ORDER BY key')}`)).body.items
  assert.deepEqual(items.map(i => [i.title, i.type, i.priority]), [['First imported', 'bug', 'urgent'], ['Second imported', 'story', 'low']])
  assert.deepEqual(o.problems, [])
})

test('notification settings: turning off Inbox for assignments stops them reaching the Inbox', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Quiet', key: 'QUI', template: 'kanban' })
  await owner('POST', '/projects/QUI/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const m = await signIn('maya@e2e.test')
  await m.goto(url('/settings'))
  await m.waitForSelector('#notifications tr:has-text("Someone assigns me a work item")')
  await m.click('#notifications [aria-label="Someone assigns me a work item: Inbox"]')
  await m.waitForSelector('text=Notification settings saved')
  const maya = await idOf('maya@e2e.test')
  const quiet = (await owner('POST', '/projects/QUI/issues', { title: 'Quietly assigned', assigneeId: maya })).body
  await owner('POST', `/issues/${quiet.key}/comments`, { body: `@${PEOPLE['maya@e2e.test']} have a look` })
  const notes = (await as('maya@e2e.test')('GET', '/notifications')).body
  assert.ok(!notes.some(n => n.issueKey === quiet.key && n.kind === 'assigned'))
  assert.ok(notes.some(n => n.issueKey === quiet.key && n.kind === 'mentioned'))
  assert.deepEqual(m.problems, [])
})

test('issue security: an item given a level vanishes for people outside it, on the board and in search', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Vault', key: 'VLT', template: 'kanban' })
  await owner('POST', '/projects/VLT/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  await owner('POST', '/projects/VLT/issues', { title: 'Ordinary task' })
  const secret = (await owner('POST', '/projects/VLT/issues', { title: 'Embargoed fix' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/VLT/settings'))
  await o.click('section[aria-label="Security levels"] button:has-text("Add level")')
  await o.fill('#sl-name', 'Security team')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('section[aria-label="Security levels"] >> text=Security team')
  await o.goto(url(`/i/${secret.key}`))
  await o.click('.detail [title="Security level"]')
  await o.click('.picker-menu .picker-item:has-text("Security team")')
  await o.waitForTimeout(1200)
  assert.ok((await owner('GET', `/issues/${secret.key}`)).body.securityLevelId)
  const m = await signIn('maya@e2e.test')
  await m.goto(url('/project/VLT/board'))
  await m.waitForSelector('text=Ordinary task')
  assert.equal(await m.locator('text=Embargoed fix').count(), 0)
  await m.goto(url(`/search?q=${encodeURIComponent('Embargoed')}`))
  await m.waitForSelector('text=0 results')
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('testing: an admin turns it on; a member writes a manual test with three steps and switches one to Gherkin', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Quality', key: 'QA', template: 'kanban' })
  await owner('POST', '/projects/QA/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/QA/settings'))
  await o.click('section[aria-label="Testing"] [role="switch"]')
  await o.waitForSelector('section[aria-label="Work types"] td:has-text("Test Execution")')
  const t = (await owner('POST', '/projects/QA/issues', { title: 'Sign in works', type: 'test' })).body
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${t.key}`))
  await m.waitForSelector('section[aria-label="Test details"]')
  for (const [i, action] of ['Open the sign-in page', 'Enter a valid email and password', 'Press Sign in'].entries()) {
    await m.click('section[aria-label="Test details"] button:has-text("Add step")')
    await m.fill(`[aria-label="Step ${i + 1} action"]`, action)
  }
  await m.fill('[aria-label="Step 3 expected result"]', 'The home page shows')
  await m.click('section[aria-label="Test details"] button:has-text("Save")')
  await m.waitForFunction(() => !document.querySelector('section[aria-label="Test details"] .row-actions'))
  await m.waitForTimeout(1200)
  const saved = (await owner('GET', `/issues/${t.key}`)).body.testSpec
  assert.deepEqual(saved.steps.map(s => s.action), ['Open the sign-in page', 'Enter a valid email and password', 'Press Sign in'])
  assert.equal(saved.steps[2].expected, 'The home page shows')
  await m.click('[aria-label="Move step 3 up"]')
  await m.click('section[aria-label="Test details"] button:has-text("Save")')
  await m.waitForTimeout(1200)
  assert.equal((await owner('GET', `/issues/${t.key}`)).body.testSpec.steps[1].action, 'Press Sign in')
  await m.click('section[aria-label="Test details"] [role="radio"]:has-text("Cucumber")')
  await m.fill('[aria-label="Gherkin scenario"]', 'Scenario: sign in\n  Given a user\n  When they sign in\n  Then they see home')
  await m.click('section[aria-label="Test details"] button:has-text("Save")')
  await m.waitForTimeout(1200)
  assert.equal((await owner('GET', `/issues/${t.key}`)).body.testSpec.kind, 'cucumber')
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('testing: tests go into a set and a plan folder; the Tests tab files them into folders', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Suites', key: 'STE', template: 'kanban' })
  await owner('PUT', '/projects/STE/testing', { enabled: true })
  const [a, b] = [(await owner('POST', '/projects/STE/issues', { title: 'Checkout works', type: 'test' })).body, (await owner('POST', '/projects/STE/issues', { title: 'Refund works', type: 'test' })).body]
  const plan = (await owner('POST', '/projects/STE/issues', { title: 'Release 2.0', type: 'test_plan' })).body
  const o = await signIn('owner@e2e.test')
  // add both tests to the plan, into a folder
  await o.goto(url(`/i/${plan.key}`))
  await o.click('section[aria-label="Tests"] button:has-text("Add tests")')
  await o.click(`.modal label:has-text("${a.key}") input`)
  await o.click(`.modal label:has-text("${b.key}") input`)
  await o.fill('.modal [aria-label="Folder"]', 'Payments')
  await o.click('.modal button:has-text("Add 2 tests")')
  await o.waitForSelector('section[aria-label="Tests"] .test-folder-label:has-text("Payments")')
  assert.deepEqual((await owner('GET', `/issues/${plan.key}/tests`)).body.map(t => [t.key, t.folder]), [[a.key, 'Payments'], [b.key, 'Payments']])
  // the test shows what holds it
  await o.goto(url(`/i/${a.key}`))
  await o.waitForSelector(`section[aria-label="Used in"] a:has-text("${plan.key}")`)
  // the Tests tab: a folder, and a test moved into it
  await o.goto(url('/project/STE/tests'))
  await o.waitForSelector(`.repo-list a:has-text("${a.key}")`)
  o.once('dialog', d => d.accept('Billing'))
  await o.click('.repo-tree button:has-text("New folder")')
  await o.waitForSelector('.repo-tree button:has-text("Billing")')
  await o.click('.repo-tree button.repo-all:has-text("All tests")')
  await o.click(`[aria-label="Select ${b.key}"]`)
  await o.selectOption('[aria-label="Move to folder"]', { label: 'Billing' })
  await o.waitForTimeout(1200)
  const folder = (await owner('GET', '/projects/STE/test-folders')).body.find(f => f.name === 'Billing')
  assert.equal((await owner('GET', `/issues/${b.key}`)).body.testFolderId, folder.id)
  await o.click('.repo-tree button:has-text("Billing")')
  await o.waitForSelector(`.repo-list a:has-text("${b.key}")`)
  assert.equal(await o.locator(`.repo-list a:has-text("${a.key}")`).count(), 0)
  assert.deepEqual(o.problems, [])
})

test('testing: run a plan — fail step 2 of a test, raise a defect from it, and see the plan’s progress', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Exec', key: 'EXE', template: 'kanban' })
  await owner('PUT', '/projects/EXE/testing', { enabled: true })
  const steps = [{ id: 's1', action: 'Open the basket' }, { id: 's2', action: 'Pay with a card', expected: 'Payment accepted' }, { id: 's3', action: 'See the receipt' }]
  const t = (await owner('POST', '/projects/EXE/issues', { title: 'Card checkout', type: 'test', testSpec: { kind: 'manual', steps } })).body
  const plan = (await owner('POST', '/projects/EXE/issues', { title: 'Release 4', type: 'test_plan' })).body
  await owner('POST', `/issues/${plan.key}/tests`, { keys: [t.key] })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${plan.key}`))
  await o.click('section[aria-label="Test executions"] button:has-text("Create execution")')
  await o.fill('#ex-envs', 'chrome')
  await o.click('.modal button:has-text("Create")')
  await o.waitForSelector('section[aria-label="Test runs"]')
  await o.click(`section[aria-label="Test runs"] [aria-label="Run ${t.key}"]`)
  await o.waitForSelector('.modal [aria-label="Step 2 status"]')
  await o.selectOption('.modal [aria-label="Step 1 status"]', 'PASS')
  await o.waitForSelector('.modal .test-lozenge:has-text("Executing")')
  await o.selectOption('.modal [aria-label="Step 2 status"]', 'FAIL')
  await o.waitForSelector('.modal .test-lozenge:has-text("Failed")')
  await o.fill('.modal [aria-label="Step 2 actual result"]', 'Card declined')
  await o.click('.modal .run-step:nth-child(2) button:has-text("Defect")')
  await o.fill('.modal [aria-label="Defect title"]', 'Valid cards are declined')
  await o.click('.modal button:has-text("Raise bug")')
  await o.waitForSelector('text=Raised EXE-')
  const exec = (await owner('GET', `/issues/${plan.key}/executions`)).body[0]
  const [run] = (await owner('GET', `/issues/${exec.key}/runs`)).body
  assert.deepEqual([run.status, run.steps[1].status, run.steps[1].actual, run.steps[1].defectIds.length], ['FAIL', 'FAIL', 'Card declined', 1])
  assert.deepEqual(exec.testEnvironments, ['chrome'])
  await o.keyboard.press('Escape')
  await o.goto(url(`/i/${plan.key}`))
  await o.waitForSelector('section[aria-label="Test executions"] .test-progress-bar[aria-label="1 Failed"]')
  assert.deepEqual(o.problems, [])
})

test('coverage: a story gains a test, shows NOK for version 1.0 after a failure, then OK after a passing rerun', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Coverage', key: 'CVG', template: 'kanban' })
  await owner('PUT', '/projects/CVG/testing', { enabled: true })
  const v1 = (await owner('POST', '/projects/CVG/releases', { name: '1.0' })).body
  const story = (await owner('POST', '/projects/CVG/issues', { title: 'Customers can check out', type: 'story' })).body
  const t = (await owner('POST', '/projects/CVG/issues', { title: 'Checkout succeeds', type: 'test' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${story.key}`))
  await o.waitForSelector('section[aria-label="Test coverage"] .test-lozenge:has-text("Uncovered")')
  await o.click('section[aria-label="Test coverage"] button:has-text("Add a test")')
  await o.click(`.modal button:has-text("${t.key}")`)
  await o.waitForSelector('section[aria-label="Test coverage"] h2 .test-lozenge:has-text("Not run")', { timeout: 15_000 })
  // a failing run for 1.0, then a passing one
  const runOnce = async (status) => {
    const e = (await owner('POST', '/projects/CVG/issues', { title: `Run ${status}`, type: 'test_execution', releaseId: v1.id })).body
    await owner('POST', `/issues/${e.key}/runs`, { keys: [t.key] })
    const [r] = (await owner('GET', `/issues/${e.key}/runs`)).body
    await owner('PATCH', `/test-runs/${r.id}`, { status })
  }
  await runOnce('FAIL')
  await o.reload()
  await o.selectOption('section[aria-label="Test coverage"] [aria-label="Coverage scope"]', { label: 'Version 1.0' })
  await o.waitForSelector('section[aria-label="Test coverage"] h2 .test-lozenge:has-text("NOK")')
  await runOnce('PASS')
  await o.reload()
  await o.selectOption('section[aria-label="Test coverage"] [aria-label="Coverage scope"]', { label: 'Version 1.0' })
  await o.waitForSelector('section[aria-label="Test coverage"] h2 .test-lozenge:has-text("OK")')
  assert.equal((await owner('GET', `/issues/${story.key}/coverage?version=${v1.id}`)).body.status, 'OK')
  assert.deepEqual(o.problems, [])
})

test('CI results: a JUnit report sent to Xray’s address with an access token becomes an execution the team sees', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Pipeline', key: 'PIPE', template: 'kanban' })
  await owner('PUT', '/projects/PIPE/testing', { enabled: true })
  const { token } = (await owner('POST', '/me/tokens', { name: 'ci' })).body
  const junit = '<testsuite name="api"><testcase classname="api.Health" name="answers"/><testcase classname="api.Health" name="isFast"><failure message="took 3s"/></testcase></testsuite>'
  const r = await postRaw('/rest/raven/1.0/import/execution/junit?projectKey=PIPE&testEnvironments=staging', junit, 'text/xml', token)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const key = r.body.testExecIssue.key
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${key}`))
  await o.waitForSelector('section[aria-label="Test runs"] td:has-text("answers")')
  await o.waitForSelector('section[aria-label="Test runs"] .test-progress-bar[aria-label="1 Passed, 1 Failed"]')
  assert.equal(await o.inputValue('[aria-label="Test environments"]'), 'staging')
  await o.goto(url('/project/PIPE/tests'))
  await o.waitForSelector('.repo-list td:has-text("isFast")')
  assert.deepEqual(o.problems, [])
})

test('plan a sprint, start it and complete it: unfinished work goes back to the backlog', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Sprinting', key: 'SPR', template: 'scrum' })).body
  const done = p.statuses.find(s => s.category === 'done')
  const sprint = (await owner('POST', '/projects/SPR/sprints', { name: 'SPR Sprint 1' })).body
  const finished = (await owner('POST', '/projects/SPR/issues', { title: 'Shipped', sprintId: sprint.id, estimate: 3 })).body
  const open = (await owner('POST', '/projects/SPR/issues', { title: 'Not yet', sprintId: sprint.id, estimate: 5 })).body
  const page = await signIn('owner@e2e.test')
  await page.goto(url('/project/SPR/backlog'))
  await page.click('button:has-text("Start sprint")')
  await page.click('.modal button:has-text("Start sprint")')
  await page.waitForSelector('button:has-text("Complete sprint")')
  await owner('PATCH', `/issues/${finished.key}`, { statusId: done.id })
  await page.reload(); await page.waitForSelector('button:has-text("Complete sprint")')
  await page.click('button:has-text("Complete sprint")')
  await page.click('.modal button:has-text("Complete sprint")')
  const closed = async () => (await owner('GET', '/projects/SPR')).body.sprints.find(s => s.id === sprint.id)
  for (let i = 0; i < 40 && (await closed()).state !== 'closed'; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal((await closed()).state, 'closed')
  assert.equal((await owner('GET', `/issues/${open.key}`)).body.sprintId, null)              // back to the backlog
  assert.equal((await owner('GET', `/issues/${finished.key}`)).body.sprintId, sprint.id)    // stays with the sprint
  assert.deepEqual(page.problems, [])
})

test('someone removed from a project loses it at once, even with it open on screen', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Private', key: 'PRV', template: 'kanban' })
  const mayaId = await idOf('maya@e2e.test')
  await owner('POST', '/projects/PRV/members', { userIds: [mayaId], role: 'member' })
  const item = (await owner('POST', '/projects/PRV/issues', { title: 'Confidential plan' })).body
  const m = await signIn('maya@e2e.test')
  const connected = new Promise(res => m.on('response', r => { if (r.url().includes('/projects/PRV/events')) res(r.status()) }))
  const streamEnded = new Promise(res => m.on('requestfinished', r => { if (r.url().includes('/projects/PRV/events')) res(true) }))
  await m.goto(url('/project/PRV/board'))
  await m.waitForSelector('text=Confidential plan')
  assert.equal(await connected, 200)                     // the live stream is really open before access is taken away
  assert.equal((await owner('DELETE', `/projects/PRV/members/${mayaId}`)).status, 204)
  assert.equal(await Promise.race([streamEnded, new Promise(r => setTimeout(() => r(false), 10_000))]), true)
  await m.goto(url(`/i/${item.key}`))
  await m.waitForSelector('text=not found')
  assert.equal((await maya('GET', `/issues/${item.key}`)).status, 404)
})
