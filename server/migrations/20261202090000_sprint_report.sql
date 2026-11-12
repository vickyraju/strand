-- Spec 0402: what a sprint held when it started (with each item's points then) and what it completed, for the Sprint
-- Report. Sprints completed before this keep their completed items (those still in them, in a Done status); their start
-- isn't known.
alter table sprints add column start_estimates jsonb;
alter table sprints add column completed_ids uuid[];
update sprints s set completed_ids = array(
    select i.id from issues i join statuses st on st.id = i.status_id
     where i.sprint_id = s.id and i.id = any(s.issue_ids) and st.category = 'done')
 where s.state = 'closed';
