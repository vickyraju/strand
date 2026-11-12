-- Spec 0309: names Jira keeps unique: projects in a workspace, versions and components in a project, a person's saved
-- views; all ignoring case. Existing duplicates are renamed first ("X (2)", "X (3)", oldest keeps its name), each in the
-- audit log; nothing is deleted.
with d as (select id, workspace_id, name, row_number() over (partition by workspace_id, lower(trim(name)) order by id) as n from projects),
     r as (update projects p set name = trim(p.name) || ' (' || d.n || ')' from d where d.id = p.id and d.n > 1 returning p.id, p.workspace_id, p.key, d.name as was, p.name)
insert into audit_log (workspace_id, actor, action, project_id, project_key, target_type, target_id, target, before, after)
select workspace_id, 'Jira Build POC', 'name.deduplicated', id, key, 'project', id::text, name, jsonb_build_object('name', was), jsonb_build_object('name', name) from r;

with d as (select id, project_id, name, row_number() over (partition by project_id, lower(trim(name)) order by id) as n from releases),
     r as (update releases x set name = trim(x.name) || ' (' || d.n || ')' from d where d.id = x.id and d.n > 1 returning x.id, x.project_id, d.name as was, x.name)
insert into audit_log (workspace_id, actor, action, project_id, project_key, target_type, target_id, target, before, after)
select p.workspace_id, 'Jira Build POC', 'name.deduplicated', p.id, p.key, 'release', r.id::text, r.name, jsonb_build_object('name', r.was), jsonb_build_object('name', r.name) from r join projects p on p.id = r.project_id;

with d as (select id, project_id, name, row_number() over (partition by project_id, lower(trim(name)) order by id) as n from components),
     r as (update components x set name = trim(x.name) || ' (' || d.n || ')' from d where d.id = x.id and d.n > 1 returning x.id, x.project_id, d.name as was, x.name)
insert into audit_log (workspace_id, actor, action, project_id, project_key, target_type, target_id, target, before, after)
select p.workspace_id, 'Jira Build POC', 'name.deduplicated', p.id, p.key, 'component', r.id::text, r.name, jsonb_build_object('name', r.was), jsonb_build_object('name', r.name) from r join projects p on p.id = r.project_id;

with d as (select id, owner_id, name, row_number() over (partition by owner_id, lower(trim(name)) order by id) as n from saved_views),
     r as (update saved_views x set name = trim(x.name) || ' (' || d.n || ')' from d where d.id = x.id and d.n > 1 returning x.id, x.workspace_id, d.name as was, x.name)
insert into audit_log (workspace_id, actor, action, target_type, target_id, target, before, after)
select workspace_id, 'Jira Build POC', 'name.deduplicated', 'view', id::text, name, jsonb_build_object('name', was), jsonb_build_object('name', name) from r;

-- A renamed "X (2)" that meets an existing "X (2)" makes the index below fail loudly; rename by hand then
create unique index projects_name_unique on projects (workspace_id, lower(trim(name)));
create unique index releases_name_unique on releases (project_id, lower(trim(name)));
alter table components drop constraint if exists components_project_id_name_key;
create unique index components_name_unique on components (project_id, lower(trim(name)));
create unique index saved_views_name_unique on saved_views (owner_id, lower(trim(name)));
