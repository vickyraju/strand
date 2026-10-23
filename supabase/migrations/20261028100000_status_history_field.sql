-- Status changes are recorded as field 'statusId' (what edits on the server write, and what reports read).
-- History that came in through import was stored under the app's own name, 'status'; rename it where it points at a real status.
update activity a set field = 'statusId'
 where a.field = 'status' and exists (select 1 from statuses s where s.id::text = a.to_value);
