-- Issue security levels are taken out for now (the product's choice: one team uses a project, so per-item restrictions
-- aren't needed). Comment visibility stays. The feature can come back from version control if it's needed.
alter table issues drop column security_level_id;
drop table security_levels;
drop function issue_visible(uuid, uuid, uuid, uuid, uuid, boolean);
