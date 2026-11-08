# 0105 Custom fields: type fixed once made; options that rename, disable and delete as in Jira

Status: Ported (aws-jira `c3d25e8`, strand `1006a53`), approved by the PO on 8 Nov 2026; awaiting verification
Parity rows: ISS-24

## Context and Jira reference

In Strand today:
- A custom field's type (`kind`) can be changed after items have values in it.
- A select field's options are a plain list of names, so the server can't tell a renamed option from one removed and another added.
- After a rename, items keep the old name, which is no longer an option. They hold it until someone edits that field.
- Removing an option leaves its value on items in the same way.

- **Jira DC:**
  - **Field type:** it can't be changed. Atlassian closed the request as Won't Fix ([JRASERVER-19312](https://jira.atlassian.com/browse/JRASERVER-19312), via the KB [How to change custom field types in Jira](https://confluence.atlassian.com/jirakb/how-to-change-custom-field-types-in-jira-158357.html)). The way round is a new field and moving the data. The field's name and description can be edited ([Editing or deleting custom fields](https://confluence.atlassian.com/adminjiraserver/editing-or-deleting-custom-fields-1047552719.html), DC 11.3, checked 8 Nov 2026).
  - **Options:** a select field's options can be added, edited (renamed), disabled, deleted, reordered and sorted alphabetically ([Configuring a custom field](https://confluence.atlassian.com/adminjiraserver0815/configuring-a-custom-field-1050546252.html), DC 8.15).
  - **Renaming an option:** issues store the option's id, so the new text shows on every issue straight away ([Community answer, Jira 8.20](https://community.atlassian.com/forums/Jira-questions/Is-it-possible-to-delete-a-custom-field-value-that-is-used/qaq-p/2101477)).
  - **Disabling an option:** it is hidden so that it "is no longer available for selection". Issues keep it.
  - **Deleting an option:** "Deleting a custom field option removes all matching values from all issues". The confirmation lists the issues that have it (same answer).
  - **Deleting a field:** removes all its data ("it's gone forever").
- **Strand today:**
  - `field_defs.options` is `text[]` (`server/migrations/20261011205352_rest_of_schema.sql`).
  - `PATCH /projects/:key/fields/:id` accepts any `kind` and `options` (`server/src/routes/projects.ts`).
  - `checkCustom` (`server/src/routes/issues.ts`) checks only values that change, "so an item keeps a value whose option was later renamed".
  - The field editor is `src/components/CustomFields.tsx`.

## Rules

- **R1:** A custom field's type can't change once it is made: a different `kind` is refused (400) with "A field's type can't change. Make a new field of the type you need." Its name can change.
- **R2:** Each option of a select field has an id. The options are sent as a list of `{ id?, name, disabled? }`. An option keeps its id when renamed, and a new one gets an id.
- **R3:** Renaming an option changes it on every item that has it, at once, as in Jira. Those items get a new version, and people with them open see the change. It isn't recorded in each item's history, as in Jira.
- **R4:** A disabled option isn't offered when choosing a value and can't be chosen (400). Items that have it keep it and show it, and it can be enabled again.
- **R5:** Deleting an option removes it from every item that has it, as in Jira. The field editor first says how many items have it ("3 work items have Mobile. Deleting it clears their Team.") and asks to confirm.
- **R6:** Option names are unique within a field, ignoring case, and can't be empty (400).
- **R7:** Options can be reordered, or sorted alphabetically with one action. The order is the order shown when choosing a value.
- **R8:** Existing fields keep every value:
  - **Options:** they get ids.
  - **Stray values:** a value an item holds that is no longer an option (left by an earlier rename or removal) becomes a disabled option with that name. Nothing is lost, and it can be renamed, enabled or deleted like any other.
- **R9:** Items keep storing the option's name, so search (JQL), CSV export and import, transition rules and screens read it as today. R3 and R5 keep the stored names in step with the options.
- **R10:** Deleting a whole field removes its values from every item (as today, and as in Jira).

## Permissions

Unchanged: project admins manage their project's custom fields (`fields` is a project-settings collection); members set values on items.

| Action | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|
| Add, rename, disable, delete, reorder options; rename a field | – | – | ✓ | ✓ |
| Change a field's type | – | – | – | – |
| See how many items have each option | ✓ | ✓ | ✓ | ✓ |

## Data model and migration

- `field_defs.options` becomes `jsonb`: `[{ "id": text, "name": text, "disabled": bool }]`. The id is text so a Jira option's id can be kept on import.
- The migration turns each `text[]` into objects with new ids. For each select field, it adds a disabled option for every distinct value items hold that isn't among its options (R8).
- `strand` gets the same migration in `supabase/migrations`.

## API

- **`POST /projects/:key/fields`, `PATCH /projects/:key/fields/:id`:**
  - `options` is `[{ id?, name, disabled? }]`.
  - In a PATCH:
    - an option listed with its id is kept, renamed if its name changed (R3);
    - an option left out is deleted (R5);
    - a new one has no id.
  - `kind` in a PATCH must equal the field's kind (R1).
  - A rename or delete updates the matching items in the same transaction.
- **New: `GET /projects/:key/fields/:id/usage`** returns `{ options: { [optionId]: count } }`, counting live items. Anyone who can see the project may call it.
- **Issue routes:** a select value is an option's name, as today. A name that matches no option, or a disabled option the item doesn't already have, is refused (R4).

## Screens

**Project settings › Custom fields › field editor** (Jira equivalent: the context's Edit Options):
- Rename, Disable or Enable, Delete, Move up or down, and "Sort A–Z" for each option.
- Delete shows the R5 confirmation, with the count from `usage`.
- The type is shown, but can't be changed, for a field that exists.
- When picking a value on an item, disabled options aren't offered.

## System settings

None.

## Scale

- A rename or delete is one `update` on the project's items that hold that value. An index isn't needed: it scans the project's items once, inside the transaction.
- `usage` is one grouped count per field.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: changing `kind` is refused (400); renaming the field works |
| R2 | Server test: options come back with ids; a rename keeps the id |
| R3 | Server test: renaming "Mobile" to "Mobile apps" changes it on the items that had it (new version), and JQL finds them by the new name |
| R4 | Server test: a disabled option can't be chosen (400), stays on an item that has it, and can be enabled again |
| R5 | Server test: deleting an option clears it from its items; `usage` counted them first. Browser journey: the editor's delete confirmation shows the count |
| R6 | Server test: duplicate (any case) and empty option names are refused |
| R7 | Web unit or browser journey: Sort A–Z and Move change the saved order |
| R8 | Migration test: a value that is no longer an option becomes a disabled option of that name, and items keep it |
| R9 | Existing JQL, CSV import/export and transition-rule tests on custom fields keep passing |
| R10 | Existing test: deleting a field removes its values |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Global custom fields, contexts, more field types:** specs 0502 and 0503. Options then belong to a field's context, as in Jira.
- **Default values for a field:** with contexts (0503).

## Open questions

None. Each rule follows Jira's behaviour, except R8, which is how Strand's existing data is brought over without loss.

## Changelog

- 8 Nov 2026, while building (within the approved rules): on `strand`, R8's migration test is in `server/test/fieldOptions.test.ts`, because `strand` keeps its migrations in `supabase/migrations`.
