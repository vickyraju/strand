-- Remaining estimate (Jira's time tracking): minutes of work left, counted down as work is logged. Items that already
-- have an original estimate start at what is left of it.
alter table issues add column time_remaining integer check (time_remaining >= 0);
update issues i set time_remaining = greatest(0, i.time_estimate - coalesce((select sum(w.minutes) from worklogs w where w.issue_id = i.id), 0))
 where i.time_estimate is not null;
