-- Everything else from reducer v4: sprints, releases, fields, templates, rules,
-- comments, activity, notifications, work logs, attachments, views, dashboards, stars.

create table sprints (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  project_id   uuid not null references projects on delete cascade,
  name         text not null,
  goal         text not null default '',
  state        text not null default 'planned' check (state in ('planned', 'active', 'closed')),
  started_at   timestamptz,
  ends_at      timestamptz,
  completed_at timestamptz,
  committed    numeric,                         -- points snapshot at start
  completed    numeric,                         -- points snapshot at completion
  issue_ids    uuid[],                          -- membership snapshot at completion
  created_at   timestamptz not null default now()
);
create index on sprints (project_id, state);
-- one active sprint per project
create unique index on sprints (project_id) where state = 'active';

create table releases (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  project_id   uuid not null references projects on delete cascade,
  name         text not null,
  description  text not null default '',
  start_date   date,
  release_date date,
  released     boolean not null default false,
  released_at  timestamptz
);
create index on releases (project_id);

alter table issues add foreign key (sprint_id)  references sprints  on delete set null;
alter table issues add foreign key (release_id) references releases on delete set null;

create table field_defs (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('text', 'number', 'select', 'date')),
  options    text[],
  position   integer not null default 0
);
create index on field_defs (project_id, position);

create table item_templates (
  id          uuid primary key default uuid_v7(),
  project_id  uuid not null references projects on delete cascade,
  name        text not null,
  type        text not null check (type in ('epic', 'story', 'task', 'bug')),
  title       text not null,
  description text not null default '',
  priority    text not null default 'none' check (priority in ('urgent', 'high', 'medium', 'low', 'none')),
  labels      text[] not null default '{}',
  estimate    numeric
);
create index on item_templates (project_id);

create table rules (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  name       text not null,
  enabled    boolean not null default true,
  trigger    jsonb not null,                    -- {kind: created|status|assigned, to?}
  actions    jsonb not null,                    -- [{kind, ...}]
  runs       integer not null default 0
);
create index on rules (project_id) where enabled;

create table comments (
  id         uuid primary key default uuid_v7(),
  issue_id   uuid not null references issues on delete cascade,
  author_id  uuid references users on delete set null,
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);
create index on comments (issue_id, created_at);

-- actor_id null = automation
create table activity (
  id         uuid primary key default uuid_v7(),
  issue_id   uuid not null references issues on delete cascade,
  actor_id   uuid references users on delete set null,
  field      text,
  from_value text,
  to_value   text,
  text       text not null,
  created_at timestamptz not null default now()
);
create index on activity (issue_id, created_at);

create table notifications (
  id         uuid primary key default uuid_v7(),
  user_id    uuid not null references users on delete cascade,
  actor_id   uuid references users on delete set null,
  issue_id   uuid not null references issues on delete cascade,
  kind       text not null check (kind in ('assigned', 'mentioned', 'commented', 'status', 'due')),
  text       text not null,
  read       boolean not null default false,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, created_at desc) where not archived;
create index on notifications (user_id) where not read and not archived;

create table worklogs (
  id         uuid primary key default uuid_v7(),
  issue_id   uuid not null references issues on delete cascade,
  user_id    uuid references users on delete set null,
  minutes    integer not null check (minutes > 0),
  date       date not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index on worklogs (issue_id);

create table attachments (
  id         uuid primary key default uuid_v7(),
  issue_id   uuid not null references issues on delete cascade,
  name       text not null,
  size       bigint not null,
  type       text not null,
  object_key text not null,                     -- S3 key
  added_by   uuid references users on delete set null,
  added_at   timestamptz not null default now()
);
create index on attachments (issue_id);

create table saved_views (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  owner_id     uuid not null references users on delete cascade,
  name         text not null,
  shared       boolean not null default false,
  filters      jsonb not null
);
create index on saved_views (workspace_id, owner_id);

create table dashboards (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  owner_id     uuid not null references users on delete cascade,
  name         text not null,
  gadgets      jsonb not null default '[]'
);
create index on dashboards (workspace_id, owner_id);

create table stars (
  user_id    uuid not null references users on delete cascade,
  project_id uuid not null references projects on delete cascade,
  primary key (user_id, project_id)
);

-- Full-text search on issues (title + description)
alter table issues add column search tsvector
  generated always as (to_tsvector('simple', title || ' ' || description)) stored;
create index on issues using gin (search);

alter table sprints         enable row level security;
alter table releases        enable row level security;
alter table field_defs      enable row level security;
alter table item_templates  enable row level security;
alter table rules           enable row level security;
alter table comments        enable row level security;
alter table activity        enable row level security;
alter table notifications   enable row level security;
alter table worklogs        enable row level security;
alter table attachments     enable row level security;
alter table saved_views     enable row level security;
alter table dashboards      enable row level security;
alter table stars           enable row level security;
