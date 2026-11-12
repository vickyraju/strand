-- A shared workflow or scheme can reach thousands of projects, so it is applied by a background job that reports how
-- far it has got, and previews look only at the items that could move.
alter table jobs add column progress jsonb;
create index on issues (status_id);
-- finding the projects that use a scheme (and so a workflow)
create index on projects (workflow_scheme_id, key);
