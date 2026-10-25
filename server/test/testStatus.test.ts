// Xray's status rules, case by case (from its page "Understanding coverage and the calculation of Test and requirement
// statuses"), against the shared module the server and the app both use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFromSteps, combine, testStatus, requirementStatus, withSubRequirements, type RunStatus, type StepStatus } from '../src/shared/testStatus.ts'

const RUN: RunStatus[] = [
  { key: 'TODO', final: false, mapsTo: 'notrun', rank: 1 }, { key: 'EXECUTING', final: false, mapsTo: 'notrun', rank: 2 },
  { key: 'PASS', final: true, mapsTo: 'ok', rank: 0 }, { key: 'FAIL', final: true, mapsTo: 'nok', rank: 4 },
  { key: 'ABORTED', final: true, mapsTo: 'notrun', rank: 3 },
  { key: 'c-flaky', final: false, mapsTo: 'unknown', rank: 5 },        // Xray's "discardable failure" pattern
  { key: 'c-blocked', final: true, mapsTo: 'nok', rank: 2 },
]
const STEP: StepStatus[] = [{ key: 'TODO', mapsTo: 'TODO' }, { key: 'EXECUTING', mapsTo: 'EXECUTING' }, { key: 'PASS', mapsTo: 'PASS' }, { key: 'FAIL', mapsTo: 'FAIL' }, { key: 'c-skip', mapsTo: 'PASS' }]

test('a run from its steps: all passed → PASS; any failed → FAIL; done and to-do mixed → EXECUTING; none → TODO', () => {
  const cases: [string[], string][] = [
    [[], 'TODO'], [['TODO', 'TODO'], 'TODO'], [['PASS', 'PASS'], 'PASS'], [['PASS', 'c-skip'], 'PASS'],
    [['PASS', 'FAIL', 'TODO'], 'FAIL'], [['TODO', 'FAIL'], 'FAIL'], [['PASS', 'TODO'], 'EXECUTING'], [['EXECUTING', 'PASS'], 'EXECUTING'],
  ]
  for (const [steps, want] of cases) assert.equal(runFromSteps(steps, STEP, RUN), want, steps.join(','))
})

test('combining results: PASS only if all passed; any FAIL is FAIL; a NOK status beats the rest; otherwise the highest rank', () => {
  const cases: [string[], string | null][] = [
    [[], null], [['PASS', 'PASS'], 'PASS'], [['PASS', 'TODO'], 'TODO'], [['PASS', 'FAIL', 'c-blocked'], 'FAIL'],
    [['TODO', 'c-blocked'], 'c-blocked'], [['ABORTED', 'TODO', 'EXECUTING'], 'ABORTED'], [['PASS', 'c-flaky'], 'c-flaky'],
  ]
  for (const [keys, want] of cases) assert.equal(combine(keys, RUN), want, keys.join(','))
})

test('a test from its runs: the latest final run counts (unless that rule is off); environments are combined', () => {
  const r = (status: string, created: string, finished: string | null, environments: string[] = []) => ({ status, createdAt: created, finishedAt: finished, environments })
  // a new TODO run doesn't hide an earlier PASS when final statuses have precedence…
  const runs = [r('PASS', '2026-01-01', '2026-01-01'), r('TODO', '2026-02-01', null)]
  assert.equal(testStatus(runs, RUN, true), 'PASS')
  // …but with the rule off the latest run made counts
  assert.equal(testStatus(runs, RUN, false), 'TODO')
  // the latest final by finish time, not by creation
  assert.equal(testStatus([r('FAIL', '2026-01-01', '2026-03-01'), r('PASS', '2026-02-01', '2026-02-02')], RUN, true), 'FAIL')
  // only non-final runs: the latest of them
  assert.equal(testStatus([r('TODO', '2026-01-01', null), r('EXECUTING', '2026-02-01', null)], RUN, true), 'EXECUTING')
  // environments: PASS only if every one passed; any FAIL fails it; one environment can be asked for
  const envs = [r('PASS', '2026-01-01', '2026-01-01', ['chrome']), r('FAIL', '2026-01-02', '2026-01-02', ['firefox']), r('PASS', '2026-01-03', '2026-01-03', ['firefox'])]
  assert.equal(testStatus(envs, RUN, true), 'PASS')
  assert.equal(testStatus([...envs, r('FAIL', '2026-01-04', '2026-01-04', ['safari'])], RUN, true), 'FAIL')
  assert.equal(testStatus([...envs, r('FAIL', '2026-01-04', '2026-01-04', ['safari'])], RUN, true, 'chrome'), 'PASS')
  assert.equal(testStatus([], RUN, true), null)
})

test('a requirement: OK when every test passed, NOK when one failed, NOTRUN or UNKNOWN in between, UNCOVERED with no tests', () => {
  const cases: [(string | null)[], string][] = [
    [[], 'UNCOVERED'], [['PASS', 'PASS'], 'OK'], [['PASS', 'FAIL'], 'NOK'], [['PASS', null], 'NOTRUN'], [['PASS', 'ABORTED'], 'NOTRUN'],
    [['PASS', 'c-flaky'], 'UNKNOWN'], [['c-flaky', 'FAIL'], 'NOK'], [['c-blocked'], 'NOK'], [[null], 'NOTRUN'],
  ]
  for (const [tests, want] of cases) assert.equal(requirementStatus(tests, RUN), want, tests.join(','))
})

test('a requirement with sub-requirements: NOK > UNKNOWN > NOTRUN > OK; UNCOVERED takes the other side', () => {
  const cases: [string, string[], string][] = [
    ['OK', ['NOK'], 'NOK'], ['NOK', ['OK', 'OK'], 'NOK'], ['OK', ['NOTRUN', 'UNKNOWN'], 'UNKNOWN'], ['OK', ['NOTRUN'], 'NOTRUN'],
    ['UNCOVERED', ['OK'], 'OK'], ['OK', ['UNCOVERED'], 'OK'], ['UNCOVERED', ['UNCOVERED'], 'UNCOVERED'], ['UNCOVERED', [], 'UNCOVERED'],
  ]
  for (const [own, subs, want] of cases) assert.equal(withSubRequirements(own as any, subs as any), want, `${own} + ${subs.join(',')}`)
})
