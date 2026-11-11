-- Spec 0604: Jira's filter subscriptions: a saved view emailed on a schedule (Quartz cron, as Jira stores them) to its
-- creator, or to the members of a group, each getting what they may see.
create table filter_subscriptions (
  id               uuid primary key default uuid_v7(),
  workspace_id     uuid not null references workspaces on delete cascade,
  view_id          uuid not null references saved_views on delete cascade,
  created_by       uuid not null references users on delete cascade,
  group_id         uuid references groups on delete cascade,   -- null: just its creator
  cron             text not null,
  email_when_empty boolean not null default false,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index on filter_subscriptions (view_id);
create index on filter_subscriptions (created_by);
alter table filter_subscriptions enable row level security;
