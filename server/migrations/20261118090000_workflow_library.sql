-- Workflows belong to system administrators, as in Jira: global statuses, shared workflows, and workflow schemes that
-- say which workflow each work type uses. A project uses one scheme; its own statuses and transitions are that scheme
-- applied (server/src/workflows.ts), so boards, rules, searches and reports keep reading them as before.
create table wf_statuses (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  color        text not null,
  category     text not null check (category in ('todo', 'in-progress', 'done')),
  position     integer not null default 0
);
create unique index on wf_statuses (workspace_id, lower(name));
alter table wf_statuses enable row level security;

create table workflows (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  statuses     uuid[] not null,                 -- wf_statuses, in order; new work starts in the first
  transitions  jsonb not null default '[]',     -- [{ id, name, fromIds (null: from any status), toId (null: a loop), rules }], ids are wf_statuses
  layout       jsonb not null default '{}',     -- where the editor draws each status
  version      integer not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users on delete set null
);
create unique index on workflows (workspace_id, lower(name));
alter table workflows enable row level security;

create table workflow_schemes (
  id                  uuid primary key default uuid_v7(),
  workspace_id        uuid not null references workspaces on delete cascade,
  name                text not null,
  description         text not null default '',
  default_workflow_id uuid not null references workflows,
  mappings            jsonb not null default '{}',   -- work type key → workflow id; every other type uses the default
  updated_at          timestamptz not null default now()
);
create unique index on workflow_schemes (workspace_id, lower(name));
alter table workflow_schemes enable row level security;

-- Published versions belong to the shared workflow now
drop table workflow_versions;
create table workflow_versions (
  id           uuid primary key default uuid_v7(),
  workflow_id  uuid not null references workflows on delete cascade,
  version      integer not null,
  statuses     jsonb not null,
  transitions  jsonb not null,
  note         text not null default '',
  published_at timestamptz not null default now(),
  published_by uuid references users on delete set null,
  unique (workflow_id, version)
);
alter table workflow_versions enable row level security;

-- Today's defaults, shared: Kanban (To do, In progress, Done) and Scrum (with In review), every status reachable from any
create function seed_workflows(ws uuid) returns void language plpgsql as $$
declare todo uuid; prog uuid; rev uuid; done uuid; kan uuid; scr uuid;
begin
  insert into wf_statuses (workspace_id, name, color, category, position) values (ws, 'To do', '#94a3b8', 'todo', 0) returning id into todo;
  insert into wf_statuses (workspace_id, name, color, category, position) values (ws, 'In progress', '#3b82f6', 'in-progress', 1) returning id into prog;
  insert into wf_statuses (workspace_id, name, color, category, position) values (ws, 'In review', '#a855f7', 'in-progress', 2) returning id into rev;
  insert into wf_statuses (workspace_id, name, color, category, position) values (ws, 'Done', '#22c55e', 'done', 3) returning id into done;
  insert into workflows (workspace_id, name, description, statuses, transitions) values (ws, 'Kanban', 'To do, In progress, Done: any status to any status',
    array[todo, prog, done], (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'name', g.name, 'fromIds', null, 'toId', g.id, 'rules', '{}'::jsonb) order by g.position)
                               from wf_statuses g where g.id in (todo, prog, done))) returning id into kan;
  insert into workflows (workspace_id, name, description, statuses, transitions) values (ws, 'Scrum', 'To do, In progress, In review, Done: any status to any status',
    array[todo, prog, rev, done], (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'name', g.name, 'fromIds', null, 'toId', g.id, 'rules', '{}'::jsonb) order by g.position)
                                    from wf_statuses g where g.id in (todo, prog, rev, done))) returning id into scr;
  insert into workflow_schemes (workspace_id, name, description, default_workflow_id) values
    (ws, 'Kanban', 'Every work type uses the Kanban workflow', kan), (ws, 'Scrum', 'Every work type uses the Scrum workflow', scr);
end $$;
select seed_workflows(id) from workspaces;
create function workspaces_seed_workflows() returns trigger language plpgsql as $$
begin perform seed_workflows(new.id); return new; end $$;
create trigger workspaces_seed_workflows after insert on workspaces for each row execute function workspaces_seed_workflows();

alter table projects add column workflow_scheme_id uuid references workflow_schemes;
alter table statuses add column global_status_id uuid references wf_statuses;
alter table statuses add constraint statuses_global_unique unique (project_id, global_status_id);
alter table transitions add column source text;                  -- workflow id:transition id it was applied from
alter table transitions add constraint transitions_source_unique unique (project_id, source);

-- Every project starts on the standard scheme of its template. Its statuses become the scheme's: a status keeps its
-- place when the workflow has one of the same name, else joins the first of its category; items follow.
update projects p set workflow_scheme_id = s.id from workflow_schemes s
 where s.workspace_id = p.workspace_id and s.name = case p.template when 'scrum' then 'Scrum' else 'Kanban' end;
alter table projects alter column workflow_scheme_id set not null;

create temp table st_map on commit drop as
select s.id as sid, s.project_id, m.gid,
       row_number() over (partition by s.project_id, m.gid order by (lower(s.name) = lower(g.name)) desc, s.position, s.id) as n
  from statuses s join projects p on p.id = s.project_id join workflow_schemes sc on sc.id = p.workflow_scheme_id join workflows w on w.id = sc.default_workflow_id
  cross join lateral (select coalesce(
    (select x from unnest(w.statuses) x join wf_statuses g on g.id = x where lower(g.name) = lower(s.name) limit 1),
    (select x from unnest(w.statuses) with ordinality u(x, o) join wf_statuses g on g.id = x where g.category = s.category order by o limit 1),
    w.statuses[1]) as gid) m
  join wf_statuses g on g.id = m.gid;
update issues i set status_id = k.sid from st_map m join st_map k on k.project_id = m.project_id and k.gid = m.gid and k.n = 1
 where i.status_id = m.sid and m.n > 1;
delete from transitions;
delete from statuses s using st_map m where m.sid = s.id and m.n > 1;
update statuses s set global_status_id = m.gid from st_map m where m.sid = s.id;
insert into statuses (project_id, name, color, category, position, global_status_id)
select p.id, g.name, g.color, g.category, 0, g.id
  from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id join workflows w on w.id = sc.default_workflow_id
  join wf_statuses g on g.id = any(w.statuses)
 where not exists (select 1 from statuses s where s.project_id = p.id and s.global_status_id = g.id);
update statuses s set name = g.name, color = g.color, category = g.category, description = g.description,
       position = array_position(w.statuses, g.id) - 1
  from wf_statuses g, projects p, workflow_schemes sc, workflows w
 where g.id = s.global_status_id and p.id = s.project_id and sc.id = p.workflow_scheme_id and w.id = sc.default_workflow_id;
insert into transitions (project_id, name, from_ids, to_id, rules, source)
select p.id, t->>'name', null, s.id, t->'rules', w.id || ':' || (t->>'id')
  from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id join workflows w on w.id = sc.default_workflow_id
  cross join jsonb_array_elements(w.transitions) t
  join statuses s on s.project_id = p.id and s.global_status_id = (t->>'toId')::uuid;
