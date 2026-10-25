-- Test management (what Xray adds to Jira): a project can turn testing on, which gives it five more built-in work types.
-- Their keys are their roles, so the app knows a Test from a Test Plan whatever the project calls them:
--   test, precondition, test_set, test_plan, test_execution
alter table work_types drop constraint work_types_key_check;
alter table work_types add constraint work_types_key_check
  check (key in ('epic', 'story', 'task', 'bug', 'test', 'precondition', 'test_set', 'test_plan', 'test_execution') or key ~ '^t-[a-z0-9]{6,32}$');

alter table projects add column testing boolean not null default false;

create function seed_testing_types(pid uuid) returns void language sql as $$
  insert into work_types (project_id, key, name, color, icon, position) values
    (pid, 'test', 'Test', '#0D9488', 'flask', 10), (pid, 'precondition', 'Pre-Condition', '#64748B', 'clipboard', 11),
    (pid, 'test_set', 'Test Set', '#0891B2', 'layers', 12), (pid, 'test_plan', 'Test Plan', '#4F46E5', 'map', 13),
    (pid, 'test_execution', 'Test Execution', '#CA8A04', 'play', 14)
  on conflict do nothing
$$;

-- What a Test (or Pre-Condition) says to do, as Xray's three kinds:
--   { "kind": "manual", "steps": [{ "id", "action", "data", "expected", "attachmentIds": [] }] }
--   { "kind": "cucumber", "gherkin": "Scenario: …" }      { "kind": "generic", "definition": "…" }
alter table issues add column test_spec jsonb;
