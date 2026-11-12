-- Jira's Epic Status (spec 0716): To Do, In Progress or Done, apart from the epic's workflow. Existing epics already in a
-- Done status start Done, so the backlog's Epics panel keeps showing what it shows today.
alter table issues add column epic_status text check (epic_status in ('To Do', 'In Progress', 'Done'));
update issues i set epic_status = case when st.category = 'done' then 'Done' else 'To Do' end from statuses st where st.id = i.status_id and i.type = 'epic';
