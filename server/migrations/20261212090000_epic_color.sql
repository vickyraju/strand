-- Spec 0407: an epic's colour, as Jira's Epic Colour (one of its fourteen labels, ghx-label-1 … ghx-label-14)
alter table issues add column epic_color text check (epic_color ~ '^ghx-label-([1-9]|1[0-4])$');
