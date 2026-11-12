-- Groups (spec 0104): where each came from, and names unique ignoring case.
--   local      made here: its owners and system administrators manage it
--   directory  provisioned by Entra over SCIM: read-only here, as a read-only directory is in Jira
--   system     users-access and system-administrators
alter table groups add column source text not null default 'local' check (source in ('local', 'directory', 'system'));
update groups set source = 'system' where system_role is not null;
-- A directory group: one with the directory's id, or one made with no creator (only SCIM leaves it empty; people are never deleted)
update groups set source = 'directory' where system_role is null and (external_id is not null or created_by is null);

-- Names already shared keep the oldest's; the others become "Name (2)", "Name (3)"…, each recorded in the audit log
with dup as (
  select id, display_name, row_number() over (partition by lower(display_name) order by created_at, id) as n from groups
), renamed as (
  update groups g set display_name = dup.display_name || ' (' || dup.n || ')' from dup where dup.id = g.id and dup.n > 1
  returning g.id, dup.display_name as before, g.display_name as after
)
insert into audit_log (actor, action, target_type, target_id, target, before, after)
select 'system', 'group.renamed', 'group', id::text, after, jsonb_build_object('name', before), jsonb_build_object('name', after, 'why', 'Group names are unique') from renamed;

create unique index groups_name_unique on groups (lower(display_name));
