-- Global permissions (spec 0717), granted to groups as in Jira: System administrators (besides the system-administrators
-- group, which always has it), Browse users and groups, Create shared objects, Manage group filter subscriptions, Bulk change.
create table global_permissions (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  permission   text not null check (permission in ('system-admin', 'browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change')),
  group_id     uuid not null references groups on delete cascade,
  created_at   timestamptz not null default now(),
  unique (workspace_id, permission, group_id)
);
create index on global_permissions (group_id);
alter table global_permissions enable row level security;

-- R2: everyone keeps what they could do, through the default users group; "system administrators only" group
-- subscriptions carry over as no grant
create function seed_global_permissions(ws uuid) returns void language sql as $$
  insert into global_permissions (workspace_id, permission, group_id)
  select ws, p, g.id from groups g, unnest(array['browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change']) p
   where g.system_role = 'default-users'
     and not (p = 'group-subscriptions' and exists (select 1 from system_settings s where s.workspace_id = ws and s.key = 'filterSubscriptions' and s.value->>'groupSubscribers' = 'admins'))
  on conflict do nothing
$$;
select seed_global_permissions(id) from workspaces;
create function workspaces_seed_global_permissions() returns trigger language plpgsql as $$
begin perform seed_global_permissions(new.id); return new; end $$;
create trigger workspaces_seed_global_permissions after insert on workspaces for each row execute function workspaces_seed_global_permissions();
update system_settings set value = value - 'groupSubscribers' where key = 'filterSubscriptions';

-- R1: members of a group granted System administrators administer Strand too
create or replace function is_system_admin(uid uuid) returns boolean language sql stable as $$
  select exists (select 1 from group_members gm join groups g on g.id = gm.group_id where g.system_role = 'system-admins' and gm.user_id = uid)
      or exists (select 1 from group_members gm join global_permissions gp on gp.group_id = gm.group_id where gp.permission = 'system-admin' and gm.user_id = uid)
$$;
