-- Boards (Jira's boards): a project can have several, each showing the work items its filter (JQL) finds, from this
-- project or several. A board has its own columns (statuses mapped to columns, with a minimum and maximum), swimlanes,
-- quick filters and card fields. Project admins and the board's named admins configure it; everyone in the project
-- uses it. Sprints belong to a board, so a sprint can hold work from every project its board covers.
create table boards (
  id            uuid primary key default uuid_v7(),
  workspace_id  uuid not null references workspaces on delete cascade,
  project_id    uuid not null references projects on delete cascade,       -- where it is listed (Jira's board location)
  name          text not null check (length(name) between 1 and 100),
  type          text not null check (type in ('kanban', 'scrum')),          -- fixed once made, as in Jira
  jql           text not null,                                              -- the board filter
  columns       jsonb not null,             -- [{ id, name, statusIds: [global status id], min?, max? }]
  swimlanes     jsonb not null default '{"by": "none"}',   -- { by: none|assignee|epic|priority|project|queries, queries?: [{ id, name, jql }] }
  quick_filters jsonb not null default '[]',               -- [{ id, name, jql }]
  card_fields   jsonb not null default '{}',
  done_days     int check (done_days between 1 and 3650),  -- Kanban: leave out Done items not updated for this many days
  position      int not null default 0,
  created_by    uuid references users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on boards (project_id, position);
alter table boards enable row level security;

create table board_admins (
  board_id uuid not null references boards on delete cascade,
  user_id  uuid references users on delete cascade,
  group_id uuid references groups on delete cascade
);
alter table board_admins add constraint board_admins_one check ((user_id is null) <> (group_id is null));   -- a person or a group
create unique index on board_admins (board_id, user_id) where user_id is not null;
create unique index on board_admins (board_id, group_id) where group_id is not null;
alter table board_admins enable row level security;

-- Every project keeps the board it had: its statuses as columns (WIP limits as each column's maximum), its swimlanes
-- and card fields, and its project as the filter
insert into boards (workspace_id, project_id, name, type, jql, columns, swimlanes, card_fields, done_days, created_by)
select p.workspace_id, p.id, p.key || ' board', p.template, 'project = ' || p.key,
       coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', s.id, 'name', s.name, 'statusIds', jsonb_build_array(s.global_status_id), 'max', s.wip_limit)) order by s.position)
                   from statuses s where s.project_id = p.id and s.global_status_id is not null), '[]'),
       jsonb_build_object('by', coalesce(nullif(p.board_prefs->>'groupBy', ''), 'none')),
       coalesce(p.board_prefs->'fields', '{}'),
       case when p.template = 'kanban' then 14 end, p.lead_id
  from projects p;
insert into board_admins (board_id, user_id) select b.id, b.created_by from boards b where b.created_by is not null;

alter table sprints add column board_id uuid references boards on delete cascade;
update sprints s set board_id = b.id from boards b where b.project_id = s.project_id;
alter table sprints alter column board_id set not null;
drop index sprints_project_id_idx;                                         -- one active sprint per project…
create unique index sprints_one_active on sprints (board_id) where state = 'active';   -- …is now per board
create index on sprints (board_id, state);
