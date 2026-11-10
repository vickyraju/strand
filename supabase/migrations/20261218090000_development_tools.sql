-- Development tools (spec 0707): a GitHub installation Strand doesn't know waits for a system admin to connect it,
-- so whoever installs a public GitHub App can't add their work to Strand's items.
alter table integrations drop constraint integrations_status_check;
alter table integrations add constraint integrations_status_check check (status in ('pending', 'active', 'suspended'));
