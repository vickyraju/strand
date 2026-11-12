# 0008 The web app and the server: loading and saving

Status: Implemented

## Context and Jira reference

The web app keeps a copy of what is on screen in the browser and changes it at once, then sends the change to the server. One mechanism covers every action, Undo included: the app keeps what the server last had, compares it with the browser's copy after each change, and sends the difference. The server's rules still decide; when it refuses, its copy wins.

- **Jira DC:** each page is read from the server and each change is a form or REST call; there is nothing to compare. The app differs in how the screen keeps up, not in what is saved: every change goes through the same REST API that Jira's routes follow.

## Rules

- **R1: Loading the workspace.**
  - On start the app loads who I am, the people, my starred projects, my saved views, my notifications and the link types.
  - It loads in full only the projects I'm likely to use: starred, recently opened and on screen. With none of those, the four where work happened most recently. Other projects load when opened.
  - The signed-in person is the store's owner, and every loaded project's sprints are collected.
- **R2: Server rows become the app's shape.**
  - Empty values become absent fields. Dates and times become milliseconds.
  - A status keeps its WIP limit and description only when set. A transition from any status reads as `any`.
  - Board preferences are the app's defaults, overlaid by what the server stored.
  - A list row has empty watchers, links, work logs and attachments: those come with the item's detail.
  - In the detail:
    - history with no actor is Automation, and `statusId` reads as `status`;
    - only the item's own (outgoing) links are kept: an incoming one belongs to the other item.
- **R3: Only the difference is sent.**
  - What the server sent becomes the base, and is never sent back.
  - **New:** a record not in the base is created once, with the id the browser gave it.
  - **Changed:** a changed record is updated with only the fields that changed. A cleared field is sent as null; the status is sent as `statusId`. A new item's rank is left to the server (spec 0302).
  - **Missing:** a record that disappears is deleted.
  - Reloading one project replaces only that project's part of the base.
- **R4: One queue, in order.**
  - Every request goes through one queue, one at a time, in the order made.
  - Within one change, new records are sent before updates.
  - A sync can send its creates and updates first and its deletes later, so other work runs in between: a status is created before items move onto it, and deleted after they move off.
- **R5: Versions.**
  - Each item edit carries `If-Match` with the version the server last gave.
  - After a create, the server's key and version are used from then on.
  - An edit made while a request was in flight is kept: the reply doesn't overwrite it, and it is sent next.
- **R6: When a request fails.** The error is shown once. The work queued behind the failed request is dropped, and the affected data is loaded again from the server, which becomes the new base.
- **R7: Undo and deletes.**
  - An item deleted and then brought back by Undo is restored on the server (`POST /issues/:key/restore`), not created again.
  - A record that vanished only because its parent did (an item or project that Undo can bring back) is not deleted on the server, and isn't created a second time when it returns.
  - Work logs, links and "I'm watching" are compared only for items whose detail is loaded, so an item not yet opened is never taken for a deletion.
- **R8: The store takes the server's copies.**
  - **Project's items:** loading them replaces only that project's items. It can't be undone. It keeps the links, watchers, work logs and attachments an item's detail had already loaded.
  - **One item's detail:** it replaces only that item's comments, history, work logs, links and watchers.
  - **One item:** the server's copy replaces it, keeping those detail parts; an identical copy changes nothing.
  - **Projects and sprints:** a project is added, then replaced, with its sprints, leaving other projects alone. A sprint's copy replaces a sprint the store has, and is ignored otherwise.
  - **Notifications:** the list is replaced.
- **R9: Project settings are sent as the server stores them.**
  - Of a status, only its board WIP limit. Fields with their options and position. Absent values as null.
  - A rule without its run count, which is the server's.
- **R10: Where work went.**
  - When a sprint is completed or a version released in the browser, the app works out where the unfinished work went and sends that as `moveTo`; the server moves the items.
  - **Sprint:** the sprint its unfinished items now point at, or the backlog.
  - **Version:** the fix version that replaced the released one on its unfinished items, or none.
- **R11: Moving work off a deleted status.** When a status is removed, moving its items to another is sent with `X-Workflow-Override: 1`, so the workflow doesn't refuse it. The server honours the header only for project admins. An ordinary move never carries it.

## Permissions

As spec 0201's table: the server checks every request the app sends.

## Data model

None on the server. The browser keeps the store in memory; without a server address (`VITE_API_URL`) it keeps it in local storage instead.

## API

The app calls the routes of specs 0004, 0007, 0009 and the rest under `/api/v1` (`VITE_API_PREFIX` overrides it). A refused request's message is shown as the server wrote it.

## Screens

- "Loading your workspace…" while the first load runs, with Try again on failure.
- A toast when a save is refused: "Couldn't save that change: <the server's message>. Showing what the server has." The screen then shows the server's data.

## Scale

- A project's items load in pages of 500, up to 5,000; a project beyond that shows its first 5,000 by rank.
- At most six projects are fetched at once.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Unit test (web): the signed-in user owns the store and every sprint is collected; views and notifications load with the workspace |
| R2 | Unit test (web): a project, board preferences, a sprint, an item row, an item's detail, views and notifications map to the app's shape |
| R3 | Unit test (web): created once, then updated, then removed; loaded records aren't sent back; a scoped load; `patchOf` and `bodyOf`; `diffIssues`; a new item created once with its client id |
| R4 | Unit test (web): writes and deletes flushed separately with other work between |
| R5 | Unit test (web): the server key and version are adopted; an edit made in flight is kept |
| R6 | Unit test (web): a failure reports once, reloads and drops queued work, for collections and items |
| R7 | Unit test (web): delete then Undo restores; a vetoed delete; a vetoed record coming back isn't created again; only loaded details contribute |
| R8 | Unit test (web): `syncIssue`, `upsertProject`, `loadIssues`, `loadIssueDetail`, `syncSprint`, `setNotifications`, `loadProject`; a reload keeps loaded detail |
| R9 | Unit test (web): settings items serialize exactly what the server stores |
| R10 | Unit test (web): `moveToOf` and `releaseMoveTo` |
| R11 | Unit test (web): a move off a deleted status carries the override; an ordinary move doesn't |

## Out of scope and deliberate divergences

- **Offline editing:** a change made while the server can't be reached fails and is reloaded; it isn't kept for later.
