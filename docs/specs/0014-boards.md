# 0014 Boards

Status: Implemented

## Context and Jira reference

A board shows the work items its filter finds, in columns, with quick filters and swimlanes. A project can have several boards, and a board's filter can span projects. People move work by dragging cards between columns.

- **Jira DC:** a board belongs to a location (a project) and shows what its saved filter finds, from any projects. Its administrators configure columns (statuses mapped to columns, with minimum and maximum), swimlanes (by queries, assignee, epic, project or none) and quick filters; see [Configuring columns](https://confluence.atlassian.com/jirasoftwareserver112/configuring-columns-1688899540.html). A new board starts with the "Only My Issues" and "Recently Updated" quick filters. The app follows Jira, except that only project admins add boards (Jira lets anyone with Create shared objects make one).
- Extended by specs 0101 (sprint actions across a board's projects), 0102 (archived projects), 0404 and 0412 (estimation), 0405 (working days), 0406 (Kanban backlog), 0407 (Epics and Versions panels), 0409 (card colours), 0410 (control chart) and 0414 (parallel sprints).

## Rules

- **R1: New boards.**
  - A new project gets one board: "KEY board", of the project's template type (Scrum or Kanban), with the filter `project = KEY`, one column per project status in workflow order (a status's WIP limit becomes the column's maximum), and Jira's two quick filters, "Only my issues" (`assignee = currentUser()`) and "Recently updated" (`updated >= -1d`). Its creator is its administrator.
  - Project admins add more boards (`POST /projects/:key/boards`); a member is refused (403). Name 1–100 characters; the type can't change later. What isn't given takes the same defaults as the first board. The creator becomes its administrator unless others are named. Audited as `board.created`.
- **R2: The filter.** A board shows the work items its JQL filter finds, from any projects, among those the viewer may see: a member of one project sees only that project's items on a board that spans two. Items come in rank order, a page at a time (200 by default, at most 500), with the total; an ORDER BY in the filter is ignored.
- **R3: What the board shows.**
  - **Scrum:** the items in the board's active sprint. Another board's sprint isn't shown.
  - **Kanban:** everything its filter finds, except Done items not updated for `doneDays` days (14 by default on a Kanban board; 1–3650, or none to show them all).
  - `scope=all` shows everything its filter finds.
- **R4: Every query is checked when saved.** The board filter, each quick filter and each swimlane query are parsed and run when the board is saved. A mistake is a 400 that names the part (`errors.jql`, `errors["quickFilters.<id>"]`), not a board that shows nothing. `POST /jql/check` answers how many work items a query finds among those the caller may see, or a 400 saying what is wrong; the settings use it to show "2 work items match now." while a query is typed.
- **R5: Columns.**
  - 1–30 columns, each with a name (1–60 characters) and up to 50 statuses. A column names global statuses, so one column serves every project on the board.
  - Optional minimum (0–9999) and maximum (1–9999); a minimum over the maximum is refused (400).
  - A status in two columns, or a status that doesn't exist, is refused (400 "A status can be in one column only", "A column names a status that doesn’t exist").
  - The statuses a board's columns can offer: its own project's, those of the projects its filter names or finds work in (only projects the viewer can see), and any a column already names.
- **R6: Quick filters.** Up to 30, each a name and a JQL query. The quick filters chosen are ANDed with the board filter. An unknown quick filter is a 400 ("No such quick filter on this board").
- **R7: Swimlanes.** By none, assignee, epic, priority, project, or queries (up to 30). With queries, an item goes in the first swimlane whose query it matches; an item that matches none is in "Everything else".
- **R8: Who changes a board.**
  - Its project's admins and its named administrators (people or groups, up to 100 of each) change and delete it; anyone else is refused (403 "Only the board’s administrators and the project’s admins can change it"). Everyone who can see the project reads the board and its settings; someone who can't gets 404.
  - Named administrators must be active people of the workspace and existing groups; anyone else is refused (400), not skipped.
  - `canManage` on the board and in the project's board list says whether the caller may change it. Changes are audited as `board.updated`.
- **R9: Deleting a board.** A project keeps at least one board (409 "A project needs at least one board"). A board with sprints not yet completed can't go (409). A deleted board's completed sprints move to the project's first other board. Audited as `board.deleted`.
- **R10: Dropping a card.**
  - Dropping a card into a column moves it to the first of the column's statuses, in its project's order, that its own project's workflow allows. A card already in one of the column's statuses keeps its status.
  - A column names global statuses; a project status counts as the global status it is.
  - A move the workflow doesn't allow is refused with the reason: "The Payments workflow doesn’t allow To do → Done", or, for a column with no status of the item's workflow (another project's board), "Review has no status of the Payments workflow".
  - Dropping into another swimlane also sets the field the board is grouped by, with or without a status change. A refused move changes nothing, not even that field.
- **R11: Keyboard and screen readers.**
  - Space picks a card up and drops it; Escape cancels. The arrow keys jump it to the next cell: left and right along its swimlane, up and down between swimlanes. A cell that is switched off is skipped; at the edge nothing happens. Other keys are left to the page.
  - A screen reader hears "Picked up PAY-7. It is in To do.", where the card is ("PAY-7 is over In progress.", "PAY-7 is back over To do, where it started.", or that the workflow doesn't allow the move), and how it ended ("PAY-7 was moved to In progress.", "PAY-7 stays in To do.", "did not move", "Cancelled. PAY-7 did not move."). The first report after lifting, over its own column, is kept quiet so "Picked up" is heard.
- **R12: The address and each person's view.**
  - The address names the board (`/project/KEY/board/<id>`) and the quick filters that are on (`?quick=<id>,<id>`), so a reload or a shared link shows the same; opening a card keeps them.
  - Collapsing a column or a swimlane is each person's own, kept in their browser; it never reaches the server and changes nothing for anyone else.
  - The board last used in a project opens next time, in the same browser.

## Permissions

| Action | Outsider | Viewer | Member | Named board admin | Project admin, global admin |
|---|---|---|---|---|---|
| See a board, its items and its settings | 404 | Yes | Yes | Yes | Yes |
| Add a board | 404 | No | No | No | Yes |
| Change or delete a board | 404 | No | No | Yes | Yes |

Who may manage a board's sprints: spec 0101. Archived projects' boards don't change: spec 0102.

## Data model

- `boards` (`server/migrations/20261120090000_boards.sql`): `project_id` (its location), `name`, `type` (`kanban` or `scrum`), `jql`, `columns` (`[{ id, name, statusIds, min?, max? }]`), `swimlanes`, `quick_filters`, `card_fields`, `done_days`, `position`, `created_by`. Later specs add estimation, working days, card colours and the Kanban backlog.
- `board_admins` (same migration): one row per person or group (`user_id` or `group_id`, never both).
- `sprints.board_id` (same migration): a sprint belongs to a board.

## API

- `GET /projects/:key/boards`: the project's boards in order, each with `canManage` and `canManageSprints`.
- `POST /projects/:key/boards`: 201; 403 for a non-admin; 400 with `errors` for a bad query or column.
- `GET /boards/:id`: 404 when the caller can't see its project.
- `PATCH /boards/:id`: 403 for a non-administrator; 400 for a bad query, column or administrator.
- `DELETE /boards/:id`: 204; 409 for the last board or one with open sprints.
- `GET /boards/:id/issues?quick=&scope=board|backlog|all&cursor=&limit=`: `{ items, total, next }`; each item has its `lane`.
- `GET /boards/:id/statuses`: the statuses its columns can name.
- `POST /jql/check` `{ jql }`: `{ count }` or 400.

## Screens

- **Board** (`/project/KEY/board/<id>`): a board switcher (its boards, "Configure board", and "Create board" for project admins), the quick filter buttons, columns with their limits ("Max 1"), swimlanes, and collapse buttons on each column.
- **Configure board** (`/project/KEY/boards/<id>`): General (name, filter with a live count), Columns (move a status to another column, name, minimum and maximum), Quick filters (a mistake shown on its row), Swimlanes, administrators. Others read it, with "Only its administrators and the project’s admins can change it."
- **Create board** dialog: name, type, and "Work items a filter finds" with the live count.

## Scale

A board's items come a page at a time (up to 500), keyed by rank and id; the total is counted in the database.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a new project's board, its columns and quick filters; a member can't add one; a board made with a filter. Browser journey: a project admin adds a board; a member has no "Create board" |
| R2 | Server test: a board across two projects; a member of one sees only its items; the filter edited later. Browser journeys: the board spans projects; a Scrum board across two projects |
| R3 | Server test: Kanban leaves out long-Done items, `scope=all` has them. Browser journey: a Scrum board shows its own active sprint, not another board's |
| R4 | Server test: a bad filter is a 400 naming `jql`; `/jql/check` counts or refuses. Browser journeys: the live count while typing; a quick filter's mistake shown on its row |
| R5 | Server test: two statuses in one column with a maximum; a status twice, an unknown one, minimum over maximum refused; the statuses offered. Browser journey: two statuses joined in a column with a maximum |
| R6 | Server test: a quick filter ANDed with the board filter; an unknown one refused. Browser journey: "Only my issues" narrows the board |
| R7 | Server test: swimlane queries, the first match wins |
| R8 | Server test: a named board admin through a group may change it, a member may not; unknown administrators refused; `canManage`; an outsider gets 404. Browser journey: a member reads the settings and can't save |
| R9 | Server test: a member can't delete; a board with a sprint not yet completed stays (409); deleting works; the last board stays (409); audited |
| R10 | Unit tests (web): the drop rules, several statuses in a column, global statuses, another project's column, swimlane changes, refused moves |
| R11 | Unit tests (web): arrow keys between cells, edges and other keys, skipped cells; announcements |
| R12 | Unit test (web): the board and its quick filters round-trip in the address. Browser journeys: quick filters stay in the address over a reload; the last board opens; a member collapses a column for themselves only |

## Out of scope and deliberate divergences

- **Who adds a board:** project admins, not anyone with Create shared objects as in Jira (spec 0717).
- **Card fields:** stored with the board; not described here.
