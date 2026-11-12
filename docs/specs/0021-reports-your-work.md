# 0021 Reports and Your work

Status: Implemented

## Context and Jira reference

A project's reports (burndown, velocity, cumulative flow, created vs resolved) are worked out from each item's real status history. Your work is each person's starting page: what is assigned to them, what they worked on and viewed, and their recent projects.

- **Jira DC:** Jira Software's agile reports (burndown chart, velocity chart, cumulative flow diagram) and the created vs resolved report are drawn from the issues' history. Jira's menus list each person's recently viewed issues and projects, and dashboard gadgets show what is assigned to them. The app follows Jira's report definitions and gathers the personal lists on one page.
- Extended by specs 0402 (sprint report), 0404 and 0412 (estimation statistic, remaining estimate, time zone), 0405 (working days), 0410 (control chart) and 0411 (version, epic and release reports).

## Rules

- **R1: Report data.** `GET /projects/:key/report-data` returns every live item of the project (not deleted, not archived) in rank order, and every status change of those items, oldest first. Anyone who can see the project gets it; someone who can't gets 404.
- **R2: Reports replay the history.** An item's status at any moment is replayed from its status changes; replayed to now, it is the item's status. The reports drawn from the server's data (items plus status changes) are the same as those drawn from a full local history.
- **R3: Burndown.** From a sprint's start to its completion (or its end date): what is left each day, an item counting until it is in a Done status at the end of that day. The guideline falls from the committed estimate to zero; what is left never starts above the committed estimate and, without scope changes, never rises.
- **R4: Velocity and created vs resolved.**
  - **Velocity:** the project's last 8 completed sprints, each with its committed and completed estimate, and the average completed. Sprint names are shown without the project key.
  - **Created vs resolved:** items created and resolved in each day, or each week for spans over 45 days. An item is resolved when it last entered a Done status.
- **R5: Cumulative flow.** For each day, how many of the project's items were in To do, In progress and Done statuses; epics are left out. The bands add up to the number of items that existed that day.
- **R6: Assigned to me and Worked on.**
  - **Assigned to me:** my open items (not in a Done status), due soonest first, then most recently updated; at most 200.
  - **Worked on:** the items I last touched (a change, a comment or a work log), newest first; at most 40.
  - Only items of projects I can see, never deleted or archived ones.
- **R7: The Your work cards.** Counted by the database, so they stay right past the first page: my open assigned items, those due soon (within the System setting's days, 3 by default; late ones included), those late, and those blocked by an unfinished item through a "blocks" link. Epics and finished items are left out.
- **R8: Recent projects.** The 4 projects I can see (not archived) with the most recent activity (their latest item update, else when they were made), each with my open items, its done items and its total; epics are left out.
- **R9: Viewed.** Opening a work item records it (`POST /issues/:key/view`, 204; 404 for an unknown item). The list keeps my newest 50, newest first, each item once (opening it again moves it to the top). It is mine alone; a deleted item leaves it.
- **R10: Recently opened projects in the browser.** The browser remembers the projects I opened: newest first, no repeats, keys compared in any case, at most 30. At startup it loads in full my starred projects, then the recent ones, then those already on screen, without repeats, at most 60.

## Permissions

Reports: anyone who can see the project (spec 0201). Your work: each person's own lists, of projects they can see.

## Data model

- `activity` (`server/migrations/20261011205352_rest_of_schema.sql`): the history the reports replay (`field = 'statusId'`, `from_value`, `to_value`, `created_at`).
- `issue_views` (`server/migrations/20261025090000_issue_views.sql`): `user_id`, `issue_id`, `viewed_at`; newest 50 per person.
- Recently opened projects: the browser's local storage.

## API

- `GET /projects/:key/report-data`: `{ issues, statusChanges, … }`.
- `GET /me/work`, `GET /me/recent`, `GET /me/work/summary` (`{ assigned, dueSoon, overdue, blocked, dueSoonDays }`), `GET /me/projects/recent`, `GET /me/viewed`.
- `POST /issues/:key/view`: 204.

## Screens

- **Reports** (a project's Reports tab): burndown, velocity, cumulative flow, created vs resolved.
- **Your work** (the home page): the cards, Assigned to me, Worked on, Viewed, Recent projects.

## System settings

- **Due reminders › Due soon** (`dueReminders.dueSoonDays`, 1–30, default 3): what "due soon" means on Your work.

## Scale

The Your work counts and recent projects are counted in the database. The report data is a whole project in one response, worked out in the browser.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: every live item and every status change in order; a viewer gets it, an outsider 404 |
| R2 | Unit tests (web): status history replays to each item's status; reports from server data match the full local history |
| R3 | Unit test (web): the burndown starts at the committed points and never rises without scope changes; the guideline ends at zero |
| R4 | Unit test (web): velocity lists the completed sprints, completed never over committed in the sample; created vs resolved counts resolved items |
| R5 | Unit test (web): cumulative flow bands add up to the items that existed |
| R6 | Server test: an assigned item is in Assigned to me; Worked on lists the item just touched, newest first |
| R7 | Server test: the cards count past the first page; due soon, late, blocked; epics and finished items left out; a finished blocker blocks nothing |
| R8 | Server test: the 4 most recently active projects, my open items, done and totals without epics |
| R9 | Server test: newest first, once each, 50 at most, private; an unknown item 404; a deleted item leaves the list |
| R10 | Unit tests (web): recent projects capped at 30; startup loads starred, recent, then on screen, up to the cap |

## Out of scope and deliberate divergences

- **Dashboards:** the app has none; a project's Summary and Your work take their place (spec 0022 R10).
- **Velocity across a board's projects:** velocity counts a project's own sprints.
