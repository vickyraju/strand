-- Deleted work items (spec 0202): who deleted one, for Project settings › Deleted work items; deleted items are removed
-- for good after the retention period in System settings. (An epic's items keep their link to a deleted epic, shown as no
-- epic, so restoring it gives it back.)
alter table issues add column deleted_by uuid references users on delete set null;
create index issues_deleted_idx on issues (project_id, deleted_at desc, id desc) where deleted_at is not null;
