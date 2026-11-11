-- Field configurations (spec 0504), as Jira's: per field a description, hidden, required; a scheme maps work types to
-- configurations; a project uses one scheme (none: the Default Field Configuration, which hides and requires nothing).
create table field_configurations (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  items        jsonb not null default '{}',     -- field key (assigneeId, custom.<id>…) → { description?, hidden?, required? }
  is_default   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index field_configurations_one_default on field_configurations (workspace_id) where is_default;
create unique index field_configurations_name on field_configurations (workspace_id, lower(name));
alter table field_configurations enable row level security;

create table field_config_schemes (
  id                uuid primary key default uuid_v7(),
  workspace_id      uuid not null references workspaces on delete cascade,
  name              text not null,
  description       text not null default '',
  default_config_id uuid not null references field_configurations,
  mappings          jsonb not null default '{}',   -- work type key → field configuration id
  created_at        timestamptz not null default now()
);
create unique index field_config_schemes_name on field_config_schemes (workspace_id, lower(name));
alter table field_config_schemes enable row level security;

alter table projects add column field_config_scheme_id uuid references field_config_schemes on delete set null;

insert into field_configurations (workspace_id, name, description, is_default)
  select id, 'Default Field Configuration', 'Used by every project without a field configuration scheme', true from workspaces;
