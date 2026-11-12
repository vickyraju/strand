-- Screens (spec 0505), as Jira's: a screen lists fields on tabs; a screen scheme gives Create, Edit and View a screen; an
-- issue type screen scheme gives each work type a screen scheme; a project uses one. The Default Screen (tabs null) shows
-- every field, new ones too, until an admin gives it tabs.
create table screens (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  tabs         jsonb,                       -- [{ name, fields: [field key…] }]; null: every field
  is_default   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index screens_one_default on screens (workspace_id) where is_default;
create unique index screens_name on screens (workspace_id, lower(name));
alter table screens enable row level security;

create table screen_schemes (
  id                uuid primary key default uuid_v7(),
  workspace_id      uuid not null references workspaces on delete cascade,
  name              text not null,
  description       text not null default '',
  default_screen_id uuid not null references screens,
  create_screen_id  uuid references screens,
  edit_screen_id    uuid references screens,
  view_screen_id    uuid references screens,
  is_default        boolean not null default false,
  created_at        timestamptz not null default now()
);
create unique index screen_schemes_one_default on screen_schemes (workspace_id) where is_default;
create unique index screen_schemes_name on screen_schemes (workspace_id, lower(name));
alter table screen_schemes enable row level security;

create table issue_type_screen_schemes (
  id                uuid primary key default uuid_v7(),
  workspace_id      uuid not null references workspaces on delete cascade,
  name              text not null,
  description       text not null default '',
  default_scheme_id uuid not null references screen_schemes,
  mappings          jsonb not null default '{}',   -- work type key → screen scheme id
  created_at        timestamptz not null default now()
);
create unique index issue_type_screen_schemes_name on issue_type_screen_schemes (workspace_id, lower(name));
alter table issue_type_screen_schemes enable row level security;

alter table projects add column issue_type_screen_scheme_id uuid references issue_type_screen_schemes on delete set null;

insert into screens (workspace_id, name, description, is_default)
  select id, 'Default Screen', 'Every field, until it is given tabs', true from workspaces;
insert into screen_schemes (workspace_id, name, description, default_screen_id, is_default)
  select s.workspace_id, 'Default Screen Scheme', 'The Default Screen for every operation', s.id, true from screens s where s.is_default;
