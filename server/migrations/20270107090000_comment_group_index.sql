-- Comments restricted to a group, found by the group (spec 0106: counted and moved when the group is deleted)
create index comments_visibility_group on comments ((visibility->>'id')) where visibility->>'kind' = 'group';
