-- Archiving single work items (spec 0508), as Jira DC's: archived items are read-only and leave lists, boards, search and
-- reports; they still open by their key, and a system administrator restores them.
alter table issues add column archived_at timestamptz;
alter table issues add column archived_by uuid references users on delete set null;
create index issues_archived on issues (workspace_id, archived_at desc) where archived_at is not null;
