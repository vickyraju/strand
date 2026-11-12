import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitLabels } from '../../server/src/shared/labels.ts'

test('[0307.R2] spaces, commas and semicolons separate labels; duplicates go', () => {
  assert.deepEqual(splitLabels('ui polish, backend;ui  '), ['ui', 'polish', 'backend'])
  assert.deepEqual(splitLabels('  '), [])
})
