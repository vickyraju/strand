-- Transition rules (Jira's): who may use a transition (restrict), what must be true to make it (validate), fields to
-- fill in (screen) and changes it makes (actions). Shape: server/src/shared/transitionRules.ts. Empty: no rules.
alter table transitions add column rules jsonb not null default '{}';

-- A loop: a transition that leaves the item in its status ("Any status → itself" in Jira), such as "Log progress".
-- to_id null means "stays where it is".
alter table transitions alter column to_id drop not null;
