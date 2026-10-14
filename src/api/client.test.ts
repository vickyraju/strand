import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, withPrefix } from './client.ts'

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

test('the API prefix is configurable: /api/... becomes /api/v1/..., other paths are left alone', () => {
  assert.equal(withPrefix('/api/projects/PAY', '/api/v1'), '/api/v1/projects/PAY')
  assert.equal(withPrefix('/api/projects', '/api'), '/api/projects')
  assert.equal(withPrefix('/health', '/api/v1'), '/health')
  assert.equal(withPrefix('/api', '/api/v1'), '/api')          // only paths under /api/ are rewritten
})
