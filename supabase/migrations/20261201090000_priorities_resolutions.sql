-- Spec 0305: priorities and resolutions are lists an administrator edits, per workspace, as in Jira. Today's values keep
-- their keys and names, so no item changes. New work gets the default priority (Medium, as Jira ships it).
create table priorities (
  workspace_id uuid not null references workspaces on delete cascade,
  key          text not null check (key in ('urgent', 'high', 'medium', 'low', 'none') or key ~ '^p-[a-z0-9]{6,32}$'),
  name         text not null,
  description  text not null default '',
  color        text not null,
  icon         text not null,
  position     integer not null default 0,
  is_default   boolean not null default false,
  primary key (workspace_id, key)
);
create unique index priorities_name_unique on priorities (workspace_id, lower(trim(name)));
create unique index priorities_one_default on priorities (workspace_id) where is_default;
alter table priorities enable row level security;

create table resolutions (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  position     integer not null default 0,
  is_default   boolean not null default false
);
create unique index resolutions_name_unique on resolutions (workspace_id, lower(trim(name)));
create unique index resolutions_one_default on resolutions (workspace_id) where is_default;
alter table resolutions enable row level security;

create function seed_priorities_resolutions(ws uuid) returns void language sql as $$
  insert into priorities (workspace_id, key, name, color, icon, position, is_default) values
    (ws, 'urgent', 'Urgent', '#DC2626', 'chevrons-up', 0, false), (ws, 'high', 'High', '#EA580C', 'chevron-up', 1, false),
    (ws, 'medium', 'Medium', '#D97706', 'equal', 2, true), (ws, 'low', 'Low', '#2563EB', 'chevron-down', 3, false),
    (ws, 'none', 'No priority', '#A8A29E', 'minus', 4, false)
  on conflict do nothing;
  insert into resolutions (workspace_id, name, description, position, is_default)
  select ws, n, d, p, p = 0 from (values ('Done', 'Work on it is complete', 0), ('Won''t do', 'It won''t be worked on', 1),
    ('Duplicate', 'It repeats another work item', 2), ('Cannot reproduce', 'The problem could not be seen again', 3)) v(n, d, p)
  where not exists (select 1 from resolutions where workspace_id = ws);
$$;
select seed_priorities_resolutions(id) from workspaces;
create function workspaces_seed_priorities_resolutions() returns trigger language plpgsql as $$
begin perform seed_priorities_resolutions(new.id); return new; end $$;
create trigger workspaces_seed_priorities_resolutions after insert on workspaces for each row execute function workspaces_seed_priorities_resolutions();

-- Items and templates may hold any priority of the list, any resolution of the list (the API checks them)
alter table issues drop constraint issues_priority_check;
alter table issues alter column priority set default 'medium';
alter table item_templates drop constraint item_templates_priority_check;
alter table issues drop constraint issues_resolution_check;

-- Each workflow says how its items get a resolution: on reaching Done (Jira Software's simplified workflows), or only
-- by its transitions' rules (Jira's classic workflows). Leaving Done clears it either way.
alter table workflows add column resolution_on_done boolean not null default true;

create or replace function track_resolution() returns trigger language plpgsql as $$
declare done_now boolean; done_before boolean := false; auto boolean;
begin
  select category = 'done' into done_now from statuses where id = new.status_id;
  if tg_op = 'UPDATE' then select category = 'done' into done_before from statuses where id = old.status_id; end if;
  if not coalesce(done_now, false) then
    new.resolved_at := null; new.resolution := null;
    return new;
  end if;
  -- the workflow this item's type uses in its project's scheme
  select w.resolution_on_done into auto from projects p join workflow_schemes s on s.id = p.workflow_scheme_id
    join workflows w on w.id = coalesce((s.mappings ->> new.type)::uuid, s.default_workflow_id) where p.id = new.project_id;
  -- resolving on its own: the one chosen, else the one it had while Done, else the list's default
  if coalesce(auto, true) and new.resolution is null then
    new.resolution := coalesce(case when tg_op = 'UPDATE' and coalesce(done_before, false) then old.resolution end,
      (select name from resolutions where workspace_id = new.workspace_id and is_default), 'Done');
  end if;
  if new.resolution is null then new.resolved_at := null;
  elsif tg_op = 'INSERT' then new.resolved_at := coalesce(new.resolved_at, now());
  elsif old.resolution is null or not coalesce(done_before, false) then new.resolved_at := now();
  else new.resolved_at := coalesce(old.resolved_at, now());
  end if;
  return new;
end $$;
