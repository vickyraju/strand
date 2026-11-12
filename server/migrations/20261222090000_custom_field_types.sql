-- Jira DC's custom field types (spec 0502). Values stay in issues.custom: text, numbers, or lists of text.
alter table field_defs drop constraint field_defs_kind_check;
alter table field_defs add constraint field_defs_kind_check check (kind in ('text', 'textarea', 'readonly', 'number', 'date', 'datetime', 'url',
  'select', 'radio', 'multiselect', 'checkboxes', 'cascading', 'labels', 'user', 'users', 'group', 'groups', 'project', 'version', 'versions'));
