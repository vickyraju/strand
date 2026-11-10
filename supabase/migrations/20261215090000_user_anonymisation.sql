-- Spec 0704: anonymised people (their personal data is gone; their work shows an alias)
alter table users add column anonymised_at timestamptz;

-- The audit log stays append-only, with one narrow exception that GDPR and Jira's anonymisation need: inside an
-- anonymisation (the transaction sets strand.anonymising), a row's texts (actor, target, before, after) may have a
-- person's details replaced. Its ids, action, project and time never change, and rows are never deleted.
drop trigger audit_log_append_only on audit_log;
create trigger audit_log_append_only before delete or truncate on audit_log
  for each statement execute function audit_log_append_only();
create function audit_log_anonymise_only() returns trigger language plpgsql as $$
begin
  if current_setting('strand.anonymising', true) = 'on'
     and (new.id, new.workspace_id, new.at, new.actor_id, new.action, new.project_id, new.project_key, new.target_type, new.target_id, new.ip)
         is not distinct from (old.id, old.workspace_id, old.at, old.actor_id, old.action, old.project_id, old.project_key, old.target_type, old.target_id, old.ip) then
    return new;
  end if;
  raise exception 'The audit log can only be added to';
end $$;
create trigger audit_log_anonymise_only before update on audit_log
  for each row execute function audit_log_anonymise_only();
