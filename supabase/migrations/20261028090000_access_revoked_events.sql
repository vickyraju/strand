-- Live streams must stop when access stops. Every way access can end (removed from a project, deactivated,
-- demoted from workspace admin, project deleted) announces it on the same channel the streams listen to,
-- whichever API pod or code path made the change. The API closes the matching streams; a stream the person
-- may still open reconnects and is checked again.
create function notify_access_revoked() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'project_members' then
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'projectId', old.project_id, 'userId', old.user_id)::text);
  elsif tg_table_name = 'projects' then
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'projectId', old.id)::text);
  elsif tg_table_name = 'users' then
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'userId', old.id)::text);
  elsif tg_table_name = 'memberships' then
    perform pg_notify('strand', json_build_object('type', 'access.revoked', 'userId', old.user_id)::text);
  end if;
  return null;
end $$;

create trigger project_members_revoke after delete on project_members
  for each row execute function notify_access_revoked();
create trigger projects_revoke after delete on projects
  for each row execute function notify_access_revoked();
create trigger users_revoke after update of active on users
  for each row when (old.active and not new.active) execute function notify_access_revoked();
-- Sign-in rewrites the role on every request, so only a real demotion counts
create trigger memberships_demote after update of role on memberships
  for each row when (old.role in ('owner', 'admin') and new.role = 'member') execute function notify_access_revoked();
create trigger memberships_remove after delete on memberships
  for each row execute function notify_access_revoked();
