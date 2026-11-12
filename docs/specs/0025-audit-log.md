# 0025 Audit log

Status: Implemented

## Context and Jira reference

The audit log records who changed what, and when: people and roles, project settings and workflows, configuration, deletions, provisioning and imports. Administrators read it to answer "who did this?". Each module writes its own entries; the specs that add actions name them (for example `group.renamed` in 0104, `comment.moderated` in 0203).

- **Jira DC:** Administration › System › Audit log records changes to users, groups, permissions, projects, workflows and other configuration, with who made each change and when, and can be searched and filtered. Its entries are kept for a period the administrator sets.
- **The app follows Jira** in what it records and how it's searched.
- **Where it differs:**
  - Project admins can read their own project's entries.
  - Entries are never edited or removed.

## Rules

- **R1: What is recorded.** Each entry has the time, who acted (their email, or `SCIM` for provisioning), the action, the project (id and key), the target (type, id, readable name), the IP address, and **before** and **after** with only the fields that changed. For a project this includes:
  - `project.created` and `project.updated` (name, description, colour, lead; board preferences and layout aren't recorded);
  - `project.member.added`, `.role_changed`, `.removed`;
  - `project.workflow_scheme.changed` with `project.workflow.applied`;
  - `issue.deleted`;
  - `project.deleted`, with how many work items it had.
- **R2: One transaction.** An entry is written in the same transaction as the change it records: both happen or neither.
- **R3: Who reads it.**
  - **System administrators:** everything in their workspace, and the entries outside any workspace (SCIM provisioning).
  - **Project admins:** their project's entries, by passing `project`. Without it: 403 "Only workspace admins can see the whole audit log; project admins can pass project".
  - **Members and viewers** passing their project: 403 "Project admin only".
  - **Outsiders:** 404, as for any route naming the project.
- **R4: Searching.** Newest first, a page at a time: `limit` 50 by default and at most 200, and `next` as the cursor. Filters:
  - `action`: the action or its start ("project.member" matches added, role changed and removed);
  - `actor`: part of the email of who acted;
  - `from` and `to`: a time range.

  A cursor that can't be read is a 400.
- **R5: Append-only.** The database refuses every update, delete or truncate of the log with "The audit log can only be added to", whoever asks, the API included.
- **R6: It outlives what it names.** Entries hold plain ids and names, with no links to other tables. After a project is deleted, its entries remain and can still be read by system administrators.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | System admin |
|---|---|---|---|---|---|
| Read the project's entries | – (404) | – (403) | – (403) | ✓ | ✓ |
| Read the whole log | – | – | – | – | ✓ |
| Change or remove an entry | – | – | – | – | – (nobody) |

## Data model

`audit_log (id, workspace_id, at, actor_id, actor, action, project_id, project_key, target_type, target_id, target, before, after, ip)`, with indexes on `(workspace_id, at desc, id desc)` and `(project_id, at desc, id desc)`, and the append-only trigger: `server/migrations/20261029090000_audit_log.sql`. `workspace_id` is empty for SCIM changes; `actor_id` is empty when no person acted.

## API

`GET /audit?project&action&actor&from&to&cursor&limit` → `{ items, next }`. There is no route that changes the log.

## Screens

- **Administration › Audit log:** filters for action, who, project and dates; each row expands to show the full before and after, with the IP address; "Show older" loads the next page.
- **Jira equivalent:** Administration › System › Audit log.

## Scale

Keyset pages on `(at, id)`, backed by the two indexes; the newest entries come first without scanning the log.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a project admin's member changes, a rename, a scheme change, an item delete and a removal are recorded in order, with who, target, before and after; board preferences aren't |
| R2 | Server test: the scheme change and the workflow it applied are recorded together |
| R3 | Server test: the owner reads everything; a project admin is refused the whole log but reads their project; a member is refused; an outsider gets 404 |
| R4 | Server test: filtering by `project.member` returns only those actions |
| R5 | Server test: an update or delete in the database is refused with "can only be added to" |
| R6 | Server test: after the project is deleted, its `project.deleted` entry is there with the key and the item count |

## Out of scope and deliberate divergences

- **Retention and export:** the log is kept for good, and isn't exported.
- **Which actions each module records:** the module's own spec.
