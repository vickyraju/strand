-- Spec 0706: rate limiting counts every request but the web app's; anonymous requests count together as Anonymous,
-- listed with no person (user_id null)
alter table rate_limited_accounts drop constraint rate_limited_accounts_pkey;
alter table rate_limited_accounts alter column user_id drop not null;
create unique index rate_limited_accounts_person on rate_limited_accounts (workspace_id, user_id) where user_id is not null;
create unique index rate_limited_accounts_anonymous on rate_limited_accounts (workspace_id) where user_id is null;
