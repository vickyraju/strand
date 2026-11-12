-- Spec 0404: each Scrum board's estimation statistic (Jira's): story points, original time estimate (minutes) or issue
-- count. A sprint keeps the one it was started with, so past sprints read the same after the board changes.
alter table boards add column estimation text not null default 'points' check (estimation in ('points', 'time', 'count'));
alter table sprints add column estimation text check (estimation in ('points', 'time', 'count'));
update sprints set estimation = 'points' where state <> 'planned';
