-- Components (Jira's): parts of a project, each with a lead and who new work in it goes to. An item can be in several.
-- And Affects versions: the releases a problem was found in (several), next to the release that fixes it (release_id).
create table components (
  id               uuid primary key default uuid_v7(),
  project_id       uuid not null references projects on delete cascade,
  name             text not null,
  description      text not null default '',
  lead_id          uuid references users on delete set null,
  default_assignee text not null default 'none' check (default_assignee in ('none', 'component_lead', 'project_lead')),
  unique (project_id, name)
);
create index on components (project_id);
alter table components enable row level security;

alter table issues add column component_ids uuid[] not null default '{}';
alter table issues add column affects_release_ids uuid[] not null default '{}';
create index on issues using gin (component_ids) where deleted_at is null;
