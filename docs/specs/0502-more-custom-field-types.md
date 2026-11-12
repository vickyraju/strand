# 0502 More custom field types

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC's custom field types** ([Adding custom fields](https://confluence.atlassian.com/adminjiraserver/adding-custom-fields-1047552713.html), checked 11 Nov 2026):
  - **Standard:** Checkboxes, Date picker, Date time picker, Labels, Number field, Radio buttons, Select list (cascading), Select list (multiple choices), Select list (single choice), Text field (multi-line), Text field (single line, at most 255 characters), URL field, User picker (single user).
  - **Advanced:** Group picker (single and multiple), Project picker (single project), Text field (read only: set programmatically, at most 255 characters), User picker (multiple users), Version picker (single and multiple).
  - Jira Software's own (Global rank, Original story points…) and Perforce's fields are not ones people add.
- **Before this spec:** four kinds per project: text (up to 5,000 characters), number, select (a dropdown) and date.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22custom%20field%20type%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | The app |
|---|---|---|---|
| [JRASERVER-7936](https://jira.atlassian.com/browse/JRASERVER-7936) Cascading select with three or more levels | 453 | Gathering interest | **Proposal P1** |
| [JRASERVER-4689](https://jira.atlassian.com/browse/JRASERVER-4689) A yes/no (boolean) field | 275 | Gathering interest | **Proposal P2** |
| [JRASERVER-10666](https://jira.atlassian.com/browse/JRASERVER-10666) An issue picker field | 79 | Won't fix | **Proposal P3** |
| [JRASERVER-23013](https://jira.atlassian.com/browse/JRASERVER-23013) Autocomplete for multi-select and checkboxes | | Gathering interest | **Built:** the multiple-choice pickers search as you type (R3) |

**Proposals for the product owner** (not built until chosen):

- **P1: Cascading select with more levels** (three or more).
- **P2: A yes/no field** (Jira users make one from a single checkbox).
- **P3: A work item picker field.**

## Rules

- **R1: The types**, under Jira's names, with what a value is:

  | Jira's type | The app kind | A value |
  |---|---|---|
  | Text field (single line) | `text` | text, at most 255 characters |
  | Text field (multi-line) | `textarea` | text, at most 32,767 characters |
  | Text field (read only) | `readonly` | text, at most 255 characters, set only through the API or automation |
  | Number field | `number` | a number |
  | Date picker | `date` | a date |
  | Date time picker | `datetime` | a date and time |
  | URL field | `url` | an `http` or `https` address |
  | Select list (single choice) | `select` | one option |
  | Radio buttons | `radio` | one option |
  | Select list (multiple choices) | `multiselect` | options |
  | Checkboxes | `checkboxes` | options |
  | Select list (cascading) | `cascading` | an option and, optionally, one of its child options |
  | Labels | `labels` | words without spaces |
  | User picker (single user) | `user` | a person |
  | User picker (multiple users) | `users` | people |
  | Group picker (single group) | `group` | a group |
  | Group picker (multiple groups) | `groups` | groups |
  | Project picker (single project) | `project` | a project the person can see |
  | Version picker (single version) | `version` | a version of the item's project |
  | Version picker (multiple versions) | `versions` | versions of the item's project |

  A field's type can't change once it is made (as before). Existing text fields keep their longer values; a new value is held to 255 characters.
- **R2: Options.** Single, radio, multiple, checkboxes and cascading fields have options; renaming, disabling and deleting options work as spec 0105 says, on every item that has them, multiple values included. A cascading field's options have child options under each parent; a child's name is unique under its parent.
- **R3: Editing.** Each type has its editor in the item's details: a text box or text area, date and date-time pickers, a single choice, radio buttons, checkboxes, multiple choice searching as you type, the two cascading choices, people and group pickers searching the server, the project picker, the version pickers (the item's project's versions that aren't archived). A read-only field shows its value and can't be edited.
- **R4: JQL**, as Jira's:
  - multiple values: `=` and `in` match any of them; `!=` and `not in` match items having none of them; `is empty` when there are none;
  - people fields take emails, names and `currentUser()`, and `membersOf()`; groups take group names; versions take version names; projects take keys or names;
  - cascading fields: `"Field" in cascadeOption("Parent")` and `cascadeOption("Parent", "Child")`, as Jira's;
  - text and URL with `~`; numbers, dates and date-times with `<`, `>`, `<=`, `>=`.
- **R5: Everywhere fields show:** list columns and board cards show values as text; the CSV importer reads them (multiple values separated by commas, people by email); webhooks send them in Jira's shapes (options as `{ value, id }`, cascading with its `child`, people and versions as Jira's objects).

## Permissions

Unchanged: project admins define fields; Edit issues sets values. A read-only field isn't editable in the app: scripts set it through the API (with Edit issues), as Jira's.

## Data model and migration

- `field_defs.kind` accepts the new kinds.
- Options gain `parentId` (cascading child options).
- Values stay in `issues.custom` (jsonb): text, numbers, or lists of text.

## API

`custom` values accept a list for multiple-value fields; field definitions accept the new kinds and child options.

## Screens

- Project settings › Fields: the type picker lists every type under Jira's names; cascading fields edit child options under each option.
- The item's details: each type's editor.

## Scale

The pickers that search (people, groups, projects) search the server.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: every type's values accepted and refused; option renames carried into multiple values; cascading children |
| R3 | Browser journey: an admin adds a checkboxes field and a user picker; a member sets both |
| R4 | Server test: JQL on each kind of value, cascadeOption, currentUser() |
| R5 | Server test: CSV import of multiple values; the webhook shapes |

## Out of scope and deliberate divergences

- Jira Software's internal types (Global rank, Original story points) and Perforce's fields.

## Open questions

None.

## Changelog
