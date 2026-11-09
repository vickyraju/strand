# 0402 Sprint Report

Status: Ported (aws-jira `6012381`, strand `3e9389c`), approved by the PO on 9 Nov 2026; awaiting verification
Parity rows: AG-12

## Context and Jira reference

- **Jira DC:** [Sprint Report](https://confluence.atlassian.com/jirasoftwareserver/sprint-report-938845689.html), checked 9 Nov 2026.
  - The report belongs to a board, and shows one sprint at a time, chosen from a list.
  - **Burndown chart:** a grey guideline from the starting total to zero, and a red line for the remaining estimate of unresolved work, including scope added or removed.
  - **"Done":** an issue is done when its status is in the board's rightmost column (as in 0401).
  - **Estimates:** an issue's estimate is the one it had when the sprint started, or when it was added if that was later. Later changes don't show.
  - **Added after start:** these issues are marked with an asterisk.
  - **Sections:** Completed Issues; Issues Not Completed; Issues completed outside of this sprint; Issues Removed From Sprint. The section names are as Jira's report shows them; the [completed-outside article](https://confluence.atlassian.com/jirakb/issues-completed-outside-of-this-sprint-in-the-sprint-report-1267336398.html) defines that section.
  - Reopening and deleting a sprint are done from this report: spec 0403.
- **Strand today:**
  - Reports offer a sprint burndown and a velocity chart; there is no sprint report.
  - A sprint records its points at start and at completion, and the items it held when it completed. It doesn't record what it held at start, or what was completed.

## Rules

- **R1: The report.** Reports › Sprint report, on Scrum projects. Choose a sprint of the project, active or completed, newest first. It shows:
  - the sprint's dates;
  - its goal;
  - the existing burndown chart for that sprint;
  - the four sections below.
- **R2: Completed Issues.** For a completed sprint, the items that were in the board's rightmost column when it completed (0401). For an active sprint, the items in it that are there now.
- **R3: Issues Not Completed.** The sprint's other items: for a completed sprint, those that moved on at completion.
- **R4: Issues completed outside of this sprint.** Items in the Completed section that were already resolved before they joined the sprint. They are listed here instead.
- **R5: Issues Removed From Sprint.** Items taken out of the sprint while it was active, other than by completing it.
- **R6: Added after start.** An item that joined after the sprint started is marked with `*`. Its points are those it had when the sprint completed.
- **R7: Estimates and totals.**
  - Each row shows the item's points at the sprint's start, or as described in R6.
  - Each section shows the total of its points.
  - Recording starts with this spec. For sprints started before it, the points are those at completion and nothing is marked as added.
- **R8: Only what you can see.** The sections list only items the person can see (and, on strand, within their security level).

## Permissions

Browse projects in the sprint's project.

## Data model and migration

- `sprints.start_estimates jsonb`: item id to points, recorded at start. It also tells which items were in the sprint at start.
- `sprints.completed_ids uuid[]`: recorded at completion.
- Existing completed sprints get `completed_ids`, from the items still in them that are in a Done status. `start_estimates` stays empty.
- `strand` gets the same migration in `supabase/migrations`.

## API

`GET /projects/:key/sprints/:id/report` returns:

- the sprint;
- `completed`, `notCompleted`, `completedOutside` and `removed`, each a list of `{ key, title, type, priority, status, points, addedAfterStart }`;
- `totals` for each list.

## Screens

Reports › Sprint report (R1). Jira equivalent: Reports › Sprint Report.

## System settings

None.

## Scale

- One sprint at a time. The lists are bounded by the sprint's items (hundreds).
- Removals are read from the item history: `activity` rows with field `sprintId`, using the existing index on `activity (issue_id, …)`, joined to the sprint's items.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R7 | Server test: a sprint started with A (3 points) and B; C added after start; D removed during it; A completed; B not; E was resolved before it was added. Each lands in its section with the right points and asterisk, and the totals add up |
| R8 | Server test: an item in a project the person can't see is left out |
| R1 | Browser journey: the report opens, lists the sections and marks the added item |

## Strand branch

Same rules; R8 includes security levels.

## Out of scope and deliberate divergences

- **"View in Issue navigator"** and the **green time-spent line:** later, with time tracking on boards (0404).

## Open questions

None.

## Changelog
