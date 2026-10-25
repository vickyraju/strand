-- Running tests (Xray's test runs). A Test Execution runs tests; each test in it has one run, which keeps a copy of the
-- test as it was when the run was made, a result for each step, and the run's own status.

-- Statuses a run or a step can have, per workspace (Xray's test and step statuses). The built-in ones are Xray's; an
-- admin can add more. A run status is final or not (TODO and EXECUTING are not: the run isn't over) and maps to what it
-- means for a requirement it tests: ok, nok, notrun or unknown. A step status maps to a run status.
create table test_statuses (
  workspace_id uuid not null references workspaces on delete cascade,
  kind         text not null check (kind in ('run', 'step')),
  key          text not null check (key in ('TODO', 'EXECUTING', 'PASS', 'FAIL', 'ABORTED') or key ~ '^c-[a-z0-9]{6,32}$'),
  name         text not null check (length(name) between 1 and 40),
  description  text not null default '',
  color        text not null,
  final        boolean not null default false,
  maps_to      text not null,                       -- run: ok | nok | notrun | unknown; step: a run status key
  rank         integer not null default 0,          -- breaks ties when results are combined: the higher one wins
  builtin      boolean not null default false,
  primary key (workspace_id, kind, key)
);
alter table test_statuses enable row level security;

create function seed_test_statuses(ws uuid) returns void language sql as $$
  insert into test_statuses (workspace_id, kind, key, name, description, color, final, maps_to, rank, builtin) values
    (ws, 'run', 'TODO', 'To do', 'Not started', '#A8A29E', false, 'notrun', 1, true),
    (ws, 'run', 'EXECUTING', 'Executing', 'Being run', '#F59E0B', false, 'notrun', 2, true),
    (ws, 'run', 'PASS', 'Passed', 'It worked', '#16A34A', true, 'ok', 0, true),
    (ws, 'run', 'FAIL', 'Failed', 'It didn’t work', '#DC2626', true, 'nok', 4, true),
    (ws, 'run', 'ABORTED', 'Aborted', 'Stopped before the end', '#78716C', true, 'notrun', 3, true),
    (ws, 'step', 'TODO', 'To do', 'Not done yet', '#A8A29E', false, 'TODO', 1, true),
    (ws, 'step', 'EXECUTING', 'Executing', 'Being done', '#F59E0B', false, 'EXECUTING', 2, true),
    (ws, 'step', 'PASS', 'Passed', 'As expected', '#16A34A', true, 'PASS', 0, true),
    (ws, 'step', 'FAIL', 'Failed', 'Not as expected', '#DC2626', true, 'FAIL', 4, true)
  on conflict do nothing
$$;
select seed_test_statuses(id) from workspaces;
create function workspaces_seed_test_statuses() returns trigger language plpgsql as $$
begin perform seed_test_statuses(new.id); return new; end $$;
create trigger workspaces_seed_test_statuses after insert on workspaces for each row execute function workspaces_seed_test_statuses();

create table test_runs (
  id           uuid primary key default uuid_v7(),
  execution_id uuid not null references issues on delete cascade,
  test_id      uuid not null references issues on delete cascade,
  status       text not null default 'TODO',
  assignee_id  uuid references users on delete set null,
  executed_by  uuid references users on delete set null,
  started_at   timestamptz,
  finished_at  timestamptz,
  spec         jsonb,                                -- the test as it was when the run was made (or last reset)
  steps        jsonb not null default '[]',          -- [{ id, status, actual, comment, defectIds, evidenceIds }]
  comment      text not null default '' check (length(comment) <= 20000),
  defect_ids   uuid[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (execution_id, test_id)
);
create index on test_runs (test_id);
alter table test_runs enable row level security;

-- What a Test Execution runs against (Xray's Test Environments and Revision); its fix version is the item's release
alter table issues add column test_environments text[] not null default '{}';
alter table issues add column revision text not null default '' check (length(revision) <= 200);

-- A defect raised from a run is linked to the test it was found by
insert into link_types (workspace_id, id, name, outward, inward, builtin, position)
  select id, 'defect', 'Defect', 'has defect', 'is a defect of', true, 4 from workspaces on conflict do nothing;
create or replace function seed_link_types(ws uuid) returns void language sql as $$
  insert into link_types (workspace_id, id, name, outward, inward, builtin, position) values
    (ws, 'blocks', 'Blocks', 'blocks', 'is blocked by', true, 0),
    (ws, 'clones', 'Cloners', 'clones', 'is cloned by', true, 1),
    (ws, 'duplicates', 'Duplicate', 'duplicates', 'is duplicated by', false, 2),
    (ws, 'relates', 'Relates', 'relates to', 'relates to', false, 3),
    (ws, 'defect', 'Defect', 'has defect', 'is a defect of', true, 4)
  on conflict do nothing
$$;
