-- Spec 0601: every change keeps the old and new names as they read at that moment (Jira's oldstring and newstring), a list
-- field's change is one row per value added or removed (Jira's changeitems), and the six fields history search runs over
-- (spec 0602) are indexed. The database does it on write, so every path that records a change is covered.
alter table activity add column from_string text;
alter table activity add column to_string text;

create function activity_name(f text, v text, issue uuid) returns text language sql stable as $$
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
    when f = 'parentId' then (select p.key || '-' || i.number from issues i join projects p on p.id = i.project_id where i.id = v::uuid)
  end
$$;

create function activity_on_write() returns trigger language plpgsql as $$
declare a text[]; b text[]; x text;
begin
  if new.field in ('fixReleaseIds', 'affectsReleaseIds', 'componentIds') then
    a := coalesce(string_to_array(nullif(new.from_value, ''), ','), '{}');
    b := coalesce(string_to_array(nullif(new.to_value, ''), ','), '{}');
    if not (cardinality(a) + cardinality(b) = 1) then   -- whole lists: one row per value removed and per value added
      for x in select unnest(a) except select unnest(b) loop
        insert into activity (issue_id, actor_id, field, from_value, to_value, text, created_at) values (new.issue_id, new.actor_id, new.field, x, null, new.text, new.created_at);
      end loop;
      for x in select unnest(b) except select unnest(a) loop
        insert into activity (issue_id, actor_id, field, from_value, to_value, text, created_at) values (new.issue_id, new.actor_id, new.field, null, x, new.text, new.created_at);
      end loop;
      return null;
    end if;
  end if;
  if new.field is not null then
    new.from_string := coalesce(new.from_string, activity_name(new.field, new.from_value, new.issue_id));
    new.to_string := coalesce(new.to_string, activity_name(new.field, new.to_value, new.issue_id));
  end if;
  return new;
end
$$;
create trigger activity_on_write before insert on activity for each row execute function activity_on_write();

-- today's history: list rows split (through the trigger), then names from today's names
with gone as (
  delete from activity where field in ('fixReleaseIds', 'affectsReleaseIds', 'componentIds')
     and cardinality(coalesce(string_to_array(nullif(from_value, ''), ','), '{}')) + cardinality(coalesce(string_to_array(nullif(to_value, ''), ','), '{}')) <> 1
  returning *)
insert into activity (issue_id, actor_id, field, from_value, to_value, text, created_at) select issue_id, actor_id, field, from_value, to_value, text, created_at from gone;
update activity set from_string = activity_name(field, from_value, issue_id), to_string = activity_name(field, to_value, issue_id)
 where field in ('statusId', 'assigneeId', 'reporterId', 'priority', 'resolution', 'type', 'fixReleaseIds', 'affectsReleaseIds', 'componentIds', 'sprintId', 'parentId')
   and from_string is null and to_string is null;

create index activity_history_to on activity (field, to_value) where field in ('statusId', 'assigneeId', 'reporterId', 'priority', 'resolution', 'fixReleaseIds');
create index activity_history_from on activity (field, from_value) where field in ('statusId', 'assigneeId', 'reporterId', 'priority', 'resolution', 'fixReleaseIds');
create index activity_history_to_name on activity (field, lower(to_string)) where field in ('statusId', 'assigneeId', 'reporterId', 'priority', 'resolution', 'fixReleaseIds');
create index activity_history_from_name on activity (field, lower(from_string)) where field in ('statusId', 'assigneeId', 'reporterId', 'priority', 'resolution', 'fixReleaseIds');
