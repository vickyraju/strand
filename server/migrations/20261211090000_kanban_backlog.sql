-- Spec 0406: a Kanban board's backlog, as Jira's "Kanban Backlog" column: the global statuses in it (empty: no backlog).
-- Its items leave the board and are planned on the Backlog tab.
alter table boards add column kanban_backlog jsonb not null default '[]';
