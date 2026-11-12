# 0310 Project templates: Basic software and Business

Status: Implemented

## Context and Jira reference

- **Jira DC** (Projects › Create project) offers templates in two groups.
  - **Software:**
    - **Scrum** and **Kanban**, each with its board.
    - **Basic software development**, for tracking development tasks and bugs without Scrum or Kanban. Its types are Bug, Task, Improvement, New Feature, Epic and Sub-task; its workflow is To Do, In Progress, In Review, Done. Older versions used Open, In Progress, Resolved, Reopened, Closed. These details come from product knowledge and secondary sources; they're on the end-of-project verification list.
  - **Business** (Jira Core, now Work Management), each with the types Task and Sub-task ([task management](https://confluence.atlassian.com/jiracoreserver/task-management-938846154.html), [project management](https://confluence.atlassian.com/jiracoreserver0901/project-management-1157491489.html), [process management](https://confluence.atlassian.com/jiracoreserver0903/process-management-1180147913.html)):
    - **Task management:** To Do, Done.
    - **Project management:** To Do, In Progress, Done, with time tracking.
    - **Process management:** Open, In Progress, Under Review, Approved, Done.
  - Business projects have no boards, backlog or sprints in Jira DC.
- **Before this spec:** Scrum and Kanban only. Each has its own workflow scheme and the work types Epic, Story, Task and Bug.

## Community and Atlassian backlog

| Ticket | Kind | What people ask | Here |
|---|---|---|---|
| Community: "create a project with the same configuration as another" | Question (common) | Jira DC's Create with shared configuration | P1 |
| Community: business projects with a board | Question | Jira DC's business projects have no board; Cloud's have | R2: every template has a board (an extra) |

## Rules

- **R1: Six templates.** Create project offers **Software** (Kanban, Scrum, Basic) and **Business** (Task management, Project management, Process management). Each template brings:

  | Template | Workflow scheme | Statuses | Work types | Board |
  |---|---|---|---|---|
  | Kanban | Kanban | To do, In progress, Done | Epic, Story, Task, Bug | Kanban |
  | Scrum | Scrum | To do, In progress, In review, Done | Epic, Story, Task, Bug | Scrum |
  | Basic | Basic software development | To do, In progress, In review, Done | Epic, Task, Bug, Improvement, New feature | Kanban |
  | Task management | Task management | To do, Done | Task | Kanban |
  | Project management | Project management | To do, In progress, Done | Task | Kanban |
  | Process management | Process management | Open, In progress, Under review, Approved, Done | Task | Kanban |

  - Every template's sub-items are allowed, as everywhere in the app.
  - Every status is reachable from any. The workflow editor refines that, as for Scrum and Kanban.
- **R2: Software and business.**
  - Sprints, the backlog's sprint planning and the Sprint field stay Scrum-only, as before.
  - Every template gets a board. Jira DC's business projects have none; the app gives them one as an extra, as Jira Cloud does.
  - The project's type shows where the app showed Scrum or Kanban: in the projects list, Your work and the project's details.
- **R3: Workspaces.** Every workspace has the four new workflows and schemes, the new ones included. Administrators can edit or copy them like any other. A template whose scheme an administrator deleted asks for a scheme, as Scrum and Kanban already do.

- **R4: Create with shared configuration** (P1, chosen 12 Nov 2026; Jira DC's option of the same name). Create project can name an existing project. The new project then shares its configuration instead of a template's:
  - **Shared, not copied:** the same workflow scheme, field configuration scheme, screen scheme and notification scheme. A change to them is a change for both, as in Jira.
  - **Copied:** its template (and so its board's kind), work types, testing and initiatives switches.
  - **Custom fields:** the new project joins every custom field context that names the existing project.
  - **Not carried over:** members, components, versions, sprints, boards' settings and work. The new project gets its creator as admin and a first board, as any new project does.
  - Only Jira administrators create projects (spec 0004 R4), and they may share any project's configuration. The server still checks that the person administers the existing project or is a Jira administrator.

## Permissions

As for creating a project.

## Data model and migration

- `projects.template` allows `basic`, `task`, `project` and `process`.
- New global statuses: Open, Under review and Approved. Existing ones of the same name are reused.
- A seed function adds the four workflows and schemes to every workspace, and a trigger adds them to each new workspace.

## API

`POST /projects` `template` takes the six ids. `GET /projects` and `GET /projects/:key` return them.

## Screens

Create project: two groups of templates, each with its statuses and work types spelled out.

## Scale

Nothing new.

## Acceptance

| Rule | Proved by |
|---|---|
| R4 | Server test: a project created with another's configuration has its schemes, work types, template and field contexts, shares a later workflow change, and none of its members or versions; someone who doesn't administer the other project is refused. Browser journey: Create project › Share settings with an existing project |
| R1, R2, R3 | Server test: each new template's workflow, statuses, work types and board; no sprints outside Scrum; a new workspace gets the schemes |
| R1 | Browser journey: create a Process management project and see its board columns |

## Out of scope and deliberate divergences

- **Business projects have a board** (R2): an extra.
- **Jira's Sub-task type:** The app's sub-items take any work type (spec 0509), so there's no separate Sub-task type.
- **Basic's older workflow** (Open, Resolved, Reopened, Closed): The app uses the newer one. An imported project keeps its own workflow either way (spec 0802).

## Proposals (not built until chosen)

- **P1: Create with shared configuration:** chosen by the PO on 12 Nov 2026, now R4.

## Open questions

None.

## Changelog
