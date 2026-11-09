-- Spec 0304: a version can be archived (Jira's): hidden from pickers and the Releases view, kept on the items that have it.
alter table releases add column archived boolean not null default false;
