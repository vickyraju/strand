-- System groups, as Jira has them (jira-users / jira-system-administrators): admin rights come from belonging to a group.
--   users-access           everyone joins it at sign-in (the default group; rejoined at the next sign-in if removed)
--   system-administrators  its members administer Strand (Administration, System settings, every project)
-- Their names can be changed: the app knows them by system_role, not by name. Other groups can be made by people (stage B).
alter table groups add column description text not null default '' check (length(description) <= 500);
alter table groups add column system_role text unique check (system_role in ('default-users', 'system-admins'));
alter table groups add column created_by uuid references users on delete set null;

-- Who manages a group made in Strand (with system admins). Directory (SCIM) groups are managed by the directory.
create table group_owners (
  group_id uuid not null references groups on delete cascade,
  user_id  uuid not null references users on delete cascade,
  primary key (group_id, user_id)
);
create index on group_owners (user_id);
alter table group_owners enable row level security;

insert into groups (display_name, description, system_role) values
  ('users-access', 'Everyone who signs in to Strand joins this group.', 'default-users'),
  ('system-administrators', 'Members administer Strand: Administration, System settings and every project.', 'system-admins');
-- everyone already here is in the default group; today's owners and admins become system administrators
insert into group_members (group_id, user_id) select g.id, u.id from groups g, users u where g.system_role = 'default-users' on conflict do nothing;
insert into group_members (group_id, user_id)
  select g.id, m.user_id from groups g, memberships m where g.system_role = 'system-admins' and m.role in ('owner', 'admin') on conflict do nothing;

/** Is this person a system administrator (in the system-admins group)? Every admin check reads this. */
create function is_system_admin(uid uuid) returns boolean language sql stable as $$
  select exists (select 1 from group_members gm join groups g on g.id = gm.group_id where g.system_role = 'system-admins' and gm.user_id = uid)
$$;

alter table users add column last_sign_in_at timestamptz;
