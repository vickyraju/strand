-- Spec 0710: License cleanup is removed (Strand has no licences). Its run history, its setting and any queued run go;
-- the audit log keeps its old entries. users.cleanup_warned_at is dropped in a later release, once no running pod
-- writes it (rolling deploys).
drop table license_cleanup_runs;
delete from system_settings where key = 'licenseCleanup';
delete from jobs where kind = 'license.cleanup';
