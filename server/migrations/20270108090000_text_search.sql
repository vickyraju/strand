-- Text search as Jira's (spec 0609): words in the workspace's indexing language (System settings › Search), stemmed,
-- without stop words; the text as written for wildcards; comments too. Kept up to date by triggers.
create extension if not exists fuzzystrmatch;

-- the workspace's indexing language; Other is no stemming and no stop words (Jira's "Other"). English by default
create function search_config(ws uuid) returns regconfig language sql stable as $$
  select case when l = 'other' then 'simple'::regconfig else l::regconfig end
    from (select coalesce((select value->>'indexingLanguage' from system_settings where workspace_id = ws and key = 'search'), 'english') as l) s
$$;

-- an item's searchable text: summary, description and its text custom fields; and its words
alter table issues alter column search drop expression;
alter table issues add column search_text text not null default '';
create function issue_search_text(i issues) returns text language sql stable as $$
  select concat_ws(' ', i.title, i.description, (select string_agg(i.custom ->> (f.id::text), ' ') from custom_fields f
    where f.workspace_id = i.workspace_id and f.kind in ('text', 'textarea', 'readonly') and jsonb_typeof(i.custom -> (f.id::text)) = 'string'))
$$;
update issues i set search_text = issue_search_text(i);
update issues i set search = to_tsvector(search_config(i.workspace_id), i.search_text);
create function issues_search() returns trigger language plpgsql as $$
begin
  new.search_text := issue_search_text(new);
  new.search := to_tsvector(search_config(new.workspace_id), new.search_text);
  return new;
end $$;
create trigger issues_search before insert or update of title, description, custom on issues for each row execute function issues_search();
create index issues_search_text_trgm on issues using gin (search_text gin_trgm_ops);

alter table comments add column search tsvector not null default ''::tsvector;
update comments c set search = to_tsvector(search_config(i.workspace_id), c.body) from issues i where i.id = c.issue_id;
create function comments_search() returns trigger language plpgsql as $$
begin
  new.search := to_tsvector(search_config((select workspace_id from issues where id = new.issue_id)), new.body);
  return new;
end $$;
create trigger comments_search before insert or update of body on comments for each row execute function comments_search();
create index comments_search on comments using gin (search);
create index comments_body_trgm on comments using gin (body gin_trgm_ops);
