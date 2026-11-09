-- Spec 0307: a label is one word, as in Jira. Spaces in existing labels become "_" ("ui polish" → "ui_polish"), and
-- an item or template that then has a label twice keeps one.
update issues set labels = array(select x from unnest(labels) with ordinality u(l, n), regexp_replace(trim(l), '\s+', '_', 'g') x group by x order by min(n))
 where exists (select 1 from unnest(labels) l where l ~ '\s');
update item_templates set labels = array(select x from unnest(labels) with ordinality u(l, n), regexp_replace(trim(l), '\s+', '_', 'g') x group by x order by min(n))
 where exists (select 1 from unnest(labels) l where l ~ '\s');
