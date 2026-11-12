-- Link types, as Jira's issue linking: a name and how the link reads each way ("blocks" / "is blocked by").
-- Per workspace, managed by its admins. `id` is a short stable key stored on each link (issue_links.type).
-- Blocks and Cloners are built in: the "blocked" flag and cloning rely on them, so they can be renamed but not removed.
create table link_types (
  workspace_id uuid not null references workspaces on delete cascade,
  id           text not null check (id ~ '^[a-z][a-z0-9-]{0,39}$'),
  name         text not null,
  outward      text not null,
  inward       text not null,
  builtin      boolean not null default false,
  position     integer not null default 0,
  primary key (workspace_id, id)
);

create function seed_link_types(ws uuid) returns void language sql as $$
  insert into link_types (workspace_id, id, name, outward, inward, builtin, position) values
    (ws, 'blocks', 'Blocks', 'blocks', 'is blocked by', true, 0),
    (ws, 'clones', 'Cloners', 'clones', 'is cloned by', true, 1),
    (ws, 'duplicates', 'Duplicate', 'duplicates', 'is duplicated by', false, 2),
    (ws, 'relates', 'Relates', 'relates to', 'relates to', false, 3)
  on conflict do nothing
$$;
select seed_link_types(id) from workspaces;
create function workspaces_seed_link_types() returns trigger language plpgsql as $$
begin perform seed_link_types(new.id); return new; end $$;
create trigger workspaces_seed_link_types after insert on workspaces for each row execute function workspaces_seed_link_types();

-- Links may now be of any type the workspace has (the API checks it)
alter table issue_links drop constraint issue_links_type_check;
alter table link_types enable row level security;
