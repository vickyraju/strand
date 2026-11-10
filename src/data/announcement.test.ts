import { test } from 'node:test'
import assert from 'node:assert/strict'
import { announcementParts, fingerprint } from './announcement.ts'

test('[0701.R3] https addresses become links; everything else, HTML included, stays text', () => {
  assert.deepEqual(announcementParts('See https://status.example.com/now. Thanks'), [{ text: 'See ' }, { href: 'https://status.example.com/now' }, { text: '. Thanks' }])
  assert.deepEqual(announcementParts('<script>alert(1)</script> http://plain.example'), [{ text: '<script>alert(1)</script> http://plain.example' }])
  assert.deepEqual(announcementParts('(https://a.example/x)'), [{ text: '(' }, { href: 'https://a.example/x' }, { text: ')' }])
})

test('[0701.R4] a changed announcement has a new fingerprint', () => {
  assert.equal(fingerprint('Maintenance Saturday'), fingerprint('Maintenance Saturday'))
  assert.notEqual(fingerprint('Maintenance Saturday'), fingerprint('Maintenance Sunday'))
})
