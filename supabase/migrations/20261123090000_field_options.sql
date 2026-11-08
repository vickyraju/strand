-- Custom field options (spec 0105, as Jira): each option has an id, so renaming one carries through to every item that
-- has it; an option can be disabled (no longer offered, items keep it). Options become [{ id, name, disabled }].
-- A value an item holds that is no longer an option (left by an earlier rename or removal) becomes a disabled option of
-- that name, so nothing is lost.
alter table field_defs add column options_new jsonb;
update field_defs f set options_new = (
  select coalesce(jsonb_agg(jsonb_build_object('id', gen_random_uuid()::text, 'name', x.o, 'disabled', false) order by x.n), '[]'::jsonb)
    from unnest(f.options) with ordinality as x(o, n))
 where f.options is not null;
alter table field_defs drop column options;
alter table field_defs rename column options_new to options;

update field_defs f set options = coalesce(f.options, '[]'::jsonb) || stray.extra
  from (select f2.id, jsonb_agg(jsonb_build_object('id', gen_random_uuid()::text, 'name', v.val, 'disabled', true) order by v.val) as extra
          from field_defs f2
          join lateral (select distinct i.custom ->> f2.id::text as val from issues i
                         where i.project_id = f2.project_id and i.custom ? f2.id::text and jsonb_typeof(i.custom -> f2.id::text) = 'string') v on true
         where f2.kind = 'select'
           and not exists (select 1 from jsonb_array_elements(coalesce(f2.options, '[]'::jsonb)) o where o ->> 'name' = v.val)
         group by f2.id) stray
 where stray.id = f.id;
