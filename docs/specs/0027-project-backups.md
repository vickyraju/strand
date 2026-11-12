# 0027 Project backups

Status: Implemented

## Context and Jira reference

Deleting a project removes all its work. So that a mistaken delete can be undone, the app first backs the whole project up to S3, files included, and a system administrator can restore it later exactly as it was. Deleting and restoring run as background jobs (spec 0026). Extended by spec 0102 R8 (deleting an archived project).

- **Jira DC:** deleting a project removes it and its issues for good. Getting one back means restoring a backup of the whole site, or of the database, into another instance and moving the project across.
- **Where it differs:** each deleted project gets its own backup, which comes back in place with one action.

## Rules

- **R1: Deleting a project.** Only system administrators delete a project (anyone else: 403).
  - The answer is 202 with the job to follow at `GET /jobs/:id`.
  - From that moment the project is "being deleted": hidden from everyone (404, missing from lists) and closed to changes.
  - The job then deletes it.
- **R2: The backup.** When backups are on, the job first writes, under `<prefix><workspace>/<KEY>-<project id>/<job id>/`:
  - `project.json`, with every row of the project as stored: the project, statuses, work types, its own custom fields and their contexts, versions, components, templates, rules, boards, sprints, members, group roles, stars, work items, links, watchers, comments, history, work logs and attachments;
  - a copy of each attachment's file under `files/`.

  It records the backup (key, name, item, file and byte counts, the document's SHA-256) and deletes the project in the same transaction. The audit has `project.deleted`.
- **R3: The list.** `GET /admin/project-backups` lists backups newest first, with their counts and whether they were restored; `query` matches the key or name; pages of 50 by default, at most 200. A download link for the document lasts 5 minutes and is audited (`project.backup.downloaded`).
- **R4: Restoring.** `POST /admin/project-backups/:id/restore` answers 202 with the job. The job puts the project back with the same ids, keys, history, people and files, and then applies today's workflows. The deleted original files are removed from storage like any deleted attachment; the restore copies them back from the backup. The audit has `project.restored_from_backup`.
  - **Once only:** restoring the same backup again is 409 "This backup has already been restored".
  - **Key taken:** while a project with its key exists, 409 "A project with the key KEY already exists".
- **R5: Only an untouched backup is restored.** The job refuses a document whose SHA-256 differs from the one recorded: "The backup document has changed since it was written; it will not be restored". It also refuses one whose rows reach outside its project or workspace. A refused restore changes nothing, and the job retries.
- **R6: The setting.** System administrators turn backups on or off and choose where they go:
  - **On** is the default.
  - **Bucket:** only one the operators list in `BACKUP_BUCKETS`; any other is 400 "That bucket is not one the operators allow for backups (BACKUP_BUCKETS)". Without a choice: `BACKUP_BUCKET`, else the attachments bucket.
  - **Off:** deleting removes the project with no backup.
  - **On with nowhere to write:** deleting is refused with 409 "Project backups are on, but no storage is set for them. Choose a bucket, or turn backups off, in Administration."

  Changes are audited (`settings.project_backups.updated`).

## Permissions

| Action | Project admin | System admin |
|---|---|---|
| Delete a project | – | ✓ |
| See, download and restore backups | – | ✓ |
| Change the backup setting | – | ✓ |

## Data model

- `projects.deleting_at` and `project_backups (id, workspace_id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, created_at, created_by, restored_at)`: `server/migrations/20261029110000_project_backups.sql`. Plain ids, no foreign keys: the project is gone by design.
- `project_backups.sha256`: `20261029120000_backup_checksum.sql`.
- The setting is the `projectBackups` row of `system_settings` (spec 0028).

## API

- `DELETE /projects/:key` → 202 `{ jobId }`.
- `GET /admin/project-backups?query&cursor&limit` → `{ items, total, next }`; `GET /admin/project-backups/:id/url`; `POST /admin/project-backups/:id/restore` → 202 `{ jobId }`.
- `GET` and `PUT /admin/settings/project-backups` `{ enabled, bucket, prefix }` → also `effectiveBucket` and `allowedBuckets`.

## Screens

- **Project settings › Delete project**, for system administrators.
- **Administration › Project backups:** the "Back up deleted projects" switch, the bucket (when the operators allow several), and the list with Download and Restore. Restore asks first and says what comes back.

## System settings

**Project backups:** `enabled` (default on), `bucket`, `prefix` (default `project-backups/`). Saved through its own route, because the bucket must be one the operators allow.

## Scale

The whole project is read into memory to write the document, table by table. Files are copied inside S3, not through the server.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a member can't delete; the owner's delete is 202, and the project is gone at once for everyone; the job finishes it |
| R2 | Server test: the backup lists 2 items and 1 file; its document holds the items, comment, work log, link, attachment, field, context, two members and the history; the file copy has the content |
| R3 | Server test: the backup is listed and downloadable; a member can't list backups |
| R4 | Server test: the restore brings back the item with its parent, assignee, status, field value, comment, work log, link, attachment, history and file; a second restore is 409; the audit has it |
| R5 | Server test: a changed document is refused and the project stays deleted; with the real document back, the retry restores it |
| R6 | Server test: a bucket not allowed is 400, an allowed one is used; a member can't change the setting; with backups off, deleting makes no backup; with no storage, deleting is 409 |

## Out of scope and deliberate divergences

- **Expiry of old backups:** they are kept until the operators remove them.
- **Backups other than on delete:** whole-site backups are the platform's.
