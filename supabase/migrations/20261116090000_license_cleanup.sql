-- License cleanup (what resolution's User Deactivator / License Optimizer adds to Jira): find people who haven't used Strand
-- for a while and, by an admin's rule, take them out of users-access (they rejoin at their next sign-in), out of chosen
-- groups, or deactivate them; warn them by email first; report to admins. Every run is kept.
alter table users add column last_active_at timestamptz;              -- any request, written at most once an hour
alter table users add column cleanup_warned_at timestamptz;           -- warned of a coming cleanup (cleared when they're active again)
create index on users (last_active_at);

create table license_cleanup_runs (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  trigger      text not null check (trigger in ('schedule', 'manual')),
  action       text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  changed      jsonb not null default '[]',      -- [{ userId, email, name, lastActiveAt }]
  warned       jsonb not null default '[]',
  notes        text not null default '',
  started_by   uuid references users on delete set null
);
create index on license_cleanup_runs (workspace_id, started_at desc);
alter table license_cleanup_runs enable row level security;
