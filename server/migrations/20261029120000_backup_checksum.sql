-- A backup's checksum is kept in the database: restore refuses a backup document that was changed after it was written.
alter table project_backups add column sha256 text;
