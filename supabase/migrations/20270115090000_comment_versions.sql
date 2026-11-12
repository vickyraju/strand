-- Comment edit history (spec 0601 R6): the text each edit replaced, who edited it and when
create table comment_versions (
  id         uuid primary key default uuid_v7(),
  comment_id uuid not null references comments on delete cascade,
  body       text not null,
  edited_by  uuid references users on delete set null,
  edited_at  timestamptz not null default now()
);
create index on comment_versions (comment_id, edited_at desc);
alter table comment_versions enable row level security;
