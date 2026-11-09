# 0405 Working days on a board

Status: Approved (PO, 9 Nov 2026: "proceed")
Parity rows: AG-08

## Context and Jira reference

- **Jira DC:** [Configuring working days](https://confluence.atlassian.com/spaces/JIRASOFTWARESERVER/pages/938845342/Configuring+working+days), checked 9 Nov 2026.
  - **Where:** each board, in Board › Configure › Working days. Board admins and Jira admins set it.
  - **What it holds:**
    - the team's time zone;
    - the standard working weekdays;
    - non-working dates (holidays and one-off days).
  - **What it changes:** the Burndown Chart, Sprint Report, Epic Report, Version Report, Control Chart and the burndown gadgets leave out the non-working time. The burndown's guideline stays flat on non-working days ([Sprint Report](https://confluence.atlassian.com/jirasoftwareserver/sprint-report-938845689.html)).
- **Strand today:** no working days. The burndown's guideline falls evenly across every calendar day, weekends included.

## Rules

- **R1: The setting.** Board configuration › Working days, for board admins and project admins:
  - **Working weekdays:** Monday to Friday by default; every existing board gets the default.
  - **Non-working dates:** add and remove dates, up to 365 of them.
- **R2: The burndown.** The guideline falls only across working days, and stays flat on the others. The red line is unchanged, since work can still be done on any day. This applies wherever the burndown is drawn: the Burndown report and the Sprint Report.
- **R3: Later reports.** The Control Chart (0410) and the version and epic reports (0411) use the same working days when they are built.

## Permissions

Board admins and project admins, as for the board's other settings.

## Data model and migration

- `boards.working_days jsonb not null default '{"weekdays": [1,2,3,4,5], "nonWorking": []}'`. Weekdays use 0 for Sunday; dates are YYYY-MM-DD.
- `strand` gets the same migration in `supabase/migrations`.

## API

`PATCH /boards/:id` accepts `workingDays: { weekdays: number[], nonWorking: string[] }`, and `GET /boards/:id` returns it. At least one working weekday is required.

## Screens

Board configuration gains a Working days section: seven weekday checkboxes, and a date list with Add and remove. Jira equivalent: Board › Configure › Working days.

## System settings

None.

## Scale

A board's setting is small and read with the board.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a board admin sets Mon–Thu and a holiday; no working weekday is refused; a member can't |
| R2 | Web unit test: over a sprint across a weekend and a holiday, the guideline is flat on them and reaches zero on the last working day |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **The team's time zone:** later. Days follow the viewer's time zone for now, recorded as partial (AG-08).

## Open questions

None.

## Changelog
