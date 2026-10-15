import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySignature, parseEvent } from '../src/integrations/github.ts'

const repository = { id: 42, full_name: 'acme/pay', default_branch: 'main', html_url: 'https://github.com/acme/pay' }
const pr = (over: object = {}, top: object = {}) => ({
  action: 'opened', number: 7, repository, installation: { id: 99 }, ...top,
  pull_request: { number: 7, html_url: 'https://github.com/acme/pay/pull/7', title: 'PAY-12 Fix login', body: 'Fixes PAY-12', state: 'open', draft: false, merged: false,
    merged_at: null, updated_at: '2026-10-14T10:00:00Z', user: { login: 'vicky', avatar_url: 'https://a/v.png' }, head: { ref: 'pay-12-fix-login', sha: 'abc' }, base: { ref: 'main' }, ...over },
})

test('signature: GitHub\'s published test vector verifies; tampering, wrong secret and missing header do not', () => {
  const secret = "It's a Secret to Everybody", body = 'Hello, World!'
  const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
  assert.equal(verifySignature(body, header, secret), true)
  assert.equal(verifySignature(Buffer.from(body), header, secret), true)
  assert.equal(verifySignature('Hello, World?', header, secret), false)
  assert.equal(verifySignature(body, header, 'other'), false)
  assert.equal(verifySignature(body, undefined, secret), false)
  assert.equal(verifySignature(body, header.replace('sha256=', 'sha1='), secret), false)
  assert.equal(verifySignature(body, header, ''), false)                       // no secret configured never verifies
})

test('a pull request becomes one record with its state, branches and the three texts to scan', () => {
  const { entities, repo, installationId } = parseEvent('pull_request', pr())
  assert.deepEqual([repo!.externalId, repo!.fullName, installationId], ['42', 'acme/pay', 99])
  const e = entities[0]!
  assert.deepEqual([e.kind, e.externalId, e.state, e.branchFrom, e.branchTo, e.author?.login], ['pull_request', '7', 'open', 'pay-12-fix-login', 'main', 'vicky'])
  assert.deepEqual(e.texts.map(t => t.via), ['branch', 'title', 'body'])
  assert.equal(parseEvent('pull_request', pr({ state: 'closed', merged: true, merged_at: 'x' })).entities[0]!.state, 'merged')
  assert.equal(parseEvent('pull_request', pr({ state: 'closed' })).entities[0]!.state, 'closed')
  assert.equal(parseEvent('pull_request', pr({ draft: true })).entities[0]!.payload.draft, true)
})

test('reviews: approved / changes requested set the state (any casing), comments leave it, dismissal clears it', () => {
  const rev = (state: string, action = 'submitted') => parseEvent('pull_request_review', { ...pr(), action, review: { state } }).entities[0]!.reviewState
  assert.equal(rev('approved'), 'approved')
  assert.equal(rev('APPROVED'), 'approved')
  assert.equal(rev('changes_requested'), 'changes_requested')
  assert.equal(rev('commented'), undefined)
  assert.equal(rev('approved', 'dismissed'), null)
  assert.equal(parseEvent('pull_request_review', { ...pr(), action: 'edited', review: { state: 'approved' } }).entities.length, 0)
})

test('a push yields the branch and its commits (capped), keeps no emails, and ignores tags', () => {
  const commits = Array.from({ length: 60 }, (_, i) => ({ id: `sha${i}`, message: `PAY-12 step ${i}\n\nlong body`, url: `https://github.com/acme/pay/commit/sha${i}`, timestamp: '2026-10-14T09:00:00Z', author: { name: 'Vicky', username: 'vicky', email: 'secret@x.com' } }))
  const { entities } = parseEvent('push', { ref: 'refs/heads/feature/pay-12', repository, installation: { id: 99 }, commits, head_commit: { timestamp: '2026-10-14T09:30:00Z' } })
  assert.equal(entities.filter(e => e.kind === 'commit').length, 50)
  assert.deepEqual([entities[0]!.kind, entities[0]!.externalId, entities[0]!.url], ['branch', 'feature/pay-12', 'https://github.com/acme/pay/tree/feature/pay-12'])
  const c = entities[1]!
  assert.deepEqual([c.title, c.branchTo, c.author], ['PAY-12 step 0', 'feature/pay-12', { login: 'vicky', name: 'Vicky' }])
  assert.ok(!JSON.stringify(entities).includes('secret@x.com'))
  assert.equal(parseEvent('push', { ref: 'refs/tags/v1', repository, commits: [] }).entities.length, 0)
  const del = parseEvent('push', { ref: 'refs/heads/old', deleted: true, repository, commits: [] }).entities
  assert.deepEqual(del.map(e => [e.kind, e.state]), [['branch', 'deleted']])
})

test('create / delete events track branches only; unknown events and malformed payloads are ignored', () => {
  assert.deepEqual(parseEvent('create', { ref: 'pay-3-x', ref_type: 'branch', repository }).entities.map(e => [e.kind, e.state]), [['branch', 'active']])
  assert.deepEqual(parseEvent('delete', { ref: 'pay-3-x', ref_type: 'branch', repository }).entities.map(e => e.state), ['deleted'])
  assert.equal(parseEvent('create', { ref: 'v1', ref_type: 'tag', repository }).entities.length, 0)
  assert.equal(parseEvent('ping', { zen: 'hi' }).entities.length, 0)
  assert.equal(parseEvent('pull_request', {}).entities.length, 0)
  assert.equal(parseEvent('push', null).entities.length, 0)
})
