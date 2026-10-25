-- Issue security (Jira's security levels): a work item can be given a level, and then only the level's members see it,
-- anywhere (lists, search, boards, links, notifications, reports, exports). Members are project roles, groups, people,
-- the item's reporter and its assignee. As in Jira, admins are not let in by default: only through a role or a listing.
create table security_levels (
  id          uuid primary key default uuid_v7(),
  project_id  uuid not null references projects on delete cascade,
  name        text not null,
  description text not null default '',
  -- [{ "kind": "role", "role": "admin" | "member" | "viewer" } | { "kind": "group" | "user", "id": uuid } | { "kind": "reporter" | "assignee" }]
  members     jsonb not null default '[]',
  unique (project_id, name)
);
create index on security_levels (project_id);
alter table security_levels enable row level security;

-- an item keeps its level until someone changes it: a level in use can't simply disappear (the API moves items first)
alter table issues add column security_level_id uuid references security_levels on delete restrict;
create index on issues (security_level_id) where security_level_id is not null;

/** Can this person see an item with this level? `is_admin`: a workspace admin, who counts as a project admin. */
create function issue_visible(level uuid, reporter uuid, assignee uuid, project uuid, who uuid, is_admin boolean)
returns boolean language sql stable as $$
  select level is null or exists (
    select 1 from security_levels l, jsonb_array_elements(l.members) m
     where l.id = level and (
          (m->>'kind' = 'reporter' and reporter = who)
       or (m->>'kind' = 'assignee' and assignee = who)
       or (m->>'kind' = 'user' and (m->>'id')::uuid = who)
       or (m->>'kind' = 'group' and exists (select 1 from group_members g where g.group_id = (m->>'id')::uuid and g.user_id = who))
       or (m->>'kind' = 'role' and (
            (is_admin and m->>'role' = 'admin')
            or exists (select 1 from project_access pa where pa.project_id = project and pa.user_id = who and pa.role = m->>'role'))))
  )
$$;

-- Comment visibility (Jira's): a comment can be limited to a project role or a group. Null: everyone who sees the item.
alter table comments add column visibility jsonb;
