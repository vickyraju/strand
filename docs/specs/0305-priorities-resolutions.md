# 0305 Priorities and resolutions as admin lists

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC:**
  - **Priorities** are a global list that administrators edit in Administration › Issues › Priorities:
    - each has a name, a description, an icon and a colour, in an order;
    - one is the default for new issues, Medium out of the box;
    - Jira ships Highest, High, Medium, Low and Lowest;
    - deleting a priority asks which priority its issues move to.
    - Priority schemes (one list per project) exist since 7.6. Out of scope here.
  - **Resolutions** are a global list too: name, description, order and a default. Jira ships Fixed, Won't Fix, Duplicate, Incomplete, Cannot Reproduce and Done.
    - A resolution is set by a transition's screen or post function, not by the status. Jira Software's simplified workflows set it when an issue reaches the Done column.
    - Deleting a resolution asks which one its issues move to.
  - Source: [Defining resolution field values](https://confluence.atlassian.com/adminjiraserver/defining-resolution-field-values-938847100.html), plus the matching priority page.
- **Before this spec:**
  - **Priorities** are fixed in code: urgent, high, medium, low and none (shown as Urgent, High, Medium, Low and No priority). New items get none.
  - **Resolutions** are fixed in code: Done, Won't do, Duplicate and Cannot reproduce. Reaching a Done-category status sets the resolution to Done (or the one chosen), and leaving clears it.
  - About 20 files read the fixed lists.

## Rules

- **R1: Priorities list.** Administration › Priorities: add, rename, recolour, choose an icon, reorder, and mark one as the default. Names are unique, ignoring case.
  - Today's five are kept, with the same keys, so existing items don't change.
  - New priorities get keys of their own.
- **R2: The default priority** is given to new work when none is chosen, including CSV import and the API. It is Medium out of the box, as in Jira; an admin can choose another. Existing items keep theirs.
- **R3: Deleting a priority** asks where its items, templates and automation rules go. At least one priority must remain.
- **R4: Search and order by priority** follow the list:
  - JQL `priority = High` matches by name;
  - `ORDER BY priority` and `priority > Low` follow the list's order.
- **R5: Resolutions list.** Administration › Resolutions: add, rename, describe, reorder, mark the default, delete (moving items to another).
  - Renaming carries over to every item that has it.
  - Today's four are kept.
- **R6: Each workflow says how its items get a resolution** (Administration › Workflows, the workflow's settings). An item follows the workflow its work type uses in its project's scheme.
  - **On reaching Done** (the default, and every existing workflow keeps it): reaching a Done status sets the resolution list's default, unless the move chose one. Leaving Done clears it. This is Jira Software's simplified workflows.
  - **Only by transition rules** (Jira's classic workflows): reaching Done sets nothing on its own. A transition's "Set field → Resolution" rule or the transition screen sets it, and items that reach Done without one stay Unresolved.
  - In both modes, leaving Done clears the resolution. Jira's classic workflows need a "clear resolution" post function for that; the app does it always, so an item is never open and resolved at once. This is a deliberate simplification.
  - "Resolved" is when the resolution was set.
- **R7: Screens.** Every priority and resolution picker, icon and filter reads the lists: create, detail, table, board, bulk edit, transition dialog, rules editor, templates, automation and search.

## Permissions

Global admins edit both lists. Everyone reads them.

## Data model and migration

- `priorities (workspace_id, key, name, description, color, icon, position, is_default)`, seeded with today's five for every workspace, and for new workspaces.
- `resolutions (workspace_id, name, description, position, is_default)`, seeded with today's four (Done is the default).
- `workflows.resolution_on_done boolean not null default true`. The resolution trigger reads it, and the list's default.
- The fixed checks on `issues.priority` and on templates are dropped; the API checks against the list.

## API

- `GET /priorities` and `GET /resolutions` (everyone).
- `POST`, `PATCH` and `DELETE` (with `?moveTo=`) under `/admin/priorities` and `/admin/resolutions` (global admins).
- Item, template and rule schemas accept any key or name in the lists.

## Screens

Two Administration pages, and every picker (R7). Jira equivalents: Administration › Issues › Priorities and Resolutions.

## System settings

None; the lists are the settings.

## Scale

Both lists are small (tens of rows), cached per workspace like System settings. Deleting with a move is one update over the workspace's items, run as a job when it is large, with the 0103 job pattern.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R3 | Server tests: add, rename, reorder, default, delete with move; a new item gets the default |
| R4 | Server test: JQL by name, ORDER BY and > follow the list order after a reorder |
| R5 | Server test: rename carries to items; delete moves them |
| R6 | Server test: a workflow set to "only by transition rules" leaves an item reaching Done unresolved, and a Set field rule resolves it; "on reaching Done" sets the list's default |
| R7 | Browser journey: an admin adds "Blocker" above High; it appears in the item's picker and sorts first |

## Out of scope and deliberate divergences

- **Priority schemes** (a different list per project): later, if needed.

## Open questions

None.

## Changelog

- 9 Nov 2026, after porting: making another priority or resolution the default failed (500). It switched both rows in one statement, against an index allowing one default. Fixed in two statements, and the test now checks it.

- 9 Nov 2026: the product owner chose Medium as the default priority, and per-workflow resolution (R6).
- 9 Nov 2026, while building (within the approved rules):
  - The CSV export's Priority column shows the priority's name, not its key.
  - An automation rule or transition rule naming a priority no longer in the list fails (automation) or is skipped with a history note (transition), as for a missing assignee.
  - The resolution setting sits in the workflow editor's header, and saves at once, apart from the diagram's draft.
