-- Automation (spec 0709): a JQL condition, scheduled rules, and global rules (no project: a scope over the workspace's projects).
alter table rules add column condition text;
alter table rules add column last_run_at timestamptz;
alter table rules add column workspace_id uuid references workspaces on delete cascade;
alter table rules add column scope jsonb;
alter table rules alter column project_id drop not null;
alter table rules add constraint rules_global_check check ((project_id is null) = (workspace_id is not null and scope is not null));
create index on rules (workspace_id) where project_id is null and enabled;

alter table rule_runs drop constraint rule_runs_result_check;
alter table rule_runs add constraint rule_runs_result_check check (result in ('success', 'some_skipped', 'no_change', 'failed', 'condition_not_met'));
