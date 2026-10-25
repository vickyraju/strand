// How Xray works out statuses (its page "Understanding coverage and the calculation of Test and requirement statuses"),
// shared by the server and the app so both give the same answer.

export interface RunStatus { key: string; final: boolean; mapsTo: 'ok' | 'nok' | 'notrun' | 'unknown'; rank: number }
export interface StepStatus { key: string; mapsTo: string }
export interface RunRecord { status: string; finishedAt: string | null; createdAt: string; environments: string[] }

/** Which of two run statuses wins when results are combined:
 *  anything beats a status that means OK (two OK ones: the higher rank); FAIL wins; a status that means NOK wins;
 *  final beats not final; otherwise the higher rank. */
function better(a: RunStatus, b: RunStatus): RunStatus {
  if ((a.mapsTo === 'ok') !== (b.mapsTo === 'ok')) return a.mapsTo === 'ok' ? b : a
  if (a.key === 'FAIL' || b.key === 'FAIL') return a.key === 'FAIL' ? a : b
  if ((a.mapsTo === 'nok') !== (b.mapsTo === 'nok')) return a.mapsTo === 'nok' ? a : b
  if (a.final !== b.final) return a.final ? a : b
  return b.rank > a.rank ? b : a
}
const lookup = (statuses: RunStatus[]) => {
  const byKey = new Map(statuses.map(s => [s.key, s]))
  return (k: string) => byKey.get(k) ?? { key: k, final: false, mapsTo: 'unknown' as const, rank: 0 }
}

/** A run's status from its steps: each step status counts as the run status it maps to (order doesn't matter). All passed:
 *  PASS; any failed: FAIL; some done and the rest still to do: EXECUTING. No steps: TODO. */
export function runFromSteps(stepKeys: string[], steps: StepStatus[], runs: RunStatus[]): string {
  if (!stepKeys.length) return 'TODO'
  const run = lookup(runs)
  const toRun = new Map(steps.map(s => [s.key, s.mapsTo]))
  const mapped = stepKeys.map(k => run(toRun.get(k) ?? 'TODO'))
  const top = mapped.reduce(better)
  return top.key === 'TODO' && mapped.some(m => m.key !== 'TODO') ? 'EXECUTING' : top.key
}

/** Several results (environments, or tests of a requirement) as one: PASS only if all passed, any FAIL makes it FAIL,
 *  otherwise the highest-ranked status. */
export function combine(keys: string[], runs: RunStatus[]): string | null {
  if (!keys.length) return null
  const run = lookup(runs)
  return keys.map(run).reduce(better).key
}

/** A test's status from its runs in some scope (a version, a plan, the latest), as Xray does it:
 *  - per environment, with "final statuses have precedence" on, the latest final run (by when it finished) counts, or
 *    the latest run if none is final; with it off, the latest run made counts;
 *  - then the environments are combined. A run with no environment counts on its own.
 *  Null when there are no runs. */
export function testStatus(records: RunRecord[], runs: RunStatus[], finalPrecedence: boolean, environment?: string): string | null {
  const run = lookup(runs)
  const groups = new Map<string, RunRecord[]>()
  for (const r of records) {
    const envs = r.environments.length ? r.environments : ['']
    for (const e of envs) if (environment === undefined || e === environment) groups.set(e, [...(groups.get(e) ?? []), r])
  }
  const latest = (rs: RunRecord[], at: (r: RunRecord) => string) => rs.reduce((a, b) => (at(b) > at(a) ? b : a))
  const perEnv = [...groups.values()].map(rs => {
    const finals = rs.filter(r => run(r.status).final && r.finishedAt)
    return finalPrecedence && finals.length ? latest(finals, r => r.finishedAt!).status : latest(rs, r => r.createdAt).status
  })
  return combine(perEnv, runs)
}
