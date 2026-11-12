# 0601 Field change history, indexed

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC** (an issue's **History** tab; the `changegroup` and `changeitem` tables; [JQL operators](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-operators-reference-939938745.html), checked 11 Nov 2026):
  - Every edit is a change group (who, when) with one item per field: the field, its type (`jira` or `custom`), the old and new **value** (an id) and the old and new **string** (the name as it read at that moment).
  - Multi-value fields (Fix Version, Affects Version, Component) get one item per value added or removed.
  - The History tab lists each change as Field, Original value, New value.
  - History search (spec 0602) runs over this record: WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED work on **Assignee, Fix Version, Priority, Reporter, Resolution and Status**, matching "the value name … configured in your system at the time when the field was changed" or its id.
- **Before this spec:** the history (`activity`) keeps the field and its old and new ids, with no names. A list field's change is one row holding both whole lists. Nothing is indexed by field and value.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22WAS%20operator%22%20OR%20summary%20~%20%22CHANGED%20operator%22%20OR%20summary%20~%20%22change%20history%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | The app |
|---|---|---|
| [JRASERVER-68450](https://jira.atlassian.com/browse/JRASERVER-68450) History shows a user key instead of the name | Bug | **Built:** names are kept with every change (R1) |
| [JRASERVER-59681](https://jira.atlassian.com/browse/JRASERVER-59681) Several versions picked at once are recorded wrongly | Bug | **Built:** one change per value added or removed (R2) |
| [JRASERVER-60107](https://jira.atlassian.com/browse/JRASERVER-60107), [JRASERVER-40161](https://jira.atlassian.com/browse/JRASERVER-40161) A large history is slow or runs out of memory | Bugs | **Built:** the History tab pages on the server (already) and history search uses indexes (R3) |
| [JRASERVER-9050](https://jira.atlassian.com/browse/JRASERVER-9050) Read an issue's change history through the API | Suggestion | **Built:** `GET /issues/{key}/activity` returns the values and names (R4) |
| [JRASERVER-11593](https://jira.atlassian.com/browse/JRASERVER-11593) Show the transition's name in the history | Suggestion | **Built** before: The app records the transition (spec 0103) |
| [JRASERVER-12400](https://jira.atlassian.com/browse/JRASERVER-12400) History of edited comments | Suggestion | **Proposal P1** |
| [JRASERVER-13760](https://jira.atlassian.com/browse/JRASERVER-13760) Adding or removing a watcher in the history | Suggestion | **Proposal P2** |
| [JRASERVER-27641](https://jira.atlassian.com/browse/JRASERVER-27641), [JRASERVER-34103](https://jira.atlassian.com/browse/JRASERVER-34103), [JRASERVER-63292](https://jira.atlassian.com/browse/JRASERVER-63292) History search on custom fields and more fields | Suggestions | **Proposal P3** (spec 0602) |

**Proposals for the product owner** (not built until chosen):

- **P1: Comment edit history:** chosen by the PO on 12 Nov 2026, now R6.
- **P2: Watchers in the history:** "Started watching", "Stopped watching".
- **P3: History search on more fields:** Sprint, Labels, Components, Type and single-choice custom fields.

## Rules

- **R1: Values and names.** Every change keeps the field, the old and new value (an id or key), and the old and new **name** as they read at that moment: a status's, a person's, a priority's, a resolution's, a version's, a component's, a work type's and a sprint's name; other fields keep the value itself. A later rename doesn't change the history.
- **R2: One change per value of a list.** Adding or removing fix versions, affects versions or components records one change per value added and one per value removed, as Jira's. The history already recorded is split the same way, its names filled from today's names.
- **R3: Indexed for history search.** Changes to Status, Assignee, Reporter, Priority, Resolution and Fix Version are indexed by field and by old and new value and name, so spec 0602's history search doesn't read every item's history.
- **R4: Shown and served.** The History tab shows each change as the field, the old name and the new name. `GET /issues/{key}/activity` and the item's `activity` give `fromString` and `toString`.
- **R5: Every path.** Edits, transitions, bulk changes, automation, workflow changes, moves and imports record changes the same way (the database fills names and splits lists on write).

- **R6: Comment edit history** (P1, chosen 12 Nov 2026; [JRASERVER-12400](https://jira.atlassian.com/browse/JRASERVER-12400)). Each edit of a comment keeps the text it replaced, who edited it and when.
  - An edited comment's **Edited** marker opens its versions, newest first, for:
    - its author;
    - the project's admins;
    - system administrators.
  - Others see only that it was edited, as today.
  - The versions follow the comment's visibility. Deleting the comment deletes them.

## Permissions

Unchanged: browse the item to read its history.

## Data model and migration

- `activity.from_string`, `activity.to_string`.
- A database function names a value and splits list changes when a change is written.
- Partial indexes on `(field, to_value)`, `(field, from_value)`, `(field, lower(to_string))`, `(field, lower(from_string))` for the six history-search fields.
- The migration fills names for today's history and splits list rows.

## API

History rows gain `fromString` and `toString`.

## Screens

The History tab: under each change, "Field: old → new".

## Scale

Four partial indexes over the six fields' changes only. Splitting and naming happen once per write; the migration splits today's list rows in one pass.

## Acceptance

| Rule | Proved by |
|---|---|
| R6 | Server test: two edits keep two earlier versions with who and when; the author and a project admin read them, a member gets 403, someone who can't see the comment 404; deleting the comment deletes them. Browser journey: the Edited marker shows the earlier text |
| R1, R4 | Server test: a status, assignee and priority change keep their names; renaming the status afterwards doesn't change the history; the API returns them |
| R2 | Server test: two fix versions added and one removed make three changes |
| R3 | Server test: a lookup by field and value, or by field and name, uses the history indexes |
| R5 | Server test: an automation change and a row written straight into the history (as a bulk workflow change writes them) are named |
| R4 | Browser journey: the History tab shows "Status: To Do → In Progress" |

## Out of scope and deliberate divergences

- **Jira's REST changelog** (`?expand=changelog`): The app serves its own API; webhooks already send Jira's changelog (spec 0715).

## Open questions

None.

## Changelog

- 12 Nov 2026: a custom field's change was stored as `[object Object]`. It is now recorded field by field (`custom:<id>`) with its values (spec 0412). Earlier rows keep their line but not their values.
