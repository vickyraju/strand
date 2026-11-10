-- Spec 0705: outgoing webhooks, as Jira's (Administration › Webhooks), with their recent calls
create table webhooks (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null check (length(name) between 1 and 100),
  description  text not null default '' check (length(description) <= 1000),
  url          text not null check (length(url) <= 2000),
  events       text[] not null default '{}',              -- Jira's webhookEvent names; empty: every event
  jql          text,                                       -- limits issue-related events to matching items
  exclude_body boolean not null default false,
  enabled      boolean not null default true,
  secret_enc   bytea not null,                             -- the signing secret, encrypted (STRAND_SECRET_KEY) and bound to this row
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on webhooks (workspace_id) where enabled;
alter table webhooks enable row level security;

create table webhook_calls (
  id          uuid primary key default uuid_v7(),
  webhook_id  uuid not null references webhooks on delete cascade,
  event       text not null,
  delivery_id uuid not null,
  url         text not null,                               -- with its variables filled in
  body        jsonb,                                       -- null with Exclude body
  state       text not null default 'queued' check (state in ('queued', 'retrying', 'delivered', 'failed')),
  attempts    int not null default 0,
  status_code int,
  error       text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index on webhook_calls (webhook_id, created_at desc);
alter table webhook_calls enable row level security;
