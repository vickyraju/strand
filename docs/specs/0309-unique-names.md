# 0309 Names that must be unique: projects, versions, components, filters per owner

Status: Approved (PO, 9 Nov 2026: "i approve everything"; "yes proceed")
Parity rows: PRJ-08, ISS-25, SR-07

## Context and Jira reference

- **Jira DC:**
  - **Project names** are unique, ignoring case ([JRASERVER-3582](https://jira.atlassian.com/browse/JRASERVER-3582)). JQL `project = "Name"` relies on it.
  - **Versions and components** are unique by name within a project.
  - **Filters:** names are unique per owner. Changing a filter's owner needs a new owner who can see the filter and who doesn't already have one by that name ([Managing shared filters](https://confluence.atlassian.com/adminjiraserver089/managing-shared-filters-1005347206.html)).
  - Groups are already unique (spec 0104).
- **Strand today:**
  - Project and version names aren't unique.
  - Components are unique only with exact case.
  - Saved views (filters) aren't unique per owner, and changing a view's owner isn't checked.

## Rules

- **R1: Project names.** Unique in the workspace, ignoring case and surrounding spaces. Creating or renaming to a name already used gives 409 "A project called X already exists". This includes projects being archived or that the person can't see; the message doesn't reveal which.
- **R2: Versions and components.** Unique within their project, ignoring case. A clash gives 409 "PAY already has a version called 2.0", or the same for a component.
- **R3: Saved views.** A view's name is unique among its owner's views, ignoring case. Changing the owner is refused (400) when:
  - the new owner already has a view by that name;
  - the new owner couldn't see the view (it isn't shared with them, and they aren't an admin).
- **R4: Existing duplicates.** The migration renames later duplicates by adding " (2)", " (3)" and so on, oldest first. Every rename goes in the audit log as `name.deduplicated`. Nothing is deleted.
- **R5: Screens.** The create and edit dialogs for projects, versions, components and views show the server's message at the name field.

## Permissions

Unchanged.

## Data model and migration

- Unique indexes:
  - `projects (workspace_id, lower(name))`;
  - `releases (project_id, lower(name))`;
  - `components (project_id, lower(name))`, replacing the case-sensitive one;
  - `views (owner_id, lower(name))`.
- R4 runs before the indexes are made.
- `strand` gets the same migration in `supabase/migrations`.

## API

The routes that create or rename these answer 409 with a field error on `name`. The views route also checks R3 on an owner change.

## Screens

R5.

## System settings

None.

## Scale

The indexes serve the checks. The migration is one pass per table.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a second "Payments" or "payments " is refused on create and rename |
| R2 | Server test: version "2.0" twice in one project is refused, allowed in another project; the same for a component, ignoring case |
| R3 | Server test: two views named "Mine" for one owner refused; an owner change to someone who has one, or can't see it, refused |
| R4 | Migration test: duplicates become "X (2)", "X (3)"; the first keeps its name |
| R5 | Typecheck and existing journeys; the dialogs already show server errors |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog

- 9 Nov 2026, while building (within the approved rules):
  - **Messages:** they don't name the clashing value: "A project with that name already exists", "This project already has a version with that name". One message per database index covers create, rename and owner change.
  - **R3:** giving a view to someone who already has one by that name is refused with 409, from the index, like the other clashes. Someone who can't see the view gets 400.
