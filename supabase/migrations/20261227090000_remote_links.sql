-- Remote links (spec 0507), as Jira's web links and remote issue links: a URL and its title on an item, with what an app
-- adds (its global id, application, relationship, summary, icon, status).
create table remote_links (
  id           uuid primary key default uuid_v7(),
  issue_id     uuid not null references issues on delete cascade,
  global_id    text,
  url          text not null,
  title        text not null,
  summary      text,
  relationship text,
  application  jsonb,
  icon         jsonb,
  status       jsonb,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on remote_links (issue_id, created_at);
create unique index remote_links_global on remote_links (issue_id, global_id) where global_id is not null;
alter table remote_links enable row level security;
