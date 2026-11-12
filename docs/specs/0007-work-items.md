# 0007 Work items

Status: Implemented

## Context and Jira reference

Work items are Jira's issues: each has a key, a type, a status and fields, and belongs to one project. This spec covers making, reading, editing, listing, cloning and bulk-changing them, and the browser's one-step Undo. Extended by spec 0202 (who deletes, sub-items, restore period), 0302 (rank), 0303 (hierarchy), 0307 (label format), 0501 (moving), 0508 (archiving), 0601 (history names).

- **Jira DC:** items are keyed `PROJ-N`, numbered per project. Clone makes a copy whose summary starts "CLONE - ", linked to the original by Cloners, optionally with its sub-tasks, links and sprint. Bulk change applies one change to many items. The app follows Jira, with these differences:
  - A stale edit is refused (409), not saved over a newer one.
  - The browser offers a one-step Undo; Jira has none.

## Rules

- **R1: Keys.** An item's key is its project's key and the project's next number: `PAY-1`, `PAY-2`. Numbers count per project and are never reused.
- **R2: Creating.** `POST /projects/:key/issues` makes an item (201).
  - It needs a title of 1 to 500 characters. The type defaults to Task.
  - The creator is the reporter.
  - It starts where its type's workflow starts, unless a status of that workflow is given.
  - A client may choose the item's id.
- **R3: Editing and versions.**
  - `PATCH /issues/:key` changes fields. Each save adds 1 to the item's version.
  - With `If-Match: <version>`, a stale version is refused: 409 "Edited elsewhere (current version 4)".
  - A status change goes through the workflow: spec 0010.
- **R4: History.** Each field an edit changes writes one history row, with the field, the old value and the new one ("Changed summary"). `GET /issues/:key/activity` lists them newest first, a page at a time.
- **R5: Opening an item.**
  - `GET /issues/:key` returns the item with its comments, history, work logs, links, watchers, attachments and child items.
  - `expand=comments,links,…` returns only those. An unknown name is refused: 400 "Unknown expand value: nope".
  - The comments and history it carries are the first 200; `GET /issues/:key/comments` (oldest first) and `/activity` page through all of them. A bad cursor is refused: 400 "Invalid cursor".
- **R6: A project's list.**
  - `GET /projects/:key/issues` lists the project's items in rank order: 200 per page by default, at most 500.
  - Pass `next` back as `cursor` for the next page.
  - Deleted and archived items are left out.
  - It filters by status, assignee, type, sprint (`none` for the backlog), fix version and parent.
- **R7: Deleting and restoring.** Deleting an item takes it out of lists and search; it is kept, and `POST /issues/:key/restore` brings it back. Who may, and what goes with it: spec 0202.
- **R8: Bulk changes.** `POST /issues/bulk/edit`, `/bulk/delete` and `/bulk/restore` take a list of keys or ids.
  - **Same rules:** each item goes through the same checks as a single change, the workflow included.
  - **All or nothing:** if one item is missing (404) or refuses (409), nothing changes.
  - **Duplicates:** a key listed twice counts once. The answer gives the count (and the edited items).
  - **Limits:** an empty list is refused (400). More items than **System settings › Search and bulk › Bulk change limit** (default 200) is refused: 400 "A bulk change can include at most 200 work items (you sent 201)".
  - **Permission:** bulk changes need Jira's Bulk change global permission: spec 0717.
- **R9: Labels offered.**
  - Every label an item gets, however it gets it (create, edit, bulk edit, automation, import), is recorded for its project.
  - `GET /labels` lists the labels used in projects I can see, alphabetically, ignoring case: at most 50 by default, 100 at most.
  - `query` keeps those containing the text, in any case; `%` and `_` are plain characters.
  - A label stays offered after its items are deleted, as in Jira.
  - What a label may be: spec 0307.
- **R10: Clone.** `POST /issues/:key/clone` makes a copy in the same project (201).
  - **Copied:** type, description, priority, labels, estimates, dates, fix versions, custom field values, parent and assignee. An assignee who can no longer work in the project is left out.
  - **Title:** "CLONE - " and the original title, unless another is given. The assignee can be changed too, or cleared.
  - **Status and links:** it starts at its workflow's start status, linked "clones" to the original. Its history says "Cloned from PAY-12".
  - **Options:** `include.children` copies the child items under the copy. `include.links` copies the original's links, both ways, except "clones". `include.sprint` keeps its sprint, unless that sprint is completed.
  - **Permission:** viewers can't clone (403).
  - The browser's own store clones the same way.
- **R11: Undo.**
  - In the browser, the last destructive or bulk change can be undone once: deleting, editing or moving items, deleting a sprint or comment, completing a sprint, removing an attachment, link or person, releasing a version, archiving, deleting a project or view.
  - Undo is withdrawn as soon as anything else changes, so it never reverts someone's later work.
- **R12: Test data.** The web unit tests share a sample workspace: three projects, at least 50 items, closed sprints with their velocity, and unread notifications. Every item's status is one of its project's, every parent exists, and keys are unique. The app itself ships no demo data.

## Permissions

As spec 0201's table, with:

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Open and list items | 404 | yes | yes | yes | yes |
| Create, edit, clone | 404 | no (403) | yes | yes | yes |
| Delete, restore | 404 | no | no | yes (spec 0202) | yes |

A bulk change needs the Bulk change global permission (spec 0717), and the permission above for every item in it.

## Data model

- `issues` (`server/migrations/20261011202354_core_schema.sql`): `workspace_id`, `project_id`, `number` (unique per project), `type`, `title`, `description`, `status_id`, `priority`, `assignee_id`, `reporter_id`, `labels`, `estimate`, `due_date`, `parent_id`, `custom`, `rank`, `version`, `deleted_at`, `created_at`, `updated_at`. `next_issue_number()` takes the project's next number in the same transaction.
- `activity` (`20261011205352_rest_of_schema.sql`): `issue_id`, `actor_id` (empty for automation), `field`, `from_value`, `to_value`, `text`.
- `labels` (`20261025100000_labels.sql`, per project since `20261027090000_project_members.sql`): `project_id`, `name`. A trigger on `issues` records every label an item gets.

## API

- `POST /projects/:key/issues`; `GET /projects/:key/issues?cursor=&limit=&status=&assignee=&type=&sprint=&release=&parent=`.
- `GET /issues/:key?expand=`, `PATCH /issues/:key` (`If-Match`), `DELETE /issues/:key`, `POST /issues/:key/restore`.
- `GET /issues/:key/comments`, `GET /issues/:key/activity` (`cursor`, `limit` up to 200).
- `POST /issues/:key/clone` `{ title?, assigneeId?, include: { children, links, sprint } }`.
- `POST /issues/bulk/edit` `{ issues, patch }`, `/bulk/delete` `{ issues }`, `/bulk/restore` `{ issues }`.
- `GET /labels?query=&limit=`.
- Errors: 400 (invalid field, unknown expand, bad cursor, bulk limit), 403 (role), 404 (no such item, or a project I can't see), 409 (stale version, workflow).

## Screens

- The item detail panel (`/i/PAY-12`): fields, comments, history, work logs, links and attachments.
- The create dialog, the item's Actions menu (Clone, Delete) and the bulk bar on lists.
- The Undo toast after a destructive or bulk change.

## System settings

- **Search and bulk › Bulk change limit:** `bulkMaxItems`, 1 to 5,000, default 200.

## Scale

- Lists page on the server by `(rank, id)`, comments and history by `(created_at, id)`, so no page repeats or skips a row.
- The detail call embeds at most 200 comments, history rows and work logs, and 500 child items.
- Labels have their own table, so offering them never scans items.
- A bulk change is one transaction of at most the bulk limit.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: the first two items are PAY-1 and PAY-2. Unit test (web): items are numbered per project |
| R2 | Server test: items are created in a new project, with and without a type |
| R3 | Server test: a move bumps the version to 2; a stale If-Match is refused (409) |
| R4 | Server test: four edits read back newest first, three a page |
| R5 | Server test: all related records by default; `expand` picks; an unknown one and a bad cursor are refused; comments page oldest first without gaps |
| R6 | Server test: one item a page, then the next page by cursor |
| R7 | Server test: a deleted item leaves the list and comes back on restore |
| R8 | Server test: three items edited in one call; a missing one changes nothing; the workflow refuses for all; duplicates count once; empty and 201 items refused |
| R9 | Server test: labels from create, edit and bulk edit are listed, alphabetically, narrowed in any case, `%` literal, limited, kept after deletion |
| R10 | Server test: a plain clone and one with children, links and sprint; its history; a viewer refused. Unit test (web): the store's clone |
| R11 | Unit test (web): undo restores a deleted item once; undo is withdrawn after another change |
| R12 | Unit test (web): the sample workspace is consistent |

## Out of scope and deliberate divergences

- **Undo** is an addition: Jira has none. Server-side, a deleted item stays restorable for the period in spec 0202.
- **Stale edits** are refused with 409, where Jira saves the last edit made.
- **Cloning attachments** (Jira's "Include attachments") is not built.
