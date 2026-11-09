-- Spec 0408: Jira's flag (the "Flagged" field, value Impediment): a work item that is blocked or needs attention.
alter table issues add column flagged boolean not null default false;
