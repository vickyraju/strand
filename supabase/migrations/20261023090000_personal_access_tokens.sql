-- Personal access tokens: how scripts and integrations call the API as a user.
-- Only a SHA-256 hash of each token is stored; the token itself is shown once, when it is created.
create table personal_access_tokens (
  id           uuid primary key default uuid_v7(),
  user_id      uuid not null references users on delete cascade,
  name         text not null check (char_length(name) between 1 and 40),
  token_hash   bytea not null unique,           -- the unique index is also the lookup path on every request
  hint         text not null,                   -- last 4 characters, so a person can tell their tokens apart
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz
);
create index on personal_access_tokens (user_id, created_at desc);
create index on personal_access_tokens (expires_at);

alter table personal_access_tokens enable row level security;
