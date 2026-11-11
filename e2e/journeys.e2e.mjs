// The main journeys, end to end in a real browser. Each one checks what a person sees and what the server keeps.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { start, stop, skip, signIn, signedOut, as, url, PEOPLE, postRaw, RECOVERY_PASSWORD, github, mailDir } from './harness.mjs'

const owner = as('owner@e2e.test'), maya = as('maya@e2e.test'), vic = as('vic@e2e.test')
const idOf = async email => (await as(email)('GET', '/me')).body.id
let flows = 0
/** Give project `p` workflows of its own, made in the library by the owner (a system administrator): its statuses, these
 *  moves (between its status ids), and for `byType` work types another workflow. Returns the workflow id. */
const flow = async (p, moves, byType = {}) => {
  const statuses = p.statuses.map(s => ({ id: s.globalStatusId, name: s.name, color: s.color, category: s.category }))
  const gid = id => p.statuses.find(s => s.id === id)?.globalStatusId ?? id
  const make = async ms => {
    const w = (await owner('POST', '/admin/workflows', { name: `${p.key} flow ${++flows}` })).body
    const r = await owner('POST', `/admin/workflows/${w.id}/publish`, { statuses,
      transitions: ms.map((m, i) => ({ id: String(i), name: m.name, fromIds: m.fromIds ? m.fromIds.map(gid) : null, toId: m.toId && gid(m.toId), rules: m.rules ?? {} })) })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return w.id
  }
  const mappings = {}
  for (const [t, ms] of Object.entries(byType)) mappings[t] = await make(ms)
  const id = await make(moves)
  const scheme = (await owner('POST', '/admin/workflow-schemes', { name: `${p.key} scheme ${++flows}`, defaultWorkflowId: id, mappings })).body
  assert.equal((await owner('PUT', `/projects/${p.key}/workflow-scheme`, { schemeId: scheme.id })).status, 200)
  return id
}

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
  await flow(p, [{ name: 'Start', fromIds: [todo.id], toId: doing.id }])
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

test('transition rules: a system admin adds one in the editor; a move is hidden or asks for details; a loop acts from the Actions menu', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Rules', key: 'RLS', template: 'kanban' })).body
  const [todo, doing, done] = [p.statuses[0], p.statuses[1], p.statuses.find(s => s.category === 'done')]
  const wf = await flow(p, [
    { name: 'Start', fromIds: [todo.id], toId: doing.id },
    { name: 'Finish', fromIds: [doing.id], toId: done.id, rules: { validate: [{ kind: 'required', fields: ['dueDate'] }], screen: ['dueDate', 'comment'] } },
    { name: 'Log progress', fromIds: [doing.id], toId: null, rules: { validate: [{ kind: 'required', fields: ['comment'] }], screen: ['comment'] } },
  ])
  await owner('POST', '/projects/RLS/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/RLS/issues', { title: 'Ruled work' })).body
  await owner('PATCH', `/issues/${item.key}`, { statusId: doing.id })

  // the system admin restricts Finish to project admins in the workflow editor (Administration › Workflows; list view, Rules tab)
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/admin/workflows/${wf}`))
  await o.click('.wf-tools [role="tab"]:has-text("List")')
  await o.click('.wf-list tr:has-text("Finish")')
  await o.click('.wf-panel [role="tab"]:has-text("Rules")')
  await o.selectOption('section[aria-label="Restrict transition"] select[aria-label="Add rule"]', { label: 'Only a project role' })
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.waitForSelector('.modal >> text=Applies to 1 project')
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
  await flow(p, [], { [inc.key]: [{ name: 'Resolve', fromIds: [todo.id], toId: done.id }] })
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

test('[0103.R3][0103.R7] workflow versions: a status with work items can’t leave an active workflow (the update says where they are); once moved, it can; each update is a version that can be loaded back', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Releases flow', key: 'RFL', template: 'scrum' })).body
  const review = p.statuses.find(s => s.name === 'In review'), doing = p.statuses.find(s => s.name === 'In progress')
  const items = []
  for (let n = 0; n < 2; n++) items.push((await owner('POST', '/projects/RFL/issues', { title: `In review ${n}`, statusId: review.id })).body)
  const wf = await flow(p, p.statuses.map(s => ({ name: s.name, toId: s.id })))          // each status from any other, as a new project has
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/admin/workflows/${wf}`))
  await o.click('.wf-tools [role="tab"]:has-text("List")')
  await o.click('.wf-list tr:has-text("In review")')
  await o.click('.wf-panel button:has-text("Delete status")')
  await o.click('.modal button:has-text("Delete status")')
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.waitForSelector('.modal >> text=A status with work items can’t be removed.')
  assert.match(await o.locator('.modal').innerText(), /In review has 2 work items in RFL/)
  assert.equal(await o.locator('.modal button:has-text("Update workflow")').isDisabled(), true)
  await o.click('.modal button:has-text("Keep editing")')
  // move the work out, then the update goes through
  for (const i of items) await owner('PATCH', `/issues/${i.key}`, { statusId: doing.id })
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.waitForSelector('.modal >> text=Applies to 1 project')
  assert.match(await o.locator('.modal').innerText(), /Removes the status “In review”/)
  await o.fill('#pub-note', 'No review step')
  await o.click('.modal button:has-text("Update workflow")')
  await o.waitForSelector('text=Workflow updated: version 2. Applying it to 1 project…')
  await o.waitForSelector('.apply-banner >> text=Applied to 1 project.')                // followed in the background to its end
  assert.ok(!(await owner('GET', '/projects/RFL')).body.statuses.some(s => s.name === 'In review'))
  // version 2 is the workflow without the review step: compare it with the editor (the same)
  const versions = (await owner('GET', `/workflows/${wf}/versions`)).body
  assert.deepEqual(versions.map(v => [v.version, v.note]), [[2, 'No review step'], [1, '']])
  await o.click('.wf-bar button:has-text("Versions")')
  await o.click('.modal tr:has-text("No review step")')
  await o.waitForSelector('.modal >> text=Going from version 2')
  assert.match(await o.locator('.modal').innerText(), /They are the same/)
  assert.deepEqual(o.problems, [])
})

test('[0103.R7] shared workflows: a system admin copies one, adds a status, makes a scheme and switches a project to it; the board gets the column; the project admin only reads it', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Switching', key: 'WFJ', template: 'kanban' })
  await owner('POST', '/projects/WFJ/members', { userIds: [await idOf('maya@e2e.test')], role: 'admin' })
  await owner('POST', '/projects/WFJ/issues', { title: 'Already started' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/workflows'))
  await o.click('[aria-label="Copy Kanban"]')
  await o.fill('#wfa-name', 'Kanban with review')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('.wf-title:has-text("Kanban with review")')
  await o.click('.wf-tools button:has-text("Add status")')
  await o.fill('#as-name', 'In review')
  await o.waitForSelector('.modal >> text=An existing status')                         // the shared one, not a second "In review"
  await o.click('.modal button:has-text("Add status")')
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.waitForSelector('.modal >> text=No project uses this yet')
  await o.click('.modal button:has-text("Update workflow")')
  await o.waitForSelector('text=Workflow updated')
  await o.click('.wf-bar button:has-text("Workflows")')
  await o.click('nav[aria-label="Workflows"] a:has-text("Schemes")')
  await o.waitForURL(/\/admin\/workflows\/schemes$/)
  await o.click('button:has-text("Add scheme")')
  await o.fill('#wsc-name', 'Reviewed')
  await o.selectOption('#wsc-default', { label: 'Kanban with review' })
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('td:has-text("Reviewed")')
  const scheme = (await owner('GET', '/workflow-schemes')).body.find(x => x.name === 'Reviewed')

  // Maya, the project's admin, reads the workflow but can't switch it (spec 0103: Jira administrators do)
  const m = await signIn('maya@e2e.test')
  await m.goto(url('/project/WFJ/settings/workflow'))
  await m.waitForSelector('h1:has-text("Workflow")')
  assert.equal(await m.locator('.wf-bar').count(), 0)                                    // nothing to edit here
  assert.equal(await m.locator('button:has-text("Change workflow")').count(), 0)
  // the owner switches it: the preview first, then Apply
  await o.goto(url('/project/WFJ/settings/workflow'))
  await o.click('button:has-text("Change workflow")')
  await o.selectOption('#cw-scheme', scheme.id)
  await o.waitForSelector('.modal >> text=adds In review')
  await o.click('.modal button:has-text("Apply")')
  await o.waitForSelector('text=WFJ now uses Reviewed')
  await m.goto(url('/project/WFJ/board'))
  await m.waitForSelector('main >> text=In review')
  assert.equal((await owner('GET', '/projects/WFJ')).body.workflowSchemeId, scheme.id)
  // only system administrators change workflows
  assert.equal((await maya('POST', '/admin/workflows', { name: 'Mine' })).status, 403)
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('a workflow used by many projects: a count opens them, searchable a page at a time; publishing summarises the change and shows it applying to the end', { skip, timeout: 180_000 }, async () => {
  const keys = Array.from({ length: 60 }, (_, n) => `BIG${String.fromCharCode(65 + Math.floor(n / 10), 65 + (n % 10))}`)   // letters only: Jira's default key pattern (spec 0308)
  for (const key of keys) await owner('POST', '/projects', { name: `Big ${key}`, key, template: 'kanban' })
  const first = (await owner('GET', `/projects/${keys[0]}`)).body
  const wf = await flow(first, first.statuses.map(s => ({ name: s.name, toId: s.id })))
  const schemeId = (await owner('GET', `/projects/${keys[0]}`)).body.workflowSchemeId
  for (const key of keys.slice(1)) await owner('PUT', `/projects/${key}/workflow-scheme`, { schemeId })
  for (const key of keys.slice(0, 4)) {
    const p = (await owner('GET', `/projects/${key}`)).body
    await owner('POST', `/projects/${key}/issues`, { title: 'done already', statusId: p.statuses.find(s => s.name === 'Done').id })   // work, but not in the status that goes
  }
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/admin/workflows/${wf}`))
  // the header counts the projects; the count opens them, 50 at a time, searchable
  await o.click('.wf-bar button:has-text("60 projects")')
  const panel = o.locator('aside[aria-label^="Projects using"]')
  await panel.locator('text=Showing 50 of 60').waitFor()
  await panel.locator('button:has-text("Load more")').click()
  await panel.locator('text=Showing 60 of 60').waitFor()
  await panel.locator('input').fill('BIGF')
  await panel.locator('text=/^10 matching/').waitFor()
  await o.keyboard.press('Escape')
  // take In progress out (no work is in it): the dialog summarises (no line per project) and the change applies in the background
  await o.click('.wf-tools [role="tab"]:has-text("List")')
  await o.click('.wf-list tr:has-text("In progress")')
  await o.click('.wf-panel button:has-text("Delete status")')
  await o.click('.modal button:has-text("Delete status")')
  await o.click('.wf-bar button:has-text("Update workflow")')
  await o.waitForSelector('.modal >> text=Applies to 60 projects')
  const text = await o.locator('.modal').innerText()
  assert.match(text, /Every one changes: they lose In progress/)
  assert.match(text, /The 10 projects most changed/)
  assert.equal(await o.locator('.modal .summary .change-list.sm li').count(), 10, 'the ten most changed, not a line per project')
  await o.click('.modal button:has-text("Update workflow")')
  await o.waitForSelector('.apply-banner >> text=Applied to 60 projects.', { timeout: 120_000 })
  for (const key of [keys[0], keys[59]]) assert.deepEqual((await owner('GET', `/projects/${key}`)).body.statuses.map(s => s.name), ['To do', 'Done'])
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
  const rule = (await owner('POST', '/projects/RBT/rules', { name: 'Broken one', trigger: { kind: 'created' }, actions: [{ kind: 'priority', value: 'high' }] })).body
  // broken since it was saved (saving checks the priority list, spec 0305): its priority isn't in the list any more
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  await c.query(`update rules set actions = '[{"kind": "priority", "value": "bogus"}]' where id = $1`, [rule.id]); await c.end()
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
    const e = (await owner('POST', '/projects/CVG/issues', { title: `Run ${status}`, type: 'test_execution', fixReleaseIds: [v1.id] })).body
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

test('testing reports: traceability shows a requirement, its failing test and the defect; JQL finds a plan’s failed tests', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Trace', key: 'TRA', template: 'kanban' })
  await owner('PUT', '/projects/TRA/testing', { enabled: true })
  const story = (await owner('POST', '/projects/TRA/issues', { title: 'Customers get receipts', type: 'story' })).body
  const [t1, t2] = [(await owner('POST', '/projects/TRA/issues', { title: 'Receipt is emailed', type: 'test' })).body, (await owner('POST', '/projects/TRA/issues', { title: 'Receipt is printable', type: 'test' })).body]
  for (const t of [t1, t2]) await owner('POST', `/issues/${t.key}/links`, { type: 'tests', targetKey: story.key })
  const plan = (await owner('POST', '/projects/TRA/issues', { title: 'Sprint 9', type: 'test_plan' })).body
  await owner('POST', `/issues/${plan.key}/tests`, { keys: [t1.key, t2.key] })
  const exec = (await owner('POST', `/issues/${plan.key}/executions`, {})).body
  const runs = (await owner('GET', `/issues/${exec.key}/runs`)).body
  await owner('PATCH', `/test-runs/${runs[0].id}`, { status: 'FAIL' }); await owner('PATCH', `/test-runs/${runs[1].id}`, { status: 'PASS' })
  const bug = (await owner('POST', `/test-runs/${runs[0].id}/defects`, { title: 'Email never arrives' })).body.defect
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/TRA/reports/traceability'))
  await o.waitForSelector(`.trace-table a:has-text("${bug.key}")`)
  const row = await o.locator(`.trace-table tr:has(a:has-text("${t1.key}"))`).innerText()
  assert.match(row, /Failed/)
  assert.match(await o.locator(`.trace-table tr:has(a:has-text("${story.key}"))`).innerText(), /NOK/)
  await o.goto(url('/project/TRA/reports/test-coverage'))
  await o.waitForSelector('.coverage-bar[aria-label="1 NOK"]')
  // JQL with Xray's function
  await o.goto(url('/search?q='))
  await o.click('button:has-text("Switch to JQL")')
  await o.fill('textarea[aria-label="JQL query"]', `issue in testPlanTests("${plan.key}", "FAIL")`)
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector(`text=${t1.key}`)
  await o.waitForSelector('text=1 result')
  assert.deepEqual(o.problems, [])
})

test('long pages scroll: Administration and the Tests tab reach their last section on a short window', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Scrolls', key: 'SCR', template: 'kanban' })
  await owner('PUT', '/projects/SCR/testing', { enabled: true })
  for (let n = 0; n < 40; n++) await owner('POST', '/projects/SCR/issues', { title: `Scroll test ${n}`, type: 'test' })
  const o = await signIn('owner@e2e.test')
  await o.setViewportSize({ width: 1200, height: 500 })
  // the scrolling area must be able to bring the last thing on the page into view
  const reachesEnd = async (scroller, last) => {
    await o.waitForSelector(last)
    await o.locator(scroller).evaluate(el => { el.scrollTop = el.scrollHeight })
    return o.locator(last).last().evaluate(el => el.getBoundingClientRect().bottom <= window.innerHeight + 1)   // its end is on screen, not cut off
  }
  for (const section of ['settings/rate-limiting', 'people', 'audit']) {
    await o.goto(url(`/admin/${section}`))
    assert.ok(await reachesEnd('.admin-body', '.admin-body :is(.panel, tr, li):not(:has(.panel, tr, li))'), `Administration › ${section} scrolls to its end`)
  }
  await o.goto(url('/project/SCR/tests'))
  assert.ok(await reachesEnd('.repo', '.repo-list tr'), 'the Tests tab scrolls to its last test')
  assert.deepEqual(o.problems, [])
})

test('Administration: a grouped menu of links; every page, a group, a Workflows part and a settings page have their own address', { skip, timeout: 60_000 }, async () => {
  const g = (await owner('POST', '/groups', { name: 'Linkable' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin'))
  const menu = o.locator('nav[aria-label="Administration"]')
  await menu.locator('.nav-section').first().waitFor()
  assert.deepEqual(await menu.locator('.nav-section').allInnerTexts(), ['PEOPLE & ACCESS', 'PROJECTS', 'WORK ITEMS', 'SYSTEM'])
  assert.equal(await menu.locator('a[aria-current="page"]').innerText(), 'People')
  await menu.locator('a:has-text("Test statuses")').click()
  await o.waitForURL(/\/admin\/test-statuses$/)
  await o.waitForSelector('h1:has-text("Test statuses")')
  // System settings is a page per setting, listed under it
  await menu.locator('a:has-text("System settings")').click()
  await menu.locator('a:has-text("Attachments")').click()
  await o.waitForURL(/\/admin\/settings\/attachments$/)
  await o.waitForSelector('section[aria-label="Attachments"]')
  assert.equal(await o.locator('section[aria-label="Rate limiting"]').count(), 0)
  // opening a group puts it in the address; the address opens it again
  await menu.locator('a:has-text("Groups")').click()
  await o.click('.groups-item:has-text("Linkable")')
  await o.waitForURL(new RegExp(`/admin/groups/${g.id}$`))
  await o.goto(url(`/admin/groups/${g.id}`))
  await o.waitForSelector('section[aria-label="Group Linkable"]')
  // the page's main action is in its header
  await o.goto(url('/admin/link-types'))
  await o.waitForSelector('.admin-hdr button:has-text("Add link type")')
  assert.deepEqual(o.problems, [])
})

test('Administration asks before removing: a group member (saying what access they lose), and a group with project roles only once its name is typed', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Asking', key: 'ASK', template: 'kanban' })
  const g = (await owner('POST', '/groups', { name: 'askers' })).body
  await owner('POST', `/groups/${g.id}/members`, { userIds: [await idOf('vic@e2e.test')] })
  await owner('POST', '/projects/ASK/groups', { groupId: g.id, role: 'member' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/admin/groups/${g.id}`))
  const detail = o.locator('section[aria-label="Group askers"]')
  await detail.locator(`[aria-label="Remove ${PEOPLE['vic@e2e.test']}"]`).click()
  assert.match(await o.locator('.modal').innerText(), /lose the roles this group gives in 1 project/)
  await o.click('.modal button:has-text("Cancel")')
  assert.equal(await detail.locator(`.person:has-text("${PEOPLE['vic@e2e.test']}")`).count(), 1)     // Cancel changes nothing
  await detail.locator(`[aria-label="Remove ${PEOPLE['vic@e2e.test']}"]`).click()
  await o.click('.modal button:text-is("Remove")')
  await o.waitForSelector(`text=Removed ${PEOPLE['vic@e2e.test']}`)
  // deleting a group that gives project roles needs its name typed
  await detail.locator('[aria-label="Delete group"]').click()
  const del = o.locator('.modal button:has-text("Delete group")')
  assert.equal(await del.isDisabled(), true)
  await o.fill('#confirm-type', 'askers')
  await del.click()
  await o.waitForSelector('text=Deleted askers')
  assert.equal((await owner('GET', `/groups/${g.id}`)).status, 404)
  assert.deepEqual(o.problems, [])
})

test('system groups: a newcomer is in users-access and sees no Administration; a system administrator does', { skip, timeout: 60_000 }, async () => {
  const n = await signIn('sam@e2e.test')
  await n.waitForSelector('nav :text("Configuration")')                     // not an admin: the area is Configuration, with only Groups
  assert.equal(await n.locator('nav :text("Administration")').count(), 0)
  assert.equal(await n.locator('nav :text("Settings")').count(), 0)          // Settings lives in the profile menu
  await n.click('nav :text("Configuration")')
  await n.waitForSelector('h1:has-text("Groups")')
  assert.equal(await n.locator('nav[aria-label="Configuration"]').count(), 0)            // only one page: no menu
  await n.goto(url('/admin/settings'))
  await n.waitForSelector('section[aria-label="Groups"], .groups')            // an admin-only section falls back to Groups
  const me = (await as('sam@e2e.test')('GET', '/me')).body
  const groups = (await as('owner@e2e.test')('GET', '/admin/users')).status
  assert.equal(groups, 200)
  assert.equal(me.admin, false)
  const boss = await signIn('owner@e2e.test')                                  // the first person is a system administrator
  await boss.waitForSelector('nav :text("Administration")')
  await boss.click('nav :text("Administration")')
  await boss.waitForSelector('.admin-body')
  assert.deepEqual([...n.problems, ...boss.problems], [])
})

test('groups: a member makes mobile-developers and adds a colleague; a project admin gives it Member; the colleague can then work there', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Phone app', key: 'APP', template: 'kanban' })
  const vicId = await idOf('vic@e2e.test')
  const m = await signIn('maya@e2e.test')
  await m.click('nav :text("Configuration")')                                 // not an admin: Configuration, with Groups
  await m.click('button:has-text("New group")')
  await m.fill('#gr-name', 'mobile-developers')
  await m.click('.modal button:has-text("Make group")')
  await m.waitForSelector('section[aria-label="Group mobile-developers"]')
  await m.click('section[aria-label="Group mobile-developers"] button:has-text("Add people")')
  await m.selectOption('.modal [aria-label="Person"]', vicId)
  await m.click('.modal button:has-text("Add 1 person")')
  await m.waitForSelector('section[aria-label="Group mobile-developers"] .person:has-text("Vic Viewer")')
  // Vic can't see the project yet; the project admin adds the group as Member, and sees who manages it
  assert.equal((await as('vic@e2e.test')('GET', '/projects/APP')).status, 404)
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/APP/settings/people'))
  await o.click('button:has-text("Add a group")')
  await o.fill('#pg-search', 'mobile')
  await o.click('.modal .picker-item:has-text("mobile-developers")')
  assert.match(await o.locator('.modal .picker-item:has-text("mobile-developers")').innerText(), /managed by Maya Member/)
  await o.click('.modal button:has-text("Add")')
  await o.waitForSelector('.person:has-text("mobile-developers")')
  assert.equal((await as('vic@e2e.test')('POST', '/projects/APP/issues', { title: 'Through the group' })).status, 201)
  assert.deepEqual([...m.problems, ...o.problems], [])
})

test('[0710.R1][0710.R3] Administration has no License cleanup; People still finds those inactive for a while', { skip, timeout: 90_000 }, async () => {
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  const samId = await idOf('sam@e2e.test')
  await c.query(`update users set last_active_at = now() - interval '200 days' where id = $1`, [samId])   // Sam hasn't used Strand for 200 days
  await c.end()
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/people'))
  assert.equal(await o.locator('nav >> text=License cleanup').count(), 0)
  await o.selectOption('[aria-label="Inactive"]', '180')
  await o.waitForSelector('td:has-text("Sam Someone")')
  assert.deepEqual(o.problems, [])
})

test('people at scale: searched and paged on the server; everyone a filter matches is changed in the background', { skip, timeout: 120_000 }, async () => {
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  const ws = (await owner('GET', '/me')).body.workspaceId
  await c.query(`insert into users (email, name, initials) select 'paged' || n || '@e2e.test', 'Paged person ' || lpad(n::text, 2, '0'), 'PP' from generate_series(1, 70) n`)
  await c.query(`insert into memberships (workspace_id, user_id, role) select $1, id, 'member' from users where email like 'paged%@e2e.test'`, [ws])
  await c.end()
  const team = (await owner('POST', '/groups', { name: 'paged-team' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/people'))
  await o.fill('[aria-label="Find a person"]', 'paged person')
  await o.waitForSelector('text=Showing 50 of 70')
  await o.click('button:has-text("Load 20 more")')
  await o.waitForSelector('text=Showing 70 of 70')
  await o.fill('[aria-label="Find a person"]', 'paged person 0')
  await o.waitForSelector('text=Showing 9 of 9')
  await o.fill('[aria-label="Find a person"]', 'paged person')
  await o.waitForSelector('text=Showing 50 of 70')
  // everyone shown, then everyone matching (70, more than the page), into a group found by search
  await o.check('[aria-label="Select everyone shown"]')
  await o.click('button:has-text("Select all 70 matching")')
  await o.selectOption('[aria-label="Bulk action"]', 'add-to-group')
  await o.fill('.modal [aria-label="Which group"]', 'paged-te')
  await o.click('.modal [role="option"]:has-text("paged-team")')
  await o.click('.modal button:text-is("Add to group")')
  await o.waitForSelector('text=Changed 70', { timeout: 30_000 })
  assert.equal((await owner('GET', `/groups/${team.id}`)).body.members, 71)                  // the 70, and its maker
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

test('boards: a project admin adds a board with its own filter; quick filters narrow it and stay in the address; a board can span projects', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Boards', key: 'BRD', template: 'kanban' })
  await owner('POST', '/projects', { name: 'Neighbours', key: 'BRX', template: 'kanban' })
  const me = await idOf('owner@e2e.test')
  await owner('POST', '/projects/BRD/issues', { title: 'Crash on save', type: 'bug' })
  await owner('POST', '/projects/BRD/issues', { title: 'Mine to fix', type: 'bug', assigneeId: me })
  await owner('POST', '/projects/BRD/issues', { title: 'Write the docs' })
  await owner('POST', '/projects/BRX/issues', { title: 'Next door work' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/BRD/board'))
  await o.waitForSelector('text=Write the docs')
  await o.waitForURL(/\/project\/BRD\/board\/[0-9a-f-]{36}$/)                             // the address names the board

  await o.click('.board-switch')
  await o.click('.picker-menu .picker-item:has-text("Create board")')
  await o.fill('#cb-name', 'Bugs board')
  await o.click('.modal >> text=Work items a filter finds')
  await o.fill('.modal textarea[aria-label="JQL query"]', 'project = BRD AND type = bug')
  await o.waitForSelector('.modal >> text=2 work items match now.')
  await o.click('.modal button:has-text("Create board")')
  await o.waitForSelector('.board-switch:has-text("Bugs board")')
  await o.waitForSelector('text=Crash on save')
  assert.equal(await o.locator('text=Write the docs').count(), 0)
  const bugs = (await owner('GET', '/projects/BRD/boards')).body.find(b => b.name === 'Bugs board')
  assert.equal(bugs.jql, 'project = BRD AND type = bug')

  // Only my issues: the address keeps it, so a reload (or a shared link) shows the same
  await o.click('.quick-filters button:has-text("Only my issues")')
  await o.waitForURL(/quick=/)
  await o.reload()
  await o.waitForSelector('text=Mine to fix')
  assert.equal(await o.locator('text=Crash on save').count(), 0)
  assert.equal(await o.locator('.quick-filters button[aria-pressed="true"]').count(), 1)

  // one board across both projects, chosen from the switcher
  await owner('POST', '/projects/BRD/boards', { name: 'Both teams', type: 'kanban', jql: 'project in (BRD, BRX)' })
  await o.goto(url('/project/BRD/board'))                                                  // the board last used here
  await o.waitForSelector('.board-switch:has-text("Bugs board")')
  await o.click('.board-switch')
  await o.click('.picker-menu .picker-item:has-text("Both teams")')
  await o.waitForSelector('text=Next door work')
  await o.waitForSelector('text=Write the docs')
  assert.deepEqual(o.problems, [])
})

test('a member collapses a board column for themselves: no error, nothing changes for anyone else, and it stays collapsed', { skip, timeout: 60_000 }, async () => {
  await owner('POST', '/projects', { name: 'Collapse', key: 'CLP', template: 'kanban' })
  await owner('POST', '/projects/CLP/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  await owner('POST', '/projects/CLP/issues', { title: 'Something to do' })
  const m = await signIn('maya@e2e.test')
  const refused = []
  m.on('response', r => { if (r.status() >= 400) refused.push(`${r.request().method()} ${r.url()} ${r.status()}`) })
  await m.goto(url('/project/CLP/board'))
  await m.waitForSelector('text=Something to do')
  await m.click('.board-switch')
  await m.waitForSelector('.picker-menu .picker-item:has-text("CLP board")')
  assert.equal(await m.locator('.picker-menu .picker-item:has-text("Create board")').count(), 0)   // members don't add boards
  await m.keyboard.press('Escape')
  await m.click('[aria-label="Collapse To do column"]')
  await m.waitForSelector('[aria-label="Expand To do column"]')
  await m.reload()
  await m.waitForSelector('[aria-label="Expand To do column"]')
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/CLP/board'))
  await o.waitForSelector('[aria-label="Collapse To do column"]')                         // the owner's board is as it was
  assert.deepEqual([refused, m.problems, o.problems], [[], [], []])
})

test('configure a board: its admin narrows the filter, puts two statuses in one column with a maximum, adds a quick filter (a mistake shows where); a member can only read the settings', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Configured', key: 'CFG', template: 'kanban' })
  await owner('POST', '/projects/CFG/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  await owner('POST', '/projects/CFG/issues', { title: 'Urgent bug', type: 'bug', priority: 'urgent' })
  await owner('POST', '/projects/CFG/issues', { title: 'Calm bug', type: 'bug', priority: 'low' })
  const board = (await owner('POST', '/projects/CFG/boards', { name: 'Bugs', type: 'kanban', jql: 'project = CFG AND type = bug' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/CFG/board/${board.id}`))
  await o.waitForSelector('text=Calm bug')
  await o.click('.board-switch')
  await o.click('.picker-menu .picker-item:has-text("Configure board")')
  await o.waitForSelector('h1:has-text("Configure Bugs")')
  assert.match(o.url(), new RegExp(`/project/CFG/boards/${board.id}$`))

  // the filter, with a count while it is written
  await o.fill('#general textarea[aria-label="JQL query"]', 'project = CFG AND type = bug AND priority = urgent')
  await o.waitForSelector('#general >> text=1 work item matches now.')
  await o.click('#general button:has-text("Save")')
  await o.waitForSelector('#general button:has-text("Save"):disabled')

  // In progress joins To do in one column, renamed Open, with a maximum of 1; the emptied column goes
  await o.click('[aria-label="Move In progress to…"]')
  await o.click('[role="menu"] button:has-text("To do")')
  await o.click('[aria-label="Remove In progress"]')
  await o.fill('#columns [aria-label="Column name"] >> nth=0', 'Open')
  await o.fill('[aria-label="Maximum for Open"]', '1')
  await o.click('#columns button:has-text("Save")')
  await o.waitForSelector('#columns button:has-text("Save"):disabled')
  const cols = (await owner('GET', `/boards/${board.id}`)).body.columns
  assert.deepEqual(cols.map(c => [c.name, c.statusIds.length, c.max ?? null]), [['Open', 2, 1], ['Done', 1, null]])

  // a quick filter: a mistake in its query is shown on its row, then fixed
  await o.click('#quick-filters button:has-text("Add quick filter")')
  await o.fill('#quick-filters [aria-label="Quick filter name"] >> nth=2', 'Low')
  await o.fill('[aria-label="Low JQL"]', 'priority = = low')
  await o.click('#quick-filters button:has-text("Save")')
  await o.waitForSelector('#quick-filters .query-row [role="alert"]')
  await o.fill('[aria-label="Low JQL"]', 'priority = low')
  await o.click('#quick-filters button:has-text("Save")')
  await o.waitForSelector('#quick-filters button:has-text("Save"):disabled')

  // the board follows: only the urgent bug, in Open, with its limit; the new quick filter is there
  await o.click('button:has-text("Open board")')
  await o.waitForSelector('text=Urgent bug')
  assert.equal(await o.locator('text=Calm bug').count(), 0)
  await o.waitForSelector('.col-hdr:has-text("Open") >> text=Max 1')
  await o.waitForSelector('.quick-filters button:has-text("Low")')

  // a member reads the settings but can't change them
  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/project/CFG/boards/${board.id}`))
  await m.waitForSelector('text=Only its administrators and the project’s admins can change it.')
  await m.waitForSelector('#general >> text=priority = urgent')
  assert.equal(await m.locator('.board-config button:has-text("Save")').count(), 0)
  assert.equal(await m.locator('#delete').count(), 0)
  assert.equal((await maya('PATCH', `/boards/${board.id}`, { name: 'Mine' })).status, 403)
  assert.deepEqual([...o.problems.filter(p => !/status of 400/.test(p)), ...m.problems], [])   // the 400 is the mistake made on purpose
})

test('a Scrum board across two projects: its backlog has both projects’ work; a sprint planned there holds both, starts on its own board, and the board shows it', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Team one', key: 'SBA', template: 'scrum' })
  await owner('POST', '/projects', { name: 'Team two', key: 'SBB', template: 'scrum' })
  const one = (await owner('POST', '/projects/SBA/issues', { title: 'Work from one' })).body
  const two = (await owner('POST', '/projects/SBB/issues', { title: 'Work from two' })).body
  const board = (await owner('POST', '/projects/SBA/boards', { name: 'Release train', type: 'scrum', jql: 'project in (SBA, SBB)' })).body
  // the project's own board already runs a sprint: another board can still start one
  const ownSprint = (await owner('POST', '/projects/SBA/sprints', { name: 'Own sprint' })).body
  await owner('POST', '/projects/SBA/issues', { title: 'Own work', sprintId: ownSprint.id })
  await owner('POST', `/projects/SBA/sprints/${ownSprint.id}/start`, { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() })

  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/SBA/backlog/${board.id}`))
  await o.waitForSelector('text=Work from one')
  await o.waitForSelector('text=Work from two')
  assert.equal(await o.locator('text=Own sprint').count(), 0)                                // another board's sprint isn't here
  await o.click('.toolbar button:has-text("Create sprint")')
  await o.waitForSelector('.sprint-name:has-text("SBA Sprint")')
  for (const key of [one.key, two.key]) {
    await o.click(`[aria-label="Move ${key}"]`)
    await o.click('[role="menu"] button:has-text("Move to SBA Sprint")')
  }
  await o.waitForSelector('button:has-text("Start sprint"):not([disabled])')
  await o.click('button:has-text("Start sprint")')
  await o.click('.modal button:has-text("Start sprint")')
  await o.waitForSelector('button:has-text("Complete sprint")')
  const sprints = (await owner('GET', '/projects/SBA')).body.sprints
  const train = sprints.find(s => s.boardId === board.id)
  assert.equal(train.state, 'active')
  assert.equal(sprints.find(s => s.id === ownSprint.id).state, 'active')                     // both boards have an active sprint
  assert.equal((await owner('GET', `/issues/${two.key}`)).body.sprintId, train.id)            // another project's work in it

  await o.goto(url(`/project/SBA/board/${board.id}`))
  await o.waitForSelector('text=Work from two')
  await o.waitForSelector('text=Work from one')
  assert.equal(await o.locator('text=Own work').count(), 0)
  assert.deepEqual(o.problems, [])
})

test('[0101.R7][0101.R9] sprints on a board across two projects: someone who can change only one of them sees the sprint actions off; the owner completes into a new sprint', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Sprint rights one', key: 'SRA', template: 'scrum' })
  await owner('POST', '/projects', { name: 'Sprint rights two', key: 'SRB', template: 'scrum' })
  await owner('POST', '/projects/SRA/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const board = (await owner('POST', '/projects/SRA/boards', { name: 'Both rights', type: 'scrum', jql: 'project in (SRA, SRB)' })).body
  const sprint = (await owner('POST', '/projects/SRA/sprints', { name: 'Rights sprint', boardId: board.id })).body
  const left = (await owner('POST', '/projects/SRB/issues', { title: 'Still open', sprintId: sprint.id })).body
  await owner('POST', `/projects/SRA/sprints/${sprint.id}/start`, { endsAt: new Date(Date.now() + 7 * 864e5).toISOString() })

  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/project/SRA/backlog/${board.id}`))
  await m.waitForSelector('.sprint-name:has-text("Rights sprint")')
  for (const label of ['Create sprint', 'Complete sprint']) {
    const b = m.locator(`button:has-text("${label}")`).first()
    assert.equal(await b.isDisabled(), true, label)
    assert.equal(await b.getAttribute('title'), 'You need to be able to change work in every project this board covers')
  }

  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/SRA/backlog/${board.id}`))
  await o.click('button:has-text("Complete sprint")')
  await o.selectOption('#cs-target', { label: 'New sprint' })
  await o.click('.modal button:has-text("Complete sprint")')
  const sprintOf = async () => (await owner('GET', `/issues/${left.key}`)).body.sprintId
  for (let i = 0; i < 40 && (await sprintOf()) === sprint.id; i++) await new Promise(r => setTimeout(r, 250))
  const made = (await owner('GET', '/projects/SRA')).body.sprints.find(s => s.boardId === board.id && s.state === 'planned')
  assert.ok(made, 'a new planned sprint on the board')
  assert.equal(await sprintOf(), made.id)
  assert.equal((await owner('GET', '/projects/SRA')).body.sprints.find(s => s.id === sprint.id).state, 'closed')
  await o.waitForSelector(`.sprint-name:has-text("${made.name}")`)
  assert.deepEqual([...m.problems, ...o.problems], [])
})

test('[0102.R4][0102.R5][0102.R7] a global admin archives a project from its settings; a member then finds it read-only and gone from lists; it is restored from Administration', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Old project', key: 'ARJ', template: 'kanban' })
  await owner('POST', '/projects/ARJ/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/ARJ/issues', { title: 'Finished long ago' })).body

  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/ARJ/settings'))
  await o.click('button:has-text("Archive project")')
  await o.click('.modal button:has-text("Archive project")')
  await o.waitForURL(/\/projects$/)
  assert.ok((await owner('GET', '/projects/ARJ')).body.archivedAt)

  // R5 + R4: the member sees only that it is archived; its item opens from a link, read-only
  const m = await signIn('maya@e2e.test')
  await m.goto(url('/project/ARJ/board'))
  await m.waitForSelector('text=ARJ is archived')
  assert.equal(await m.locator('button:has-text("Restore project")').count(), 0)
  await m.goto(url(`/i/${item.key}`))
  await m.waitForSelector('text=This work item is in an archived project. It can’t be changed.')
  assert.equal(await m.locator('[aria-label="Add a comment"]').count(), 0)

  // R7: Administration › Archived projects lists it; restoring brings it back
  await o.goto(url('/admin/archived'))
  await o.waitForSelector('.paged-items >> text=Old project')
  await o.click('.paged-items button:has-text("Restore")')
  await o.click('.modal button:has-text("Restore project")')
  await o.waitForSelector('text=Old project restored')
  assert.equal((await owner('GET', '/projects/ARJ')).body.archivedAt, null)
  await m.goto(url('/project/ARJ/board'))
  await m.waitForSelector('text=Finished long ago')
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('[0105.R3][0105.R5][0105.R7] a project admin edits a dropdown field: renames an option (items follow), sorts A–Z, and deletes one after being told how many items have it', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Dropdowns', key: 'DRP', template: 'kanban' })
  const f = (await owner('POST', '/projects/DRP/fields', { name: 'Team', kind: 'select', options: [{ name: 'Web' }, { name: 'Mobile' }, { name: 'Data' }], position: 0 })).body
  const a = (await owner('POST', '/projects/DRP/issues', { title: 'App work', custom: { [f.id]: 'Mobile' } })).body
  const b = (await owner('POST', '/projects/DRP/issues', { title: 'Pipeline work', custom: { [f.id]: 'Data' } })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/DRP/settings'))
  await o.click('.person:has-text("Team") button:has-text("Edit")')
  await o.fill('[aria-label="Option 2"]', 'Mobile apps')
  await o.click('.modal button:has-text("Sort A–Z")')
  assert.deepEqual(await o.locator('.option-list input').evaluateAll(xs => xs.map(x => x.value)), ['Data', 'Mobile apps', 'Web'])
  await o.click('[aria-label="Delete Data"]')
  await o.waitForSelector('.modal >> text=1 work item has Data.')
  await o.click('.modal button:has-text("Delete option")')
  await o.click('.modal button:has-text("Save field")')
  await o.waitForSelector('text=Saved Team')
  const field = async () => (await owner('GET', '/projects/DRP')).body.fields.find(x => x.id === f.id)
  for (let i = 0; i < 40 && (await field()).options.length !== 2; i++) await new Promise(r => setTimeout(r, 250))
  assert.deepEqual((await field()).options.map(x => x.name), ['Mobile apps', 'Web'])
  assert.equal((await owner('GET', `/issues/${a.key}`)).body.custom[f.id], 'Mobile apps')
  assert.equal(f.id in (await owner('GET', `/issues/${b.key}`)).body.custom, false)
  // the item page shows the new name
  await o.goto(url(`/i/${a.key}`))
  await o.waitForSelector('text=Mobile apps')
  assert.deepEqual(o.problems, [])
})

test('[0202.R7][0202.R8] deleting as in Jira: a member has no Delete; an admin is told what goes with it, deletes, and restores it from Project settings', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Deleting', key: 'DLJ', template: 'kanban' })
  await owner('POST', '/projects/DLJ/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const story = (await owner('POST', '/projects/DLJ/issues', { title: 'Story to delete' })).body
  await owner('POST', '/projects/DLJ/issues', { title: 'Its sub-item', parentId: story.id })

  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${story.key}`))
  await m.waitForSelector('text=Story to delete')
  await m.click('.detail-hdr [aria-label="More actions"]')
  await m.waitForSelector('[role="menu"]')
  assert.equal(await m.locator('[role="menu"] button:has-text("Delete")').count(), 0)

  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${story.key}`))
  await o.waitForSelector('text=Story to delete')
  await o.click('.detail-hdr [aria-label="More actions"]')
  await o.click('[role="menu"] button:has-text("Delete")')
  await o.waitForSelector('.modal >> text=and 1 sub-item will be deleted')
  await o.click('.modal button:has-text("Delete")')
  const gone = async () => (await owner('GET', `/issues/${story.key}`)).status
  for (let i = 0; i < 40 && (await gone()) !== 404; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await gone(), 404)

  await o.goto(url('/project/DLJ/settings'))
  await o.waitForSelector('#deleted-items >> text=Story to delete')
  await o.waitForSelector('#deleted-items >> text=+ 1 sub-item')
  await o.click('#deleted-items button:has-text("Restore")')
  await o.waitForSelector(`text=${story.key} restored with 1 sub-item`)
  assert.equal(await gone(), 200)
  assert.deepEqual([...m.problems, ...o.problems], [])
})

test('[0203.R9] Jira’s default permissions on screen: a member can’t touch others’ comments or limit to admins; an admin edits a member’s comment and changes the reporter', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Moderated', key: 'MOD', template: 'kanban' })
  const mayaId = await idOf('maya@e2e.test'), vicId = await idOf('vic@e2e.test')
  await owner('POST', '/projects/MOD/members', { userIds: [mayaId], role: 'member' })
  await owner('POST', '/projects/MOD/members', { userIds: [vicId], role: 'member' })
  const item = (await owner('POST', '/projects/MOD/issues', { title: 'Talked about' })).body
  await vic('POST', `/issues/${item.key}/comments`, { body: 'Vic wrote this' })

  const m = await signIn('maya@e2e.test')
  await m.goto(url(`/i/${item.key}`))
  await m.waitForSelector('text=Vic wrote this')
  assert.equal(await m.locator('.comment:has-text("Vic wrote this") button:has-text("Edit")').count(), 0)
  await m.fill('[aria-label="Add a comment"]', 'mine')
  assert.deepEqual(await m.locator('[aria-label="Who can read this comment"] option').allTextContents(), ['Everyone who sees the item', 'Members only'])

  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('.comment:has-text("Vic wrote this") button:has-text("Edit")')
  await o.fill('[aria-label="Edit comment"]', 'Vic wrote this (tidied)')
  await o.click('.comment button:has-text("Save")')
  const comments = async () => (await owner('GET', `/issues/${item.key}/comments`)).body.items.map(c => c.body)
  for (let i = 0; i < 40 && !(await comments()).includes('Vic wrote this (tidied)'); i++) await new Promise(r => setTimeout(r, 250))
  assert.ok((await comments()).includes('Vic wrote this (tidied)'))
  await o.click('[title="Reporter"]')
  await o.fill('.picker-menu input', 'Maya')
  await o.click('.picker-menu .picker-item:has-text("Maya")')
  for (let i = 0; i < 40 && (await owner('GET', `/issues/${item.key}`)).body.reporterId !== mayaId; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal((await owner('GET', `/issues/${item.key}`)).body.reporterId, mayaId)
  assert.deepEqual([...m.problems, ...o.problems], [])
})

test('[0301.R1][0301.R3] several fix versions: set two on an item, then find it by either with JQL', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Versions', key: 'VER', template: 'kanban' })
  for (const name of ['2.3', '2.4']) await owner('POST', '/projects/VER/releases', { name })
  const item = (await owner('POST', '/projects/VER/issues', { title: 'Back-ported fix' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.selectOption('[aria-label="Add to fix versions"]', { label: '2.3' })
  await o.selectOption('[aria-label="Add to fix versions"]', { label: '2.4' })
  const fix = async () => (await owner('GET', `/issues/${item.key}`)).body.fixReleaseIds.length
  for (let i = 0; i < 40 && (await fix()) < 2; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await fix(), 2)
  await o.goto(url('/search?q='))
  await o.click('button:has-text("Switch to JQL")')
  await o.fill('textarea[aria-label="JQL query"]', 'project = VER AND fixVersion = "2.3"')
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector(`text=${item.key}`)
  await o.fill('textarea[aria-label="JQL query"]', 'project = VER AND fixVersion = "2.4"')
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector('text=1 result')
})

test('[0303.R6] the parent picker offers Jira’s levels: an epic or an item under it, never a sub-item; the server keeps the choice', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Levels', key: 'HIE', template: 'kanban' })
  const epic = (await owner('POST', '/projects/HIE/issues', { title: 'Payments epic', type: 'epic' })).body
  const item = (await owner('POST', '/projects/HIE/issues', { title: 'Card form', parentId: epic.id })).body
  await owner('POST', '/projects/HIE/issues', { title: 'Validate expiry', parentId: item.id })
  const lone = (await owner('POST', '/projects/HIE/issues', { title: 'Loose end' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${lone.key}`))
  await o.click('[title="Parent"]')
  const offered = await o.locator('.picker-menu .picker-item').allTextContents()
  assert.ok(offered.some(t => t.includes('Payments epic')) && offered.some(t => t.includes('Card form')))
  assert.ok(!offered.some(t => t.includes('Validate expiry')))                      // a sub-item has no sub-items
  await o.click('.picker-menu .picker-item:has-text("Card form")')
  const parentOf = async () => (await owner('GET', `/issues/${lone.key}`)).body.parentId
  for (let i = 0; i < 40 && (await parentOf()) !== item.id; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await parentOf(), item.id)
  assert.deepEqual(o.problems, [])
})

test('[0304.R5] versions as in Jira: deleting one used by work items moves them to another; merging folds one into another; archiving hides it', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Version admin', key: 'VRS', template: 'kanban' })
  const rel = async name => (await owner('POST', '/projects/VRS/releases', { name })).body.id
  const [v1, v2, v3] = [await rel('3.0'), await rel('3.1'), await rel('4.0')]
  const item = (await owner('POST', '/projects/VRS/issues', { title: 'Shipping item', fixReleaseIds: [v1] })).body
  const fix = async () => (await owner('GET', `/issues/${item.key}`)).body.fixReleaseIds
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/VRS/releases'))
  await o.click('[aria-label="Actions for 3.0"]')
  await o.click('[role="menuitem"]:has-text("Delete")')
  await o.waitForSelector('text=1 work item has it as a fix version')
  await o.selectOption('#del-fix', { label: '3.1' })
  await o.click('.modal button:has-text("Delete version")')
  for (let i = 0; i < 40 && (await fix())[0] !== v2; i++) await new Promise(r => setTimeout(r, 250))
  assert.deepEqual(await fix(), [v2])
  await o.click('[aria-label="Actions for 3.1"]')
  await o.click('[role="menuitem"]:has-text("Merge into another version")')
  await o.selectOption('#merge-into', { label: '4.0' })
  await o.click('.modal button:has-text("Merge")')
  for (let i = 0; i < 40 && (await fix())[0] !== v3; i++) await new Promise(r => setTimeout(r, 250))
  assert.deepEqual(await fix(), [v3])
  await o.waitForSelector('text=3.1', { state: 'detached' })
  await o.click('[aria-label="Actions for 4.0"]')
  await o.click('[role="menuitem"]:has-text("Archive")')
  await o.waitForSelector('text=Show archived (1)')
  for (let i = 0; i < 40 && !(await owner('GET', '/projects/VRS')).body.releases.find(r => r.id === v3).archived; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal((await owner('GET', '/projects/VRS')).body.releases.find(r => r.id === v3).archived, true)
  assert.deepEqual(o.problems, [])
})

test('[0305.R7] priorities are a list admins edit: Blocker added at the top shows in an item’s picker, first; new work gets the default, Medium', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Prioritised', key: 'PRI', template: 'kanban' })
  const item = (await owner('POST', '/projects/PRI/issues', { title: 'Needs triage' })).body
  assert.equal(item.priority, 'medium')
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/priorities'))
  await o.click('button:has-text("Add priority")')
  await o.fill('#li-name', 'Blocker')
  await o.click('.modal button:has-text("Add")')
  await o.waitForSelector('input[aria-label="Blocker: name"]')
  for (let n = 0; n < 6; n++) {                                                      // up to the top of the list
    const up = o.locator('[aria-label="Move Blocker up"]')
    if (await up.isDisabled()) break
    await up.click(); await o.waitForTimeout(300)
  }
  await o.goto(url(`/i/${item.key}`))
  await o.click('[title="Priority"]')
  assert.match(await o.locator('.picker-menu .picker-item').first().innerText(), /Blocker/)
  await o.click('.picker-menu .picker-item:has-text("Blocker")')
  const prio = async () => (await owner('GET', `/issues/${item.key}`)).body.priority
  for (let i = 0; i < 40 && (await prio()) === 'medium'; i++) await new Promise(r => setTimeout(r, 250))
  assert.match(await prio(), /^p-/)
  // put the list back: Blocker's items go to Urgent
  const key = await prio()
  assert.equal((await owner('DELETE', `/admin/priorities/${key}?moveTo=urgent`)).status, 204)
  assert.deepEqual(o.problems, [])
})

test('[0402.R1] the Sprint Report lists what a sprint completed and what it didn’t, and marks work added after it started', { skip, timeout: 90_000 }, async () => {
  const p = (await owner('POST', '/projects', { name: 'Reporting', key: 'SRP', template: 'scrum' })).body
  const done = p.statuses.find(s => s.category === 'done').id
  const s1 = (await owner('POST', '/projects/SRP/sprints', { name: 'Sprint report one' })).body
  const finished = (await owner('POST', '/projects/SRP/issues', { title: 'Finished work', sprintId: s1.id, estimate: 3 })).body
  await owner('POST', '/projects/SRP/issues', { title: 'Unfinished work', sprintId: s1.id, estimate: 2 })
  await owner('POST', `/projects/SRP/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  const late = (await owner('POST', '/projects/SRP/issues', { title: 'Late arrival', estimate: 1 })).body
  await owner('PATCH', `/issues/${late.key}`, { sprintId: s1.id })
  await owner('PATCH', `/issues/${finished.key}`, { statusId: done })
  await owner('POST', `/projects/SRP/sprints/${s1.id}/complete`, { moveTo: null })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/SRP/reports/sprint'))
  const completed = o.locator('section[aria-label="Completed Issues"]')
  await completed.waitFor()
  assert.match(await completed.innerText(), /Finished work/)
  const notDone = await o.locator('section[aria-label="Issues Not Completed"]').innerText()
  assert.match(notDone, /Unfinished work/); assert.match(notDone, new RegExp(`${late.key} \\*`))
  assert.deepEqual(o.problems, [])
})

test('[0403.R4] a project admin reopens a completed sprint from the Sprint Report; its unfinished work comes back', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Reopening', key: 'RPN', template: 'scrum' })
  const s1 = (await owner('POST', '/projects/RPN/sprints', { name: 'Closed too soon' })).body
  const item = (await owner('POST', '/projects/RPN/issues', { title: 'Not finished', sprintId: s1.id, estimate: 2 })).body
  await owner('POST', `/projects/RPN/sprints/${s1.id}/start`, { endsAt: new Date(Date.now() + 864e5).toISOString() })
  await owner('POST', `/projects/RPN/sprints/${s1.id}/complete`, { moveTo: null })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RPN/reports/sprint'))
  await o.click('button:has-text("Reopen sprint")')
  const state = async () => (await owner('GET', '/projects/RPN')).body.sprints.find(s => s.id === s1.id).state
  for (let i = 0; i < 40 && (await state()) !== 'active'; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await state(), 'active')
  assert.equal((await owner('GET', `/issues/${item.key}`)).body.sprintId, s1.id)
  assert.deepEqual(o.problems, [])
})

test('[0404.R1][0404.R3] a board admin sets the board to Original time estimate; the backlog totals turn into times', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Timing', key: 'TMG', template: 'scrum' })
  const s1 = (await owner('POST', '/projects/TMG/sprints', { name: 'Timed sprint' })).body
  await owner('POST', '/projects/TMG/issues', { title: 'Two hours', sprintId: s1.id, estimate: 5, timeEstimate: 120 })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/TMG/boards/${s1.boardId}`))
  await o.selectOption('#bc-estimation', 'time')
  await o.click('#general button:has-text("Save")')
  const est = async () => (await owner('GET', `/boards/${s1.boardId}`)).body.estimation
  for (let i = 0; i < 40 && (await est()) !== 'time'; i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await est(), 'time')
  await o.goto(url(`/project/TMG/backlog/${s1.boardId}`))
  await o.waitForSelector('.pts-summary .pt-todo')
  assert.equal((await o.locator('.pts-summary .pt-todo').first().innerText()).trim(), '2h')
  assert.deepEqual(o.problems, [])
})

test('[0408.R1][0408.R2] a member flags a card from its menu: it turns yellow and shows the flag; the flag can come off with a comment', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Flagging', key: 'FLA', template: 'kanban' })
  const item = (await owner('POST', '/projects/FLA/issues', { title: 'Waiting on legal' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/FLA/board'))
  const card = o.locator(`.card:has-text("Waiting on legal")`)
  await card.waitFor()
  await card.hover()
  await o.click(`[aria-label="Actions for ${item.key}"]`)
  await o.click('[role="menuitem"]:has-text("Add flag")')
  await o.waitForSelector('.card.flagged [aria-label="Flagged"]')
  const flagged = async () => (await owner('GET', `/issues/${item.key}`)).body.flagged
  for (let i = 0; i < 40 && !(await flagged()); i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await flagged(), true)
  await card.hover()
  await o.click(`[aria-label="Actions for ${item.key}"]`)
  await o.click('[role="menuitem"]:has-text("Remove flag and add comment")')
  await o.fill('#flag-comment', 'Legal signed it off')
  await o.click('.modal button:has-text("Remove flag")')
  for (let i = 0; i < 40 && (await flagged()); i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await flagged(), false)
  const comments = async () => (await owner('GET', `/issues/${item.key}/comments`)).body.items.map(c => c.body)
  for (let i = 0; i < 40 && !(await comments()).length; i++) await new Promise(r => setTimeout(r, 250))
  assert.match((await comments())[0], /Flag removed[\s\S]*Legal signed it off/)
  assert.deepEqual(o.problems, [])
})

test('[0409.R3] a board’s card colours by priority: the admin chooses Priorities and the cards get a stripe in each priority’s colour', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Colourful', key: 'CLF', template: 'kanban' })
  const board = (await owner('GET', '/projects/CLF/boards')).body[0]
  await owner('POST', '/projects/CLF/issues', { title: 'Urgent thing', priority: 'urgent' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/CLF/boards/${board.id}`))
  await o.selectOption('#bc-color-by', 'priorities')
  await o.click('#card-colors button:has-text("Save")')
  const by = async () => (await owner('GET', `/boards/${board.id}`)).body.cardColors.by
  for (let i = 0; i < 40 && (await by()) !== 'priorities'; i++) await new Promise(r => setTimeout(r, 250))
  await o.goto(url('/project/CLF/board'))
  const card = o.locator('.card.striped:has-text("Urgent thing")')
  await card.waitFor()
  assert.equal(await card.evaluate(el => getComputedStyle(el).getPropertyValue('--stripe').trim().toUpperCase()), '#DC2626')
  assert.deepEqual(o.problems, [])
})

test('[0711.R6][0711.R9][0711.R10] with the login form hidden, recovery_admin signs in at /?auth_fallback, sees the recovery banner and shows the form again', { skip, timeout: 90_000 }, async () => {
  // strand's development server has no Entra: one is configured (as Administration would) so the form may be hidden (R5)
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  await c.query('update auth_config set entra = $1', [JSON.stringify({ enabled: true, name: 'Microsoft', tenantId: '11111111-1111-4111-8111-111111111111',
    apiClientId: '22222222-2222-4222-8222-222222222222', webClientId: '22222222-2222-4222-8222-222222222222', authority: 'https://login.microsoftonline.com' })])
  assert.equal((await owner('PUT', '/admin/authentication', { loginForm: false, fallback: false })).status, 200)
  const p = await signedOut('/?auth_fallback')
  await p.fill('#login-username', 'recovery_admin')
  await p.fill('#login-password', 'not the password')
  await p.click('button:has-text("Log in")')
  await p.waitForSelector('text=Sorry, your username and password are incorrect - please try again.')
  await p.fill('#login-password', RECOVERY_PASSWORD)
  await p.click('button:has-text("Log in")')
  await p.waitForSelector('nav')
  await p.waitForSelector('text=Strand is running in recovery mode')
  await p.goto(url('/admin/auth-methods'))
  await p.click('[aria-label="Show the login form on the login page"]')
  await p.waitForSelector('text=Login form shown')
  assert.equal((await owner('GET', '/admin/authentication')).body.loginForm, true)
  await c.query('update auth_config set entra = null'); await c.end()
  assert.deepEqual(p.problems, [])
})

test('[0712.R1][0712.R4][0712.R5][0712.R7] an admin adds the company Active Directory, tests it, saves it; a corp id then signs in on the login form', { skip, timeout: 120_000 }, async () => {
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/directories'))
  await o.click('button:has-text("Add directory")')
  await o.click('button:has-text("Microsoft Active Directory")')
  await o.fill('#dir-host', 'dc1.e2e.test')
  await o.fill('#dir-bindDn', 'CN=svc-strand,OU=Service,DC=e2e,DC=test')
  await o.fill('#dir-password', 'svc-pass')
  await o.fill('#dir-baseDn', 'DC=e2e,DC=test')
  await o.fill('#dir-test-user', 'ccarla')
  await o.fill('#dir-test-password', 'carla-pass')
  await o.click('button:has-text("Test settings")')
  await o.waitForSelector('[aria-label="Test results"] >> text=✓ The test user’s password')
  assert.equal(await o.locator('[aria-label="Test results"] .text-danger').count(), 0)
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('td:has-text("Active Directory")')
  // the first synchronisation runs at once: Corp Carla and her group arrive
  await o.waitForSelector('td >> text=/1 new/', { timeout: 30_000 })
  const groups = (await owner('GET', '/groups?query=Corp')).body
  assert.ok(JSON.stringify(groups).includes('Corp Engineers'))
  // she signs in with her corp id; a wrong password gets Jira's message (strand's login page shows the dev login: the form is at ?auth_fallback)
  const p = await signedOut('/?auth_fallback')
  await p.fill('#login-username', 'ccarla')
  await p.fill('#login-password', 'wrong')
  await p.click('button:has-text("Log in")')
  await p.waitForSelector('text=Sorry, your username and password are incorrect - please try again.')
  await p.fill('#login-password', 'carla-pass')
  await p.click('button:has-text("Log in")')
  await p.waitForSelector('nav')
  assert.equal((await owner('GET', '/admin/users?query=carla')).body.items[0].directory, 'Active Directory')
  assert.deepEqual([...o.problems, ...p.problems], [])
})

test('[0714.R2][0714.R5][0714.R8] an admin creates a local user in People; they sign in on the login form and change their password in Settings', { skip, timeout: 120_000 }, async () => {
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/people'))
  await o.click('button:has-text("Create user")')
  await o.fill('#lu-email', 'lou@local.e2e.test')
  await o.fill('#lu-name', 'Lou Local')
  await o.fill('#lu-username', 'lou')
  await o.fill('#lu-password', 'lou-password-1')
  await o.click('.modal button:has-text("Create user")')
  await o.waitForSelector('text=Lou Local created')
  await o.fill('[aria-label="Find a person"]', 'lou')
  await o.waitForSelector('[aria-label="Edit Lou Local"]')
  const p = await signedOut('/?auth_fallback')   // strand's login page shows the dev login; the form is at ?auth_fallback
  await p.fill('#login-username', 'lou')
  await p.fill('#login-password', 'lou-password-1')
  await p.click('button:has-text("Log in")')
  await p.waitForSelector('nav')
  await p.goto(url('/settings'))
  await p.fill('#pw-current', 'lou-password-1')
  await p.fill('#pw-password', 'lou-password-2')
  await p.fill('#pw-again', 'lou-password-2')
  await p.click('button:has-text("Change password")')
  await p.waitForSelector('text=Password changed')
  // the new password is the one that works
  const login = async password => (await postRaw('/api/v1/auth/login', JSON.stringify({ username: 'lou', password }), 'application/json', 'none')).status
  assert.deepEqual([await login('lou-password-1'), await login('lou-password-2')], [401, 200])
  assert.deepEqual([...o.problems, ...p.problems], [])
})

test('[0406.R1][0406.R2][0406.R4][0406.R5][0406.R7] a Kanban backlog: To do goes into it; the item leaves the board, waits in the Backlog tab, and is dragged to the next column', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Kanban planned', key: 'KBP', template: 'kanban' })
  const item = (await owner('POST', '/projects/KBP/issues', { title: 'Plan me first' })).body
  const [board] = (await owner('GET', '/projects/KBP/boards')).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/project/KBP/boards/${board.id}`))
  // R1: To do goes into the Kanban backlog (its emptied column goes)
  await o.click('[aria-label="Move To do to…"]')
  await o.click('[role="menu"] button:has-text("Kanban backlog")')
  await o.click('[aria-label="Remove To do"]')
  await o.click('#columns button:has-text("Save")')
  await o.waitForSelector('#columns button:has-text("Save"):disabled')
  assert.equal((await owner('GET', `/boards/${board.id}`)).body.kanbanBacklog.length, 1)
  // R2: the board no longer shows it; R3: the Backlog tab does
  await o.goto(url(`/project/KBP/board/${board.id}`))
  await o.waitForSelector('text=Nothing in progress')
  assert.equal(await o.locator('text=Plan me first').count(), 0)
  await o.click('button:has-text("Go to backlog")')
  await o.waitForSelector('[aria-label="Backlog"] >> text=Plan me first')
  // R7: Create in the Backlog section starts new work in the Kanban backlog's status
  await o.click('[aria-label="Backlog"] button.cell-create')
  await o.fill('[aria-label="Title"]', 'Made in the backlog')
  await o.click('[aria-label="Create work item"] button[type="submit"]')
  await o.waitForSelector('[aria-label="Backlog"] >> text=Made in the backlog')
  // R5: Top of backlog ranks it first
  let made
  for (let n = 0; n < 50 && !made; n++) {                                     // saved in the background
    made = (await owner('GET', '/projects/KBP/issues')).body.items.find(i => i.title === 'Made in the backlog')
    if (!made) await new Promise(r => setTimeout(r, 200))
  }
  assert.equal(made.statusId, (await owner('GET', '/projects/KBP')).body.statuses.find(x => x.name === 'To do').id)
  await o.click(`[aria-label="Move ${made.key}"]`)
  await o.click('[role="menu"] button:has-text("Top of backlog")')
  await o.waitForFunction(() => document.querySelector('[aria-label="Backlog"] .rank-slot')?.textContent?.includes('Made in the backlog'))
  // R4: moved to the next column (In progress), it is on the board
  await o.click(`[aria-label="Move ${item.key}"]`)
  await o.click('[role="menu"] button:has-text("Move to In progress")')
  await o.waitForSelector('[aria-label="In progress"] >> text=Plan me first')
  await o.goto(url(`/project/KBP/board/${board.id}`))
  await o.waitForSelector('.col-name')
  assert.deepEqual(await o.locator('.col-name').allTextContents(), ['In progress', 'Done'])   // To do is the Kanban backlog's now
  await o.waitForSelector('text=Plan me first')
  assert.deepEqual(o.problems, [])
})

test('[0407.R1][0407.R3][0407.R4][0407.R5][0407.R8][0407.R9][0407.R10][0407.R12] the backlog’s Epics and Versions panels: an item joins an epic and a version, and each panel filters the backlog', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Panelled', key: 'PAN', template: 'scrum' })
  const epic = (await owner('POST', '/projects/PAN/issues', { title: 'Checkout epic', type: 'epic' })).body
  const story = (await owner('POST', '/projects/PAN/issues', { title: 'Pay by card' })).body
  await owner('POST', '/projects/PAN/issues', { title: 'Unrelated chore' })
  await owner('POST', '/projects/PAN/releases', { name: '2.0' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/PAN/backlog'))
  await o.waitForSelector('text=Pay by card')
  // R1: the Epics panel opens from its toggle
  await o.click('[role="tab"]:has-text("Epics")')
  await o.waitForSelector('[aria-label="Epics"] >> text=Checkout epic')
  // R4: the selected item goes into the epic (the selection bar does what dragging onto the epic does)
  await o.click(`[aria-label="Select ${story.key}"]`)
  await o.click('[title="Change epic"]')
  await o.click('.picker-menu .picker-item:has-text("Checkout epic")')
  await o.waitForSelector('text=Updated epic on 1 item')
  // R3: clicking the epic shows only its items
  await o.click('[aria-label="Epics"] button.panel-entry-name:has-text("Checkout epic")')
  await o.waitForSelector('.backlog-scroll >> text=Pay by card')
  assert.equal(await o.locator('.backlog-scroll >> text=Unrelated chore').count(), 0)
  await o.click('[aria-label="Epics"] button.panel-entry-name:has-text("All issues")')
  await o.waitForSelector('.backlog-scroll >> text=Unrelated chore')
  // R9, R8: into version 2.0, then the Versions panel filters by it
  await o.click('[title="Add fix version"]')
  await o.click('.picker-menu .picker-item:has-text("2.0")')
  await o.waitForSelector('text=Updated fix versions on 1 item')
  await o.click('[role="tab"]:has-text("Versions")')
  await o.click('[aria-label="Versions"] button.panel-entry-name:has-text("2.0")')
  await o.waitForSelector('.backlog-scroll >> text=Pay by card')
  assert.equal(await o.locator('.backlog-scroll >> text=Unrelated chore').count(), 0)
  // saved on the server
  let saved
  for (let n = 0; n < 50; n++) {
    saved = (await owner('GET', `/issues/${story.key}`)).body
    if (saved.parentId === epic.id && saved.fixReleaseIds?.length === 1) break
    await new Promise(r => setTimeout(r, 200))
  }
  assert.deepEqual([saved.parentId, saved.fixReleaseIds.length], [epic.id, 1])
  // R10: Create version from the panel
  await o.click('[aria-label="Versions"] button:has-text("Create version")')
  await o.fill('#rel-name', '2.1')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('[aria-label="Versions"] >> text=2.1')
  // R5: Create epic from the panel, and an epic's colour
  await o.click('[role="tab"]:has-text("Epics")')
  await o.click('[aria-label="Epics"] button:has-text("Create epic")')
  await o.fill('[aria-label="Title"]', 'Second epic')
  await o.click('[aria-label="Create work item"] button[type="submit"]')
  await o.click('[aria-label="Actions for Checkout epic"]')
  await o.click('[role="menu"] button:has-text("Colour 4")')
  let colored
  for (let n = 0; n < 50 && colored !== 'ghx-label-4'; n++) { colored = (await owner('GET', `/issues/${epic.key}`)).body.epicColor; if (colored !== 'ghx-label-4') await new Promise(r => setTimeout(r, 200)) }
  assert.equal(colored, 'ghx-label-4')
  let second
  for (let n = 0; n < 50 && !second; n++) { second = (await owner('GET', '/projects/PAN/issues')).body.items.find(i => i.title === 'Second epic'); if (!second) await new Promise(r => setTimeout(r, 200)) }
  assert.equal(second.type, 'epic')
  // R12: a viewer can filter but not create
  await owner('POST', '/projects/PAN/members', { userIds: [await idOf('vic@e2e.test')], role: 'viewer' })
  const v = await signIn('vic@e2e.test')
  await v.goto(url('/project/PAN/backlog'))
  await v.waitForSelector('text=Pay by card')
  await v.click('[role="tab"]:has-text("Epics")')                           // a new browser: every panel starts closed
  await v.waitForSelector('[aria-label="Epics"] >> text=Checkout epic')
  assert.equal(await v.locator('[aria-label="Epics"] button:has-text("Create epic")').count(), 0)
  assert.deepEqual([...o.problems, ...v.problems], [])
})

test('[0410.R1][0410.R4][0410.R8] the control chart shows an item that went through In progress, in its chart and its table', { skip, timeout: 90_000 }, async () => {
  await owner('POST', '/projects', { name: 'Controlled', key: 'CCH', template: 'kanban' })
  const p = (await owner('GET', '/projects/CCH')).body
  const item = (await owner('POST', '/projects/CCH/issues', { title: 'Measured work' })).body
  for (const name of ['In progress', 'Done']) await owner('PATCH', `/issues/${item.key}`, { statusId: p.statuses.find(x => x.name === name).id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/CCH/reports/control'))
  await o.waitForSelector('[aria-label="Control chart: cycle time per item"]')
  await o.waitForSelector('[aria-label="Control chart items"] >> text=Measured work')
  await o.selectOption('[aria-label="Timeframe"]', '7')
  await o.waitForSelector('[aria-label="Control chart items"] >> text=Measured work')
  assert.deepEqual(o.problems, [])
})

test('[0411.R1][0411.R2][0411.R3][0411.R4] the epic, version, burnup, epic burndown and release burndown reports draw for a Scrum project', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Reported', key: 'REP', template: 'scrum' })
  const p = (await owner('GET', '/projects/REP')).body
  const epic = (await owner('POST', '/projects/REP/issues', { title: 'Reporting epic', type: 'epic' })).body
  const v = (await owner('POST', '/projects/REP/releases', { name: '3.0' })).body
  const sprint = (await owner('POST', '/projects/REP/sprints', { name: 'REP Sprint 1' })).body
  const a = (await owner('POST', '/projects/REP/issues', { title: 'Report me', parentId: epic.id, fixReleaseIds: [v.id], estimate: 3, sprintId: sprint.id })).body
  await owner('POST', '/projects/REP/issues', { title: 'Still open', parentId: epic.id, fixReleaseIds: [v.id], estimate: 5, sprintId: sprint.id })
  assert.equal((await owner('POST', `/projects/REP/sprints/${sprint.id}/start`, { endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString() })).status, 200)
  await owner('PATCH', `/issues/${a.key}`, { statusId: p.statuses.find(x => x.category === 'done').id })
  const o = await signIn('owner@e2e.test')
  const open = async (report, check) => { await o.goto(url(`/project/REP/reports/${report}`)); await o.waitForSelector(check) }
  await open('epic', '[aria-label="Completed"] >> text=Report me')
  await o.waitForSelector('[aria-label="Incomplete"] >> text=Still open')
  await open('version', 'text=predicted release date')
  await open('burnup', '[aria-label="Burnup for REP Sprint 1"]')
  await open('epic-burndown', '[aria-label="Epic burndown"]')
  await open('release-burndown', '[aria-label="Release burndown"]')
  assert.deepEqual(o.problems, [])
})

test('[0701.R2][0701.R4][0701.R5] an admin writes an announcement: the preview shows it, everyone sees it, and closing it lasts until it changes', { skip, timeout: 90_000 }, async () => {
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/settings/announcement'))
  await o.fill('#announcement-text', 'Planned maintenance on Saturday. Details: https://status.example.com')
  await o.waitForSelector('.announcement-preview >> a[href="https://status.example.com"]')
  await o.click('section[aria-label="Announcement banner"] button:has-text("Save")')
  await o.waitForSelector('section[aria-label="Announcement banner"] button:has-text("Save"):disabled')
  const m = await signIn('maya@e2e.test')
  await m.waitForSelector('[aria-label="Announcement"] >> text=Planned maintenance on Saturday')
  await m.click('[aria-label="Close the announcement"]')
  await m.reload()
  await m.waitForSelector('nav')
  assert.equal(await m.locator('[aria-label="Announcement"]').count(), 0)
  // a new announcement shows again
  await owner('PUT', '/admin/settings/announcement', { text: 'Maintenance moved to Sunday', visibility: 'private' })
  await new Promise(r => setTimeout(r, 10_500))                                    // the settings cache
  await m.reload()
  await m.waitForSelector('[aria-label="Announcement"] >> text=Maintenance moved to Sunday')
  await owner('PUT', '/admin/settings/announcement', { text: '', visibility: 'private' })
  assert.deepEqual([...o.problems, ...m.problems], [])
})

test('[0702.R1][0702.R2][0702.R4] an admin renames the site and changes its colour: the menu, the browser tab and the buttons follow; a too-light colour is refused', { skip, timeout: 90_000 }, async () => {
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/settings/look-and-feel'))
  await o.fill('section[aria-label="Look and feel"] input[maxlength="60"]', 'Acme Work')
  await o.fill('[aria-label="Brand colour"]', '#FACC15')
  await o.waitForSelector('text=Too light for white text')
  await o.fill('[aria-label="Brand colour"]', '#1D4ED8')
  await o.click('section[aria-label="Look and feel"] button:has-text("Save")')
  await o.waitForSelector('text=Look and feel saved')
  await o.waitForSelector('.nav-workspace:has-text("Acme Work")')
  assert.match(await o.title(), /Acme Work$/)
  const brand = await o.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim())
  assert.equal(brand.toUpperCase(), '#1D4ED8')
  // everyone sees it, also before signing in
  const p = await signedOut('/')
  await p.waitForSelector('text=to Acme Work')
  await owner('DELETE', '/admin/look-and-feel')
  assert.deepEqual([...o.problems, ...p.problems], [])
})

test('[0703.R1][0703.R3][0703.R5][0703.R6] an admin changes a project’s key: an old address still opens its work; a category groups it in the projects list', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Rekeyed', key: 'RKA', template: 'kanban' })
  const item = (await owner('POST', '/projects/RKA/issues', { title: 'Find me by my old key' })).body
  const cat = (await owner('POST', '/admin/project-categories', { name: 'Platform team' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RKA/settings'))
  await o.click('button[title="Change the key"]')
  await o.fill('#ps-key', 'RKB')
  await o.click('.modal button:has-text("Change key")')
  await o.waitForURL(/\/project\/RKB\/settings/)
  await o.waitForSelector('text=Earlier: RKA')
  await o.selectOption('[aria-label="Project category"]', cat.id)
  await o.waitForSelector('text=Category saved')
  // R3: the old address opens the item at its new key
  await o.goto(url(`/i/${item.key}`))
  await o.waitForURL(new RegExp(`/i/RKB-${item.key.split('-')[1]}`))
  await o.waitForSelector('text=Find me by my old key')
  // R6: the projects list finds it by category
  await o.goto(url('/projects'))
  await o.selectOption('[aria-label="Category"]', cat.id)
  await o.waitForSelector('[aria-label="Project search results"] >> text=Rekeyed')
  await o.waitForSelector('[aria-label="Project search results"] >> text=Platform team')
  assert.deepEqual(o.problems, [])
})

test('[0704.R1][0704.R4][0704.R6] an admin anonymises a deactivated person: the preview, a confirmation by alias, and their name becomes the alias', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/admin/users', { username: 'gone.gary', name: 'Gary Gone', email: 'gary@local.e2e.test', password: 'gary-password-1' })
  const gary = (await owner('GET', '/admin/users?query=gary')).body.items[0]
  await owner('POST', '/admin/users/bulk', { userIds: [gary.id], action: 'deactivate' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/people'))
  await o.fill('[aria-label="Find a person"]', 'gary')
  await o.click('[aria-label="Anonymise Gary Gone"]')
  await o.waitForSelector('text=This can’t be undone')
  const alias = await o.locator('.modal b.mono').innerText()
  assert.match(alias, /^user-[0-9a-f]{6}$/)
  assert.ok(await o.locator('.modal button:has-text("Anonymise"):disabled').count())
  await o.fill('#anon-confirm', alias)
  await o.click('.modal button:has-text("Anonymise")')
  await o.waitForSelector('text=Gary Gone anonymised')
  const after = (await owner('GET', `/admin/users?query=${alias}`)).body.items[0]
  assert.deepEqual([after.name, after.username, !!after.anonymisedAt], [alias, null, true])
  assert.deepEqual(o.problems, [])
})

test('[0705.R1][0705.R5][0705.R7] an admin adds a webhook: the secret shows once, a test call is delivered and listed', { skip, timeout: 120_000 }, async () => {
  const got = []
  const receiver = createServer((req, res) => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.writeHead(200).end('ok') }) })
  await new Promise(r => receiver.listen(0, '127.0.0.1', r))
  try {
    const o = await signIn('owner@e2e.test')
    await o.goto(url('/admin/webhooks'))
    await o.click('button:has-text("Create a webhook")')
    await o.fill('#wh-name', 'Build server')
    await o.fill('#wh-url', `http://127.0.0.1:${receiver.address().port}/strand`)
    await o.click('.modal button:has-text("Create")')
    const secret = await o.locator('[aria-label="Signing secret"]').innerText()
    assert.match(secret, /^whsec_/)
    await o.click('.modal button:has-text("Done")')
    await o.click('td:has-text("Build server")')
    await o.click('.modal button:has-text("Test")')
    await o.waitForSelector('[aria-label="Recent calls"] >> text=delivered', { timeout: 30_000 })
    assert.equal(JSON.parse(got[0].body).webhookEvent, 'ping')
    assert.match(got[0].headers['x-strand-signature'], /^sha256=[0-9a-f]{64}$/)
    assert.deepEqual(o.problems, [])
  } finally { receiver.close() }
})

test('[0707.R1][0707.R2][0707.R3][0707.R4] an admin connects GitHub; the item shows its branch, commit and pull request, and its branch name', { skip, timeout: 120_000 }, async () => {
  const owner = as('owner@e2e.test')
  await owner('POST', '/projects', { name: 'Dev journey', key: 'DVJ', template: 'kanban' })
  const item = (await owner('POST', '/projects/DVJ/issues', { title: 'Fix login redirect' })).body
  const repository = { id: 7070, full_name: 'e2e-org/web', default_branch: 'main', html_url: 'https://github.com/e2e-org/web' }
  const installation = { id: 70707, account: { login: 'e2e-org' } }
  const pr = { action: 'opened', number: 12, repository, installation, pull_request: { number: 12, html_url: 'https://github.com/e2e-org/web/pull/12', title: `${item.key} Fix the redirect`,
    body: '', state: 'open', merged: false, updated_at: '2026-11-10T10:00:00Z', user: { login: 'dev' }, head: { ref: 'dvj-1-fix-login-redirect' }, base: { ref: 'main' } } }
  assert.equal((await github('pull_request', pr)).body.ignored, 'waiting for an administrator to connect this installation')

  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/development'))
  const acct = o.locator('[aria-label="GitHub account e2e-org"]')
  await acct.locator('text=Waiting').waitFor()
  await acct.locator('button:has-text("Connect")').click()
  await acct.locator('text=Connected').waitFor()

  await github('pull_request', pr)
  await github('push', { ref: 'refs/heads/dvj-1-fix-login-redirect', repository, installation, head_commit: { timestamp: '2026-11-10T11:00:00Z' },
    commits: [{ id: 'abcdef1234567', message: `${item.key} send people back where they were`, url: 'https://github.com/e2e-org/web/commit/abcdef1', timestamp: '2026-11-10T11:00:00Z', author: { name: 'Dev' } }] })

  await o.goto(url(`/i/${item.key}`))
  const panel = o.locator('[aria-label="Development"]')
  await panel.locator('button:has-text("1 pull request")').waitFor()
  assert.match(await panel.innerText(), /1 branch[\s\S]*1 commit[\s\S]*1 Open[\s\S]*dvj-1-fix-login-redirect/i)   // lozenges are upper case
  await panel.locator('button:has-text("1 commit")').click()
  assert.match(await o.locator('.modal').innerText(), /e2e-org\/web[\s\S]*abcdef1[\s\S]*send people back/)
  await o.click('.modal [aria-label="Close"]')
  await panel.locator('button:has-text("1 pull request")').click()
  assert.match(await o.locator('.modal').innerText(), /#12 DVJ-1 Fix the redirect[\s\S]*Open/i)
  assert.deepEqual(o.problems, [])
})

test('[0709.R1][0709.R3] a system admin makes a global rule for a category with a condition; new bugs in its projects get the label, and their admins see it read-only', { skip, timeout: 120_000 }, async () => {
  const owner = as('owner@e2e.test')
  const cat = (await owner('POST', '/admin/project-categories', { name: 'Robots inc' })).body
  await owner('POST', '/projects', { name: 'Global one', key: 'GLA', template: 'kanban' })
  await owner('PATCH', '/projects/GLA', { categoryId: cat.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/automation'))
  await o.click('button:has-text("Create rule")')
  await o.fill('#rule-name', 'Label robot bugs')
  await o.selectOption('.modal select[aria-label="Scope"]', 'category')
  await o.selectOption('.modal select[aria-label="Category"]', { label: 'Robots inc' })
  await o.click('.modal button:has-text("Add a JQL condition")')
  await o.fill('.modal .rule-if textarea[aria-label="JQL query"]', 'type = bug')
  await o.fill('.modal input[aria-label="Label"]', 'robot')
  await o.click('.modal button:has-text("Save rule")')
  await o.waitForSelector('.rule-card:has-text("Label robot bugs") >> text=projects in Robots inc')
  const bug = (await owner('POST', '/projects/GLA/issues', { title: 'Beep', type: 'bug' })).body
  const task = (await owner('POST', '/projects/GLA/issues', { title: 'Boop', type: 'task' })).body
  assert.deepEqual([(await owner('GET', `/issues/${bug.key}`)).body.labels, (await owner('GET', `/issues/${task.key}`)).body.labels], [['robot'], []])
  await o.goto(url('/project/GLA/settings/automation'))
  const g = o.locator('[aria-label="Global rules"]')
  await g.locator('text=Label robot bugs').waitFor()
  assert.match(await g.innerText(), /if type = bug[\s\S]*Administration › Automation/)
  assert.deepEqual(o.problems, [])
})

test('[0716.R3][0716.R5] Mark as Done: the epic leaves the Epics panel and keeps its workflow status; its details show the Epic Status', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Epic status', key: 'EPS', template: 'scrum' })
  const epic = (await owner('POST', '/projects/EPS/issues', { title: 'Old theme', type: 'epic' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${epic.key}`))
  await o.waitForSelector('.field:has-text("Epic Status") >> text=To Do')
  await o.goto(url('/project/EPS/backlog'))
  await o.click('[role="tab"]:has-text("Epics")')
  await o.waitForSelector('[aria-label="Epics"] >> text=Old theme')
  await o.click('[aria-label="Actions for Old theme"]')
  await o.click('[role="menu"] button:has-text("Mark as Done")')
  await o.waitForSelector('[aria-label="Epics"] >> text=No open epics.')
  let now
  for (let n = 0; n < 50 && now?.epicStatus !== 'Done'; n++) { now = (await owner('GET', `/issues/${epic.key}`)).body; if (now.epicStatus !== 'Done') await new Promise(r => setTimeout(r, 200)) }
  assert.deepEqual([now.epicStatus, now.statusId], ['Done', epic.statusId])
  assert.deepEqual(o.problems, [])
})

test('[0501.R5][0501.R6] Move: an item goes to another project from its actions, after a preview; its old address opens the new key', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Moving from', key: 'MFR', template: 'kanban' })
  await owner('POST', '/projects', { name: 'Moving to', key: 'MTO', template: 'kanban' })
  const item = (await owner('POST', '/projects/MFR/issues', { title: 'Packed and ready' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.waitForSelector('text=Packed and ready')
  await o.click('[aria-label="More actions"]')
  await o.click('[role="menu"] button:has-text("Move")')
  await o.fill('#mv-project', 'MTO')
  await o.waitForSelector('[aria-label="What changes"] >> text=MFR')
  assert.match(await o.locator('[aria-label="What changes"]').innerText(), new RegExp(`${item.key} → MTO-\\d+`))
  await o.click('.modal button:text-is("Move")')
  await o.waitForURL(/MTO-\d+/)
  const moved = (await owner('GET', `/issues/${item.key}`)).body
  assert.match(moved.key, /^MTO-\d+$/)
  // the old address opens it at its new key
  await o.goto(url(`/i/${item.key}`))
  await o.waitForURL(new RegExp(`/i/${moved.key}$`))
  await o.waitForSelector('text=Packed and ready')
  assert.deepEqual(o.problems, [])
})

test('[0502.R3] custom field types: an admin adds a checkboxes field and a user picker; the item’s details set both', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Typed fields', key: 'TYF', template: 'kanban' })
  const item = (await owner('POST', '/projects/TYF/issues', { title: 'Has typed fields' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/TYF/settings'))
  await o.click('button:has-text("Add field")')
  await o.fill('#fd-name', 'Platforms')
  await o.selectOption('.modal select[aria-label="Field type"]', 'checkboxes')
  for (const n of ['iOS', 'Android']) { await o.fill('#fd-opt', n); await o.press('#fd-opt', 'Enter') }
  await o.click('.modal button:has-text("Save field")')
  await o.waitForSelector('text=Saved Platforms')
  await o.click('button:has-text("Add field")')
  await o.fill('#fd-name', 'Reviewer')
  await o.selectOption('.modal select[aria-label="Field type"]', 'user')
  await o.click('.modal button:has-text("Save field")')
  await o.waitForSelector('text=Saved Reviewer')
  await o.goto(url(`/i/${item.key}`))
  const platforms = o.locator('.field:has-text("Platforms")')
  await platforms.locator('label:has-text("Android") input').check()
  await o.click('.field:has-text("Reviewer") button')
  await o.click(`.picker-menu .picker-item:has-text("${PEOPLE['owner@e2e.test']}")`)
  const fields = (await owner('GET', '/projects/TYF')).body.fields
  let custom = {}
  for (let n = 0; n < 50; n++) { custom = (await owner('GET', `/issues/${item.key}`)).body.custom; if (Object.keys(custom).length === 2) break; await new Promise(r => setTimeout(r, 200)) }
  assert.deepEqual(custom[fields.find(f => f.name === 'Platforms').id], ['Android'])
  assert.equal(custom[fields.find(f => f.name === 'Reviewer').id], await idOf('owner@e2e.test'))
  assert.deepEqual(o.problems, [])
})

test('[0503.R1][0503.R2] an admin makes a global custom field, then a project context with other options; each project offers its own', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Global field A', key: 'GFA', template: 'kanban' })
  await owner('POST', '/projects', { name: 'Global field B', key: 'GFB', template: 'kanban' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/custom-fields'))
  await o.click('button:has-text("Create custom field")')
  await o.fill('#cf-name', 'Market')
  await o.selectOption('#cf-kind', 'select')
  await o.fill('#cx-options', 'Retail\nWholesale')
  await o.click('.modal button:text-is("Create")')
  await o.waitForSelector('[aria-label="Contexts"] >> text=Global (all projects)')
  await o.click('.modal button:has-text("Add context")')
  await o.fill('#cx-name', 'B only')
  await o.fill('.modal .modal [aria-label="Project keys"], .modal [aria-label="Project keys"] >> nth=-1', 'GFB')
  await o.fill('#cx-options >> nth=-1', 'Public sector')
  await o.click('.modal button:text-is("Save")')
  await o.waitForSelector('[aria-label="Contexts"] >> text=B only')
  const field = (b) => b.fields.find(f => f.name === 'Market')
  assert.deepEqual(field((await owner('GET', '/projects/GFA')).body).options.map(x => x.name), ['Retail', 'Wholesale'])
  assert.deepEqual(field((await owner('GET', '/projects/GFB')).body).options.map(x => x.name), ['Public sector'])
  assert.deepEqual(o.problems, [])
})

test('[0504.R4][0504.R5] a required custom field is marked in the create dialog, and Create waits for it', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Required fields', key: 'RQF', template: 'kanban' })
  const f = (await owner('POST', '/admin/custom-fields', { name: 'Customer', kind: 'text', context: { projectKeys: ['RQF'] } })).body
  const cfg = (await owner('POST', '/admin/field-configurations', { name: 'Customer required', items: { [`custom.${f.id}`]: { required: true, description: 'Who asked for it' } } })).body
  const def = (await owner('GET', '/admin/field-configurations')).body.find(c => c.isDefault)
  const sch = (await owner('POST', '/admin/field-config-schemes', { name: 'RQF scheme', defaultConfigId: def.id, mappings: { task: cfg.id } })).body
  await owner('PATCH', '/projects/RQF', { fieldConfigSchemeId: sch.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/project/RQF'))
  await o.waitForSelector('text=Required fields')
  await o.locator('body').click({ position: { x: 5, y: 5 } })
  await o.keyboard.press('c')
  const dialog = o.locator('[aria-label="Create work item"]')
  await dialog.locator('[aria-label="Title"]').fill('Needs a customer')
  await dialog.locator('[aria-label="Required fields"] >> text=Customer *').waitFor()
  assert.equal(await dialog.locator('button[type="submit"]').isDisabled(), true)
  assert.match(await dialog.innerText(), /Who asked for it/)
  await dialog.locator('[aria-label="Required fields"] input').fill('Acme')
  await dialog.locator('button[type="submit"]').click()
  let made
  for (let n = 0; n < 50 && !made; n++) { made = (await owner('GET', '/projects/RQF/issues')).body.items.find(i => i.title === 'Needs a customer'); if (!made) await new Promise(r => setTimeout(r, 200)) }
  assert.equal(made.custom[f.id], 'Acme')
  assert.deepEqual(o.problems, [])
})

test('[0505.R4][0505.R5] screens: Priority off the edit screen is read-only in the details; a view screen with two tabs', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Screened journey', key: 'SCJ', template: 'kanban' })
  const item = (await owner('POST', '/projects/SCJ/issues', { title: 'Seen through screens', type: 'task', dueDate: '2026-12-24' })).body
  const edit = (await owner('POST', '/admin/screens', { name: 'SCJ edit', tabs: [{ name: 'Main', fields: ['assigneeId', 'labels', 'dueDate'] }] })).body
  const view = (await owner('POST', '/admin/screens', { name: 'SCJ view', tabs: [{ name: 'Main', fields: ['assigneeId', 'priority', 'labels'] }, { name: 'Dates', fields: ['dueDate'] }] })).body
  const def = (await owner('GET', '/admin/screens')).body.find(s => s.isDefault)
  const ss = (await owner('POST', '/admin/screen-schemes', { name: 'SCJ scheme', defaultScreenId: def.id, editScreenId: edit.id, viewScreenId: view.id })).body
  const its = (await owner('POST', '/admin/issue-type-screen-schemes', { name: 'SCJ types', defaultSchemeId: ss.id })).body
  await owner('PATCH', '/projects/SCJ', { issueTypeScreenSchemeId: its.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  const tabs = o.locator('[aria-label="Field tabs"]')
  await tabs.waitFor()
  // Main: Priority shows, read-only (not on the edit screen); Due date is on the other tab
  const priority = o.locator('.field:has-text("Priority")')
  await priority.waitFor()
  assert.equal(await priority.locator('fieldset[disabled]').count(), 1)
  assert.equal(await o.locator('.field:has-text("Due date")').count(), 0)
  await tabs.locator('button:has-text("Dates")').click()
  await o.locator('.field:has-text("Due date")').waitFor()
  assert.equal(await o.locator('.field:has-text("Priority")').count(), 0)
  assert.deepEqual(o.problems, [])
})

test('[0506.R1] someone votes for an item and sees the count; the reporter can’t', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Votes journey', key: 'VTJ', template: 'kanban' })
  await owner('POST', '/projects/VTJ/members', { userIds: [await idOf('vic@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/VTJ/issues', { title: 'Popular idea' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  assert.equal(await o.locator('[aria-label="You can’t vote for a work item you reported"]').isDisabled(), true)
  const v = await signIn('vic@e2e.test')
  await v.goto(url(`/i/${item.key}`))
  await v.click('[aria-label="Vote for this work item"]')
  await v.waitForSelector('[aria-label="Remove your vote"] >> text=1')
  assert.equal((await owner('GET', `/issues/${item.key}/votes`)).body.votes, 1)
  assert.deepEqual([o.problems, v.problems], [[], []])
})

test('[0507.R1] a web link is added to an item and opens its address in a new tab', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Web links journey', key: 'WLJ', template: 'kanban' })
  const item = (await owner('POST', '/projects/WLJ/issues', { title: 'Points elsewhere' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('[aria-label="Add web link"]')
  await o.fill('#wl-url', 'https://example.com/design')
  await o.fill('#wl-title', 'Design doc')
  await o.click('.modal button:has-text("Save")')
  const link = o.locator('[aria-label="Web links"] a:has-text("Design doc")')
  await link.waitFor()
  assert.deepEqual([await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')], ['https://example.com/design', '_blank', 'noopener noreferrer'])
  assert.deepEqual(o.problems, [])
})

test('[0508.R2][0508.R3] an admin archives an item: it leaves the project’s list, opens read-only by key, and comes back with Restore', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Archive journey', key: 'AWI', template: 'kanban' })
  const item = (await owner('POST', '/projects/AWI/issues', { title: 'Done long ago' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('[aria-label="More actions"]')
  await o.click('[role="menu"] button:has-text("Archive")')
  await o.waitForSelector('text=read-only, and left out of lists')
  assert.deepEqual((await owner('GET', '/projects/AWI/issues')).body.items, [])
  await o.goto(url(`/i/${item.key}`))
  await o.waitForSelector('text=Done long ago')
  await o.waitForSelector('text=read-only, and left out of lists')
  await o.goto(url('/admin/archived-items'))
  await o.click(`tr:has-text("${item.key}") button:has-text("Restore")`)
  await o.waitForSelector(`text=Restored ${item.key}`)
  assert.equal((await owner('GET', '/projects/AWI/issues')).body.items.length, 1)
  assert.deepEqual(o.problems, [])
})

test('[0509.R1][0509.R2] an item is converted to a sub-item from its menu, then back to an item', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Convert journey', key: 'CVJ', template: 'kanban' })
  const parent = (await owner('POST', '/projects/CVJ/issues', { title: 'The parent' })).body
  const item = (await owner('POST', '/projects/CVJ/issues', { title: 'Will be a sub-item' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('[aria-label="More actions"]')
  await o.click('[role="menu"] button:has-text("Convert to sub-item")')
  await o.click('.modal button:has-text("Choose the parent")')
  await o.click(`.picker-menu .picker-item:has-text("${parent.key}")`)
  await o.waitForSelector(`text=${item.key} is now a sub-item of ${parent.key}`)
  assert.equal((await owner('GET', `/issues/${item.key}`)).body.parentId, parent.id)
  await o.click('[aria-label="More actions"]')
  await o.click('[role="menu"] button:has-text("Convert to item")')
  await o.waitForSelector(`text=${item.key} is now an item`)
  assert.equal((await owner('GET', `/issues/${item.key}`)).body.parentId, null)
  assert.deepEqual(o.problems, [])
})

test('[0601.R4] the History tab shows each change with its old and new names', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Changes journey', key: 'HSJ', template: 'kanban' })
  const [todo, doing] = (await owner('GET', '/projects/HSJ')).body.statuses
  const item = (await owner('POST', '/projects/HSJ/issues', { title: 'Watch its history' })).body
  await owner('PATCH', `/issues/${item.key}`, { statusId: doing.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/i/${item.key}`))
  await o.click('[aria-label="Activity filter"] [role="tab"]:has-text("History")')
  await o.waitForSelector(`text=${todo.name} → ${doing.name}`)
  assert.deepEqual(o.problems, [])
})

test('[0602.R1] JQL: status WAS finds an item that has moved on', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Was journey', key: 'WSJ', template: 'kanban' })
  const [, doing, done] = (await owner('GET', '/projects/WSJ')).body.statuses
  const moved = (await owner('POST', '/projects/WSJ/issues', { title: 'Moved on' })).body
  await owner('POST', '/projects/WSJ/issues', { title: 'Never started' })
  await owner('PATCH', `/issues/${moved.key}`, { statusId: doing.id })
  await owner('PATCH', `/issues/${moved.key}`, { statusId: done.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/search?q='))
  await o.click('button:has-text("Switch to JQL")')
  await o.fill('textarea[aria-label="JQL query"]', `project = WSJ AND status WAS "${doing.name}"`)
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector(`text=${moved.key}`)
  await o.waitForSelector('text=1 result')
  assert.deepEqual(o.problems, [])
})

test('[0603.R3] JQL: watchedIssues() finds the items you watch', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Watch journey', key: 'WTJ', template: 'kanban' })
  const watched = (await owner('POST', '/projects/WTJ/issues', { title: 'Watched' })).body
  const unwatched = (await owner('POST', '/projects/WTJ/issues', { title: 'Not watched' })).body
  await owner('DELETE', `/issues/${unwatched.key}/watch`)
  await owner('PUT', `/issues/${watched.key}/watch`)
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/search?q='))
  await o.click('button:has-text("Switch to JQL")')
  await o.fill('textarea[aria-label="JQL query"]', 'project = WTJ AND issue in watchedIssues()')
  await o.press('textarea[aria-label="JQL query"]', 'Enter')
  await o.waitForSelector(`text=${watched.key}`)
  await o.waitForSelector('text=1 result')
  assert.deepEqual(o.problems, [])
})

test('[0604.R1][0604.R5] a saved view is subscribed to daily; Run now sends the email', { skip, timeout: 120_000 }, async () => {
  assert.equal((await owner('PUT', '/admin/settings/email', { enabled: true, from: 'Strand <strand@e2e.test>', appUrl: 'https://strand.e2e.test' })).status, 200)
  await owner('POST', '/projects', { name: 'Subscription journey', key: 'SBJ', template: 'kanban' })
  await owner('POST', '/projects/SBJ/issues', { title: 'In the email' })
  const view = (await owner('POST', '/views', { name: 'Mailed view', filters: { q: '', resolution: 'open', jql: 'project = SBJ' } })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/search?view=${view.id}`))
  await o.click('button:has-text("Subscribe")')
  await o.click('.modal button:has-text("New subscription")')
  await o.selectOption('#sub-mode', 'daily')
  await o.click('.modal button:has-text("Subscribe")')
  await o.waitForSelector('.modal td:has-text("Just me")')
  assert.equal(await o.locator('.modal code').innerText(), '0 0 7 ? * *')
  await o.click('.modal [aria-label="Run now"]')
  await o.waitForSelector('text=Sending it now')
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  let sent
  for (let i = 0; i < 40 && !sent; i++) {
    sent = (await c.query(`select result->>'sent' as sent from jobs where kind = 'email.filter-subscription' and status = 'done' and payload->>'id' in (select id::text from filter_subscriptions where view_id = $1)`, [view.id])).rows[0]?.sent
    if (!sent) await new Promise(r => setTimeout(r, 500))
  }
  await c.end()
  assert.equal(sent, 'owner@e2e.test')
  await owner('PUT', '/admin/settings/email', { enabled: false, from: '', appUrl: '' })
  assert.deepEqual(o.problems, [])
})

test('[0605.R1][0605.R3] an admin adds a group to Issue Commented; a member of it hears about a comment', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Scheme journey', key: 'NSJ', template: 'kanban' })
  await owner('POST', '/projects/NSJ/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const group = (await owner('POST', '/groups', { name: 'nsj-listeners' })).body
  await owner('POST', `/groups/${group.id}/members`, { userIds: [await idOf('maya@e2e.test')] })
  const scheme = (await owner('POST', '/admin/notification-schemes', { name: 'Journey scheme' })).body
  await owner('PUT', '/projects/NSJ/notification-scheme', { schemeId: scheme.id })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/notification-schemes'))
  await o.click('tr:has-text("Journey scheme")')
  await o.click('[aria-label="Add a recipient to Issue Commented"]')
  await o.selectOption('#nr-kind', 'group')
  await o.selectOption('.modal [aria-label="Group"]', group.id)
  await o.click('.modal button:has-text("Add")')
  await o.waitForSelector('tr:has-text("Issue Commented") .chip:has-text("nsj-listeners")')
  const item = (await owner('POST', '/projects/NSJ/issues', { title: 'Talked about' })).body
  await owner('POST', `/issues/${item.key}/comments`, { body: 'Hello listeners' })
  const heard = (await maya('GET', '/notifications')).body.filter(n => n.issueKey === item.key).map(n => n.kind)
  assert.deepEqual(heard, ['commented'])
  assert.deepEqual(o.problems, [])
})

test('[0606.R2] with Autowatch turned off in Settings, commenting doesn\'t make you a watcher', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Autowatch journey', key: 'AWJ', template: 'kanban' })
  await owner('POST', '/projects/AWJ/members', { userIds: [await idOf('maya@e2e.test')], role: 'member' })
  const item = (await owner('POST', '/projects/AWJ/issues', { title: 'Commented on' })).body
  const m = await signIn('maya@e2e.test')
  await m.goto(url('/settings'))
  const box = m.locator('[role="checkbox"][aria-label="Watch work I create or comment on"]')
  await box.waitFor()
  assert.equal(await box.getAttribute('aria-checked'), 'true')
  await box.click()
  await m.waitForSelector('text=Notification settings saved')
  assert.equal(await box.getAttribute('aria-checked'), 'false')
  await maya('POST', `/issues/${item.key}/comments`, { body: 'Just passing by' })
  const mayaId = await idOf('maya@e2e.test')
  assert.equal((await owner('GET', `/issues/${item.key}`)).body.watcherIds.includes(mayaId), false)
  await maya('PUT', '/me/notification-prefs', { autowatch: null })
  assert.deepEqual(m.problems, [])
})

test('[0607.R1][0607.R2] an admin sets up incoming mail; an email becomes a work item', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Mail journey', key: 'MLJ', template: 'kanban' })
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/incoming-mail'))
  await o.click('button:has-text("Add mail server")')
  await o.fill('#ms-name', 'Drop folder')
  await o.selectOption('#ms-kind', 'files')
  await o.fill('#ms-authservId', 'mx.e2e.test')
  await o.click('.modal button:has-text("Test")')
  await o.waitForSelector('.modal [role="status"]:has-text("Connected: 0 unread")')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('td:has-text("Drop folder")')
  await o.click('button:has-text("Add mail handler")')
  await o.fill('#mh-name', 'Support desk')
  await o.fill('#mh-project', 'MLJ')
  await o.click('.modal button:has-text("Save")')
  await o.waitForSelector('td:has-text("Support desk")')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${mailDir}/1.eml`, ['Authentication-Results: mx.e2e.test; dmarc=pass header.from=e2e.test', 'From: Olive <owner@e2e.test>', 'To: support@e2e.test', 'Subject: Kettle is broken', 'Message-ID: <k1@e2e.test>', 'Content-Type: text/plain', '', 'It will not boil.'].join('\r\n'))
  await o.click('[aria-label="Run Support desk now"]')
  let items = []
  for (let i = 0; i < 40 && !items.length; i++) {
    items = (await owner('GET', `/search?jql=${encodeURIComponent('project = MLJ')}`)).body.items
    if (!items.length) await new Promise(r => setTimeout(r, 500))
  }
  assert.deepEqual(items.map(i => i.title), ['Kettle is broken'])
  await o.reload()
  await o.waitForSelector('td:has-text("1 created")')
  assert.deepEqual(o.problems, [])
})

test('[0608.R1][0608.R3] a search is exported as XML; an item\'s Printable opens in a new tab', { skip, timeout: 120_000 }, async () => {
  await owner('POST', '/projects', { name: 'Export journey', key: 'XPJ', template: 'kanban' })
  const item = (await owner('POST', '/projects/XPJ/issues', { title: 'Print me' })).body
  const o = await signIn('owner@e2e.test')
  await o.goto(url(`/search?q=${encodeURIComponent('Print me')}`))
  await o.waitForSelector(`text=${item.key}`)
  await o.click('button[title="Export"]')
  const [file] = await Promise.all([o.waitForEvent('download'), o.click('[role="menu"] button:has-text("XML")')])
  const xml = await (await import('node:fs')).promises.readFile(await file.path(), 'utf8')
  assert.match(xml, new RegExp(`<key id="[^"]+">${item.key}</key>`))
  await o.goto(url(`/i/${item.key}`))
  await o.click('[aria-label="More actions"]')
  const [tab] = await Promise.all([o.context().waitForEvent('page'), o.click('[role="menu"] button:has-text("Printable")')])
  await tab.waitForSelector(`h2:has-text("${item.key} Print me")`)
  assert.deepEqual(o.problems, [])
})

