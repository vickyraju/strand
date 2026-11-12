-- Jira administrators (spec 0717 R5): a global permission for most administration, granted to groups
alter table global_permissions drop constraint global_permissions_permission_check;
alter table global_permissions add constraint global_permissions_permission_check
  check (permission in ('system-admin', 'jira-admin', 'browse-users', 'shared-objects', 'group-subscriptions', 'bulk-change'));
