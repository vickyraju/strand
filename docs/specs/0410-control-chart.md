# 0410 Control chart

Status: Ported (aws-jira `2e29e8f`, strand `48be6d1`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AG-12

## Context and Jira reference

- **Jira DC:** Reports › **Control Chart**, for a board, Scrum or Kanban.
  - **Each dot** is a work item, or a cluster of items at the same place.
    - Horizontal position: when it last left the last of the chosen columns.
    - Vertical position: its cycle time ("Elapsed Time"), the time spent in the chosen columns. Rework counts: time from every visit adds up.
  - **Lines:** the **average**, and a **rolling average** with a **standard deviation** band.
    - The rolling average is over items, not days.
    - Its window is 20% of the items shown: an odd number, at least 5.
  - **Timeframe** picks the period.
  - **Refine report:** the columns that make up cycle time (Jira picks them first), the board's swimlanes and its quick filters.
  - **Axis:** the vertical axis is linear under 30 days, else a cube-root scale.
- **Source** (checked 10 Nov 2026): [View and understand the control chart](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-control-chart/). The Data Center page wasn't reachable; Atlassian describes the chart the same way in both.
- **Strand today:**
  - Reports › **Cycle time**: a project's items, from their first in-progress status to done, worked out in the browser from the history it holds.
  - No board, column or quick-filter choice; no rolling average.

## Rules

- **R1: The report.** Reports › **Control chart** shows for a board of the project (Scrum or Kanban; the board switcher picks one):
  - one dot per work item that has left the chosen columns within the timeframe;
  - horizontal position: when it last left them;
  - vertical position: its cycle time, the total time spent in the chosen columns' statuses, every visit added.
  - Items still in a chosen column aren't shown.
- **R2: The work items** are the board's: its filter, ANDed with the quick filters chosen, among what the viewer may see. Epics are left out.
- **R3: Columns.** The chosen columns default as Jira's do: every column but the first and the last. A board of one or two columns defaults to all but the last.
- **R4: Timeframe:** last week, 2 weeks, month, 3 months, 6 months, year, or all time. The default is 3 months.
- **R5: Statistics:**
  - average, median, minimum and maximum cycle time, and the number of items;
  - the rolling average: each item with the items around it, the window 20% of the items, odd, at least 5, and at most all of them;
  - the standard deviation band around the rolling average, over the same window.
- **R6: Clusters.** Items whose dots would land on the same spot are drawn as one larger dot with their count, at their average.
- **R7: The vertical axis** is linear when the largest cycle time is under 30 days, else a cube-root scale.
- **R8: The table** under the chart lists the items, longest first: key, summary, cycle time, and when each left the columns.
- **R9: Scale.** The server works out cycle times from the status history. One request returns at most 5,000 items, the most recent; the report says when more were left out.

## Permissions

Anyone who can see the board.

## Data model and migration

None. The status history (`activity`, field `statusId`) is read.

## API

`GET /boards/:id/reports/control?days=&statuses=&quick=`: items with key, summary, type, left-at and cycle time in minutes, and `truncated`.

## Screens

- **Reports › Control chart:** the board, timeframe, columns and quick filters at the top; the statistics; the chart; the table.
- **Jira equivalent:** Reports › Control Chart.

## System settings

None.

## Scale

One SQL query over the board's items' status changes, bounded by the timeframe and 5,000 items, using the `activity (issue_id, created_at)` index.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R9 | Server test: cycle time over two visits; an item still in progress left out; a quick filter; the timeframe |
| R3, R5, R6, R7 | Web unit tests: default columns; average, median, min, max; the rolling window and its standard deviation; clusters; the axis switch |
| R4, R8 | Browser journey: the report shows a measured item in its table |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Zooming** by selecting part of the chart: not built; the timeframe narrows it.
- **Swimlanes** in Refine report: not built; quick filters narrow the items.
- **Working days:** cycle time is calendar time, as Jira's control chart counts it.
- **The old Cycle time report** is removed (PO, 10 Nov 2026: as Jira DC, whose only cycle-time report is the control chart).

## Open questions

None.

## Changelog

- 10 Nov 2026: the old Cycle time report is removed, as Jira DC has none besides the control chart (PO: "handled as how Jira DC handles them currently").
