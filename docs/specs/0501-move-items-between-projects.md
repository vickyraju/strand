# 0501 Move items between projects

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: ISS-10, ISS-20

## Context and Jira reference

- **Jira DC's Move** (More › Move; Bulk change › Move issues):
  - **The steps:** choose the target project and issue type; choose a new status when the item's status isn't in the target workflow; update the fields the target needs (versions and components belong to projects, an assignee who can't be assigned there); confirm, seeing every change.
  - **Keys:** the item takes the next key of the target project. **The old key still opens it**, in links, the address bar, REST and JQL.
  - **Sub-tasks** move with their parent. A sub-task can't be moved to another project alone.
  - **What stays:** comments, attachments, work logs, history, links, watchers, the epic link.
  - **Permissions** (Jira's default scheme): Move Issues in the source project and Create Issues in the target.
  - **History** records the move; webhooks send `jira:issue_updated` with `issue_event_type_name` `issue_moved`.
- **Strand today:** no move. The permission table has Move issues held by nobody until this spec (spec 0201 R6).

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22move%20issue*%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-61359](https://jira.atlassian.com/browse/JRASERVER-61359) Move an issue through the REST API | 66 | Gathering interest | **Built:** `POST /issues/:key/move` and `POST /issues/bulk/move` (R7) |
| [JRASERVER-39112](https://jira.atlassian.com/browse/JRASERVER-39112) An assignee who can't be assigned in the target is kept | 32 | Fixed in 7.3.2 | **Built:** such an assignee is replaced (R4) |
| [JRASERVER-41039](https://jira.atlassian.com/browse/JRASERVER-41039) Search for items that were moved | 118 | Gathering interest | **Proposal P1** |
| [JRASERVER-15259](https://jira.atlassian.com/browse/JRASERVER-15259) Move a sub-task to a parent in another project | 105 | Gathering interest | **Proposal P2** |
| [JRASERVER-12059](https://jira.atlassian.com/browse/JRASERVER-12059) Bulk copy (clone and move) to several projects | | Gathering interest | Not proposed |
| [JRASERVER-5159](https://jira.atlassian.com/browse/JRASERVER-5159) Admins force the target status | | Gathering interest | Not proposed |

**Proposals for the product owner** (not built until chosen):

- **P1: JQL for moved items**, for example `issue in movedFrom("OLD")`.
- **P2: Move a sub-item alone**, choosing its new parent in the target project.

## Rules

- **R1: Who.** Move needs Move issues in the source project (Jira's default: anyone with access, so Strand's member) and Create issues in the target. Neither project may be archived. Moving within one project is changing the type, not a move.
- **R2: What moves.** An item or an epic, with its sub-items. A sub-item alone can't move to another project (it moves with its parent).
- **R3: The target's type and status.**
  - The type: one of the target's work types (the same one by default when the target has it). Jira's levels apply (spec 0303).
  - The status: the same status when the target's workflow for that type has it, else one chosen from it.
  - Sub-items take the same status, else one of the same category, else where the workflow starts.
- **R4: Fields.**
  - Fix versions, affects versions and components become the target's versions and components **of the same names**, unless others are chosen; the rest are removed.
  - Custom fields keep their value when the target has a field of the same name and kind; other values are removed.
  - The sprint is cleared (Strand's sprints belong to a project's board). The test folder is cleared.
  - An assignee who can't be assigned in the target is replaced by the chosen person or nobody.
  - A resolution stays only in a Done status.
  - Comments, attachments, work logs, history, links, watchers, labels, dates, estimates, rank and the epic link stay.
- **R5: Keys.** The item (and each sub-item) takes the next key of the target project. Its earlier keys keep working everywhere a key is used: the address, the API, JQL (`key = OLD-1`) and search. Numbers are never reused, so an old key always means this item.
- **R6: The preview.** Before anything changes, Strand shows the new keys and every change, field by field (Jira's confirmation page).
- **R7: The API and bulk.** `POST /issues/:key/move` (with `dryRun` for the preview), and `POST /issues/bulk/move` for many items to one project, up to the bulk limit in System settings, with statuses mapped by R3 (or a status map given).
- **R8: Records.** Each moved item's history says "Moved from OLD-1". Webhooks send `jira:issue_updated` with `issue_event_type_name` `issue_moved` and Jira's changelog (`Key`, `project`).

## Permissions

Move issues (member) in the source; Create issues in the target (spec 0201's table: `moveIssues` gets its role).

## Data model and migration

- `moved_issue_keys`: workspace, the old project, the old number, the item, when, by whom.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `POST /issues/:key/move` `{ projectKey, type?, statusId?, assigneeId?, fixReleaseIds?, affectsReleaseIds?, componentIds?, dryRun? }`.
- `POST /issues/bulk/move` `{ issues, projectKey, type?, statusMap? }`.

## Screens

- An item's actions: **Move…**: target project, type and status, the fields to update, the preview, Move.
- The bulk bar: **Move…** for the selected items.

## System settings

`searchAndBulk.bulkMaxItems` limits bulk moves.

## Scale

One transaction per item (with its sub-items); a bulk move handles up to the bulk limit in one request.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: refused without Move or Create, to an archived project, within one project, for a sub-item alone |
| R3, R4, R6 | Server test: the preview, status mapping, versions and components by name, custom fields by name and kind, sprint cleared, assignee replaced |
| R5 | Server test: the old key opens it, finds it in JQL and search; moved twice, both old keys work |
| R7, R8 | Server test: bulk move; history; the webhook. Browser journey: Move… from an item, then its old address opens the new key |

## Strand branch

Same rules; the item's security level is cleared (the target has its own levels).

## Out of scope and deliberate divergences

- **The sprint** is cleared, where Jira keeps it.

## Open questions

None.

## Changelog
