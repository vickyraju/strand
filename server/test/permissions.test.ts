import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSIONS, holds, rolesWith } from '../src/shared/permissions.ts'

// The table of spec 0201, pinned: changing who holds a permission is a change of the product and needs its own spec.
const SPEC: Record<string, [jira: string, strand: string | null, spec?: string]> = {
  browse: ['any user with access', 'viewer'], createIssues: ['any user with access', 'member'], editIssues: ['any user with access', 'member'],
  transitionIssues: ['any user with access', 'member'], assignIssues: ['any user with access', 'member'],
  assignable: ['any user with access', 'viewer', '0207'], linkIssues: ['any user with access', 'member'], moveIssues: ['any user with access', null, '0501'],
  deleteIssues: ['Administrators', 'admin', '0202'], modifyReporter: ['Administrators', null, '0207'], manageWatchers: ['Administrators', null, '0207'],
  viewWatchers: ['any user with access', 'viewer'], addComments: ['any user with access', 'viewer'],
  editOwnComments: ['any user with access', 'viewer'], deleteOwnComments: ['any user with access', 'viewer'],
  editAllComments: ['Administrators', null, '0205'], deleteAllComments: ['Administrators', null, '0205'],
  createAttachments: ['any user with access', 'member'], deleteOwnAttachments: ['any user with access', 'member'],
  deleteAllAttachments: ['Administrators', 'member', '0204'], workOnIssues: ['any user with access', 'member'],
  editOwnWorklogs: ['any user with access', 'member'], deleteOwnWorklogs: ['any user with access', 'member'],
  editAllWorklogs: ['Administrators', 'admin'], deleteAllWorklogs: ['Administrators', 'admin'],
  manageSprints: ['Administrators', 'member', '0203'], administer: ['Administrators', 'admin'], archiveIssues: ['none', null, '0508'],
  setIssueSecurity: ['none', 'member'],   // strand only
}

test('[0201.R1][0201.R5] one table of Jira’s project permissions: for each, Jira’s default and the lowest Strand role that holds it, as the spec says', () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(SPEC).sort())
  for (const [k, [jira, role, spec]] of Object.entries(SPEC)) {
    const row = PERMISSIONS[k as keyof typeof PERMISSIONS]
    assert.deepEqual([row.jira, row.role, row.spec], [jira, role, spec], k)
  }
})

test('[0201.R6] permissions Strand doesn’t have yet are held by nobody, each naming the spec that adds it', () => {
  const missing = Object.entries(PERMISSIONS).filter(([, r]) => !r.role)
  assert.deepEqual(missing.map(([k, r]) => [k, r.spec]).sort(), [['archiveIssues', '0508'], ['deleteAllComments', '0205'], ['editAllComments', '0205'], ['manageWatchers', '0207'], ['modifyReporter', '0207'], ['moveIssues', '0501']].sort())
  for (const [k] of missing) assert.deepEqual(rolesWith(k as never), [], k)
})

test('[0201.R1] a higher role holds what a lower one does; nobody without a role holds anything', () => {
  assert.deepEqual(rolesWith('browse'), ['viewer', 'member', 'admin'])
  assert.deepEqual(rolesWith('editIssues'), ['member', 'admin'])
  assert.deepEqual(rolesWith('administer'), ['admin'])
  assert.equal(holds(null, 'browse'), false)
})
