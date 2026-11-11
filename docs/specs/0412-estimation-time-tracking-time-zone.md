# 0412 Estimation by any number field, remaining-estimate tracking, and the team's time zone

Status: Approved (pending work, 12 Nov 2026)
Parity rows: AG-07, AG-08

## Context and Jira reference

- **Jira DC** (Board › Configure › Estimation, [configuring estimation and tracking](https://confluence.atlassian.com/jirasoftwareserver/configuring-estimation-and-tracking-938845319.html)):
  - **Estimation statistic:** Story Points, Original Time Estimate, Issue Count, or **any number field**. Business Value is one such field (Jira Software ships it), and teams add their own (t-shirt points, effort).
  - **Time tracking:** **None**, or **Remaining Estimate and Time Spent**. The latter makes the sprint burndown follow the remaining estimate as work is logged (and drop to zero when an item is done). It's offered with the Original Time Estimate statistic.
- **Jira DC** (Board › Configure › Working days, spec 0405): the team's **time zone**, "System default" or a chosen zone. Days in the reports start and end in that zone.
- **Strand today:**
  - Story points, original time estimate and issue count (spec 0404).
  - No time tracking on the board.
  - Working days without a time zone: reports use the viewer's own clock.
- **Found while checking:** a custom field's change is stored in the item's history as `[object Object]`. The values are lost, so the history and JQL history can't show them. This must be fixed for a number field's estimate history (R1).

## Community and Atlassian backlog

Spec 0404's and 0405's research applies. A question that comes up often is that a custom-field statistic isn't totalled in the backlog's sprint headers. R1 covers it.

## Rules

- **R1: Any number field.**
  - A Scrum board's estimation statistic can be Story points, Original time estimate, Issue count, or a **number custom field** the board's projects have, such as Business value.
  - The sprint headers, the burndown, burnup, velocity, Sprint Report and the epic and version reports total that field.
  - A sprint keeps the statistic it started with, as before.
  - A change to a custom field is saved in the history field by field, with its value, so reports see the estimate as it stood at each moment.
- **R2: Remaining estimate and time spent.**
  - With the Original time estimate statistic, the board's **Time tracking** can be **Remaining estimate and time spent**.
  - The sprint burndown then shows each day's total remaining estimate of the sprint's items. An item without a remaining estimate counts its original estimate. An item done counts nothing.
  - So the line falls as people log work, not only when items are done.
  - The guideline starts from the remaining estimate when the sprint started.
- **R3: The team's time zone.**
  - Working days gain a **time zone**: the viewer's own (the default, as today) or a chosen one.
  - The burndown, burnup, Sprint Report, epic and version reports, and the working-day checks split days in that zone.

## Permissions

Board admins and project admins, as for the board's other settings.

## Data model and migration

- `boards.estimation` and `sprints.estimation` allow `field`, with `estimation_field_id` naming the custom field.
- `boards.time_tracking` holds `none` or `remaining`, `none` by default.
- `boards.working_days` gains `timeZone` (an IANA name, or absent for the viewer's own).
- Past history rows that read `[object Object]` lose those words, since their values can't be recovered.

## API

`PATCH /boards/:id` accepts:
- `estimation: 'points' | 'time' | 'count' | 'field'` with `estimationFieldId`;
- `timeTracking: 'none' | 'remaining'`;
- `workingDays.timeZone`.

`GET /boards/:id` returns them. A field that isn't a number field of the board's projects is refused. So is remaining-estimate tracking without the time statistic.

## Screens

Board configuration:
- **Estimation** lists the number fields after the three built-in statistics, and gains **Time tracking**.
- **Working days** gains **Time zone**.

## Scale

Nothing new. Reports run over the project's loaded items, as before.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: the board takes a number field and refuses a text one; a started sprint totals the field; a custom field change is recorded with its value |
| R1, R2, R3 | Unit tests: estimates at a moment from a field's history; the remaining-estimate burndown; days in a chosen time zone |
| R1, R2 | Browser journey: choose a number field as the statistic; the sprint header totals it |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Kanban boards** have no estimation statistic or sprints, as in Jira.

## Proposals (not built until chosen)

None.

## Open questions

None.

## Changelog
