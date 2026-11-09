# 0305 Priorities and resolutions as admin lists

Status: In review (two questions for the product owner, below)
Parity rows: ISS-04, ISS-05

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
- **Strand today:**
  - **Priorities** are fixed in code: urgent, high, medium, low and none (shown as Urgent, High, Medium, Low and No priority). New items get none.
  - **Resolutions** are fixed in code: Done, Won't do, Duplicate and Cannot reproduce. Reaching a Done-category status sets the resolution to Done (or the one chosen), and leaving clears it.
  - About 20 files read the fixed lists.

## Rules

- **R1: Priorities list.** Administration › Priorities: add, rename, recolour, choose an icon, reorder, and mark one as the default. Names are unique, ignoring case.
  - Today's five are kept, with the same keys, so existing items don't change.
  - New priorities get keys of their own.
- **R2: The default priority** is given to new work when none is chosen, including CSV import and the API. *(Question 1.)*
- **R3: Deleting a priority** asks where its items, templates and automation rules go. At least one priority must remain.
- **R4: Search and order by priority** follow the list:
  - JQL `priority = High` matches by name;
  - `ORDER BY priority` and `priority > Low` follow the list's order.
- **R5: Resolutions list.** Administration › Resolutions: add, rename, describe, reorder, mark the default, delete (moving items to another).
  - Renaming carries over to every item that has it.
  - Today's four are kept.
- **R6: When the resolution is set.** *(Question 2.)*
- **R7: Screens.** Every priority and resolution picker, icon and filter reads the lists: create, detail, table, board, bulk edit, transition dialog, rules editor, templates, automation and search.

## Questions for the product owner

1. **Default priority for new work.** Jira's is Medium. Strand's is "No priority" today.
   - **Recommendation:** make Medium the default, as in Jira. An admin can choose another.
   - The question is whether existing habits around "No priority" matter.
2. **When the resolution is set.** Jira sets it per transition (screen or post function). Jira Software's simplified workflows set it on reaching Done, as Strand does today for any Done-category status.
   - **Recommendation:** keep today's behaviour, which matches Jira Software's simplified workflows, and use the list's default as the resolution set on reaching Done. Transition rules can already set a resolution explicitly.
   - The alternative, resolution only through transition rules, means every existing workflow needs a rule added, or items stay unresolved.

## Permissions

Global admins edit both lists. Everyone reads them.

## Data model and migration

- `priorities (workspace_id, key, name, description, color, icon, position, is_default)`, seeded with today's five for every workspace, and for new workspaces.
- `resolutions (workspace_id, name, description, position, is_default)`, seeded with today's four.
- The fixed checks on `issues.priority` and on templates are dropped; the API checks against the list.
- `strand` gets the same migration in `supabase/migrations`.

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
| R6 | Per the decision |
| R7 | Browser journey: an admin adds "Blocker" above High; it appears in the item's picker and sorts first |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Priority schemes** (a different list per project): later, if needed.

## Changelog
