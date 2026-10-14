import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractLinks, branchName, type Source } from '../src/integrations/links.ts'

const keys = ['PAY', 'API']
const run = (sources: Source[]) => extractLinks(sources, keys).map(l => `${l.key}:${l.via}:${l.closing ? 'closing' : 'plain'}`)

test('branch names link case-insensitively and never close', () => {
  assert.deepEqual(run([{ via: 'branch', text: 'feature/pay-12-fix-login' }]), ['PAY-12:branch:plain'])
  assert.deepEqual(run([{ via: 'branch', text: 'fixes-pay-1' }]), ['PAY-1:branch:plain'])   // magic words are not read in branches
})

test('only real project keys match, whole tokens only', () => {
  assert.deepEqual(run([{ via: 'title', text: 'Support UTF-8 and SHA-256, see ZZZ-4' }]), [])
  assert.deepEqual(run([{ via: 'title', text: 'XPAY-1 and PAY-1x' }]), ['PAY-1:title:plain'])   // PAY-1x still reads as PAY-1 followed by a letter
  assert.deepEqual(run([{ via: 'title', text: 'PAY-120' }]), ['PAY-120:title:plain'])          // not PAY-12
  assert.deepEqual(extractLinks([{ via: 'title', text: 'PAY-1' }], []), [])
})

test('closing words mark the link as closing, lists share the word, other words do not', () => {
  assert.deepEqual(run([{ via: 'body', text: 'Fixes PAY-1, PAY-2 and API-3' }]), ['PAY-1:body:closing', 'PAY-2:body:closing', 'API-3:body:closing'])
  assert.deepEqual(run([{ via: 'body', text: 'closes PAY-1\nrelates to PAY-2\nRefs: API-9' }]), ['PAY-1:body:closing', 'PAY-2:body:plain', 'API-9:body:plain'])
  assert.deepEqual(run([{ via: 'commit', text: 'Resolved: PAY-7' }]), ['PAY-7:commit:closing'])
})

test('a key found in several places is one link: first source wins, closing from any source', () => {
  assert.deepEqual(run([
    { via: 'branch', text: 'pay-12-login' },
    { via: 'title', text: 'Login redirect (PAY-12)' },
    { via: 'body', text: 'Fixes PAY-12' },
  ]), ['PAY-12:branch:closing'])
})

test('skip / ignore removes the link from every source', () => {
  assert.deepEqual(run([{ via: 'branch', text: 'pay-12-login' }, { via: 'body', text: 'skip PAY-12\nFixes API-1' }]), ['API-1:body:closing'])
  assert.deepEqual(run([{ via: 'body', text: 'Ignore pay-3' }]), [])
})

test('branchName makes a short, git-safe name', () => {
  assert.equal(branchName('PAY-12', 'Fix login redirect!'), 'pay-12-fix-login-redirect')
  assert.equal(branchName('PAY-1', '  Ünïcode — dash & more  '), 'pay-1-unicode-dash-more')
  assert.equal(branchName('PAY-1', '???'), 'pay-1')
  assert.ok(branchName('PAY-1', 'word '.repeat(40)).length <= 60)
  assert.ok(!branchName('PAY-1', 'word '.repeat(40)).endsWith('-'))
})
