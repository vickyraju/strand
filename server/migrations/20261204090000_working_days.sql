-- Spec 0405: a board's working days (Jira's): its working weekdays (0 is Sunday) and non-working dates. The burndown's
-- guideline falls only on working days.
alter table boards add column working_days jsonb not null default '{"weekdays": [1, 2, 3, 4, 5], "nonWorking": []}';
