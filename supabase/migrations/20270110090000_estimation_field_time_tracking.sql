-- Spec 0412: a Scrum board's estimation statistic can be a number custom field (a sprint keeps the one it started with);
-- remaining-estimate time tracking; the team's time zone lives in working_days (JSON, nothing to change here).
alter table boards drop constraint boards_estimation_check;
alter table boards add constraint boards_estimation_check check (estimation in ('points', 'time', 'count', 'field'));
alter table boards add column estimation_field_id uuid references custom_fields on delete set null;
alter table boards add column time_tracking text not null default 'none' check (time_tracking in ('none', 'remaining'));
alter table sprints drop constraint sprints_estimation_check;
alter table sprints add constraint sprints_estimation_check check (estimation in ('points', 'time', 'count', 'field'));
alter table sprints add column estimation_field_id uuid references custom_fields on delete set null;
-- a board whose field is deleted falls back to story points, as Jira does
create function boards_estimation_field_gone() returns trigger language plpgsql as $$
begin
  if new.estimation = 'field' and new.estimation_field_id is null then new.estimation := 'points'; end if;
  return new;
end $$;
create trigger boards_estimation_field_gone before update of estimation_field_id on boards for each row execute function boards_estimation_field_gone();

-- a custom field's change was stored as "[object Object]": its values are gone, the line stays
update activity set from_value = null, to_value = null, from_string = null, to_string = null where field = 'custom' and (from_value = '[object Object]' or to_value = '[object Object]');

-- names for a custom field's people, groups and versions in the history
create or replace function activity_name(f text, v text, issue uuid) returns text language sql stable as $$
  select case
    when v is null then null
    when f = 'resolution' then v
    when f = 'priority' then (select pr.name from priorities pr join projects p on p.workspace_id = pr.workspace_id join issues i on i.project_id = p.id where i.id = issue and pr.key = v)
    when f = 'type' then (select t.name from work_types t join issues i on i.project_id = t.project_id where i.id = issue and t.key = v)
    when v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then null
    when f = 'statusId' then (select name from statuses where id = v::uuid)
    when f in ('assigneeId', 'reporterId') then (select name from users where id = v::uuid)
    when f in ('fixReleaseIds', 'affectsReleaseIds') then (select name from releases where id = v::uuid)
    when f = 'componentIds' then (select name from components where id = v::uuid)
    when f = 'sprintId' then (select name from sprints where id = v::uuid)
    when f in ('parentId', 'parentLinkId') then (select p.key || '-' || i.number from issues i join projects p on p.id = i.project_id where i.id = v::uuid)
    when f like 'custom:%' then coalesce((select name from users where id = v::uuid), (select display_name from groups where id = v::uuid), (select name from releases where id = v::uuid))
  end
$$;
