# 0015 Backlog, sprints and ranking

Status: Implemented

## Context and Jira reference

A Scrum board's backlog is where a team ranks its work and plans sprints. A sprint belongs to a board, so it can hold work from every project the board covers. People drag items to rank them and to move them between sprints and the backlog.

- **Jira DC:** [Using your Scrum backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-scrum-backlog-1688899657.html): the backlog lists the board's future and active sprints and the unfinished issues in none, in rank order; dragging ranks issues and moves them between sprints. A board has one active sprint unless parallel sprints are on. Starting a sprint records its committed estimate; [Completing a sprint](https://confluence.atlassian.com/jirasoftwareserver/completing-a-sprint-938845450.html) moves unfinished issues to a future sprint or the backlog. Ranking is [LexoRank](https://confluence.atlassian.com/adminjiraserver/managing-lexorank-938847803.html). The app follows Jira; its ranks are numbers rather than LexoRank strings.
- Extended by specs 0101 (sprint actions across a board's projects, completing into a new sprint), 0203 (who manages sprints), 0302 (one rank across projects), 0401 (what "done" means at completion), 0402 (sprint report), 0403 (reopen and delete), 0404 (estimation statistic), 0406 (Kanban backlog), 0407 (Epics and Versions panels) and 0414 (parallel sprints).

## Rules

- **R1: Sprints belong to boards.** A new sprint goes on the board named (`boardId`, one of the project's boards), else on the project's first Scrum board. A board of another project is refused (400 "That board isn’t one of this project’s"). Each board has its own sprints.
- **R2: One active sprint per board.** Starting a sprint while another is active on the same board is refused (409, naming the active sprint). Two boards can each have an active sprint, even in the same project.
- **R3: Starting.** Only a planned sprint starts (409 "Sprint is not planned"); it needs an end date and time. Starting records `committed`: the sum of its items' estimates (story points).
- **R4: Completing.**
  - Only an active sprint completes (409 "Sprint is not active").
  - It records `completed`, the estimate of its done items, and which items it held.
  - Unfinished items, from every project in it, go back to the backlog (`moveTo: null`, the default) or to a planned sprint of the same board. Another board's sprint is refused (400 "Unfinished work can go to a future sprint of the same board, a new sprint, or the backlog").
  - Done items stay with the completed sprint.
- **R5: A sprint holds work from every project its board covers.** An item joins only a sprint that isn't completed (400 "That sprint is completed: choose an open one") and that is in a project the person can see (400 "No such sprint").
- **R6: The backlog.** A Scrum board's backlog (`scope=backlog`) holds, within its filter, the items of its sprints not yet completed (done ones too) and the unfinished items in no sprint. Another board's sprints aren't there.
- **R7: Ranking.**
  - Items are in rank order. Moving an item before another gives it the midpoint of its new neighbours' ranks; to the top, one less than the first; to the end of a list, one more than the last. Only the moved item's rank changes.
  - Moving an item into a sprint's list, or the backlog's, also puts it in that sprint, or in none.
  - The order stays exactly as placed, however many items are dropped into the same spot (the server spreads crowded ranks apart: spec 0302 R4).
- **R8: Dropping rows.**
  - Dropped on a row, the items go before it, in that row's list (a sprint or the backlog), keeping their order. An item dropped on itself is left out; the others still move.
  - Dropped on the end of a list, or on the box around it, the items go to the end of that sprint or of the backlog.
  - Drop targets are a row, a list's end or a list's box; the Epics and Versions panels' targets (an epic, a version, or "none") are told apart from them (spec 0407).
- **R9: Keyboard.** Space picks a row up and drops it. Down and Up jump to the next gap in that direction: the gap before a row, or a list's end. Down skips the gap straight after the row's own place, since dropping there changes nothing. A list's box is never a keyboard stop. At the very top or bottom nothing happens; other keys are left to the page.
- **R10: Screen readers.** They hear "Picked up PAY-4. It is in Backlog." (with a selection: "PAY-4 and 2 other selected items"), where it would go ("Over before PAY-9 in Sprint 2.", "Not over a list."), and how it ended ("PAY-4 moved to the end of Sprint 2.", "was dropped outside the lists and did not move", "Cancelled. PAY-4 did not move."). The first report after lifting is kept quiet so "Picked up" is heard.

## Permissions

Who creates, edits, starts, completes and deletes sprints: specs 0101 and 0203. Ranking and moving items: as spec 0201's table (members and admins). Reading the backlog: anyone who can see the board's project.

## Data model

- `sprints` (`server/migrations/20261011205352_rest_of_schema.sql`): `name`, `goal`, `state` (`planned`, `active`, `closed`), `started_at`, `ends_at`, `completed_at`, `committed`, `completed`, `issue_ids` (what it held when completed).
- `sprints.board_id`, and one active sprint per board (`server/migrations/20261120090000_boards.sql`).
- `issues.rank` (number) and `issues.sprint_id`.

## API

- `POST /projects/:key/sprints` `{ name, boardId?, goal?, endsAt? }`: 400 for another project's board.
- `PATCH /projects/:key/sprints/:id`.
- `POST /projects/:key/sprints/:id/start` `{ endsAt }`: 409 when not planned or another sprint is active on the board.
- `POST /projects/:key/sprints/:id/complete` `{ moveTo }`: 409 when not active; 400 for a sprint of another board.
- `PATCH /issues/:key` `{ sprintId }` or `{ rank }`: 400 for a completed or unseen sprint.
- `GET /boards/:id/issues?scope=backlog`: the backlog.

## Screens

- **Backlog** (`/project/KEY/backlog/<board id>`): the board's sprints and the backlog, each a list in rank order; "Create sprint", "Start sprint" and "Complete sprint" with their dialogs; a row's menu "Move to <sprint>".
- Rows are dragged with a mouse, a finger or the keyboard; a selected row carries the whole selection.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: sprints on each board; without a board, the project's first Scrum board; an unknown board refused |
| R2 | Server tests: a second sprint on the same board can't start; one active sprint per board, not per project. Browser journey: two boards each with an active sprint |
| R3 | Server test: starting records the committed points. Browser journey: start a sprint from the backlog |
| R4 | Server tests: completing records completed points and carries unfinished work to the next sprint; another board's sprint refused. Browser journey: unfinished work goes back to the backlog, finished work stays |
| R5 | Server test: a sprint holds work from both projects; a completed sprint and an unseen sprint refused. Browser journey: a sprint planned on a board across two projects holds both |
| R6 | Server test: the backlog has the open sprints' and unfinished work. Browser journey: the backlog has both projects' work, not another board's sprint |
| R7 | Unit test (web): moving re-ranks only that item, to the top, into a sprint. Server test: 60 drops into the same spot keep their order |
| R8 | Unit tests (web): dropping on a row, on itself, on a list's end or box; panel targets round-trip |
| R9 | Unit tests (web): Down skips the no-change gap, the box isn't a stop, nothing at the edges, other keys left alone |
| R10 | Unit test (web): announcements name the item, count a selection and say where it would go |

## Out of scope and deliberate divergences

- **Ranks** are numbers, not LexoRank strings; the order is the same.
- **Kanban backlog:** spec 0406.
