-- Which tests a Test Set, Test Plan or Pre-Condition holds (Xray's associations). A test can be in many of each; a plan
-- can sort its tests into folders (Xray's Test Plan board), written as a path such as "Smoke/Sign in".
create table test_items (
  container_id uuid not null references issues on delete cascade,
  member_id    uuid not null references issues on delete cascade,
  position     double precision not null default 0,
  folder       text not null default '' check (length(folder) <= 500),
  added_at     timestamptz not null default now(),
  primary key (container_id, member_id)
);
alter table test_items add constraint test_items_not_itself check (container_id <> member_id);
create index on test_items (member_id);
alter table test_items enable row level security;

-- A project's test repository (Xray's Test Repository): a folder tree that each Test sits in (or at the top).
create table test_folders (
  id         uuid primary key default uuid_v7(),
  project_id uuid not null references projects on delete cascade,
  parent_id  uuid references test_folders on delete cascade,
  name       text not null check (length(name) between 1 and 100),
  position   double precision not null default 0
);
create unique index on test_folders (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
alter table test_folders enable row level security;

alter table issues add column test_folder_id uuid references test_folders on delete set null;
create index on issues (test_folder_id) where test_folder_id is not null;
