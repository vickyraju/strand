-- Automation's audit log (Jira's): every time a rule runs, what started it, the item, what each action did, and how it
-- ended. Kept 90 days. A rule has an owner (who made it) who hears when it fails.
create table rule_runs (
  id         uuid primary key default uuid_v7(),
  rule_id    uuid not null references rules on delete cascade,
  project_id uuid not null references projects on delete cascade,
  issue_id   uuid references issues on delete set null,
  trigger    jsonb not null,
  result     text not null check (result in ('success', 'some_skipped', 'no_change', 'failed')),
  steps      jsonb not null default '[]',               -- [{ action, outcome: done | skipped | unchanged | failed, note? }]
  error      text,
  at         timestamptz not null default now()
);
create index on rule_runs (rule_id, at desc);
create index on rule_runs (project_id, at desc);
alter table rule_runs enable row level security;

alter table rules add column owner_id uuid references users on delete set null;
alter table rules add column failures integer not null default 0;

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('assigned', 'mentioned', 'commented', 'status', 'due', 'automation'));
