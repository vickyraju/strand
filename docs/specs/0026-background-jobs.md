# 0026 Background jobs

Status: Implemented

## Context and Jira reference

Work too large or slow for one request runs as a background job: for example deleting and restoring projects, CSV and Jira imports, applying workflow changes, directory synchronisation, emails, webhooks, filter subscriptions and mail handlers. Jobs are kept in the database, so they survive a restart, and every API server takes part in running them.

- **Jira DC:** long tasks run in the background with a progress page, and a cluster's scheduled jobs run on one node at a time. The app follows Jira: a job runs on one server at a time, and the person who started it can follow it.

## Rules

- **R1: Queued with the change.** A job is queued inside the transaction of the change that needs it, so it exists only if the change is saved. It has a kind, a payload, a time to run (now, unless given) and a limit of attempts (5, unless given).
  - With a deduplication key, a job with the same key that is still queued or running is returned instead of queueing a second one.
- **R2: Runs once, on one server.** A worker claims the next due job (oldest `run_at` first) with `for update skip locked`. However many workers run at once, on however many servers, each job runs exactly once.
- **R3: Done.** A job that finishes is marked `done`, with its result kept and the last error cleared.
- **R4: Retried with growing waits.** A job that fails goes back in the queue with its error. Its next try waits 10 seconds after the first failure, then doubles each time (20, 40 seconds…), up to an hour. It isn't run again before then.
- **R5: Gives up after the limit.** A job that has failed as many times as its limit of attempts is marked `failed`.
- **R6: Survives a crashed worker.** A claimed job is held for 5 minutes. If its worker dies, another worker takes it once that time has passed, and the attempt is counted.

## Permissions

- **Follow a job** (`GET /jobs/:id`): the person who started it, and system admins. Anyone else gets 404 "Job not found".
- Who may start each kind of job: the spec of the feature that queues it.

## Data model

- `jobs`: `kind`, `payload`, `status` (`queued`, `running`, `done`, `failed`), `dedupe_key`, `run_at`, `attempts`, `max_attempts`, `locked_until`, `last_error`, `result`, `workspace_id`, `created_by`, `created_at`, `finished_at`. A partial unique index keeps one queued or running job per `dedupe_key`. Migration `20261029100000_jobs.sql`.

## API

- `GET /api/v1/jobs/:id`: the job's status, attempts, last error, result and progress.
- Routes that start a job answer 202 with `{ jobId }`.

## Screens

- None of its own. Screens that start a job (for example an import) follow it through `GET /jobs/:id`.

## Scale

- Each server polls every `JOBS_POLL_MS` (5 seconds; 0 turns polling off) and runs up to 20 due jobs, one at a time. A change someone is waiting for starts the due jobs at once instead of at the next poll.
- Due jobs are found through an index on `run_at` over queued and running jobs.

## Acceptance

| Rule | Test |
|---|---|
| R1–R6 | Server test: jobs run once each (a deduplicated one too), retry with growing waits, give up after the limit, are taken over after a crashed worker, and 40 jobs over 12 runners each run once |

## Out of scope and deliberate divergences

- **An administrator's list of all jobs:** not built; each feature shows its own.
