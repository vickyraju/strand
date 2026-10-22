import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageHours, lockedPackages, nameOf, olderChoice } from './check-release-age.mjs'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const hoursAgo = h => new Date(NOW - h * 3_600_000).toISOString()

test('age is counted in hours from the publish time, and unknown versions have none', () => {
  const time = { '1.0.0': hoursAgo(100), '1.0.1': hoursAgo(71.9), '1.0.2': hoursAgo(72) }
  assert.equal(ageHours(time, '1.0.0', NOW), 100)
  assert.ok(ageHours(time, '1.0.1', NOW) < 72)                      // just under the line: too new
  assert.ok(ageHours(time, '1.0.2', NOW) >= 72)                     // exactly 72 hours: allowed
  assert.equal(ageHours(time, '9.9.9', NOW), undefined)
  assert.equal(ageHours(undefined, '1.0.0', NOW), undefined)
})

test('the replacement is the newest old-enough version of the same major, never a pre-release or a newer one', () => {
  const time = {
    created: hoursAgo(9000), modified: hoursAgo(1),
    '1.9.0': hoursAgo(500), '2.0.0': hoursAgo(400), '2.1.0': hoursAgo(200), '2.2.0': hoursAgo(80),
    '2.3.0': hoursAgo(10), '2.3.1-beta.1': hoursAgo(90), '3.0.0': hoursAgo(300),
  }
  assert.equal(olderChoice(time, '2.3.0', 72, NOW), '2.2.0')         // 2.3.1-beta.1 is old enough but is a pre-release; 3.0.0 is another major
  assert.equal(olderChoice(time, '2.2.0', 72, NOW), '2.1.0')
  assert.equal(olderChoice(time, '2.0.0', 72, NOW), undefined)       // nothing older in this major
  assert.equal(olderChoice(time, '2.3.0', 600, NOW), undefined)      // a stricter limit leaves nothing
})

test('lockfile entries: names come from the path, and links, workspaces and the root are skipped', () => {
  assert.equal(nameOf('node_modules/react'), 'react')
  assert.equal(nameOf('node_modules/a/node_modules/@scope/b'), '@scope/b')
  const lock = {
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/react': { version: '19.0.0', resolved: 'https://registry.npmjs.org/react/-/react-19.0.0.tgz' },
      'node_modules/x/node_modules/@s/y': { version: '2.0.0', dev: true, resolved: 'https://registry.npmjs.org/@s/y/-/y-2.0.0.tgz' },
      'node_modules/linked': { link: true, resolved: '../linked' },
      'node_modules/local': { version: '1.0.0', resolved: 'file:../local' },
    },
  }
  assert.deepEqual(lockedPackages(lock), [{ name: 'react', version: '19.0.0', dev: false }, { name: '@s/y', version: '2.0.0', dev: true }])
})
