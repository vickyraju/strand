import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRun, parseCron } from '../src/shared/cron.ts'

test('[0604.R2] cron: Jira\'s schedules give the right next runs', () => {
  const after = new Date(2026, 10, 11, 15, 30)                    // Wednesday 11 Nov 2026, 15:30 local
  const at = (expr: string, from = after) => { const d = nextRun(expr, from)!; return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()] }
  assert.deepEqual(at('0 0 7 ? * *'), [2026, 11, 12, 7, 0])         // daily at 7:00
  assert.deepEqual(at('0 0 16 * * ?'), [2026, 11, 11, 16, 0])       // later today
  assert.deepEqual(at('0 0 9 ? * MON,FRI'), [2026, 11, 13, 9, 0])   // days per week
  assert.deepEqual(at('0 0 9 ? * 2-6'), [2026, 11, 12, 9, 0])       // weekdays (2 is Monday)
  assert.deepEqual(at('0 30 8 1 * ?'), [2026, 12, 1, 8, 30])        // a day of the month
  assert.deepEqual(at('0 0 8 ? * 2#1'), [2026, 12, 7, 8, 0])        // the first Monday
  assert.deepEqual(at('0 0 8 ? * 6L'), [2026, 11, 27, 8, 0])        // the last Friday
  assert.deepEqual(at('0 0 8 L * ?'), [2026, 11, 30, 8, 0])         // the last day
  assert.deepEqual(at('0 0/15 * ? * *'), [2026, 11, 11, 15, 45])    // every 15 minutes
  assert.deepEqual(at('0 0 9-17/2 ? * *'), [2026, 11, 11, 17, 0])   // every 2 hours from 9 to 17
  assert.deepEqual(at('0 0 9 1 JAN ? 2028'), [2028, 1, 1, 9, 0])    // a year
  assert.equal(nextRun('0 0 9 31 2 ?', after), null)                // never (no 31 February)
})

test('[0604.R2] cron: mistakes are refused with a reason', () => {
  const err = (expr: string) => { try { parseCron(expr); return null } catch (e) { return (e as Error).message } }
  assert.match(err('0 0 7 * *')!, /six or seven parts/)
  assert.match(err('0 0 25 ? * *')!, /hours: “25” isn’t between 0 and 23/)
  assert.match(err('0 0 7 1 * MON')!, /Use \?/)
  assert.match(err('0 0 7 15W * ?')!, /W/)
  assert.match(err('0 0 7 ? * FUNDAY')!, /days of the week/)
  assert.equal(err('0 0 7 ? * 2#1'), null)
})
