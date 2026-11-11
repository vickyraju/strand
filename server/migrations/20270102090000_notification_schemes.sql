-- Spec 0605: Jira's notification schemes. For each of Jira's events, who hears about it; every project has one, or none.
-- Each workspace starts with Jira's Default Notification Scheme (every event: All Watchers, Current Assignee, Reporter),
-- given to every project, and new projects get whichever scheme is marked the default.
create table notification_schemes (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text not null default '',
  is_default   boolean not null default false
);
create unique index notification_schemes_name on notification_schemes (workspace_id, lower(name));
create unique index notification_schemes_one_default on notification_schemes (workspace_id) where is_default;
alter table notification_schemes enable row level security;

create table notification_scheme_entries (
  id        uuid primary key default uuid_v7(),
  scheme_id uuid not null references notification_schemes on delete cascade,
  event     text not null check (event in ('issue_created', 'issue_updated', 'issue_assigned', 'issue_resolved', 'issue_closed', 'issue_commented',
    'issue_comment_edited', 'issue_comment_deleted', 'issue_reopened', 'issue_deleted', 'issue_moved', 'issue_worklogged', 'issue_work_started',
    'issue_work_stopped', 'issue_worklog_updated', 'issue_worklog_deleted', 'issue_generic')),
  recipient text not null check (recipient in ('current_assignee', 'reporter', 'current_user', 'project_lead', 'component_lead', 'user', 'group',
    'project_role', 'all_watchers', 'user_field', 'group_field')),
  value     text    -- the person, group, role (admin, member, viewer) or custom field
);
create unique index notification_scheme_entries_once on notification_scheme_entries (scheme_id, event, recipient, coalesce(value, ''));
alter table notification_scheme_entries enable row level security;

alter table projects add column notification_scheme_id uuid references notification_schemes on delete restrict;   -- null: None

insert into notification_schemes (workspace_id, name, description, is_default)
  select id, 'Default Notification Scheme', 'Every event: all watchers, the current assignee and the reporter (Jira’s default).', true from workspaces;
insert into notification_scheme_entries (scheme_id, event, recipient)
  select s.id, e, r from notification_schemes s,
    unnest(array['issue_created', 'issue_updated', 'issue_assigned', 'issue_resolved', 'issue_closed', 'issue_commented', 'issue_comment_edited',
      'issue_comment_deleted', 'issue_reopened', 'issue_deleted', 'issue_moved', 'issue_worklogged', 'issue_work_started', 'issue_work_stopped',
      'issue_worklog_updated', 'issue_worklog_deleted', 'issue_generic']) e,
    unnest(array['all_watchers', 'current_assignee', 'reporter']) r;
update projects p set notification_scheme_id = s.id from notification_schemes s where s.workspace_id = p.workspace_id and s.is_default;

-- a new workspace gets the scheme too; a new project gets its workspace's default
create function notification_scheme_for_workspace() returns trigger language plpgsql as $$
declare s uuid;
begin
  insert into notification_schemes (workspace_id, name, description, is_default)
    values (new.id, 'Default Notification Scheme', 'Every event: all watchers, the current assignee and the reporter (Jira’s default).', true) returning id into s;
  insert into notification_scheme_entries (scheme_id, event, recipient)
    select s, e, r from unnest(array['issue_created', 'issue_updated', 'issue_assigned', 'issue_resolved', 'issue_closed', 'issue_commented', 'issue_comment_edited',
      'issue_comment_deleted', 'issue_reopened', 'issue_deleted', 'issue_moved', 'issue_worklogged', 'issue_work_started', 'issue_work_stopped',
      'issue_worklog_updated', 'issue_worklog_deleted', 'issue_generic']) e, unnest(array['all_watchers', 'current_assignee', 'reporter']) r;
  return new;
end $$;
create trigger notification_scheme_for_workspace after insert on workspaces for each row execute function notification_scheme_for_workspace();

create function notification_scheme_for_project() returns trigger language plpgsql as $$
begin
  if new.notification_scheme_id is null then
    new.notification_scheme_id := (select id from notification_schemes where workspace_id = new.workspace_id and is_default);
  end if;
  return new;
end $$;
create trigger notification_scheme_for_project before insert on projects for each row execute function notification_scheme_for_project();

-- the kinds a person chooses Inbox and email for gain "updated": the other events a scheme sends them
alter table notification_prefs drop constraint notification_prefs_kind_check;
alter table notification_prefs add constraint notification_prefs_kind_check check (kind in ('assigned', 'mentioned', 'commented', 'status', 'due', 'automation', 'updated'));
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('assigned', 'mentioned', 'commented', 'status', 'due', 'automation', 'updated'));
