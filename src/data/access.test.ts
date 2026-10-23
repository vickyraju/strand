import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAdmin, canEdit } from './access.ts'

test('viewers read only, members work, admins also manage; a local workspace has no limits', () => {
  assert.deepEqual([canEdit({ role: 'viewer' }), canEdit({ role: 'member' }), canEdit({ role: 'admin' }), canEdit({})], [false, true, true, true])
  assert.deepEqual([canAdmin({ role: 'viewer' }), canAdmin({ role: 'member' }), canAdmin({ role: 'admin' }), canAdmin({})], [false, false, true, true])
  assert.equal(canEdit(undefined), true)
})
