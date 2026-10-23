-- Groups: teams from the organisation's directory (Entra provisions them over SCIM, like people). A project can give a
-- role to a whole group; everyone in the group then has that role there, and loses it when they leave the group.
create table groups (
  id           uuid primary key default uuid_v7(),
  display_name text not null,
  external_id  text unique,        -- the directory's own id for the group
  created_at   timestamptz not null default now()
);
create table group_members (
  group_id uuid not null references groups on delete cascade,
  user_id  uuid not null references users on delete cascade,
  primary key (group_id, user_id)
);
create index on group_members (user_id);
create table project_group_roles (
  project_id uuid not null references projects on delete cascade,
  group_id   uuid not null references groups on delete cascade,
  role       text not null check (role in ('admin', 'member', 'viewer')),
  added_at   timestamptz not null default now(),
  added_by   uuid references users on delete set null,
  primary key (project_id, group_id)
);
create index on project_group_roles (group_id);
alter table groups enable row level security;
alter table group_members enable row level security;
alter table project_group_roles enable row level security;

-- Everyone's role in every project: their own, or the highest any of their groups gives them. Every access check reads this.
create view project_access as
select project_id, user_id, (array['viewer', 'member', 'admin'])[max(rank)] as role
  from (select project_id, user_id, case role when 'admin' then 3 when 'member' then 2 else 1 end as rank from project_members
        union all
        select g.project_id, gm.user_id, case g.role when 'admin' then 3 when 'member' then 2 else 1 end
          from project_group_roles g join group_members gm on gm.group_id = g.group_id) x
 group by project_id, user_id;

-- Losing access through a group closes live streams too (see notify_access_revoked): a person leaving a group may lose
-- several projects, and a group's grant ending affects everyone in it. Streams that are still allowed reconnect.
create function notify_group_access_revoked() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'group_members' then
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'userId', old.user_id)::text);
  else
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'projectId', old.project_id)::text);
  end if;
  return null;
end $$;
create trigger group_members_revoke after delete on group_members
  for each row execute function notify_group_access_revoked();
create trigger project_group_roles_revoke after delete or update of role on project_group_roles
  for each row execute function notify_group_access_revoked();
