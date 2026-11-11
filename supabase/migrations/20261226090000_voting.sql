-- Voting (spec 0506), as Jira's: one vote per person per item.
create table issue_votes (
  issue_id uuid not null references issues on delete cascade,
  user_id  uuid not null references users on delete cascade,
  voted_at timestamptz not null default now(),
  primary key (issue_id, user_id)
);
create index on issue_votes (user_id);
alter table issue_votes enable row level security;
