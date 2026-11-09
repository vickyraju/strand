# 0403 Reopen a completed sprint; delete a completed sprint

Status: Approved (PO, 9 Nov 2026: "i approve everything"; "continue")
Parity rows: AG-04, AG-05

## Context and Jira reference

- **Jira DC [Reopening a sprint](https://confluence.atlassian.com/jirasoftwareserver/reopening-a-sprint-938845456.html)** (checked 9 Nov 2026):
  - **Who:** people with Manage sprints (or Jira administrators).
  - **Where:** from the Sprint Report.
  - **When:** without parallel sprints, not while another sprint is active on the board.
  - **What comes back:** the reopened sprint gets back the issues it had when it closed, except those now in an active sprint.
  - **Report:** the Sprint Report keeps the new end date. Completing it again records the last completion.
- **Jira DC [Deleting a sprint](https://confluence.atlassian.com/jirasoftwareserver/deleting-a-sprint-938845460.html):**
  - **Who:** Manage sprints.
  - **When:** only inactive sprints, from the Sprint Report.
  - **What happens:** it is gone for good. Its uncompleted issues move to the next sprint in the board's list. Issues it completed stay as they are, without the sprint.
- **Strand today:** a planned sprint can be deleted, and its items go to the backlog. A completed sprint can be neither reopened nor deleted.

## Rules

- **R1: Reopen.** A completed sprint can be reopened from the Sprint Report by someone with Manage sprints in every project its board covers (0101, 0203). It is refused (409) while another sprint is active on its board, as in Jira without parallel sprints.
  - It becomes active again, keeping its start date and end date. Its completion date and completed points are cleared.
  - The items it held when it closed come back into it, unless they are now in an active sprint, and as long as they still exist.
  - The audit log records the reopening.
- **R2: Delete a completed sprint.** From the Sprint Report, with Manage sprints.
  - Its items that aren't completed on its board go to the next planned sprint of its board. With none, they go to the backlog.
  - Its completed items stay as they are, without a sprint.
  - Velocity and the burndown no longer show it.
  - The audit log records the deletion.
  - Active sprints can't be deleted: complete them first.
- **R3: Planned sprints** are deleted as today: their items go to the backlog.
- **R4: Screens.** The Sprint Report shows "Reopen sprint" and "Delete sprint" for a completed sprint, to people who may use them. Deleting asks for confirmation and says where its unfinished work goes.

## Permissions

Manage sprints in every project the board covers. On a board in one project, that is the project admins (0203).

## Data model and migration

None.

## API

- New: `POST /projects/:key/sprints/:id/reopen`.
- `DELETE /projects/:key/sprints/:id` also deletes completed sprints, by R2. Active sprints still get 409.

## Screens

R4.

## System settings

None. Parallel sprints are a separate question (AG-06, undecided).

## Scale

One sprint's items: bounded.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: reopening brings back its items except one in another active sprint; refused while another sprint is active on the board; a member is refused |
| R2 | Server test: deleting a completed sprint moves an uncompleted item to the next planned sprint, leaves a completed item with no sprint; with no planned sprint, the backlog |
| R3 | Existing test of deleting a planned sprint stays green |
| R4 | Browser journey: an admin reopens a completed sprint from the Sprint Report |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
