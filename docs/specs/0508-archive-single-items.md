# 0508 Archive single items

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC 8.1 and later** (Archiving an issue; the Archived issues list):
  - A **Jira administrator** archives an issue (More › Archive) or many (bulk change). Its **sub-tasks are archived with it**; an epic's issues aren't.
  - An archived issue is **read-only**: no edits, comments, transitions, votes or watching. It is **left out of search, boards, reports and dashboards**; it still opens by its key (and from links), marked archived.
  - The **Archived issues** page lists them (newest first, searchable); an administrator **restores** one from there or from the issue, with its sub-tasks.
  - Archiving and restoring are audited. Jira's default permission scheme grants nobody the project permission Archive Issues; Jira administrators do it.
- **Before this spec:** a whole project can be archived (spec 0102); single items can't.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22archive%20issue*%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Issue | Status | The app |
|---|---|---|
| Project admins can't archive their own project's issues | Long-standing request | **Proposal P1** |
| Archive by a JQL query, on a schedule (e.g. resolved more than two years ago) | Long-standing request | **Proposal P2** (with automation, spec 0709) |

**Proposals for the product owner** (not built until chosen):

- **P1: Project admins archive** their project's items (the permission table's Archive issues given to project admins).
- **P2: Archiving by automation:** a scheduled rule's action "Archive" for, say, items resolved over two years ago.

## Rules

- **R1: Who.** System admins archive an item (its menu), or many (the bulk bar). Sub-items go with their parent; an epic's items stay.
- **R2: Archived.** Read-only: no edit, comment, work log, transition, link, vote or watch (a 403 saying so). Left out of project lists, boards, backlogs, search and JQL, reports, Your work and the project summary. It still opens by its key and from links, with a banner: "Archived …: read-only".
- **R3: The list.** Administration › **Archived work items**: newest first, searchable by key or summary, a page at a time; **Restore** brings an item back with its sub-items, as it was.
- **R4: Records.** Archiving and restoring are audited and go into the item's history.

## Permissions

System admins (Jira's default scheme grants Archive Issues to nobody).

## Data model and migration

- `issues.archived_at`, `issues.archived_by`.

## API

- `POST /issues/:key/archive`, `POST /issues/:key/unarchive`, `POST /issues/bulk/archive`.
- `GET /admin/archived-items` (`query`, `cursor`).
- Items gain `archivedAt`, `archivedBy`.

## Screens

- The item's menu: **Archive**; its banner with **Restore**. The bulk bar: **Archive**.
- Administration › Archived work items.

## Scale

Lists filter one column; the archived list pages on the server.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R4 | Server test: archive with sub-items, not an epic's items; read-only; out of lists, search and boards; opens by key; audited; non-admins refused |
| R3 | Server test: the list and restore. Browser journey: archive an item, it leaves the list, restore it |

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
