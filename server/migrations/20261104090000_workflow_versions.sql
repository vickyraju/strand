-- Published versions of a project's workflow (Jira keeps every published workflow): its statuses, transitions and work
-- types as they were, who published it, and why. Compared and restored from the workflow editor.
create table workflow_versions (
  id           uuid primary key default uuid_v7(),
  project_id   uuid not null references projects on delete cascade,
  version      integer not null,
  statuses     jsonb not null,
  transitions  jsonb not null,
  types        jsonb not null,
  note         text not null default '',
  published_at timestamptz not null default now(),
  published_by uuid references users on delete set null,
  unique (project_id, version)
);
alter table workflow_versions enable row level security;

-- A project with no transitions at all allowed any move, but its workflow could not be edited without first drawing
-- every move. Give it what a new project gets: each status reachable from any status (the same moves as before).
insert into transitions (project_id, name, from_ids, to_id)
select s.project_id, s.name, null, s.id from statuses s
 where not exists (select 1 from transitions t where t.project_id = s.project_id);
