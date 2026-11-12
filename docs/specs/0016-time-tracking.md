# 0016 Time tracking

Status: Implemented

## Context and Jira reference

People estimate work and log the time they spend on it. An item has an original estimate and a remaining estimate; logging work counts the remaining estimate down, in one of Jira's four ways. Times are stored as minutes. The counting is one shared function (`server/src/shared/estimates.ts`) used by the server and the web app.

Extended by spec 0306 (hours per day, days per week, display format and default unit) and spec 0412 (the board's remaining-estimate burndown).

- **Jira DC:** [Configuring time tracking](https://confluence.atlassian.com/adminjiraserver/configuring-time-tracking-938847808.html): an issue has Original Estimate, Remaining Estimate and Time Spent. Logging work adjusts the remaining estimate automatically, leaves it, sets it to a new value, or reduces it by an amount. People edit and delete their own work logs; the Edit All and Delete All Worklogs permissions cover everyone's. The app follows Jira.

## Rules

- **R1: Estimates.** An item has an original estimate (`timeEstimate`) and a remaining estimate (`timeRemaining`), in whole minutes, not negative. Setting the original estimate, on create or later, when there is no remaining estimate yet starts the remaining one at the same value.
- **R2: Logging work.** Someone who can work on the item logs time: minutes (a positive whole number), a date and an optional note. By default the remaining estimate counts down by the time logged, never below zero. An item with no remaining estimate keeps none. The web app adds "logged 1h 30m" to the item's history.
- **R3: Jira's four ways.** `adjustEstimate` says what happens to the remaining estimate:
  - `auto` (the default): reduce it by the time logged;
  - `leave`: leave it;
  - `new`: set it to `newEstimate`;
  - `manual`: reduce it by `reduceBy`.

  Without the amount `new` or `manual` needs, the log is refused (400 "Say the new remaining estimate", "Say how much to change it by").
- **R4: Changing or removing a log.** Changing a log's time moves the remaining estimate by the difference; removing a log puts its time back. Both take the same `adjustEstimate`.
- **R5: Setting the remaining estimate.** The remaining estimate can be set by hand (`PATCH /issues/:key { timeRemaining }`). Logging more than is left leaves zero.
- **R6: Whose logs.** People change and remove their own logs. A project admin changes and removes anyone's in the project; anyone else gets 403. A change to, or the removal of, someone else's log is audited (`worklog.updated`, `worklog.deleted`). In a workspace kept only in the browser, which has no roles, everyone may.
- **R7: Typing and showing durations.** With the default settings people type `1h 30m`, `45m`, `2d` (a day is 8 hours) or `1d4h`; text that isn't a duration (`soon`, `3 apples`, nothing) is not read. Durations show as `1h 30m`, `2h`, and nothing as `0m`.
- **R8: Screens.** An item's details show a bar of time logged against the estimate, "3h logged" and "1h remaining", and the original and remaining estimates, editable. The bar opens Time tracking: time spent, date, the remaining estimate (Adjust automatically, Leave unchanged, Set to, Reduce by) and what was worked on. Log time confirms with "Logged 2h on KEY-1". The work log below lists each entry, with Change and Delete for one's own, or for everyone's as a project admin.

## Permissions

As spec 0201's table: Work on issues to log; Edit own and Delete own work logs for the author; Edit all and Delete all work logs for project admins.

## Data model

- `worklogs (id, issue_id, user_id, minutes, date, note, created_at)`: `server/migrations/20261011205352_rest_of_schema.sql`.
- `issues.time_estimate`: `20261011202354_core_schema.sql`; `issues.time_remaining integer check (time_remaining >= 0)`: `20261105090000_remaining_estimate.sql`.

## API

- `POST /issues/:key/worklogs { minutes, date, note, adjustEstimate, newEstimate, reduceBy }`.
- `PATCH /worklogs/:id { minutes, date, note, adjustEstimate, … }`, `DELETE /worklogs/:id?adjustEstimate=…`: 403 for someone else's without the permission, 404 for one you can't see.
- `PATCH /issues/:key { timeEstimate, timeRemaining }`.

## Screens

As R8.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: the remaining estimate starts at the original. Unit test (web): the same |
| R2 | Server test: logging counts it down, never below zero. Unit test (web): logs add up, history says "logged 1h 30m". Browser journey: logging 2h counts it down |
| R3 | Server test: auto, leave, new and manual; `new` without an amount is 400. Unit test (web): the four ways. Browser journey: Set to |
| R4 | Server test: changing a log moves it by the difference; removing puts the time back. Unit test (web): the same |
| R5 | Server test: set by hand, then logging more than is left leaves zero |
| R6 | Server test: a member can't touch another's log, a project admin can, audited. Unit tests (web): a member can't delete another's log; anyone can in a browser workspace |
| R7 | Unit test (web): durations parse and show as people type them |
| R8 | Browser journey: Log time, then "3h logged … 1h remaining" |

## Out of scope and deliberate divergences

- **Turning time tracking off:** spec 0306.
