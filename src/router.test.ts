import { test } from 'node:test'
import assert from 'node:assert/strict'

// router.ts touches window/location at import; stub just enough for pure parse/href.
Object.assign(globalThis, { window: { addEventListener() {} }, location: { pathname: '/', search: '' } })
const { parse, href } = await import('./router.ts')

test('project url round-trips as /project/KEY/tab', () => {
  const route = { name: 'project' as const, key: 'PAY', tab: 'list' as const, sub: undefined }
  assert.equal(href(route), '/project/PAY/list')
  assert.deepEqual(parse('/project/pay/list', '').route, route)
})

test('legacy /p/ still parses', () => {
  assert.equal(parse('/p/PAY/list', '').route.name, 'project')
})
