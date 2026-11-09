-- Spec 0712: user directories, as Jira's Administration › User directories. Active Directory or LDAP, Read Only: they
-- check passwords on the login form and copy users, groups and memberships into Strand on a schedule.
create table user_directories (
  id           uuid primary key default uuid_v7(),
  name         text not null,
  type         text not null check (type in ('ad', 'ldap')),
  position     int not null,
  enabled      boolean not null default true,
  config       jsonb not null,                     -- server, schema and membership settings (no password)
  password_enc bytea,                              -- the bind password, encrypted (STRAND_SECRET_KEY) and bound to this row
  last_sync    jsonb,                              -- when, how it went, and what changed
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index user_directories_name on user_directories (lower(name));
alter table user_directories enable row level security;

-- Where a person or a group comes from: the directory and its own id for them (objectGUID, entryUUID), which survives
-- renames and moves; a group's DN as last read, for memberships
alter table users add column directory_id uuid references user_directories, add column directory_guid text;
create unique index users_directory_guid on users (directory_id, directory_guid) where directory_guid is not null;
alter table groups add column directory_id uuid references user_directories, add column directory_guid text, add column directory_dn text;
create unique index groups_directory_guid on groups (directory_id, directory_guid) where directory_guid is not null;
