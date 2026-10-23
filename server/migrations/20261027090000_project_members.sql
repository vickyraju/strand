-- Project access: who can see a project and what they may do there. One role per person per project.
--   admin  : manage the project's settings, workflow and people; delete any work
--   member : create, edit, comment on and move work
--   viewer : see the project and comment, nothing else
-- Workspace owners and admins (the "global admins") can see and administer every project without being listed.
create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id    uuid not null references users on delete cascade,
  role       text not null check (role in ('admin', 'member', 'viewer')),
  added_at   timestamptz not null default now(),
  added_by   uuid references users on delete set null,
  primary key (project_id, user_id)
);
create index on project_members (user_id);
alter table project_members enable row level security;

-- Nobody loses access: every workspace member joins every existing project, keeping what they could do before.
-- Project leads and workspace owners/admins become the project's admins, so each project starts with at least one.
insert into project_members (project_id, user_id, role)
select p.id, m.user_id,
       case when p.lead_id = m.user_id or m.role in ('owner', 'admin') then 'admin'
            when m.role = 'viewer' then 'viewer' else 'member' end
  from projects p join memberships m on m.workspace_id = p.workspace_id
on conflict do nothing;

-- A workspace-wide "viewer" no longer exists: read-only is a project role now.
update memberships set role = 'member' where role = 'viewer';
alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check check (role in ('owner', 'admin', 'member'));

-- Labels belong to a project, so a person only ever sees labels used in projects they can see.
drop trigger issues_note_labels on issues;
drop function note_labels();
drop table labels;
create table labels (
  project_id uuid not null references projects on delete cascade,
  name       text not null,
  primary key (project_id, name)
);
create index on labels (project_id, lower(name) text_pattern_ops);
insert into labels (project_id, name)
  select distinct project_id, unnest(labels) from issues where cardinality(labels) > 0
  on conflict do nothing;
create function note_labels() returns trigger language plpgsql as $$
begin
  if cardinality(new.labels) > 0 then
    insert into labels (project_id, name) select new.project_id, unnest(new.labels) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger issues_note_labels after insert or update of labels on issues
  for each row execute function note_labels();
alter table labels enable row level security;
