# 0404 Each Scrum board's estimation statistic: story points, original time estimate, or issue count

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC:** [Configuring estimation and tracking](https://confluence.atlassian.com/jirasoftwareserver/configuring-estimation-and-tracking-938845319.html), checked 9 Nov 2026.
  - **Where:** each Scrum board chooses its estimation statistic, in Board › Configure › Estimation. Board admins and Jira admins set it.
  - **Options:**
    - **Story Points:** the most common;
    - **Original Time Estimate;**
    - **Business Value;**
    - **Issue Count:** the Estimate field isn't editable;
    - **any numeric custom field.**
  - **What it drives:** the backlog's Estimate values and totals, sprint commitment, velocity (the sum for completed issues, recorded when an issue joins the sprint), and the burndown.
  - **Tracking statistic:** a separate setting (None, or Remaining Estimate and Time Spent) that changes how the burndown burns down.
- **Before this spec:** every board uses story points (the `estimate` field). Sprint commitment and completion, the backlog totals, the burndown and velocity all sum story points.

## Rules

- **R1: The setting.** Each Scrum board has an Estimation setting in its configuration's General section:
  - **Story points** (the default; every existing board keeps it);
  - **Original time estimate;**
  - **Issue count.**

  Board admins and project admins change it, like the rest of the board. Kanban boards have no estimation, as in Jira.
- **R2: What a sprint records.** Starting and completing a sprint on the board records the committed and completed totals, and each item's starting value for the Sprint Report (0402), in the board's statistic:
  - points;
  - minutes of original estimate;
  - one per item.
- **R3: Where it shows.** The board's statistic, in its own units, is used by:
  - the backlog: sprint and backlog totals, the completion dialog;
  - the burndown and velocity reports, and the Sprint Report.

  The units are "points", a duration in the workspace's time format (0306), or "issues". A sprint keeps the statistic it was started with, so changing the setting doesn't rewrite past sprints.
- **R4: Issue count.** Every item counts as one, whatever its fields say.

## Permissions

Board admins and project admins, as for the board's other settings.

## Data model and migration

- `boards.estimation text not null default 'points' check (estimation in ('points', 'time', 'count'))`.
- `sprints.estimation text` records the statistic the sprint was started with. Existing sprints count as points.

## API

- `PATCH /boards/:id` accepts `estimation`, and `GET /boards/:id` returns it.
- Sprints return `estimation`.

## Screens

Board configuration › General: "Estimation". Jira equivalent: Board › Configure › Estimation.

## System settings

None.

## Scale

The statistic is a column choice in the same sums as today.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a board admin sets Original time estimate; a member can't; a Kanban board refuses it |
| R2, R4 | Server test: a sprint started on a time board commits minutes; on a count board, the number of items; completed follows; start values are in that unit |
| R3 | Web unit test: the sprint total in each unit; browser journey: the backlog shows "2 issues" for a count board |

## Out of scope and deliberate divergences

- **Business Value and numeric custom fields as the statistic:** later, with global custom fields (0503).
- **Tracking statistic (Remaining Estimate and Time Spent burndown):** later. The burndown keeps burning down by the estimation statistic when items complete. Recorded as partial (AG-07).

## Open questions

None.

## Changelog
