-- Core schema: workspaces, users, memberships, projects, workflow, issues.
-- Plain Postgres only (no Supabase-specific objects) so it moves to Aurora unchanged.
-- Access control lives in the API, which connects with a privileged role.
-- RLS is enabled with no policies, so anon/authenticated roles see nothing.

-- Time-ordered UUIDs (Postgres 17 has no native uuidv7)
create function uuid_v7() returns uuid language sql volatile as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid()) placing
        substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

create extension if not exists pg_trgm;

create table workspaces (
  id         uuid primary key default uuid_v7(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table users (
  id         uuid primary key default uuid_v7(),
  entra_oid  uuid unique,                       -- Microsoft Entra object id
  email      text not null unique,
  name       text not null,
  initials   text not null,
  color      text not null default '#6366f1',
  title      text,
  active     boolean not null default true,     -- SCIM deprovisioning flips this
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id      uuid not null references users on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (workspace_id, user_id)
);
create index on memberships (user_id);

create table projects (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  key          text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text not null,
  description  text not null default '',
  color        text not null default '#6366f1',
  template     text not null check (template in ('kanban', 'scrum')),
  lead_id      uuid references users on delete set null,
  next_number  integer not null default 1,      -- issue key allocator
  board_prefs  jsonb not null default '{}',
  layout       jsonb not null default '{}',
  sample       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (workspace_id, key)
);

create table statuses (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  name       text not null,
  color      text not null,
  category   text not null check (category in ('todo', 'in-progress', 'done')),
  wip_limit  integer check (wip_limit > 0),
  position   integer not null
);
create index on statuses (project_id, position);

create table transitions (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  name       text not null,
  from_ids   uuid[],                            -- null = from any status
  to_id      uuid not null references statuses on delete cascade
);
create index on transitions (project_id);

create table issues (
  id            uuid primary key default uuid_v7(),
  workspace_id  uuid not null references workspaces on delete cascade,
  project_id    uuid not null references projects on delete cascade,
  number        integer not null,
  type          text not null default 'task' check (type in ('epic', 'story', 'task', 'bug')),
  title         text not null,
  description   text not null default '',
  status_id     uuid not null references statuses,
  priority      text not null default 'none' check (priority in ('urgent', 'high', 'medium', 'low', 'none')),
  assignee_id   uuid references users on delete set null,
  reporter_id   uuid references users on delete set null,
  labels        text[] not null default '{}',
  estimate      numeric,
  time_estimate integer,                        -- minutes
  due_date      date,
  start_date    date,
  parent_id     uuid references issues on delete set null,
  custom        jsonb not null default '{}',
  rank          double precision not null,      -- fractional; a move touches one row
  version       integer not null default 1,     -- optimistic concurrency
  deleted_at    timestamptz,                    -- soft delete backs Undo
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, number)
);
-- Sprint/release FKs are added with those tables in the next migration.
alter table issues add column sprint_id  uuid;
alter table issues add column release_id uuid;

create index on issues (project_id, status_id, rank) where deleted_at is null;
create index on issues (project_id, updated_at desc) where deleted_at is null;
create index on issues (assignee_id, updated_at desc) where deleted_at is null;
create index on issues (parent_id) where parent_id is not null;
create index on issues (sprint_id) where sprint_id is not null;
create index on issues (release_id) where release_id is not null;
create index on issues using gin (title gin_trgm_ops);

create table issue_links (
  issue_id  uuid not null references issues on delete cascade,
  target_id uuid not null references issues on delete cascade,
  type      text not null check (type in ('blocks', 'relates')),
  primary key (issue_id, target_id, type)
);
create index on issue_links (target_id);

create table issue_watchers (
  issue_id uuid not null references issues on delete cascade,
  user_id  uuid not null references users on delete cascade,
  primary key (issue_id, user_id)
);

-- Soft edit presence (Jira/monday.com style): who has this issue open for editing right now.
-- The app heartbeats every 30 s; rows older than 90 s are pruned lazily and read as gone.
create table issue_editors (
  issue_id       uuid not null references issues on delete cascade,
  user_id        uuid not null references users on delete cascade,
  last_heartbeat timestamptz not null default now(),
  primary key (issue_id, user_id)
);

-- Allocate the next issue key number atomically (call inside the insert transaction)
create function next_issue_number(p_project uuid) returns integer language sql as $$
  update projects set next_number = next_number + 1 where id = p_project returning next_number - 1
$$;

-- Deny-by-default for Supabase's anon/authenticated roles; the API uses a privileged role.
alter table workspaces    enable row level security;
alter table users         enable row level security;
alter table memberships   enable row level security;
alter table projects      enable row level security;
alter table statuses      enable row level security;
alter table transitions   enable row level security;
alter table issues        enable row level security;
alter table issue_links   enable row level security;
alter table issue_watchers enable row level security;
alter table issue_editors  enable row level security;
