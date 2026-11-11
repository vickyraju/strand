-- Spec 0803: planning across projects. Initiatives are a built-in work type a project turns on; an epic joins one through
-- its Parent Link (Jira's field, apart from the parent); plans are timelines over some projects or a saved view.
alter table work_types drop constraint work_types_key_check;
alter table work_types add constraint work_types_key_check
  check (key in ('epic', 'story', 'task', 'bug', 'initiative', 'test', 'precondition', 'test_set', 'test_plan', 'test_execution') or key ~ '^t-[a-z0-9]{6,32}$');
alter table projects add column initiatives boolean not null default false;
create function seed_initiative_type(pid uuid) returns void language sql as $$
  insert into work_types (project_id, key, name, color, icon, position) values (pid, 'initiative', 'Initiative', '#EA580C', 'flag', -1) on conflict do nothing
$$;

alter table issues add column parent_link_id uuid references issues on delete set null;
create index on issues (parent_link_id) where parent_link_id is not null;

-- history names a Parent Link like a parent (spec 0601)
create or replace function activity_name(f text, v text, issue uuid) returns text language sql stable as $$
  select case
    when v is null then null
    when f = 'resolution' then v
    when f = 'priority' then (select pr.name from priorities pr join projects p on p.workspace_id = pr.workspace_id join issues i on i.project_id = p.id where i.id = issue and pr.key = v)
    when f = 'type' then (select t.name from work_types t join issues i on i.project_id = t.project_id where i.id = issue and t.key = v)
    when v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then null
    when f = 'statusId' then (select name from statuses where id = v::uuid)
    when f in ('assigneeId', 'reporterId') then (select name from users where id = v::uuid)
    when f in ('fixReleaseIds', 'affectsReleaseIds') then (select name from releases where id = v::uuid)
    when f = 'componentIds' then (select name from components where id = v::uuid)
    when f = 'sprintId' then (select name from sprints where id = v::uuid)
    when f in ('parentId', 'parentLinkId') then (select p.key || '-' || i.number from issues i join projects p on p.id = i.project_id where i.id = v::uuid)
  end
$$;

create table plans (
  id                uuid primary key default uuid_v7(),
  workspace_id      uuid not null references workspaces on delete cascade,
  name              text not null,
  owner_id          uuid not null references users on delete cascade,
  project_ids       uuid[],                     -- the source: these projects…
  view_id           uuid references saved_views on delete set null,   -- …or a saved view
  done_days         integer not null default 30 check (done_days between 0 and 3650),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index plans_name on plans (workspace_id, lower(name));
alter table plans enable row level security;
