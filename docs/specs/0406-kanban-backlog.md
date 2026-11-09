# 0406 Kanban backlog

Status: Ported (aws-jira `ec6256d`, strand `fd9b0c7`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AG-09

## Context and Jira reference

- **Jira DC:** a Kanban board can have a **Kanban backlog**, so planners rank upcoming work while the team sees only work in progress on the board.
  - **Turning it on:** Board › Configure › **Columns** shows **Kanban Backlog** as the leftmost column. Dragging a status into it enables the backlog. Jira administrators and board administrators can do this.
  - **The board** no longer shows items in the backlog's statuses.
  - **The Backlog** lists two sections: **Backlog** (the Kanban backlog column) and **Selected for Development** (the board's next column, under its own name).
  - **Dragging** an item from Backlog to the next section moves it to that column's status, and it appears on the board. If the column has two statuses, the one that needs no screen is used. Items are ranked by dragging, or with **Top of backlog** / **Bottom of backlog**.
  - **Several at once:** Shift and Ctrl select several items; a bulk move works only when all of them can make the move.
  - **The Epics panel** appears in a Kanban backlog (spec 0407).
- **Sources** (checked 10 Nov 2026):
  - [Using your Kanban backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-kanban-backlog-1688899675.html)
  - [Configuring columns: enabling the Kanban backlog](https://confluence.atlassian.com/jirasoftwareserver112/configuring-columns-1688899540.html)
- **Strand today:** the Backlog tab exists only for Scrum boards. A Kanban board shows every mapped status as a column.

## Rules

- **R1: Turning it on.** On a Kanban board, Configure › Columns shows **Kanban backlog** as the leftmost column.
  - Putting statuses in it turns the backlog on; taking every status out turns it off.
  - A status is in the Kanban backlog or in one column, never both.
  - Who: the board's administrators and the project's admins (as for every board setting). Scrum boards have no Kanban backlog (400).
- **R2: The board** doesn't show items whose status is in the Kanban backlog.
- **R3: The Backlog tab** appears for a project when any of its boards is a Scrum board or a Kanban board with a backlog; the board switcher lists both kinds.
  - A Kanban board's backlog shows two sections, in rank order: **Backlog** (items in the Kanban backlog's statuses) and the board's first column, under its own name (Jira's "Selected for Development").
  - Items are the board's: its filter, and what the viewer may see.
- **R4: Moving between the sections.** Dragging an item into the other section moves it to the first of that section's statuses its workflow allows. A move whose transition asks for details opens its screen. A move the workflow forbids is refused, saying why.
- **R5: Ranking.** Dragging within a section ranks the item there. The row's menu has **Top of backlog** and **Bottom of backlog**.
- **R6: Several at once.** Shift-click selects a range and Ctrl/Cmd-click adds one. Dragging a selected item carries the whole selection, in its order. Between the sections, nothing moves unless every one of them can.
- **R7: Create.** **Create** in the Backlog section starts a new item in the board's project, in the first of the Kanban backlog's statuses.
- **R8: Following the workflow.** When a project loses a status, it leaves the Kanban backlog too, as it leaves the columns.

## Permissions

| Action | Who |
|---|---|
| Turn the Kanban backlog on or off | Board administrators, project admins |
| See the Kanban backlog | Anyone who can see the board |
| Move and rank items | Anyone who can change them (Jira's Transition and Schedule issues) |

## Data model and migration

- `boards.kanban_backlog` jsonb: the global status ids in the Kanban backlog (default empty: off). No existing board changes.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `PATCH /boards/:id` accepts `kanbanBacklog` (status ids).
- `GET /boards/:id` returns it.
- `GET /boards/:id/issues?scope=backlog` on a Kanban board returns the two sections' items; `scope=board` leaves the Kanban backlog's items out.

## Screens

- **Configure board › Columns:** the **Kanban backlog** column, leftmost, for Kanban boards.
- **Backlog tab:** the two sections, with drag and drop, selection, the row menu and Create.
- **Jira equivalent:** Board › Backlog on a Kanban board.

## System settings

None.

## Scale

The backlog loads a page at a time, up to the board's limit (5,000 items), like the Scrum backlog.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: saving, the one-place rule, Scrum refused. Browser journey: an admin drags a status into Kanban backlog |
| R2, R3 | Server test: board and backlog scopes. Browser journey: the item leaves the board and shows in the backlog |
| R4, R5, R6 | Web unit test: the drop plan for one and several items, and a forbidden move. Browser journey: an item dragged to the next section appears on the board |
| R7 | Browser journey: Create in the Backlog section |
| R8 | Server test: a status the project loses leaves the Kanban backlog |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Jira shows 100 items at first** ("Show all issues"). Strand shows the board's items up to its limit, as its Scrum backlog does.
- **Sub-items** move with their own row; carrying a parent with its sub-items is not built.
- **The Epics panel** is spec 0407.

## Open questions

None.

## Changelog
