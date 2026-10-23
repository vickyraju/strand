-- One "due" reminder per person, item and due date, even when two API pods create reminders at the same moment.
delete from notifications a using notifications b
 where a.kind = 'due' and b.kind = 'due' and a.user_id = b.user_id and a.issue_id = b.issue_id and a.text = b.text
   and (a.created_at, a.id) > (b.created_at, b.id);
create unique index notifications_due_once on notifications (user_id, issue_id, text) where kind = 'due';
