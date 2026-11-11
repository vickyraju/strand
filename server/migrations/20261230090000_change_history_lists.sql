-- Spec 0601 follow-up: a list change from none to one value (or back) kept the empty side as '' rather than no value.
create or replace function activity_on_write() returns trigger language plpgsql as $$
declare a text[]; b text[]; x text;
begin
  if new.field in ('fixReleaseIds', 'affectsReleaseIds', 'componentIds') then
    new.from_value := nullif(new.from_value, '');
    new.to_value := nullif(new.to_value, '');
    a := coalesce(string_to_array(new.from_value, ','), '{}');
    b := coalesce(string_to_array(new.to_value, ','), '{}');
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

update activity set from_value = nullif(from_value, ''), to_value = nullif(to_value, '')
 where field in ('fixReleaseIds', 'affectsReleaseIds', 'componentIds') and (from_value = '' or to_value = '');
