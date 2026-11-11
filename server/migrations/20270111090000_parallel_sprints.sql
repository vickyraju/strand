-- Parallel sprints (spec 0414): with System settings › Sprints › Parallel sprints on, a board can have more than one
-- active sprint. The server checks the rule under a lock on the board, so the unique index goes.
drop index sprints_one_active;
create index sprints_active on sprints (board_id) where state = 'active';
