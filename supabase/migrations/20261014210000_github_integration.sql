-- Source-control integration (GitHub first): installations, repositories, commits/branches/PRs/builds
-- linked to issues, webhook delivery log, and GitHub-login → user mapping.
-- Plain Postgres; RLS on with no policies (the API is the only reader), like every other table.

create table integrations (
  id              uuid primary key default uuid_v7(),
  workspace_id    uuid not null references workspaces on delete cascade,
  provider        text not null check (provider in ('github')),
  installation_id bigint not null,                 -- the provider's installation id
  account_login   text not null,                   -- GitHub org/user the app is installed on
  status          text not null default 'active' check (status in ('active', 'suspended')),
  settings        jsonb not null default '{}',
  backfill        jsonb not null default '{}',     -- progress of the initial history import
  created_by      uuid references users on delete set null,
  created_at      timestamptz not null default now(),
  unique (provider, installation_id)
);
create index on integrations (workspace_id);

create table repositories (
  id             uuid primary key default uuid_v7(),
  integration_id uuid not null references integrations on delete cascade,
  external_id    text not null,
  full_name      text not null,                    -- owner/name
  default_branch text not null default 'main',
  project_ids    uuid[] not null default '{}',     -- empty = link to any project key; otherwise only these
  unique (integration_id, external_id)
);

-- One row per commit / branch / pull request / build / deployment. Upserted by webhook handlers;
-- an update is applied only if source_updated_at is newer, so redelivery and reordering are harmless.
create table dev_entities (
  id                uuid primary key default uuid_v7(),
  workspace_id      uuid not null references workspaces on delete cascade,
  repo_id           uuid not null references repositories on delete cascade,
  kind              text not null check (kind in ('commit', 'branch', 'pull_request', 'build', 'deployment')),
  external_id       text not null,                 -- sha, branch name, PR number, run id…
  url               text,
  title             text not null default '',
  state             text,                          -- PR: open|merged|closed; build/deploy: its status
  author            jsonb,                         -- {login, name, avatarUrl}; emails are never stored
  branch_from       text,
  branch_to         text,
  review_state      text,                          -- approved | changes_requested | review_required
  checks_state      text,                          -- pending | success | failure
  payload           jsonb not null default '{}',
  source_updated_at timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (repo_id, kind, external_id)
);
create index on dev_entities (repo_id, kind, source_updated_at desc);

create table dev_links (
  issue_id  uuid not null references issues on delete cascade,
  entity_id uuid not null references dev_entities on delete cascade,
  via       text not null check (via in ('branch', 'title', 'body', 'commit')),
  closing   boolean not null default false,        -- linked with a closing word (fixes/closes/resolves…)
  primary key (issue_id, entity_id)
);
create index on dev_links (entity_id);

-- Delivery log: dedupes redelivered webhooks and powers an admin "recent deliveries" view
create table webhook_deliveries (
  delivery_id text primary key,
  provider    text not null,
  event       text not null,
  status      text not null default 'received' check (status in ('received', 'processed', 'failed')),
  error       text,
  received_at timestamptz not null default now()
);
create index on webhook_deliveries (received_at desc);

-- GitHub login → Strand user (attribution and smart commits)
create table user_identities (
  user_id        uuid not null references users on delete cascade,
  provider       text not null,
  external_login text not null,
  primary key (user_id, provider)
);
create unique index on user_identities (provider, lower(external_login));

alter table integrations       enable row level security;
alter table repositories       enable row level security;
alter table dev_entities       enable row level security;
alter table dev_links          enable row level security;
alter table webhook_deliveries enable row level security;
alter table user_identities    enable row level security;
