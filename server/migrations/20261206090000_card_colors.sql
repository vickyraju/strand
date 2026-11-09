-- Spec 0409: a board's card colours (Jira's "Colors based on"): none, work types, priorities, assignees or JQL queries,
-- each method keeping its own colours. Shown as a stripe on a card's left edge.
alter table boards add column card_colors jsonb not null default '{"by": "none"}';
