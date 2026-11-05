# 0101 Sprint actions need a role in every project the board covers; completing as in Jira

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

  Only the filter decides, as in Jira: the board's own project counts only when the filter names it. Projects the filter names that don't exist are ignored.
- **R2:** Creating, editing, starting, completing and deleting a sprint needs the role member or higher in **every covered project** of the sprint's board.
- **R3:** When the filter is open (R1), the person needs member or higher in **every project of the workspace**. In practice that means global admins, as in Jira.
- **R4:** *Withdrawn in review (5 Nov 2026): Jira checks only the board's filter, so Strand does too.* Completing a sprint moves its unfinished work wherever it is from, and deleting a planned sprint sends its items to the backlog, without any check beyond R2 and R3.
- **R5:** A refusal is a 403. Nothing changes: no sprint, item or snapshot. The message names the covered projects the person lacks the role in, but only those they can see. Any others are counted, not named:

  > You can manage this board's sprints only if you can change work in every project it covers: PAY, OPS and 2 more

  For an open filter the message reads:

  > This board's filter can include any project, so only someone who can change work in every project can manage its sprints

- **R6:** The board's own project still decides where sprints live and who sees them. Reading sprints, the backlog and the board is unchanged: anyone who can see the board's project can.
- **R7:** `GET /boards/:id` and `GET /projects/:key/boards` return `canManageSprints` (true when R2–R3 hold for the caller).
  - In the backlog and on the board, Create sprint, Start sprint, Complete sprint, Edit sprint and Delete sprint are disabled when it is false, with the tooltip "You need to be able to change work in every project this board covers".
- **R8:** The old routes (`/projects/:key/sprints…`) keep their addresses. A sprint is found only through its own board's project, as today. Seeing that project is enough to reach the route; R2 and R3 decide whether the action is allowed. So a member of every project the filter names may manage the sprints even if they only view the board's own project.
- **R9:** When a sprint is completed, its unfinished work goes where the person chooses, as Jira offers: the **backlog**, one of the board's **future sprints**, or a **new sprint**. A new sprint is created on the same board, planned, and named like any new sprint ("PAY Sprint 4"). The complete dialog lists those three choices. Completed work stays with the completed sprint. Choosing a sprint of another board, or a completed one, is refused (400).
- **R10:** A sprint can't be completed while one of its items is Done but has a sub-item in the sprint that isn't. The refusal is a 409 naming the parents ("Complete the sub-items first: PAY-12, PAY-15"), and nothing changes. A parent that isn't Done whose sub-items are all Done is unfinished and moves like any other unfinished item (Jira's rule).

## Permissions

| Action | Outsider | Viewer | Member of the board's project only | Member of every covered project | Project admin of the board's project only | Global admin |
|---|---|---|---|---|---|---|
| See sprints, backlog, board | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create, edit, start, complete, delete a sprint (filter names projects) | – | – | ✓ only if the filter names just that project | ✓ | ✓ only if the filter names just that project | ✓ |
| The same, filter open | – | – | – | – (unless member of every project) | – | ✓ |

## Data model and migration

None. Covered projects are worked out from the board's stored filter when a sprint action is asked for.

## API

- Unchanged routes and bodies. New 403 cases are covered by R5.
- `Board` and the `GET /projects/:key/boards` rows gain `canManageSprints: boolean`.
- **New helper** in `server/src/boards.ts`: `coveredProjects(d, me, board)` returns `{ ids: string[] } | { open: true }`, following R1. The parsing reuses `parseJql` from `server/src/shared/jql.ts`, and project keys and names are resolved the same way JQL does.
- **New helper** `canManageSprints(d, me, board)`: for named projects, a single query checking `project_access` across the ids; for an open filter, global admin or member of every project (R3).
- The sprint routes resolve the board's project for reading (any role), then call it before changing anything.
- `POST /projects/:key/sprints/:id/complete` accepts `moveTo`: a future sprint id, `null` for the backlog, or `"new"` (R9). The response is the completed sprint; when a new sprint was made, the response also has `newSprint`.
- The R10 check runs inside the completion transaction before anything changes.

## Screens

- Backlog (`src/components/BacklogView.tsx`) and Board (`src/components/BoardView.tsx`): the sprint buttons and menu items follow R7. Jira equivalent: the backlog's sprint actions, which are hidden without Manage Sprints.
- The Complete sprint dialog offers "Move open items to": the board's future sprints, "New sprint" and "Backlog" (R9). A refusal under R10 shows in the dialog, which stays open.
- Any other refusal from the server shows its message in the usual warning toast.

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
| R4 | Withdrawn; R2's tests cover completion on a board whose filter names both projects |
| R5 | Server tests check the 403 message names only visible projects and counts the rest; and that a refused complete changes no sprint state, snapshot or item |
| R6 | Existing board and backlog tests keep passing (viewers read) |
| R7 | Server test of `canManageSprints` on both responses; browser journey: a member of one project sees the sprint buttons disabled with the tooltip on a board spanning two projects |
| R8 | Permission matrix rows for the five routes are unchanged (`write`) and pass; server test: a viewer of the board's project who is a member of the one project its filter names may start a sprint |
| R9 | Server tests: unfinished work moves to the backlog, to a future sprint, and to a new sprint (created on the board, planned, numbered); another board's sprint or a completed one is refused; browser journey: completing with "New sprint" |
| R10 | Server test: a Done parent with an unfinished sub-item in the sprint refuses completion (409) and changes nothing; a parent not Done with all sub-items Done moves |

## Strand branch

Same rules. Issue security levels don't change who manages sprints. An item hidden from the person by a security level still moves when the sprint is completed (as in Jira, completion isn't limited to what the person sees). R10's message names a hidden parent only by count.

## Out of scope and deliberate divergences

- **Start/Complete Sprints and Edit Sprints,** Jira's narrower permissions, come with spec 0203.
- **Sprints shown on several boards** (a sprint from another board appearing on this one) don't exist in Strand. A sprint belongs to one board.

## Open questions

None. Both questions raised in review were answered the Jira way (5 Nov 2026): the filter alone decides the covered projects, and completion checks nothing beyond it.

## Changelog

- 5 Nov 2026, while building (wording and a fix within the approved rules, no change of behaviour):
  - R5: when none of the missing projects can be named, the message reads "…every project it covers, including one you can't see" (or the number).
  - R9: after a sprint is completed, the web app reloads every project that had work in it, not only the board's. Without this, the moved items of another project were saved again with an old version and refused (409).
  - R9: in one change the app sends new sprints before updates, so a sprint completed into a new one reaches the server after it.
- 5 Nov 2026, in review: the product owner asked for Jira's handling. R1 no longer adds the board's own project; R4 withdrawn; R8 clarified; R9 (backlog, future sprint or new sprint) and R10 (Done parents with unfinished sub-items block completion) added from Jira's [Completing a sprint](https://confluence.atlassian.com/jirasoftwareserver/completing-a-sprint-938845450.html) (DC 11.3, checked 5 Nov 2026).
