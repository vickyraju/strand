import { test } from 'node:test'
import assert from 'node:assert/strict'

// router.ts touches window/location at import; stub just enough for pure parse/href.
Object.assign(globalThis, { window: { addEventListener() {} }, location: { pathname: '/', search: '' } })
const { parse, href } = await import('./router.ts')

test('a board and its quick filters round-trip, and opening a card keeps them', () => {
  const route = { name: 'project' as const, key: 'PAY', tab: 'board' as const, sub: 'b1', quick: 'q1,q2' }
  assert.equal(href(route, 'PAY-7'), '/project/PAY/board/b1?quick=q1%2Cq2&peek=PAY-7')
  assert.deepEqual(parse('/project/PAY/board/b1', '?quick=q1%2Cq2&peek=PAY-7'), { route, peek: 'PAY-7' })
})

test('project url round-trips as /project/KEY/tab', () => {
  const route = { name: 'project' as const, key: 'PAY', tab: 'list' as const, sub: undefined }
  assert.equal(href(route), '/project/PAY/list')
  assert.deepEqual(parse('/project/pay/list', '').route, route)
})

test('legacy /p/ still parses', () => {
  assert.equal(parse('/p/PAY/list', '').route.name, 'project')
})

test('administration urls: /admin and its sections; unknown sections are not found', () => {
  assert.deepEqual(parse('/admin', '').route, { name: 'admin', section: undefined })
  assert.deepEqual(parse('/admin/audit', '').route, { name: 'admin', section: 'audit' })
  assert.equal(href({ name: 'admin', section: 'backups' }), '/admin/backups')
  assert.deepEqual(parse('/admin/settings', '').route, { name: 'admin', section: 'settings' })
  assert.deepEqual(parse('/admin/link-types', '').route, { name: 'admin', section: 'link-types' })
  assert.deepEqual(parse('/admin/views', '').route, { name: 'admin', section: 'views' })
  assert.equal(parse('/admin/nope', '').route.name, 'not-found')
})

test('[0806.R1][0806.R3] Jira’s addresses open Strand’s pages', () => {
  const at = (path: string, search = '') => href(parse(path, search).route)
  assert.equal(at('/browse/PAY-12', '?focusedCommentId=10400'), '/i/PAY-12')
  assert.equal(at('/browse/pay-12'), '/i/PAY-12')
  assert.equal(at('/browse/PAY'), '/project/PAY')
  assert.equal(at('/projects/PAY'), '/project/PAY')
  assert.equal(at('/projects/PAY/issues/PAY-3'), '/project/PAY')
  assert.equal(at('/issues/', '?jql=project%20%3D%20PAY%20AND%20status%20%3D%20Open'), '/search?jql=project+%3D+PAY+AND+status+%3D+Open')
  assert.equal(at('/issues/', '?filter=10200'), '/search')
  assert.equal(at('/secure/IssueNavigator.jspa', '?jqlQuery=assignee%3DcurrentUser()'), '/search?jql=assignee%3DcurrentUser%28%29')
  assert.equal(at('/secure/RapidBoard.jspa', '?rapidView=5&projectKey=PAY'), '/project/PAY/board')
  assert.equal(at('/secure/RapidBoard.jspa', '?rapidView=5'), '/projects')
  assert.equal(at('/secure/Dashboard.jspa'), '/')
  assert.equal(at('/projects'), '/projects')                                          // Strand's own list stays
  assert.equal(parse('/secure/Unknown.jspa', '').route.name, 'not-found')
  assert.deepEqual(parse('/search', '?jql=type%20%3D%20bug').route, { name: 'search', q: '', view: undefined, jql: 'type = bug' })
})
