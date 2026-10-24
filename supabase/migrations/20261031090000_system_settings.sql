-- System settings: policies an administrator sets at runtime (rate limiting, attachments, access tokens, export and
-- bulk sizes, due reminders, project backups). One row per workspace and setting; the value holds what the admin
-- saved, and the API fills in defaults for anything not saved.
create table system_settings (
  workspace_id uuid not null references workspaces on delete cascade,
  key          text not null,
  value        jsonb not null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users on delete set null,
  primary key (workspace_id, key)
);
alter table system_settings enable row level security;

-- the project-backup setting moves here
insert into system_settings (workspace_id, key, value, updated_at, updated_by)
  select workspace_id, 'projectBackups', project_backups, updated_at, updated_by from workspace_settings;
drop table workspace_settings;

-- Rate limiting: who was refused, and when (Administration › System settings › Rate limiting › Limited accounts).
-- `times` counts minutes in which the person was refused at least once, not single requests.
create table rate_limited_accounts (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id      uuid not null references users on delete cascade,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  times        int not null default 1,
  primary key (workspace_id, user_id)
);
alter table rate_limited_accounts enable row level security;
