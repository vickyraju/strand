-- Archived projects (spec 0102): who archived it, for Administration › Archived projects, newest first.
alter table projects add column archived_by uuid references users on delete set null;
create index projects_archived_idx on projects (workspace_id, archived_at desc, id desc) where archived_at is not null;
