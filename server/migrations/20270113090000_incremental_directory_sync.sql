-- Incremental directory synchronisation (spec 0713): the highest uSNChanged seen, the settings' fingerprint and when the
-- last full run was; and each directory user's DN, so a group's members are matched without reading every user.
alter table user_directories add column sync_state jsonb;
alter table users add column directory_dn text;
create index on users (directory_id, lower(directory_dn)) where directory_id is not null;
update user_directories set config = config || jsonb_build_object('incremental', type = 'ad', 'fullSyncHours', 24);
