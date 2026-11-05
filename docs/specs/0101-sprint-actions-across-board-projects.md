# 0101 Sprint actions need a role in every project the board covers

Status: In review
Parity rows: PRM-03

## Context and Jira reference

Since 4 November 2026, a board's filter can span projects, and a sprint can hold work from every project its board covers. The sprint routes, however, check only the project in the address (the board's own project). So a member of one project can complete a sprint and move unfinished work out of it in projects where they have no role at all. The same member can also create, edit, start or delete sprints for a board that spans projects they can't change.

- **Jira DC:**
  - Sprints are managed with the **Manage Sprints** permission. It covers creating, editing, deleting, starting and completing sprints ([sprint permissions](https://confluence.atlassian.com/adminjiraserver/sprint-permissions-and-defined-processes-983794894.html), Jira DC 11.3).
  - "The board's filter query determines the projects that users need to have permission on." The check uses "the filter query of the board from which the sprint originates", not just the issues in the sprint.
  - When Jira can't tell from the query which projects it returns, it requires the permission "for all projects in the instance" ([advanced cases](https://confluence.atlassian.com/adminjiraserver/using-manage-sprints-permission-for-advanced-cases-938847165.html)). Example: a part of the query without a project clause, as in `project = TIS OR issuetype = Bug`.
  - Both pages checked on 5 November 2026.
- **Strand today:**
  - The sprint routes are in `server/src/routes/projects.ts`: create (line 556), update (569), delete (580), start (586) and complete (601). Each resolves only the address's project and needs `member` there (the default from `minFor` in `server/src/access.ts:28`).
  - Completing moves unfinished items from every project in the sprint (`projects.ts`, the complete route).
  - The permission matrix has `write` rows for the five routes (`server/test/api.test.ts:3005-3009`).

Until spec 0201 introduces the permission table, a project role of **member or higher** is what Strand treats as Manage Sprints. Spec 0203 later swaps that role for the named permission.

## Rules

- **R1:** A board's **covered projects** are worked out from its filter:
  - a `project = X` or `project in (…)` clause gives those projects;
  - `AND` takes the intersection of the parts that name projects;
  - `OR` takes the union, but only when every branch names projects;
  - anything else is **open**: a part without a project clause, `project != X`, `project not in`, or `NOT`.

  The board's own project is always included. Projects the filter names that don't exist are ignored.
- **R2:** Creating, editing, starting, completing and deleting a sprint needs the role member or higher in **every covered project** of the sprint's board.
- **R3:** When the filter is open (R1), the person needs member or higher in **every project of the workspace**. In practice that means global admins, as in Jira.
- **R4:** Completing a sprint also needs member or higher in every project that has an unfinished item in the sprint, even if the board's filter no longer covers that project. Deleting a sprint needs the same for every project with an item in it. Either way, no item moves in a project the person can't change. This goes beyond Jira, which checks only the filter (see Deliberate divergences).
- **R5:** A refusal is a 403. Nothing changes: no sprint, item or snapshot. The message names the covered projects the person lacks the role in, but only those they can see. Any others are counted, not named:

  > You can manage this board's sprints only if you can change work in every project it covers: PAY, OPS and 2 more

  For an open filter the message reads:

  > This board's filter can include any project, so only someone who can change work in every project can manage its sprints

- **R6:** The board's own project still decides where sprints live and who sees them. Reading sprints, the backlog and the board is unchanged: anyone who can see the board's project can.
- **R7:** `GET /boards/:id` and `GET /projects/:key/boards` return `canManageSprints` (true when R2–R3 hold for the caller).
  - In the backlog and on the board, Create sprint, Start sprint, Complete sprint, Edit sprint and Delete sprint are disabled when it is false, with the tooltip "You need to be able to change work in every project this board covers".
  - R4 is checked when Complete or Delete is chosen.
- **R8:** The old routes (`/projects/:key/sprints…`) keep their addresses. A sprint is found only through its own board's project, as today.

## Permissions

| Action | Outsider | Viewer | Member of the board's project only | Member of every covered project | Project admin of the board's project only | Global admin |
|---|---|---|---|---|---|---|
| See sprints, backlog, board | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create, edit, start, complete, delete a sprint (filter names projects) | – | – | ✓ only if the board covers just its own project | ✓ | ✓ only if the board covers just its own project | ✓ |
| The same, filter open | – | – | – | – (unless member of every project) | – | ✓ |

## Data model and migration

None. Covered projects are worked out from the board's stored filter when a sprint action is asked for.

## API

- Unchanged routes and bodies. New 403 cases are covered by R5.
- `Board` and the `GET /projects/:key/boards` rows gain `canManageSprints: boolean`.
- **New helper** in `server/src/boards.ts`: `coveredProjects(d, me, board)` returns `{ ids: string[] } | { open: true }`, following R1. The parsing reuses `parseJql` from `server/src/shared/jql.ts`, and project keys and names are resolved the same way JQL does.
- **New helper** `canManageSprints(d, me, board)`: for named projects, a single query checking `project_access` across the ids; for an open filter, global admin or member of every project (R3).
- The sprint routes call it before changing anything. The complete and delete routes then run the R4 check inside the same transaction.

## Screens

- Backlog (`src/components/BacklogView.tsx`) and Board (`src/components/BoardView.tsx`): the sprint buttons and menu items follow R7. Jira equivalent: the backlog's sprint actions, which are hidden without Manage Sprints.
- A refusal from the server, for example under R4, shows its message in the usual warning toast.

## System settings

None.

## Scale

- A filter usually names a handful of projects; the check is one query over `project_access` for those ids.
- An open filter (R3) is checked with one count over the workspace's projects (up to 6,000), only for people who aren't global admins, and only when a sprint is changed. `canManageSprints` for the board list is worked out once per board in the response.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server unit test of `coveredProjects`: `project = A`, `project in (A, B)`, `project = A AND type = Bug`, `project in (A,B) AND project = B`, `project = A OR project = B`, and as open: `project = A OR type = Bug`, `assignee = x`, `project != A`, `NOT project = A`, `(project = A OR assignee = x) AND (project = B OR assignee = y)` |
| R2 | Server test: a member of only the board's project is refused each of the five actions on a board covering two projects; a member of both succeeds |
| R3 | Server test: a board with an open filter refuses a member of every named project, and a global admin succeeds |
| R4 | Server test: an item of a third project put in the sprint, then the filter narrowed; completing is refused for someone who can't change work in that third project, and its item is untouched |
| R5 | Server tests check the 403 message names only visible projects and counts the rest; and that a refused complete changes no sprint state, snapshot or item |
| R6 | Existing board and backlog tests keep passing (viewers read) |
| R7 | Server test of `canManageSprints` on both responses; browser journey: a member of one project sees the sprint buttons disabled with the tooltip on a board spanning two projects |
| R8 | Permission matrix rows for the five routes are unchanged (`write`) and pass |

## Strand branch

Same rules. Issue security levels don't change who manages sprints. Items hidden by a security level still count for R4: their project decides, not their visibility.

## Out of scope and deliberate divergences

- **R4 goes beyond Jira:** Jira checks only the board's filter. Strand also refuses to move or release items of projects the person can't change. Recorded in `../jira-parity.md` (PRM-03).
- **Start/Complete Sprints and Edit Sprints,** Jira's narrower permissions, come with spec 0203.
- **Sprints shown on several boards** (a sprint from another board appearing on this one) don't exist in Strand. A sprint belongs to one board.

## Open questions

1. **Is the board's own project always covered, even when its filter names only other projects?** Jira way: the filter alone decides. Proposed: include it (R1). Sprints are stored under it and its admins manage the board, so they should be the ones managing its sprints.
2. **Should a sprint's unfinished items in projects the person can't change block completion (R4), or simply stay in the closed sprint?** Jira way: Jira only checks the filter. Proposed: refuse, so a sprint never ends half-done.

## Changelog

—
