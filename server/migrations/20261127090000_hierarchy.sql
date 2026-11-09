-- Spec 0303: Jira's levels (epic > item > sub-item), now kept by the server. Rows that break them are detached from their
-- parent, with a line in their history; nothing is deleted.
with broken as (
  -- an epic has no parent
  select id from issues where type = 'epic' and parent_id is not null
  -- a sub-item is in its parent's project
  union select i.id from issues i join issues p on p.id = i.parent_id where p.type <> 'epic' and p.project_id <> i.project_id
  -- a sub-item has no sub-items: an item whose parent is itself under an item (unless that parent is detached above)
  union select i.id from issues i join issues p on p.id = i.parent_id join issues g on g.id = p.parent_id
   where p.type <> 'epic' and g.type <> 'epic' and g.project_id = p.project_id
), detached as (
  update issues set parent_id = null, version = version + 1, updated_at = now() where id in (select id from broken) returning id
)
insert into activity (issue_id, actor_id, field, text) select id, null, 'parentId', 'Parent removed: it broke the work item hierarchy' from detached;
