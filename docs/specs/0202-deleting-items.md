# 0202 Deleting work items: project admins only, sub-items go too, epics' items stay; Undo kept for a set time

Status: Ported (aws-jira `9f82bba`, strand `6707c7a`), approved by the PO on 9 Nov 2026 with the Deleted work items list; awaiting verification
Parity rows: PRM-02

## Context and Jira reference

In Strand today:
- **Any member can delete,** one item or a bulk selection, and restore one.
- **Children:** the web app deletes an item's direct children with it, epics included: deleting an epic deletes its items. The server deletes only the item it is sent.
- **Purging:** deleted items are never purged.

- **Jira DC:**
  - **Delete Issues** belongs to the **Administrators** project role in the default permission scheme ([Managing project permissions](https://confluence.atlassian.com/adminjiraserver/managing-project-permissions-938847145.html), DC 11.3; defaults as listed by [Default Jira project permissions](https://www.jirastrategy.com/default-jira-project-permissions/), both checked 9 Nov 2026).
  - **Deleting is permanent:** "when the issues are deleted they are permanently and irrevocably deleted" ([Atlassian Community](https://community.atlassian.com/t5/Marketplace-Apps-Integrations/Trying-to-delete-all-the-children-Tasks-when-an-Epic-is-deleted/qaq-p/577694)).
  - **Sub-tasks:** deleting a parent deletes its sub-tasks. Jira's REST API refuses to delete a parent without `deleteSubtasks` ([Atlassian Community](https://community.atlassian.com/forums/Jira-questions/bulk-delete-deletes-parents-of-tickets-i-am-deleti/qaq-p/3112103)).
  - **Epics:** deleting an epic doesn't delete the issues in it; "JIRA has already removed the epic link from all the stories that used to be in this epic" (same Community thread as above).
  - These last three points come from Atlassian's Community and the REST API, not from a DC documentation page; marked as such.
- **Strand:**
  - The table of spec 0201 has Delete issues at member, marked "0202: admin".
  - Undo of a delete is a Strand extra. The product owner decided on 5 Nov 2026 to keep it, admins only, with a retention period set in System settings.

## Rules

- **R1:** Deleting a work item needs Delete issues, which moves to **project admins** (spec 0201's table, as Jira's default). This applies to the single delete, the bulk delete and the API. Members and viewers get 403 ("You need the Delete issues permission in PAY").
- **R2:** Restoring a deleted item (Undo) needs Delete issues too.
- **R3:** Deleting an item also deletes its sub-items, at any depth, in the same action, as in Jira. The confirmation says how many: "PAY-12 and its 3 sub-items will be deleted."
- **R4:** Deleting an epic doesn't delete the items in it, as in Jira. They stay, without an epic while it is deleted. The confirmation says so: "Its 8 work items stay, without an epic."
- **R5:** Restoring an item brings back the sub-items deleted with it, not ones deleted separately before. Restoring an epic gives its items their epic back, if they still have none.
- **R6:** A deleted item stays restorable for the number of days set in **System settings › Deleted work items** (default 30; 1–365). After that it is removed for good, with its comments, work logs, links, attachments and history, by a daily background job. This is a deliberate extra over Jira, recorded in the register.
- **R7:** Project admins see **Project settings › Deleted work items**: the items deleted in the project, newest first, a page at a time, each with who deleted it and when, until they are removed for good. They can restore an item there (R5).
- **R8:** On screen, Delete is shown only to those who may delete: in the item's menu, the board card's menu and the bulk bar. Undo after a delete is offered to them as today.

## Permissions

| Action | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|
| Delete a work item (with its sub-items) | – | – (was ✓) | ✓ | ✓ |
| Restore a deleted work item | – | – (was ✓) | ✓ | ✓ |
| See Project settings › Deleted work items | – | – | ✓ | ✓ |
| Set the retention period | – | – | – | ✓ |

## Data model and migration

- `issues.deleted_by uuid` (who deleted it, for R7). Items already deleted keep it empty.
- Sub-items deleted with their parent share the parent's `deleted_at` (one statement, one timestamp), which is how R5 finds them.
- A partial index on `(project_id, deleted_at desc) where deleted_at is not null`, for R6 and R7.
- System setting `deletedItems: { retentionDays: 30 }`.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `DELETE /issues/:key`, `POST /issues/bulk/delete`, `POST /issues/:key/restore` and `POST /issues/bulk/restore` need Delete issues (R1, R2). Deleting also deletes the sub-items (R3).
- **New: `GET /projects/:key/deleted?cursor&limit`**, for project admins: keyset paged by deletion time. Returns key, title, type, deleted at, deleted by, sub-items deleted with it, and when it will be removed for good.
- **New: `GET /issues/:key/delete-preview`:** how many sub-items go with it, and, for an epic, how many items stay. Needs Delete issues.
- A daily job (`deleted-items.purge`) removes items deleted more than the retention period ago, in batches.

## Screens

- **Delete confirmation** (item, board card, bulk bar): the counts from R3/R4. Jira equivalent: Delete issue, which lists its sub-tasks.
- **Project settings › Deleted work items:** a paged list with Restore.
- **Administration › System settings:** "Deleted work items: keep for N days".

## System settings

`deletedItems.retentionDays`: default 30, between 1 and 365.

## Scale

- The purge job deletes in batches of 1,000 per transaction, oldest first. It is safe to run on many projects at once, and a stopped run resumes.
- The list and the preview use the new index and the existing `parent_id` index.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server tests: a member is refused single and bulk delete (403, message names the permission); a project admin deletes. Permission matrix rows for delete and restore become `padmin` |
| R2 | Server test: a member is refused restore; an admin restores |
| R3 | Server test: deleting an item deletes its sub-items (two levels); the preview counts them |
| R4 | Server test: deleting an epic leaves its items, with no epic; the preview counts them |
| R5 | Server test: restoring brings back only the sub-items deleted with it; restoring an epic gives its items their epic back |
| R6 | Server test: with a retention of 1 day, an item deleted 2 days ago is removed by the job, with its comments and links; one deleted today stays; the setting refuses 0 and 400 |
| R7 | Server test: the list pages, shows who deleted, and is for project admins only. Browser journey: an admin restores from Project settings |
| R8 | Browser journey: a member sees no Delete on an item, a card or the bulk bar; an admin deletes with the counts shown and undoes |

## Strand branch

Same rules. A deleted item hidden by a security level is listed only for admins who could see it.

## Out of scope and deliberate divergences

- **Undo, the Deleted work items list and the retention period** are Strand extras. Jira deletes permanently. Recorded as deliberate (PRM-02). They add to Jira's flow without changing who may delete or what is deleted.
- **Archiving single items** instead of deleting them: spec 0508.

## Open questions

None. The product owner chose to include the Deleted work items list (R7) on 9 Nov 2026.

## Changelog

- 9 Nov 2026, in review: the list (R7) is included.
- 9 Nov 2026, while building (within the approved rules):
  - **R4/R5:** an epic's items keep their link to a deleted epic in the database, and the API shows them with no epic while it is deleted. Restoring the epic shows the link again, unless the item was given another epic or none in the meantime. This keeps Undo and the browser's copy of the items in step without reloading.
  - **R7:** the list can be searched by key or title.
