// The main journeys, end to end in a real browser. Each one checks what a person sees and what the server keeps.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { start, stop, skip, signIn, as, url, PEOPLE, postRaw } from './harness.mjs'

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
  const keys = Array.from({ length: 60 }, (_, n) => `BIG${String(n).padStart(2, '0')}`)
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
  await panel.locator('input').fill('BIG5')
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
  assert.deepEqual(await menu.locator('.nav-section').allInnerTexts(), ['PEOPLE & ACCESS', 'WORK ITEMS', 'SYSTEM'])
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

test('system groups: a newcomer is in users-access and sees no Administration; someone with Entra’s admin role does', { skip, timeout: 60_000 }, async () => {
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
  const boss = await signIn('boss@e2e.test', ['Strand.Admin'])
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

test('license cleanup: an admin previews who is idle, runs the cleanup, and the idle person loses their seat until they sign in again', { skip, timeout: 90_000 }, async () => {
  const pg = (await import('node:module')).createRequire(new URL('../server/package.json', import.meta.url))('pg')
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  const samId = await idOf('sam@e2e.test')
  await c.query(`update users set last_active_at = now() - interval '200 days' where id = $1`, [samId])   // Sam hasn't used Strand for 200 days
  await c.end()
  const o = await signIn('owner@e2e.test')
  await o.goto(url('/admin/license'))
  await o.fill('[aria-label="Inactive for (days)"]', '180')
  await o.fill('[aria-label="Warn days before"]', '0')
  await o.click('section[aria-label="License cleanup"] button:has-text("Save")')
  await o.waitForSelector('text=Saved')
  await o.click('button:has-text("Preview")')
  await o.waitForSelector('[aria-label="Preview"] td:has-text("Sam Someone")')
  // "Run now" says how many people it changes before it does
  await o.click('button:has-text("Run now")')
  await o.waitForSelector('.modal >> text=Run the cleanup now?')
  assert.match(await o.locator('.modal').innerText(), /\d+ (person is|people are) changed now/)
  await o.click('.modal button:has-text("Change")')
  await o.waitForSelector('text=/Changed [1-9]/')
  const seat = async () => (await as('owner@e2e.test')('GET', '/admin/users?query=sam')).body.items.find(u => u.id === samId).groups.some(g => g.name === 'users-access')
  assert.equal(await seat(), false)
  // People: filter to the inactive, and see the change; Sam signs in and is back
  await o.goto(url('/admin/people'))
  await o.selectOption('[aria-label="Inactive"]', '180')
  await o.waitForSelector('td:has-text("Sam Someone")')
  await signIn('sam@e2e.test')
  await o.waitForTimeout(1000)
  assert.equal(await seat(), true)
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
