-- Coverage (Xray's): a Test covers a requirement through the built-in link type "tests / is tested by", always stored
-- from the test. Which work types count as requirements is the project's choice; null means every type except the
-- testing ones and Bug (Xray's default: bugs are defects, not requirements).
insert into link_types (workspace_id, id, name, outward, inward, builtin, position)
  select id, 'tests', 'Test', 'tests', 'is tested by', true, 5 from workspaces on conflict do nothing;
create or replace function seed_link_types(ws uuid) returns void language sql as $$
  insert into link_types (workspace_id, id, name, outward, inward, builtin, position) values
    (ws, 'blocks', 'Blocks', 'blocks', 'is blocked by', true, 0),
    (ws, 'clones', 'Cloners', 'clones', 'is cloned by', true, 1),
    (ws, 'duplicates', 'Duplicate', 'duplicates', 'is duplicated by', false, 2),
    (ws, 'relates', 'Relates', 'relates to', 'relates to', false, 3),
    (ws, 'defect', 'Defect', 'has defect', 'is a defect of', true, 4),
    (ws, 'tests', 'Test', 'tests', 'is tested by', true, 5)
  on conflict do nothing
$$;

alter table projects add column requirement_types text[];
