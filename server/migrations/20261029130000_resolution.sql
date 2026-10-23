-- Resolution: how and when an item was finished. Kept by the database itself, so every way an item's status changes
-- (edits, bulk edits, automation, import, restore, a status moved to another category) keeps it right:
--   reaching a Done status sets resolved_at (now) and a resolution (Done unless one is given);
--   leaving Done clears both; staying Done keeps them (the resolution can still be changed).
alter table issues add column resolution text check (resolution in ('Done', 'Won''t do', 'Duplicate', 'Cannot reproduce'));
alter table issues add column resolved_at timestamptz;

create function track_resolution() returns trigger language plpgsql as $$
declare done_now boolean; done_before boolean := false;
begin
  select category = 'done' into done_now from statuses where id = new.status_id;
  if tg_op = 'UPDATE' then select category = 'done' into done_before from statuses where id = old.status_id; end if;
  if coalesce(done_now, false) then
    if tg_op = 'INSERT' then new.resolved_at := coalesce(new.resolved_at, now());
    elsif not coalesce(done_before, false) then new.resolved_at := now();
    else new.resolved_at := coalesce(old.resolved_at, now());
    end if;
    new.resolution := coalesce(new.resolution, 'Done');
  else
    new.resolved_at := null; new.resolution := null;
  end if;
  return new;
end $$;
create trigger issues_track_resolution before insert or update of status_id, resolution, resolved_at on issues
  for each row execute function track_resolution();

-- moving a status to or from the Done category re-evaluates the items in it
create function statuses_category_changed() returns trigger language plpgsql as $$
begin
  update issues set status_id = status_id where status_id = new.id;
  return null;
end $$;
create trigger statuses_category_changed after update of category on statuses
  for each row when (old.category is distinct from new.category) execute function statuses_category_changed();

-- existing finished items: resolved when they last reached Done (from history), else when last updated
update issues i set resolution = 'Done', resolved_at = coalesce(
    (select max(a.created_at) from activity a join statuses s on s.id::text = a.to_value
      where a.issue_id = i.id and a.field = 'statusId' and s.category = 'done'), i.updated_at)
 where i.status_id in (select id from statuses where category = 'done');
