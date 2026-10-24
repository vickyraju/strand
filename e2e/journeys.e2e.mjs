// The main journeys, end to end in a real browser. Each one checks what a person sees and what the server keeps.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { start, stop, skip, signIn, as, url, PEOPLE } from './harness.mjs'

const owner = as('owner@e2e.test'), maya = as('maya@e2e.test'), vic = as('vic@e2e.test')
const idOf = async email => (await as(email)('GET', '/me')).body.id

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
