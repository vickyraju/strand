import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from './client.ts'

test('requests carry the dev login and a JSON body', () => {
  const [url, init] = buildRequest('https://api.test', { email: 'a@x.com', secret: 's3cret' }, 'POST', '/api/projects', { name: 'P' })
  assert.equal(url, 'https://api.test/api/projects')
  assert.deepEqual(init.headers, { 'x-dev-user': 'a@x.com', 'x-dev-secret': 's3cret', 'content-type': 'application/json' })
  assert.equal(init.body, '{"name":"P"}')
})

test('no login and no body sends no auth or content-type headers', () => {
  const [, init] = buildRequest('https://api.test', null, 'GET', '/api/me')
  assert.deepEqual(init.headers, {})
  assert.equal(init.body, undefined)
})
