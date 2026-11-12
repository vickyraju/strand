# 0023 Attachments and file storage

Status: Implemented

## Context and Jira reference

Files attached to work items live in S3-compatible storage. The browser sends a file straight to storage and the server only checks that it arrived, so large files never pass through the API. A file that is removed, by any route, leaves storage reliably. Who may delete whose attachments: spec 0203 R2.

- **Jira DC:** attachments are uploaded through Jira and kept in its home directory. Administration › Attachments turns them on or off and sets the largest file (10 MB by default). The app follows Jira's settings with its own default of 25 MB, and keeps the files in object storage instead of on a disk.

## Rules

- **R1: Uploading in two steps.**
  - **Register:** `POST /issues/:key/attachments` with the file's name (up to 255 characters), size and type. The answer has an address to `PUT` the bytes to, valid for 5 minutes.
  - **Confirm:** `POST /attachments/:id/complete`.
- **R2: Confirming checks the file.**
  - The file must be in storage with the registered size. A file never sent, or with fewer bytes, is refused: 409 "The file has not arrived (or is not the size that was registered); upload it again".
  - Only the person who uploaded it can confirm it (403 otherwise).
- **R3: Shown once it has arrived.** Until it is confirmed, an attachment isn't listed on the item and has no download address (404). Once confirmed, `GET /attachments/:id/url` gives a download address valid for 5 minutes.
- **R4: Unconfirmed uploads go.** An upload not confirmed within a day is removed, its record and its file.
- **R5: Removed files leave storage.**
  - Removing an attachment takes it off the item at once (204).
  - Its file is queued for deletion, whatever removed it: the attachment itself, its item purged for good, or its whole project deleted.
  - A sweep deletes queued files. One that storage fails to delete stays queued, with the error, and is tried again on the next sweep.
- **R6: Outsiders see nothing.** Someone who can't see the item's project gets 404 for its attachments, as if they didn't exist.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Download | 404 | yes | yes | yes | yes |
| Attach (register, confirm my own upload) | 404 | no | yes | yes | yes |

Deleting an attachment: spec 0203 R2.

## Data model

- `attachments` (`server/migrations/20261011205352_rest_of_schema.sql`): `issue_id`, `name`, `size`, `type`, `object_key` (`<workspace>/<item>/<random id>`), `added_by`, `added_at`; `uploaded_at`, empty until confirmed (`20261028110000_attachment_lifecycle.sql`).
- `file_deletions` (same migration): `object_key`, `queued_at`, `attempts`, `last_error`. A trigger queues the object of every deleted `attachments` row.

## API

- `POST /issues/:key/attachments` `{ name, size, type }` → `{ id, …, uploadUrl }`.
- `POST /attachments/:id/complete`; `GET /attachments/:id/url`; `DELETE /attachments/:id`.
- Errors: 400 (larger than the limit), 403 (attachments turned off, or not the uploader), 404, 409 (file not arrived), 503 "File storage is not configured (S3_BUCKET)".

## Screens

- The item detail's Attachments section: add files, open, delete.

## System settings

- **Attachments:** `enabled` (on), `maxSizeMb` 1–2,048 (25). Tested with spec 0028.

## Scale

- Bytes go between the browser and storage; the API never carries them.
- The sweep runs every 10 minutes (`FILE_SWEEP_MS`), on one API server at a time, 200 files a run.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a file registered, put and confirmed (200) |
| R2 | Server test: a file never sent, and one with 4 of 10 bytes, are refused (409) |
| R3 | Server test: only the confirmed file is listed; the unconfirmed one has no download address, the confirmed one has |
| R4 | Server test: a day later the unconfirmed records and files are gone |
| R5 | Server test: a removed attachment leaves the item at once; a failed storage delete is retried; a deleted project's files leave storage |
| R6 | Server test: an outsider gets 404 for a download address |

## Out of scope and deliberate divergences

- **Storage:** object storage (S3 or compatible) instead of Jira's home directory.
- **Thumbnails and zip downloads** are not built.
