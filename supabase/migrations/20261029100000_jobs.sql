-- Background jobs (exports, backups, large imports): stored in the database so they survive restarts, shared by every
-- API pod (a job is claimed with skip-locked, so only one pod runs it), retried with growing waits, and visible.
-- A job runs at least once: if a pod dies mid-job, the job is picked up again when its lock runs out.
create table jobs (
  id           uuid primary key default uuid_v7(),
  kind         text not null,
  payload      jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  dedupe_key   text,
  run_at       timestamptz not null default now(),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  locked_until timestamptz,
  last_error   text,
  result       jsonb,
  workspace_id uuid references workspaces on delete cascade,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index jobs_due on jobs (run_at) where status in ('queued', 'running');
-- the same piece of work is not queued twice while one is waiting or running
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
alter table jobs enable row level security;
