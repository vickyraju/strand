-- Soft edit presence: who has an issue open for editing right now. The app heartbeats every 30 s;
-- rows older than 90 s are pruned on the next heartbeat and ignored when read. (Added as its own
-- migration: databases that already ran the earlier ones need it too.)
create table issue_editors (
  issue_id       uuid not null references issues on delete cascade,
  user_id        uuid not null references users on delete cascade,
  last_heartbeat timestamptz not null default now(),
  primary key (issue_id, user_id)
);
create index on issue_editors (last_heartbeat);                     -- the prune query
alter table issue_editors enable row level security;

-- "Your work → Worked on" looks up what a user touched; without these it scans every activity, comment and work log.
create index on activity (actor_id, created_at desc) where actor_id is not null;
create index on comments (author_id, created_at desc) where author_id is not null;
create index on worklogs (user_id, created_at desc) where user_id is not null;
