-- Spec 0703: a project's key can change (its old keys keep finding it, and no other project can take them), projects
-- have a category, and an avatar.
create table project_key_history (
  workspace_id uuid not null references workspaces on delete cascade,
  key          text not null,
  project_id   uuid not null references projects on delete cascade,   -- deleting the project frees its old keys (Jira's rule)
  changed_at   timestamptz not null default now(),
  changed_by   uuid references users on delete set null,
  primary key (workspace_id, key)
);
create index on project_key_history (project_id);
alter table project_key_history enable row level security;

-- the key follows System settings › Project keys (spec 0309); the column only keeps it well formed
alter table projects drop constraint if exists projects_key_check;
alter table projects add constraint projects_key_check check (key ~ '^[A-Z][A-Z0-9_]{1,254}$');

create table project_categories (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null check (length(name) between 1 and 100),
  description  text not null default '' check (length(description) <= 1000),
  created_at   timestamptz not null default now()
);
create unique index project_categories_name on project_categories (workspace_id, lower(name));
alter table project_categories enable row level security;

alter table projects add column category_id uuid references project_categories on delete set null;
alter table projects add column avatar bytea check (octet_length(avatar) <= 131072);
alter table projects add column avatar_type text check (avatar_type in ('image/png', 'image/jpeg', 'image/webp'));
alter table projects add column avatar_hash text;                  -- the image's sha256: its public address (spec 0703 R8)
create index on projects (category_id);
