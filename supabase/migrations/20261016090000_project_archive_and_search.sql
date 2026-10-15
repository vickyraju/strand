-- Archive projects (hide without deleting) and make name/e-mail search fast on large workspaces.
-- Plain Postgres, no Supabase-specific objects.

alter table projects add column archived_at timestamptz;
create index on projects (workspace_id, lower(name), id) where archived_at is null;     -- default project list, name order
create index on projects using gin (name gin_trgm_ops);                                    -- "contains" search by name
create index on projects using gin (key gin_trgm_ops);                                     -- … and by key

create index on users using gin (name gin_trgm_ops);                                       -- user search (people picker)
create index on users using gin (email gin_trgm_ops);
