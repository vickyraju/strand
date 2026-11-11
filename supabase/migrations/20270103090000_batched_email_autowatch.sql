-- Spec 0606: Jira's user preferences Autowatch and My changes (unset: System settings › Default user preferences), and
-- Jira 8's batched email notifications: with batching on, a person's emails about one work item wait for the window,
-- then go as one email; @mentions go at once.
create table user_preferences (
  user_id            uuid primary key references users on delete cascade,
  autowatch          boolean,
  notify_own_changes boolean
);
alter table user_preferences enable row level security;

create table email_batch_items (
  id         uuid primary key default uuid_v7(),
  user_id    uuid not null references users on delete cascade,
  issue_id   uuid not null references issues on delete cascade,
  actor_id   uuid references users on delete set null,
  text       text not null,
  created_at timestamptz not null default now()
);
create index on email_batch_items (user_id, issue_id, created_at);
alter table email_batch_items enable row level security;

-- every notification still passes here; with batching on, its email joins the person's batch for that work item
create or replace function notifications_route() returns trigger language plpgsql as $$
declare
  pref notification_prefs;
  ws uuid;
  sends boolean;
  batch jsonb;
begin
  select * into pref from notification_prefs where user_id = new.user_id and kind = new.kind;
  select workspace_id into ws from issues where id = new.issue_id;
  select coalesce((value->>'enabled')::boolean, false) into sends from system_settings where workspace_id = ws and key = 'email';
  select value into batch from system_settings where workspace_id = ws and key = 'emailBatching';
  if coalesce(sends, false) and coalesce(pref.email, true) then
    if coalesce((batch->>'enabled')::boolean, false) and new.kind <> 'mentioned' then
      insert into email_batch_items (user_id, issue_id, actor_id, text) values (new.user_id, new.issue_id, new.actor_id, new.text);
      insert into jobs (kind, payload, workspace_id, max_attempts, run_at, dedupe_key)
        values ('email.batch', jsonb_build_object('userId', new.user_id, 'issueId', new.issue_id), ws, 8,
                now() + make_interval(mins => coalesce((batch->>'minutes')::int, 10)), 'email.batch:' || new.user_id || ':' || new.issue_id)
        on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing;
    else
      insert into jobs (kind, payload, workspace_id, max_attempts)
      values ('email.notification', jsonb_build_object('userId', new.user_id, 'actorId', new.actor_id, 'issueId', new.issue_id, 'kind', new.kind, 'text', new.text), ws, 8);
    end if;
  end if;
  if not coalesce(pref.inbox, true) then return null; end if;
  return new;
end $$;
