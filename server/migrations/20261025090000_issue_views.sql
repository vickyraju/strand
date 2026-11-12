-- "Recently viewed": the work items each person opened last. The app keeps the newest 50 per person.
create table issue_views (
  user_id   uuid not null references users on delete cascade,
  issue_id  uuid not null references issues on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, issue_id)
);
create index on issue_views (user_id, viewed_at desc);

alter table issue_views enable row level security;
