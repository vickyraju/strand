-- Global custom fields with contexts (spec 0503), as Jira's: a field belongs to the workspace; its contexts say where it
-- applies (some projects, or global) and for which work types, each with its own options and default value. A project is
-- in at most one context of a field; its own context wins over the global one. field_defs becomes a view of the fields
-- each project has, so everything that read a project's fields keeps working.
create table custom_fields (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('text', 'textarea', 'readonly', 'number', 'date', 'datetime', 'url',
                 'select', 'radio', 'multiselect', 'checkboxes', 'cascading', 'labels', 'user', 'users', 'group', 'groups', 'project', 'version', 'versions')),
  description  text not null default '',
  position     integer not null default 0,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now()
);
create index on custom_fields (workspace_id, lower(name));
alter table custom_fields enable row level security;

create table field_contexts (
  id            uuid primary key default uuid_v7(),
  field_id      uuid not null references custom_fields on delete cascade,
  name          text not null,
  description   text not null default '',
  project_ids   uuid[],                 -- null: global (every project without a context of its own)
  type_keys     text[],                 -- null: every work type
  options       jsonb,
  default_value jsonb
);
create unique index field_contexts_one_global on field_contexts (field_id) where project_ids is null;
create index on field_contexts (field_id);
create index on field_contexts using gin (project_ids);
alter table field_contexts enable row level security;

-- each project's field becomes a field with a context for that project (R7)
insert into custom_fields (id, workspace_id, name, kind, position)
  select f.id, p.workspace_id, f.name, f.kind, f.position from field_defs f join projects p on p.id = f.project_id;
insert into field_contexts (field_id, name, project_ids, options)
  select f.id, 'Default context for ' || f.name, array[f.project_id], f.options from field_defs f;
drop table field_defs;

create view field_defs as
  select f.id, p.id as project_id, f.name, f.kind, c.options, f.position, f.description, c.type_keys, c.default_value, c.id as context_id,
         (c.project_ids is null or cardinality(c.project_ids) > 1) as shared
    from custom_fields f
    join field_contexts c on c.field_id = f.id
    join projects p on p.workspace_id = f.workspace_id
   where (c.project_ids is not null and p.id = any(c.project_ids))
      or (c.project_ids is null and not exists (select 1 from field_contexts o where o.field_id = f.id and o.project_ids is not null and p.id = any(o.project_ids)));

-- a deleted project leaves the contexts it was in; a field it alone used goes with it (R8)
create function field_contexts_forget_project() returns trigger language plpgsql as $$
begin
  update field_contexts set project_ids = array_remove(project_ids, old.id) where old.id = any(project_ids);
  delete from field_contexts where project_ids = '{}';
  delete from custom_fields f where f.workspace_id = old.workspace_id and not exists (select 1 from field_contexts c where c.field_id = f.id);
  return old;
end $$;
create trigger projects_forget_field_contexts after delete on projects for each row execute function field_contexts_forget_project();
