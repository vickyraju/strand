# 0407 Epics and versions panels

Status: Ported (aws-jira `e578fe7`, strand `125d3c1`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AG-10

## Context and Jira reference

- **Jira DC:** the Scrum backlog and the Kanban backlog have two panels, **EPICS** and **VERSIONS**, opened from labels running down the left side.
  - **EPICS:**
    - **Create epic** (on hover);
    - click an epic to show only its issues, **All issues** to clear the filter;
    - drag issues onto an epic to add them, onto **Issues without epics** to take them out;
    - the arrow beside an epic's name: **Edit name**, **View epic details**, a colour, **Mark as Done** (sets the Epic Status to Done without touching the workflow).
  - **VERSIONS:**
    - shown when the project has at least one version;
    - **Create version** (Start Date, End Date);
    - click to filter, **All issues**;
    - drag onto a version to add issues, onto **Issues without versions** to take them out;
    - **Edit name**.
  - **Permissions:** Edit Issues to add an issue to an epic or a version.
  - **Kanban:** with the Kanban backlog on, epics show in the panel and not as cards on the board.
- **Sources** (checked 10 Nov 2026):
  - [Managing epics in a Kanban project](https://confluence.atlassian.com/jirasoftwareserver112/managing-epics-in-a-kanban-project-1688899713.html)
  - [Configuring versions in a Kanban project](https://confluence.atlassian.com/jirasoftwareserver112/configuring-versions-in-a-kanban-project-1688899691.html)
  - [Using your Scrum backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-scrum-backlog-1688899657.html)
- **Strand today:**
  - Epics are work items of type Epic, parents of stories (spec 0303). Versions are a project's releases (spec 0304); items have several fix versions (spec 0301).
  - The backlog has no panels: items get an epic or a version only from their own fields.

## Rules

- **R1: The panels.** The Scrum backlog and the Kanban backlog have **Epics** and **Versions** toggles on the left.
  - Each opens its panel; which is open is remembered in this browser.
  - **Versions** shows only when the board's project has an unarchived version.
- **R2: The Epics panel** lists the epics of the board's projects that aren't Done, in rank order. Each one shows:
  - its name and colour;
  - a progress bar of its items by status category;
  - expanded: **Issues**, **Completed**, **Unestimated** and **Estimate** (in the board's estimation statistic).
- **R3: Filtering by epic.** Clicking an epic shows only its items; **Issues without epics** shows items with no epic; **All issues** clears it. The filter is ANDed with the backlog's other filters.
- **R4: Dragging onto an epic.** Dropping items (one, or a selection) onto an epic makes it their parent; dropping onto **Issues without epics** takes it away.
  - The hierarchy rules hold (spec 0303): an epic or a sub-item can't go under an epic. If any dragged item can't, none moves, saying why.
- **R5: Epic actions** (the menu beside its name):
  - **Edit name** (its summary);
  - **View epic details** (opens it);
  - a colour from Jira's fourteen;
  - **Create issue in epic**.
  - **Create epic** at the top of the panel.
- **R6: Epic colour** is a field of the epic (Jira's Epic Colour). It is imported and exported. Without one, an epic gets a colour from its key, the same everywhere.
- **R7: The Versions panel** lists the unreleased, unarchived versions of the board's project. Each one shows:
  - its name, start and release dates;
  - a progress bar;
  - expanded: **Issues**, **Completed**, **Unestimated**, **Estimate**.
- **R8: Filtering by version:** a version, **Issues without versions**, **All issues**, as for epics.
- **R9: Dragging onto a version** adds it to the items' fix versions; **Issues without versions** clears their fix versions.
- **R10: Version actions:** **Edit name**, and **Create version** (name, start date, release date, description) at the top of the panel.
- **R11: Kanban boards** with a Kanban backlog leave epics off the board: they are in the panel.
- **R12a: Without dragging.** The selection bar has **Epic** and **Version**, doing what dropping onto an epic or a version does (a keyboard way, as dragging needs a pointer).
- **R12: Who.** Anyone can open the panels and filter. Dragging needs Edit Issues on every dragged item. Creating and renaming epics needs Create or Edit Issues; creating and renaming versions needs Administer Projects (as on the Releases page).

## Permissions

| Action | Who |
|---|---|
| Open the panels, filter | Anyone who can see the board |
| Drag items onto an epic or a version | Members (Edit Issues) |
| Create, rename, recolour an epic | Members |
| Create, rename a version | Project admins |

## Data model and migration

- `issues.epic_color` text: one of Jira's `ghx-label-1` … `ghx-label-14`, or null.
- `strand` gets the same migration in `supabase/migrations`.

## API

- Work items gain `epicColor` (read, create, update, CSV and JSON import).
- Everything else uses existing routes: the item update (parent, fix versions), item creation, and the releases routes.

## Screens

- **Backlog** (Scrum and Kanban): the Epics and Versions toggles and panels.
- **Board cards and backlog rows:** the epic lozenge uses the epic's colour.
- **Jira equivalent:** the backlog's EPICS and VERSIONS panels.

## System settings

None.

## Scale

- An epic's counts and progress come from the backlog's loaded items and the epic's children already in the browser.
- A board with very many epics lists those not Done, which Jira also does.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R3, R7, R8 | Web unit tests: an epic's and a version's counts and progress; the three filters. Browser journey: open the panels, filter |
| R4, R9 | Web unit test: the drop plan with a refused item. Browser journey: an item put into an epic, then a version (the selection bar, which does what dragging does) |
| R5, R6, R10 | Server test: `epicColor` saved, refused when not Jira's, imported. Browser journey: Create epic, colour |
| R11 | Server test: a Kanban board with a backlog leaves epics out |
| R12 | Existing permission tests of item updates and releases |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Mark as Done** (Jira's Epic Status, apart from the workflow): built by spec 0716.
- **Ranking epics in the panel:** they keep their backlog rank.
- **The board option to turn the Epics panel off** (Kanban): not built.

## Open questions

- ~~Should Strand add Jira's separate Epic Status ("Mark as Done")?~~ Answered 10 Nov 2026 by the PO: as Jira DC does (spec 0716).

## Changelog
