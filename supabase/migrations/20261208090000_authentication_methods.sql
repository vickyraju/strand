-- Spec 0711: authentication methods, as Jira's Administration › Authentication methods. One row for the whole system
-- (it is read by the login page, before anyone signs in): whether the username/password login form shows, whether it
-- can still be reached when hidden (fallback), and Microsoft Entra's configuration.
create table auth_config (
  id         boolean primary key default true check (id),
  login_form boolean not null default true,
  fallback   boolean not null default false,
  entra      jsonb,                                -- { enabled, name, tenantId, apiClientId, webClientId, authority }
  updated_at timestamptz not null default now(),
  updated_by uuid references users on delete set null
);
insert into auth_config default values;
alter table auth_config enable row level security;

-- A sign-in through the login form: the token is kept only as a hash; it ends when idle or at its expiry
create table user_sessions (
  token_hash   bytea primary key,
  user_id      uuid not null references users on delete cascade,
  via          text not null check (via in ('password', 'recovery')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  idle_until   timestamptz not null,
  last_used_at timestamptz not null default now()
);
create index on user_sessions (user_id);
alter table user_sessions enable row level security;

-- Wrong passwords per username: after a few, the username is locked for a while
create table login_failures (
  username     text primary key,
  failures     int not null default 0,
  locked_until timestamptz,
  last_at      timestamptz not null default now()
);
alter table login_failures enable row level security;

-- The name a person signs in with on the login form (a directory's corp id)
alter table users add column username text;
create unique index users_username on users (lower(username)) where username is not null;
