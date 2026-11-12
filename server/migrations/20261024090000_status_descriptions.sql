-- A status can say what it means ("Waiting for the customer to reply"), shown in the workflow editor and on the board.
alter table statuses add column description text not null default '';
