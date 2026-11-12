-- The labels used in a workspace, so a label filter can offer them without scanning every work item.
-- A trigger records labels whenever an item is created or its labels change, so no code path can forget to.
create table labels (
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  primary key (workspace_id, name)
);
create index on labels (workspace_id, lower(name) text_pattern_ops);

insert into labels (workspace_id, name)
  select distinct workspace_id, unnest(labels) from issues where cardinality(labels) > 0
  on conflict do nothing;

create function note_labels() returns trigger language plpgsql as $$
begin
  if cardinality(new.labels) > 0 then
    insert into labels (workspace_id, name) select new.workspace_id, unnest(new.labels) on conflict do nothing;
  end if;
  return new;
end $$;

create trigger issues_note_labels after insert or update of labels on issues
  for each row execute function note_labels();

alter table labels enable row level security;
