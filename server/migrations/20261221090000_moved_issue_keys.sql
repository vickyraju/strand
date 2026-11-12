-- Moving work between projects (spec 0501): each key an item had before a move keeps meaning that item, as in Jira.
create table moved_issue_keys (
  workspace_id uuid not null references workspaces on delete cascade,
  project_id   uuid not null references projects on delete cascade,
  number       integer not null,
  issue_id     uuid not null references issues on delete cascade,
  moved_by     uuid references users on delete set null,
  moved_at     timestamptz not null default now(),
  primary key (project_id, number)
);
create index on moved_issue_keys (issue_id);
alter table moved_issue_keys enable row level security;
