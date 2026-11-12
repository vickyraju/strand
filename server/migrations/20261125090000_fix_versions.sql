-- Spec 0301: an item has several fix versions, as Jira's Fix Version/s (affects versions already are a list).
alter table issues add column fix_release_ids uuid[] not null default '{}';
update issues set fix_release_ids = array[release_id] where release_id is not null;
alter table issues drop column release_id;
create index issues_fix_release_ids on issues using gin (fix_release_ids);

-- Workflow rules name the field by its new name (a "set" action's single version is read as a one-element list)
update transitions set rules = replace(rules::text, '"releaseId"', '"fixReleaseIds"')::jsonb where rules::text like '%"releaseId"%';
update workflows set transitions = replace(transitions::text, '"releaseId"', '"fixReleaseIds"')::jsonb where transitions::text like '%"releaseId"%';
update workflow_versions set transitions = replace(transitions::text, '"releaseId"', '"fixReleaseIds"')::jsonb where transitions::text like '%"releaseId"%';
