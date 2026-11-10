# 0716 Epic Status

Status: Ported (aws-jira `52ad087`, strand `2a0a497`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AG-10

## Context and Jira reference

- **Jira Software DC** (Epics panel of the backlog; the Epic Status field, checked 10 Nov 2026):
  - An epic has a locked field, **Epic Status**, with three values: **To Do**, **In Progress** and **Done**. A new epic gets To Do.
  - Epic Status is separate from the epic's workflow status: moving the epic through its workflow doesn't change it, and changing it doesn't move the epic.
  - In the backlog's Epics panel, an epic's menu has **Mark as Done**, which sets Epic Status to Done. The panel lists only epics whose Epic Status isn't Done.
  - The Epic Link picker leaves out epics whose Epic Status is Done.
  - JQL: `"Epic Status" = Done`, `"Epic Status" != Done`, `in`, `is empty`.
- **Strand today** (spec 0407): there is no Epic Status. The panel leaves out an epic whose own workflow status is Done; spec 0407 recorded Mark as Done as an open question.

## Rules

- **R1: The field.** Every epic has an Epic Status: To Do, In Progress or Done. A new epic, and an item made an epic, start at To Do; an item that stops being an epic loses it. Only epics have one (a 400 otherwise). Changes go to the item's history.
- **R2: Separate from the workflow.** Moving an epic through its workflow doesn't change its Epic Status, and setting it doesn't move the epic.
- **R3: Mark as Done.** The Epics panel's menu for an epic has **Mark as Done**: it sets Epic Status to Done (anyone who can edit the epic). The panel lists the epics whose Epic Status isn't Done.
- **R4: Pickers.** The parent picker of an item leaves out epics whose Epic Status is Done, except the item's own parent.
- **R5: The epic's details** show Epic Status, and it can be changed there.
- **R6: JQL:** `"Epic Status"` (also `epicStatus`) with `=`, `!=`, `in`, `not in`, `is empty`, `is not empty`.

## Permissions

Edit issues, as for any field.

## Data model and migration

- `issues.epic_status` (`To Do`, `In Progress`, `Done`; null for anything but an epic).
- **Existing epics:** Done when their workflow status is in the Done category (so the Epics panel keeps showing what it shows today), else To Do.
- `strand` gets the same migration in `supabase/migrations`.

## API

`epicStatus` on items (read and `PATCH`).

## Screens

- The Epics panel's epic menu: **Mark as Done**.
- The epic's details: **Epic Status**.

## Scale

The Epics panel's query compares one column.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R6 | Server test: new epics start at To Do; only epics have it; a workflow move leaves it; JQL |
| R3 | Server test: an epic marked Done leaves the panel. Browser journey: Mark as Done from the panel |
| R4, R5 | Browser journey: the epic's details show and change it |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
