-- Spec 0302: one rank order for every work item in a workspace (Jira's global Rank). Existing ranks are renumbered once,
-- in their current order (ties, from different projects, broken by id), and new items go after all of them.
update issues i set rank = r.n * 1024
  from (select id, row_number() over (partition by workspace_id order by rank, id) as n from issues) r
 where i.id = r.id;
create index issues_workspace_rank on issues (workspace_id, rank, id) where deleted_at is null;
