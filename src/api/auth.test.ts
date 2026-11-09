import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeUrl, challengeOf, needsRefresh, randomToken, showsLoginForm, type EntraClient } from './auth.ts'
import { buildRequest, withPrefix, API_PREFIX } from './client.ts'

test('PKCE: the challenge matches the RFC 7636 test vector', async () => {
  assert.equal(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('random tokens are url-safe and different every time', () => {
  const a = randomToken(), b = randomToken()
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
})

test('the authorize URL asks for a code with PKCE, the scope the server publishes, and the state', () => {
  const e: EntraClient = { name: 'Microsoft', tenantId: 'T', clientId: 'C', authority: 'https://login.example', scope: 'api://A/access_as_user openid' }
  const u = new URL(authorizeUrl(e, { redirectUri: 'https://app.example/', challenge: 'CH', state: 'ST' }))
  assert.equal(u.origin + u.pathname, 'https://login.example/T/oauth2/v2.0/authorize')
  const q = u.searchParams
  assert.deepEqual([q.get('client_id'), q.get('response_type'), q.get('redirect_uri'), q.get('state')], ['C', 'code', 'https://app.example/', 'ST'])
  assert.deepEqual([q.get('code_challenge'), q.get('code_challenge_method')], ['CH', 'S256'])
  assert.equal(q.get('scope'), 'api://A/access_as_user openid')
})

test('[0711.R6][0711.R7] the login form shows when the admin shows it, with ?auth_fallback, or when Microsoft is off', () => {
  const entra: EntraClient = { name: 'Microsoft', tenantId: 'T', clientId: 'C', authority: 'https://login.example', scope: 's' }
  assert.equal(showsLoginForm({ loginForm: true, fallback: false, entra }, ''), true)
  assert.equal(showsLoginForm({ loginForm: false, fallback: false, entra }, ''), false)           // straight to Microsoft
  assert.equal(showsLoginForm({ loginForm: false, fallback: true, entra }, '?auth_fallback'), true)
  assert.equal(showsLoginForm({ loginForm: false, fallback: false, entra }, '?auth_fallback'), true)   // recovery_admin still gets in
  assert.equal(showsLoginForm({ loginForm: false, fallback: false, entra: null }, ''), true)
})

test('a token is refreshed a minute before it expires', () => {
  const s = { access: 'a', expiresAt: 1_000_000 }
  assert.equal(needsRefresh(s, 1_000_000 - 61_000), false)
  assert.equal(needsRefresh(s, 1_000_000 - 59_000), true)
  assert.equal(needsRefresh(s, 1_000_001), true)
})

test('requests carry the bearer token and a JSON body', () => {
  const [url, init] = buildRequest('https://api.test', 'tok', 'POST', '/api/v1/projects', { name: 'P' })
  assert.equal(url, 'https://api.test/api/v1/projects')
  assert.deepEqual(init.headers, { authorization: 'Bearer tok', 'content-type': 'application/json' })
  assert.equal(init.body, '{"name":"P"}')
})

test('no token and no body sends no auth or content-type headers', () => {
  const [, init] = buildRequest('https://api.test', null, 'GET', '/api/v1/me')
  assert.deepEqual(init.headers, {})
  assert.equal(init.body, undefined)
})

test('the API is called under /api/v1 unless the prefix is overridden', () => {
  assert.equal(API_PREFIX, '/api/v1')
  assert.equal(withPrefix('/api/projects/PAY'), '/api/v1/projects/PAY')
  assert.equal(withPrefix('/api/projects/PAY', '/gateway/v1'), '/gateway/v1/projects/PAY')
  assert.equal(withPrefix('/health'), '/health')
  assert.equal(withPrefix('/api'), '/api')          // only paths under /api/ are rewritten
})
