-- Spec 0714: local users, as Jira's internal directory. Their passwords are kept as salted scrypt hashes; a link to set
-- one (from "Can't access your account?" or an admin's notification email) is kept only as a hash and used once.
alter table users add column password_hash text, add column password_changed_at timestamptz;

create table password_resets (
  token_hash bytea primary key,
  user_id    uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on password_resets (user_id, created_at);
alter table password_resets enable row level security;
