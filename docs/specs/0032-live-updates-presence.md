# 0032 Live updates and edit presence

Status: Implemented

## Context and Jira reference

Each open project receives a live stream of what changes in it, so boards and lists stay current without reloading, and people see who else has an item open for editing. Presence is a soft hint, not a lock: anyone may still edit, and spec 0007 R3's versions keep edits from overwriting each other.

- **Jira DC:** a page shows what it read when it loaded; there is no live stream and no "is editing" hint. Both are additions that change nothing about how work is saved.

## Rules

- **R1: The stream.**
  - `GET /projects/:key/events` opens a Server-Sent Events stream (`text/event-stream`) for anyone who can see the project; anyone else gets 404.
  - It starts with `: connected` and sends `: ping` every 25 seconds.
  - Each change in the project arrives as `data: <json>` with its type: an item created, updated or deleted, items re-ranked, a comment added, or someone editing.
- **R2: From another site.** The stream carries the CORS headers for the web app's addresses (`CORS_ORIGINS`), so a browser there may read it. Any other origin gets none.
- **R3: Every server delivers.** A change is announced through the database, which every API server listens to, so it reaches the project's streams whichever server made it and whichever server holds the stream.
- **R4: Losing access ends the stream.**
  - The stream closes at once when its person loses access:
    - removed from the project;
    - deactivated;
    - removed from the workspace, or no longer a workspace admin;
    - or the project is deleted.
  - Other people's streams stay open.
  - Opening it again is refused (404), and the item's page then says it is not found.
- **R5: Editing heartbeat.**
  - While someone has an item open to edit, the app sends `POST /issues/:key/presence` every 30 seconds (204).
  - Each person has one row per item; a second beat only refreshes it.
  - Each beat:
    - removes rows with no beat for 90 seconds;
    - announces `issue.editing` on the project's stream with the people editing now, newest beat first, each with their name, initials and colour.
  - Viewers can't announce editing (403); an unknown item is 404.
- **R6: Leaving.** Closing the item sends `DELETE /issues/:key/presence`: the person's row goes at once and the new list is announced.
- **R7: On screen.**
  - The app keeps each item's editors from the stream. The same list again changes nothing; an empty list clears it.
  - The item shows the others editing it, with up to four faces: "Maya Chen is editing".

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Open the stream | 404 | yes | yes | yes | yes |
| Announce editing | 404 | no (403) | yes | yes | yes |
| Stop editing | 404 | yes | yes | yes | yes |

## Data model

- `issue_editors` (`server/migrations/20261022100000_issue_editors.sql`): `issue_id`, `user_id`, `last_heartbeat`; one row per person and item.
- Triggers announce lost access on the stream channel (`20261028090000_access_revoked_events.sql`): a project member removed, a project deleted, a person deactivated, a workspace membership removed or demoted from admin.

## API

- `GET /projects/:key/events` (Server-Sent Events).
- `POST /issues/:key/presence`, `DELETE /issues/:key/presence` (204).

## Screens

- An open project page reloads its items shortly after any change arrives (several changes in a burst cause one reload), and catches up after the stream reconnects.
- The item detail shows "… is editing" with the editors' faces.
- The app reconnects a dropped stream after 1 second, doubling up to 30 seconds; it stops when the stream answers 403 or 404.

## Scale

- Each API server holds one database connection for listening (`DATABASE_DIRECT_URL`), however many streams it serves.
- A stream lasts at most 10 minutes; the app then reconnects and is checked again, so an expired sign-in can't keep a stream open.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: the stream answers 200 as `text/event-stream`; a heartbeat arrives on it as `issue.editing` |
| R2 | Server test: an allowed origin gets `Access-Control-Allow-Origin`, an unlisted one doesn't |
| R3 | Server test: a heartbeat made by another request reaches the open stream, with the person's name |
| R4 | Server test: removed and deactivated people's streams end, another's stays, reopening is 404. Browser journey: a person removed with the board open loses the stream and the item |
| R5 | Server test: two beats make one row; stale rows are pruned by the next beat; a viewer refused; an unknown item 404 |
| R6 | Server test: leaving removes the row at once |
| R7 | Unit test (web): editors stored; the same list is no change; empty clears |

## Out of scope and deliberate divergences

- **Locking an item** while someone edits it: presence only informs.
