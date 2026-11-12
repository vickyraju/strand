// Project templates (spec 0310): Jira's Software and Business templates. Each brings a workflow scheme (seeded in every
// workspace by name), work types and a board; sprints stay Scrum's.
export const TEMPLATES = {
  kanban:  { name: 'Kanban', group: 'Software', scheme: 'Kanban', board: 'kanban', types: ['epic', 'story', 'task', 'bug'], statuses: 'To do, In progress, Done',
    desc: 'Visualize work on a board and keep it flowing. Good for support, ops and continuous delivery.' },
  scrum:   { name: 'Scrum', group: 'Software', scheme: 'Scrum', board: 'scrum', types: ['epic', 'story', 'task', 'bug'], statuses: 'To do, In progress, In review, Done',
    desc: 'Plan work in sprints from a prioritized backlog, with burndown and velocity reports.' },
  basic:   { name: 'Basic', group: 'Software', scheme: 'Basic software development', board: 'kanban', types: ['epic', 'task', 'bug', 't-improvement', 't-newfeature'], statuses: 'To do, In progress, In review, Done',
    desc: 'Track development tasks and bugs without sprints: Jira’s Basic software development.' },
  task:    { name: 'Task management', group: 'Business', scheme: 'Task management', board: 'kanban', types: ['task'], statuses: 'To do, Done',
    desc: 'A simple list of tasks to get done, alone or as a team.' },
  project: { name: 'Project management', group: 'Business', scheme: 'Project management', board: 'kanban', types: ['task'], statuses: 'To do, In progress, Done',
    desc: 'Plan and track the tasks of a project from start to finish, with time tracking.' },
  process: { name: 'Process management', group: 'Business', scheme: 'Process management', board: 'kanban', types: ['task'], statuses: 'Open, In progress, Under review, Approved, Done',
    desc: 'Take work through a process with review and approval steps.' },
} as const
export type Template = keyof typeof TEMPLATES
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as [Template, ...Template[]]
/** Work types a template adds beyond the app's four (Jira's Basic software development). */
export const EXTRA_TYPES: Record<string, { name: string; color: string; icon: string }> = {
  't-improvement': { name: 'Improvement', color: '#0891B2', icon: 'rocket' },
  't-newfeature': { name: 'New feature', color: '#16A34A', icon: 'star' },
}
