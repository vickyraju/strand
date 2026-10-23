-- Attachments: an attachment exists once its file has arrived, and a removed file is deleted from storage reliably.
--  * uploaded_at stays empty until the browser confirms the upload and the API has checked the object is there.
--    Unconfirmed attachments are hidden and cleaned up after a day.
--  * Deleting an attachment row, by any route (removing it, deleting its item or project), queues its object for
--    deletion; a sweeper deletes queued objects and retries the ones that fail.
alter table attachments add column uploaded_at timestamptz;
update attachments set uploaded_at = added_at;

create table file_deletions (
  object_key text primary key,
  queued_at  timestamptz not null default now(),
  attempts   int not null default 0,
  last_error text
);
alter table file_deletions enable row level security;

create function queue_file_deletion() returns trigger language plpgsql as $$
begin
  insert into file_deletions (object_key) values (old.object_key) on conflict do nothing;
  return null;
end $$;
create trigger attachments_queue_file_deletion after delete on attachments
  for each row execute function queue_file_deletion();
