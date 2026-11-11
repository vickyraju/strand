# 0505 Screens

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending"; product questions follow Jira DC)
Parity rows: ISS-09

## Context and Jira reference

- **Jira DC** ([Defining a screen](https://confluence.atlassian.com/adminjiraserver/defining-a-screen-938847288.html), checked 11 Nov 2026):
  - **A screen** groups fields, in order, on one or more **tabs**. The **Default Screen** is used for creating, editing and viewing issues unless another is chosen.
  - **A screen scheme** gives the issue operations (**Create**, **Edit**, **View**) a screen each, with a default for the rest.
  - **An issue type screen scheme** gives each issue type a screen scheme, with a default. A project uses one.
  - A field shows in an operation only when it is on that operation's screen, it isn't hidden by the field configuration (spec 0504), and its context applies (spec 0503). Through REST, setting a field that isn't on the screen is refused ("It is not on the appropriate screen").
  - A screen used by a scheme or a transition can't be deleted. Workflow transitions have their own screens (Strand's transition Screen rule, spec 0103).
  - Only Jira administrators manage screens and schemes.
- **Strand today:** every field shows everywhere unless the field configuration hides it (spec 0504); transitions have their own screen (spec 0103).

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22screen%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Issue | Status | Strand |
|---|---|---|
| A new custom field doesn't show until someone adds it to a screen (the most common question on the Community) | Long-standing | **Better:** the Default Screen shows every field, new ones included, until an admin lists its fields (R1) |
| Three layers (screens, screen schemes, issue type screen schemes) are hard to follow | Long-standing | **Built:** each project's settings show which screen each work type gets for create, edit and view (R5) |

**Proposals for the product owner** (not built until chosen):

- **P1: "Show when empty"** per field on view screens (Jira's toggle for custom fields without a value).

## Rules

- **R1: Screens.** Administration › **Screens** (system admins, signed in themselves): screens with tabs and their fields in order (the system fields Strand has and custom fields; Summary and work type are always on). The **Default Screen** shows **every field** until an admin gives it tabs (better than Jira's: new fields appear without being added); it can't be deleted. A screen a scheme uses can't be deleted.
- **R2: Screen schemes:** a default screen and, optionally, a screen for **Create**, **Edit** and **View**. The Default Screen Scheme uses the Default Screen.
- **R3: Issue type screen schemes:** a default screen scheme and one per work type. System admins choose a project's (none: the Default Screen Scheme for every type).
- **R4: What they do**, for the screens that apply to the item's project and type:
  - **Create:** the create dialog offers the create screen's fields; a value for a field not on it is refused ("isn't on the create screen").
  - **Edit:** a field not on the edit screen can't be changed, in the item's details (shown read-only) or through the API; agile actions that Jira doesn't check against screens (rank, sprint, epic and version from the backlog panels, flag, status through transitions) are unaffected.
  - **View:** the item's details show only the view screen's fields, under its tabs.
  - The field configuration still hides fields (spec 0504); a required field missing from the create screen makes creating fail, as in Jira, so the screen editor warns about it.
- **R5: Where it shows:** Project settings › Fields shows the project's issue type screen scheme and, per work type, its create, edit and view screens.

## Permissions

System admins manage screens and schemes, and choose a project's.

## Data model and migration

- `screens`: workspace, name, description, tabs (null: every field), whether it is the default.
- `screen_schemes`: workspace, name, description, default screen, create, edit and view screens.
- `issue_type_screen_schemes`: workspace, name, description, default screen scheme, work type → screen scheme.
- `projects.issue_type_screen_scheme_id`.
- Every workspace gets its Default Screen (every field) and Default Screen Scheme, so nothing changes.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `/admin/screens`, `/admin/screen-schemes`, `/admin/issue-type-screen-schemes`: list, create, read, change, delete.
- `PATCH /projects/:key` `{ issueTypeScreenSchemeId }` (system admins).
- `GET /projects/:key` gains `screens`: per work type, the create, edit and view screens' tabs (null: every field).

## Screens

- Administration › Screens: screens (the tab and field editor), screen schemes, issue type screen schemes.
- The create dialog, the item's details (tabs, read-only fields), Project settings › Fields.

## Scale

A project's screens are worked out once per request from at most a handful of rows.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Server test: screens and schemes; the default can't be deleted; a used screen can't be deleted |
| R4 | Server test: a field off the create screen refused on create; off the edit screen refused on edit; agile actions unaffected |
| R4, R5 | Browser journey: an edit screen without Priority shows it read-only; a view screen with two tabs |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **The Default Screen shows every field** until it is given tabs (R1).
- **Field order in the details** follows Strand's layout within each tab; tabs and which fields appear follow the screen.
- **Agile actions** (R4) aren't checked against screens, as Jira's boards don't.

## Open questions

None.

## Changelog
