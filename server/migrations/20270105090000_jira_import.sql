-- Spec 0802: importing from a Jira Data Center. Each run (a dry run or an import) is a row with its report; what was
-- imported is remembered (Jira's id → the app's), so a run can be repeated and resumed; links whose other item isn't
-- imported yet wait until it is.
create table jira_imports (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  url          text not null,
  token_enc    bytea not null,                -- sealed to this row (secrets.ts)
  project_keys text[] not null,
  dry_run      boolean not null,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  report       jsonb,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index on jira_imports (workspace_id, created_at desc);
alter table jira_imports enable row level security;

create table jira_import_map (
  workspace_id uuid not null references workspaces on delete cascade,
  kind         text not null,                 -- project, status, user, version, component, sprint, issue, comment, worklog…
  jira_id      text not null,
  local_id    text not null,
  primary key (workspace_id, kind, jira_id)
);
alter table jira_import_map enable row level security;

create table jira_import_links (
  workspace_id uuid not null references workspaces on delete cascade,
  issue_id     uuid not null references issues on delete cascade,
  jira_target  text not null,                 -- the other item's Jira id
  type_id      text not null,
  primary key (issue_id, jira_target, type_id)
);
alter table jira_import_links enable row level security;
