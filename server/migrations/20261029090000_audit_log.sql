-- Who changed what, and when: people and roles, project settings and workflow, automation, deletions, tokens,
-- provisioning, imports. Append-only: rows can be added but never changed or removed (not even by the API).
-- Rows hold plain ids and names (no foreign keys), so the record outlives the projects and people it mentions.
create table audit_log (
  id           uuid primary key default uuid_v7(),
  workspace_id uuid,                -- empty for changes outside any workspace (SCIM provisioning)
  at           timestamptz not null default now(),
  actor_id     uuid,                -- empty when no person acted (SCIM, automation)
  actor        text not null,       -- the person's email at the time, or 'SCIM'
  action       text not null,       -- e.g. project.member.added
  project_id   uuid,
  project_key  text,
  target_type  text not null,       -- project, member, status, transition, field, rule, template, release, issue, token, user
  target_id    text,
  target       text,                -- readable name of the target (PAY-12, a status name, an email)
  before       jsonb,
  after        jsonb,
  ip           text
);
create index on audit_log (workspace_id, at desc, id desc);
create index on audit_log (project_id, at desc, id desc) where project_id is not null;
alter table audit_log enable row level security;

create function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'The audit log can only be added to';
end $$;
create trigger audit_log_append_only before update or delete or truncate on audit_log
  for each statement execute function audit_log_append_only();
