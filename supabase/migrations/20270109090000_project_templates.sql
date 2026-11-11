-- Project templates (spec 0310): Basic software development and Jira's business templates (Task, Project and Process
-- management), each with a workflow and scheme of its own in every workspace; every status reachable from any.
alter table projects drop constraint projects_template_check;
alter table projects add constraint projects_template_check check (template in ('kanban', 'scrum', 'basic', 'task', 'project', 'process'));

create function seed_template_workflows(ws uuid) returns void language plpgsql as $$
declare t record; ids uuid[]; wid uuid;
begin
  -- statuses of the same name are reused, whatever their case
  insert into wf_statuses (workspace_id, name, color, category, position) values
    (ws, 'To do', '#94a3b8', 'todo', 0), (ws, 'In progress', '#3b82f6', 'in-progress', 1), (ws, 'In review', '#a855f7', 'in-progress', 2),
    (ws, 'Done', '#22c55e', 'done', 3), (ws, 'Open', '#94a3b8', 'todo', 4), (ws, 'Under review', '#a855f7', 'in-progress', 5),
    (ws, 'Approved', '#14b8a6', 'in-progress', 6)
  on conflict do nothing;
  for t in select * from (values
      ('Basic software development', 'To do, In progress, In review, Done: any status to any status', array['to do', 'in progress', 'in review', 'done']),
      ('Task management', 'To do, Done: any status to any status', array['to do', 'done']),
      ('Project management', 'To do, In progress, Done: any status to any status', array['to do', 'in progress', 'done']),
      ('Process management', 'Open, In progress, Under review, Approved, Done: any status to any status', array['open', 'in progress', 'under review', 'approved', 'done'])
    ) v(name, description, statuses) loop
    continue when exists (select 1 from workflow_schemes where workspace_id = ws and lower(name) = lower(t.name))
               or exists (select 1 from workflows where workspace_id = ws and lower(name) = lower(t.name));
    select array_agg(g.id order by array_position(t.statuses, lower(g.name))) into ids from wf_statuses g where g.workspace_id = ws and lower(g.name) = any(t.statuses);
    insert into workflows (workspace_id, name, description, statuses, transitions) values (ws, t.name, t.description, ids,
      (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'name', g.name, 'fromIds', null, 'toId', g.id, 'rules', '{}'::jsonb) order by array_position(ids, g.id))
         from wf_statuses g where g.id = any(ids))) returning id into wid;
    insert into workflow_schemes (workspace_id, name, description, default_workflow_id) values (ws, t.name, 'Every work type uses the ' || t.name || ' workflow', wid);
  end loop;
end $$;
select seed_template_workflows(id) from workspaces;
create function workspaces_seed_template_workflows() returns trigger language plpgsql as $$
begin perform seed_template_workflows(new.id); return new; end $$;
-- named to run after workspaces_seed_workflows (triggers fire in name order)
create trigger workspaces_seed_workflows_templates after insert on workspaces for each row execute function workspaces_seed_template_workflows();
