# 0411 Version, epic, epic burndown, release burndown and burnup reports

Status: Ported (aws-jira `1f2c95a`, strand `f31ab3e`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AG-12

## Context and Jira reference

- **Jira DC Agile reports** (Reports menu), besides the sprint report, burndown, velocity, CFD and control chart:
  - **Burnup:** for a sprint, the work scope and the work completed over time, with a guideline to the scope.
  - **Epic Report:** for one epic, its total and completed work over time, then its issues: **Completed**, **Incomplete**, **Unestimated**.
  - **Version Report:** the same for a version, with a **predicted release date** and optimistic and pessimistic dates, from the team's pace.
  - **Epic Burndown** and **Release Burndown:** per sprint, the work **completed** in the sprint, the work **remaining** after it, and the work **added** while it ran. A forecast says how many more sprints are needed at the team's velocity.
  - Every report counts in the board's estimation statistic, and counts an item as done when its status is in the board's last column.
- **Source** (checked 10 Nov 2026): [View and understand the epic report](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-epic-report/), and Jira DC's report list. The Data Center pages weren't reachable.
- **Strand today:** sprint report, sprint burndown, velocity, CFD, created vs resolved, control chart (0410), cycle time and workload.

## Rules

- **R1: Burnup** (Scrum): for a sprint chosen from the board's sprints, per day:
  - the **work scope**: the sprint's items, in the sprint's statistic;
  - the **work completed**: items done by that day;
  - a **guideline** from zero to the scope at the start, rising on working days only (spec 0405).
- **R2: Epic Report:** for an epic chosen from the project's epics, per day since the epic was created:
  - the **total** work of its items;
  - the **completed** work.

  Below it, three lists: **Completed**, **Incomplete**, **Unestimated** (open items with no estimate).
- **R3: Version Report:** the same for a version chosen from the project's versions, from its start date (or its first item) to its release date or today. It adds:
  - the **predicted release date**: the remaining work at the pace completed so far (work done per day since the start);
  - **optimistic** (10% faster) and **pessimistic** (10% slower) dates;
  - nothing predicted when no work has been completed yet.
- **R4: Epic Burndown and Release Burndown** (Scrum): for an epic or a version, one bar per completed sprint of the board, oldest first, then the active sprint:
  - **completed** in the sprint: items of the epic or version done during it;
  - **remaining** after it: items not done by its end;
  - **added** during it: items that joined the epic or version while it ran.

  The **forecast** is the remaining work divided by the average completed in the last three sprints, rounded up, shown as "about N more sprints". With no completed work there's no forecast.
- **R5: Estimates.** Every report counts in the board's statistic (story points, original time estimate or issue count, spec 0404). An item counts as done when its status is in the Done category.
  - Estimates count **as they stood at each moment**, as Jira's reports count them: the scope and total lines move when an estimate changes; completed work counts at its estimate when it was done; remaining work at its estimate at the sprint's end.
  - In the epic and release burndowns, an estimate raised during a sprint on work already there is **added** work (Jira's scope change), besides work that joined.
  - The Unestimated list is what has no estimate now.
- **R6: When an item joined** an epic or a version: the last time it was put there (its history), else when it was created.

## Permissions

Anyone who can see the project.

## Data model and migration

None. The project's history the reports already load is used.

## API

None new. The reports read the project's items and history (`useReportState`).

## Screens

Reports gains **Burnup**, **Epic report**, **Version report**, **Epic burndown** and **Release burndown**. Burnup and the two burndowns are for Scrum projects.

## System settings

None.

## Scale

As the existing sprint burndown: worked out in the browser from the project's history, which the Reports page already loads.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Web unit test: scope and completed per day; the guideline flat on days off |
| R2, R5 | Web unit test: totals over time and the three lists, in the statistic |
| R3 | Web unit test: the predicted, optimistic and pessimistic dates; none without progress |
| R4, R6 | Web unit test: completed, remaining and added per sprint; the forecast |
| All | Browser journey: each report opens and draws for a project with history |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Several boards:** the reports use the project's sprints and the first Scrum board's statistic.

## Open questions

None.

## Changelog

- 10 Nov 2026: estimates count as they stood at each moment, replaying their history, as Jira DC's reports do (PO: "handled as how Jira DC handles them currently"); R5 says how.
