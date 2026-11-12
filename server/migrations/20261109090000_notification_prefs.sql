-- What each person hears about, and how (Jira's notification settings): for each kind of notification, in the Inbox
-- and/or by email. A kind with no row: Inbox on; email on, once a workspace admin turns email on (System settings).
create table notification_prefs (
  user_id uuid not null references users on delete cascade,
  kind    text not null check (kind in ('assigned', 'mentioned', 'commented', 'status', 'due', 'automation')),
  inbox   boolean not null default true,
  email   boolean not null default true,
  primary key (user_id, kind)
);
alter table notification_prefs enable row level security;

-- Every notification, whichever code makes it, passes here: an email is queued if the person wants one (and the
-- workspace sends email); the Inbox entry is kept only if they want that.
create function notifications_route() returns trigger language plpgsql as $$
declare
  pref notification_prefs;
  ws uuid;
  sends boolean;
begin
  select * into pref from notification_prefs where user_id = new.user_id and kind = new.kind;
  select workspace_id into ws from issues where id = new.issue_id;
  select coalesce((value->>'enabled')::boolean, false) into sends from system_settings where workspace_id = ws and key = 'email';
  if coalesce(sends, false) and coalesce(pref.email, true) then
    insert into jobs (kind, payload, workspace_id, max_attempts)
    values ('email.notification', jsonb_build_object('userId', new.user_id, 'actorId', new.actor_id, 'issueId', new.issue_id, 'kind', new.kind, 'text', new.text), ws, 8);
  end if;
  if not coalesce(pref.inbox, true) then return null; end if;
  return new;
end $$;
create trigger notifications_route before insert on notifications for each row execute function notifications_route();
