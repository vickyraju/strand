-- Work types per project (Jira's issue types). Every project has the four built-in ones (epic, story, task, bug: Epic is
-- the parent level, Task the default), which can be renamed and recoloured but not removed, and may add its own.
-- `key` is what an item's `type` holds: the built-in name, or "t-…" for a type the project added.
create table work_types (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  key        text not null check (key in ('epic', 'story', 'task', 'bug') or key ~ '^t-[a-z0-9]{6,32}$'),
  name       text not null,
  color      text not null,
  icon       text not null,
  position   integer not null default 0,
  unique (project_id, key)
);
create function seed_work_types(pid uuid) returns void language sql as $$
  insert into work_types (project_id, key, name, color, icon, position) values
    (pid, 'epic', 'Epic', '#7C3AED', 'zap', 0), (pid, 'story', 'Story', '#16A34A', 'bookmark', 1),
    (pid, 'task', 'Task', '#2563EB', 'check', 2), (pid, 'bug', 'Bug', '#DC2626', 'bug', 3)
  on conflict do nothing
$$;
select seed_work_types(id) from projects;
-- A new project gets them too (a restored one brings its own rows; "on conflict do nothing" keeps those)
create function projects_seed_work_types() returns trigger language plpgsql as $$
begin perform seed_work_types(new.id); return new; end $$;
create trigger projects_seed_work_types after insert on projects for each row execute function projects_seed_work_types();
alter table work_types enable row level security;

-- An item's type and a template's type: a key of the project's work types (the API checks it)
alter table issues drop constraint issues_type_check;
alter table item_templates drop constraint item_templates_type_check;

-- Which work types a transition is for (Jira's workflow per work type). Null: every type.
alter table transitions add column type_keys text[];
