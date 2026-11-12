# 0102 Archived projects are read-only; only global admins archive

Status: Implemented (approved 5 Nov 2026)

## Context and Jira reference

The app marks a project archived (`projects.archived_at`), but this only hides it from the project lists. Its work can still be changed by anyone who could change it before, and project admins can archive and restore their own projects. The web app has no Archive or Restore button; there is only an "Archived" filter on the Projects page.

- **Jira DC** ([Archiving a project](https://confluence.atlassian.com/adminjiraserver/archiving-a-project-938847621.html), Jira DC 11.3, checked 5 November 2026):
  - **Who archives:** archiving and restoring need "the Jira Administrator or Jira System Administrator global permission". It's done from Administration › Projects › Actions › Archive, and the project moves to the **Archived projects** page.
  - **Hidden:** the project "can't be viewed by anyone" and disappears from "project pickers, list of projects, search results, or JQL auto-complete".
  - **Read-only:** "Issues will become read-only. You won't be able to modify them." They can still be viewed "through direct links or mentions in other projects or applications", and links to the project still work.
  - **Configuration:** schemes, workflows and custom fields "remain active and still shared with other projects". Changes to them apply to the archived project too.
  - **Restore:** Administration › Projects › Archived projects › Restore brings the project back "to its original state". All its data stayed in the database.
- **Before this spec:**
  - `roleOf` in `server/src/access.ts` ignores `archived_at`, so every route that checks a role lets changes through.
  - `POST /projects/:key/archive` and `/restore` (`server/src/routes/projects.ts`) need a project admin.
  - Only the project lists filter on `archived_at` (`projects.ts`, `GET /projects` and `/projects/search`). Search, boards, Your work and pickers don't.

## Rules

- **R1:** Only global admins archive and restore a project. Anyone else gets 403. Both actions are audited, as today.
- **R2:** An archived project is read-only for everyone, global admins included. Every change to it or to anything in it is refused with 403 and the message "This project is archived. A system administrator can restore it to change it." This covers:
  - its items, comments, attachments, work logs, links and watchers;
  - its sprints, boards, versions and components;
  - its people and its settings.

  Restore (R1) and delete (R8) are the exceptions.
- **R3:** An archived project's items don't appear anywhere work is listed or searched:
  - search and JQL results, and the counts from `POST /jql/check`;
  - saved views and CSV export;
  - every board and backlog, including boards of other projects whose filter names it;
  - Your work;
  - project lists, the starred list, and project pickers (for example the project of a new work item).
- **R4:** An archived project's items still open by their key, read-only, for anyone who could see them before. The item page shows the notice "This work item is in an archived project. It can't be changed." Links to such items keep working.
- **R5:** The project's own pages (Summary, Board, Backlog, List, Timeline, Calendar, Releases, Reports, Tests, Settings) show only "PAY is archived", and nothing else, as in Jira: the project can't be viewed. Global admins also see a Restore button there.
- **R6:** Completing a sprint on another project's board leaves the items of an archived project where they are, in the completed sprint (R2).
- **R7:** **Administration › Archived projects** lists archived projects a page at a time, searchable by name or key, newest archived first. Each row shows when the project was archived and by whom, and has a Restore action, which asks first. **Archive project** is in Project settings, for global admins only, next to Delete project, and also asks first. Its confirmation says what archiving does (R2–R5).
- **R8:** A global admin can delete an archived project without restoring it first. The delete runs as today: a background job, with a backup first when backups are on.
- **R9:** A restored project is as it was: listed, searchable, on its boards, and changeable by its members.
- **R10:** A system administrator's workflow and scheme changes still apply to an archived project, as in Jira, where its configuration stays shared. That includes moving its items out of a removed status as the change maps them. This is configuration, not a change of its work, so R2 doesn't refuse it.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Archive or restore a project | – | – | – | – | ✓ |
| Change anything in an archived project | – | – | – | – | – |
| Open an archived project's item by its key | – | ✓ | ✓ | ✓ | ✓ |
| See an archived project's pages, items in search, boards, lists | – | – | – | – | – (Administration › Archived projects only) |
| Delete an archived project | – | – | – | – | ✓ |

## Data model and migration

- One column added: `projects.archived_by` (who archived it), shown in R7.
- No data moves. Projects already archived stay archived; from now on they are read-only (R2).

## API

- `POST /projects/:key/archive` and `POST /projects/:key/restore` need a global admin (R1). Restore can reach an archived project; nothing else that changes data can (R2).
- **New** `GET /admin/archived-projects?query&cursor&limit`, for global admins: keyset paged by archive date, returning key, name, archived date and who archived it (R7).
- `GET /projects/search?archived=1` is dropped. The Projects page's "Archived" filter moves to Administration.
- All other routes: no change of shape. Writes to an archived project return 403 with the R2 message.
- `GET /issues/:key` and `GET /projects/:key` stay readable for those who could see the project (R4 needs the project's statuses and types). The project detail includes `archivedAt`, already present.

## Screens

- **Project settings:** "Archive project" for global admins, beside "Delete project", with a confirmation.
- **Project pages:** the archived notice from R5.
- **Item page and side panel:** the archived notice; fields, comments and actions are read-only (R4).
- **Administration › Archived projects:** the list and Restore, using the shared paged list. Jira equivalent: Administration › Projects › Archived projects.
- **Projects page:** the "Archived" checkbox goes.

## System settings

None.

## Scale

- **Exclusion from lists and search:** a single check on `projects.archived_at` inside the shared visibility condition (`visible` in `server/src/access.ts`), which every list and search already uses.
- **Archived projects list:** keyset paging on `(archived_at, id)`, backed by a partial index on archived projects.
- **Archiving:** nothing needs reindexing; the hide is query-time.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a project admin is refused archive and restore (403); a global admin archives and restores; audit rows exist; permission matrix rows become `gadmin` |
| R2 | Server tests: after archiving, these are each refused with the R2 message for a member, a project admin and a global admin: edit item, create item, comment, attachment, work log, link, watch, sprint create, board change, version, component, member change, settings change. A mutation check removes the guard and a test fails |
| R3 | Server tests: the archived project's items are absent from search, `jql/check` counts, CSV export, a board of another project that names it, Your work, and the project and starred lists |
| R4 | Server test: `GET /issues/:key` still answers for a member; browser journey: the item opens with the archived notice and no editable fields |
| R5 | Browser journey: the project's board shows "PAY is archived"; a global admin sees Restore |
| R6 | Server test: a sprint on another board holding an archived project's unfinished item completes; that item keeps its sprint |
| R7 | Server test of `GET /admin/archived-projects` (paging, search, admin only); browser journey: archive from Project settings, find it in Administration › Archived projects, restore it |
| R8 | Server test: deleting an archived project as a global admin starts the job |
| R9 | Server test: after restore, a member edits an item and it is in search again |
| R10 | Server test: publishing a workflow that drops a status moves an archived project's items in it as mapped |

## Out of scope and deliberate divergences

- **Archiving single items** (Jira DC's issue archiving): spec 0508.
- **Reindexing:** The app has no search index to rebuild, so neither archiving nor restoring needs Jira's reindex step.

## Open questions

1. **R8, deleting an archived project without restoring it.** Atlassian's archiving page doesn't say. Proposed: allow it for global admins, since delete already backs up first.

## Changelog

- 5 Nov 2026, while building (within the approved rules): starring an archived project, recording that an item was opened and closing its edit presence are allowed (they change no work, and R4's "opens by key" needs them).
