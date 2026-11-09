# 0401 Completing a sprint: done means the board's rightmost column

Status: Approved (PO, 9 Nov 2026: "i approve everything"; "continue")
Parity rows: AG-03

## Context and Jira reference

- **Jira DC:** [Completing a sprint](https://confluence.atlassian.com/jirasoftwareserver/completing-a-sprint-938845450.html). When a sprint is completed:
  - an issue counts as **completed** when its status is mapped to the board's rightmost column, whatever the status's category;
  - every other issue is incomplete and moves to a future sprint, a new sprint, or the backlog;
  - a completed parent whose sub-tasks aren't completed blocks completion.
  - This is why a board can have a "Ready to release" column at the right that counts as done.
- **Strand today:**
  - Spec 0101 built the destinations (a future sprint, a new sprint, the backlog) and the sub-item rule.
  - "Done" is still the Done status category, on the server (`/sprints/:id/complete`) and in the completion dialog (`CompleteSprintModal`).

## Rules

- **R1: Done is the rightmost column.** When a sprint completes, an item is completed if its status is in the board's rightmost column that has statuses. All others are incomplete and move as chosen. A status the board doesn't show at all is incomplete, as in Jira.
- **R2: The same rule everywhere completion looks.**
  - the sub-item rule: a completed parent with incomplete sub-items in the sprint blocks completion;
  - the completed points recorded on the sprint, for velocity and the sprint report;
  - the counts in the completion dialog.
- **R3: Without a board.** A sprint without a board (from before boards, or a workspace kept in the browser without its board) falls back to the Done category, as today.
- **R4: Resolution is separate.** Completing a sprint changes no status and no resolution: an item in the rightmost column keeps whatever resolution its workflow gave it (0305).

## Permissions

Unchanged: Manage sprints in every project the board covers (0101, 0203).

## Data model and migration

None.

## API

`POST /projects/:key/sprints/:id/complete` applies R1–R3. The response is unchanged.

## Screens

The completion dialog counts completed and incomplete work by R1. Jira equivalent: the Complete sprint dialog.

## System settings

None.

## Scale

The board's columns are read once; each query compares the item's status to a short list of status ids.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: a board whose rightmost column is "In review": an item there is completed and stays; an item in Done (now not in the rightmost column) moves; the completed points count the first; a parent in the rightmost column with a sub-item elsewhere blocks |
| R3 | Existing sprint tests (boards' rightmost column is Done by default) stay green |
| R4 | Server test: the completed item's resolution and status are unchanged |
| R2 (dialog) | Web unit test: the reducer moves only items outside the given column |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
