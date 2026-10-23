-- Deleting a project first backs it up (everything: items, history, comments, work logs, links, attachments and their
-- files, settings, people) to S3, then deletes it. Whether, and where, is a workspace setting for global admins.
-- While the backup runs the project is "being deleted": hidden from everyone and closed to changes.
alter table projects add column deleting_at timestamptz;

create table workspace_settings (
  workspace_id    uuid primary key references workspaces on delete cascade,
  project_backups jsonb not null default '{"enabled": true}',   -- { enabled, bucket?, prefix? }
  updated_at      timestamptz not null default now(),
  updated_by      uuid references users on delete set null
);
alter table workspace_settings enable row level security;

-- One row per backup taken. Plain ids and names (no foreign keys): the project is gone by design.
create table project_backups (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  project_id   uuid not null,
  project_key  text not null,
  project_name text not null,
  bucket       text not null,
  object_key   text not null,       -- the backup document; its files sit next to it under files/
  items        int not null,
  files        int not null,
  bytes        bigint not null,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  restored_at  timestamptz
);
create index on project_backups (workspace_id, created_at desc);
alter table project_backups enable row level security;
