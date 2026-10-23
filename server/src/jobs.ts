import type { FastifyBaseLogger } from 'fastify'
import { db, type Db } from './db.ts'

/** What a job handler gets: its payload and the job's own row. Throwing retries the job; the return value is kept as its result. */
export type JobHandler = (payload: any, job: { id: string; attempts: number; workspaceId: string | null; createdBy: string | null }) => Promise<unknown>

const handlers = new Map<string, JobHandler>()
/** How long a claimed job is reserved for its worker; after that another pod may take it. */
const LEASE_MS = 5 * 60_000

export function registerJob(kind: string, handler: JobHandler) { handlers.set(kind, handler) }

/** Queue a job (inside the caller's transaction, so it exists only if the change does). With `dedupeKey`, a job with the
 *  same key that is still waiting or running is returned instead of queueing a second one. */
export async function enqueue(d: Db, kind: string, payload: unknown, o: { workspaceId?: string | null; createdBy?: string | null; dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}) {
  const [row] = await d.query<{ id: string }>(
    `insert into jobs (kind, payload, workspace_id, created_by, dedupe_key, run_at, max_attempts)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7, 5))
     on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing returning id`,
    [kind, JSON.stringify(payload ?? {}), o.workspaceId ?? null, o.createdBy ?? null, o.dedupeKey ?? null, o.runAt ?? null, o.maxAttempts ?? null])
  if (row) return row.id
  return (await d.query<{ id: string }>(`select id from jobs where dedupe_key = $1 and status in ('queued', 'running')`, [o.dedupeKey]))[0]!.id
}

/** Wait before retry n (1-based): 10 s, 20 s, 40 s… capped at an hour. */
export const backoffMs = (attempt: number) => Math.min(10_000 * 2 ** (attempt - 1), 60 * 60_000)

/** Claims and runs due jobs, one at a time, until none is left or `max` have run. Returns how many ran. */
export async function runJobs(max = 20, log?: FastifyBaseLogger) {
  let ran = 0
  while (ran < max) {
    const [job] = await db.query<any>(
      `update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $1)
        where id = (select id from jobs
                     where (status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now())
                     order by run_at, id for update skip locked limit 1)
        returning *`, [LEASE_MS / 1000])
    if (!job) break
    ran++
    const handler = handlers.get(job.kind)
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}"`)
      const result = await handler(job.payload, { id: job.id, attempts: job.attempts, workspaceId: job.workspaceId, createdBy: job.createdBy })
      await db.query(`update jobs set status = 'done', result = $2, last_error = null, locked_until = null, finished_at = now() where id = $1`,
        [job.id, JSON.stringify(result ?? null)])
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 2000)
      const final = job.attempts >= job.maxAttempts
      log?.warn({ job: job.id, kind: job.kind, attempt: job.attempts, final }, `job failed: ${message}`)
      await db.query(
        `update jobs set status = $2, last_error = $3, locked_until = null, run_at = now() + make_interval(secs => $4), finished_at = case when $2 = 'failed' then now() end where id = $1`,
        [job.id, final ? 'failed' : 'queued', message, backoffMs(job.attempts) / 1000])
    }
  }
  return ran
}

/** Starts due jobs now rather than at the next poll (after queueing work someone is waiting for). Off when polling is off. */
export function kickJobs(log?: FastifyBaseLogger) {
  if (!(Number(process.env.JOBS_POLL_MS ?? 5000) > 0)) return
  setImmediate(() => { runJobs(20, log).catch(e => log?.error(e)) })
}

/** Polls for due jobs every JOBS_POLL_MS (default 5 s; 0 = off, e.g. in tests that call runJobs themselves). */
export function startJobWorker(log: FastifyBaseLogger) {
  const every = Number(process.env.JOBS_POLL_MS ?? 5000)
  if (!(every > 0)) return () => {}
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    runJobs(20, log).catch(e => log.error(e)).finally(() => { busy = false })
  }, every)
  timer.unref()
  return () => clearInterval(timer)
}
