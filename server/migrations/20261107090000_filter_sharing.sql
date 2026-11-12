-- Sharing saved filters as Jira does: besides the whole workspace (`shared`), with projects, groups or people, each to
-- view or to edit: [{ "kind": "project" | "group" | "user", "id": uuid, "can": "view" | "edit" }].
alter table saved_views add column share jsonb not null default '[]';
-- a filter outlives its owner leaving: an admin gives it to someone else (Jira's "change owner")
alter table saved_views drop constraint saved_views_owner_id_fkey;
alter table saved_views add constraint saved_views_owner_id_fkey foreign key (owner_id) references users on delete restrict;
