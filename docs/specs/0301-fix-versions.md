# 0301 Several fix versions on a work item

Status: In review
Parity rows: ISS-01

## Context and Jira reference

- **Jira:**
  - **Fix Version/s** is a multi-valued field: an item can be fixed in several versions, such as a fix released in 2.4 and back-ported to 2.3.
  - **Affects Version/s** works the same way.
  - Sources, checked 9 Nov 2026:
    - [Managing versions](https://confluence.atlassian.com/adminjiraserver/managing-versions-938847201.html) (DC). It describes the "Fix For" versions of issues when releasing, merging and deleting.
    - Jira's REST API (`fixVersions` is an array; a release's `moveUnfixedIssuesTo`).
- **Strand today:**
  - An item has one fix version: `issues.release_id`, a single picker in the item.
  - Its affects versions are already a list: `issues.affects_release_ids uuid[]`, a multi-select.
  - Importing from Jira would have to drop every fix version after the first, so this comes before the importer (Phase 3).

## Rules

- **R1: Several fix versions.**
  - An item's fix versions are a list of the project's versions (at most 50), as affects versions already are.
  - The item's **Fix versions** field is a multi-select, like Affects versions.
  - Each change is in the item's history.
- **R2: Existing items keep their fix version.** An item with a fix version today has a list with that one version. An item without one has an empty list.
- **R3: Search.** JQL `fixVersion` matches an item if any of its fix versions matches:
  - `fixVersion = "2.4"`, `fixVersion in ("2.3", "2.4")`, `fixVersion is EMPTY`;
  - `!=` and `not in` behave as they do for `affectedVersion` today.
- **R4: Releases view.** A version's items are those with the version among their fix versions. An item in two versions counts in both, as in Jira's release pages.
- **R5: Releasing with unresolved items.** When a version is released and the unresolved items are moved to another version, the released version is replaced by that version in each item's list. Their other fix versions stay. This is Jira's `moveUnfixedIssuesTo`.
- **R6: Deleting a version.** It disappears from every item's fix versions, as it already does from affects versions. Moving them to another version instead is spec 0304.
- **R7: Workflow rules.**
  - "Set a field" on Fix versions sets the list to the version chosen.
  - "Copy from the parent" copies the whole list.
  - "Field required" needs at least one version.
  - Existing rules that name the old field are converted.
- **R8: Import and export.**
  - The CSV export's Fix versions column lists the versions, separated by commas (as Affects versions does).
  - The CSV import maps one column to one fix version, as today.
  - The JSON project import accepts a list, and still accepts the old single value.
- **R9: Test executions keep their single version.** An execution is run against one version, as in Xray. Unchanged.

## Permissions

Unchanged: changing fix versions needs Edit issues; managing versions needs Administer projects.

## Data model and migration

- `issues.fix_release_ids uuid[] not null default '{}'`, filled from `release_id`. Then `release_id` is dropped.
- A GIN index on `fix_release_ids`, so the Releases view and search use `@>` and `&&`.
- Workflow rules naming `releaseId` are rewritten to name `fixReleaseIds`; a set-field value becomes a one-element list.
- `strand` gets the same migration in `supabase/migrations`.
- The migration is a single update. There is no production data yet; the importer (0802) writes lists directly.

## API

- Issues: `fixReleaseIds: uuid[]` (at most 50, each a version of the project) replaces `releaseId`:
  - in create, patch and bulk update;
  - in responses.
- `GET /issues?release=` returns items with that version among their fix versions.
- Release: `moveTo` replaces the released version (R5).
- Project import accepts `fixReleaseIds`, or `releaseId` for files exported before this change.

This is a breaking change to `releaseId`. Strand has no outside users of the API yet; the OpenAPI document is regenerated.

## Screens

- Item detail: Fix versions becomes a multi-select. Jira equivalent: Fix Version/s.
- Releases view, release dialog and bulk edit: they read the list. Bulk edit sets it, as Jira's "Replace all with" does.
- Transition dialog and rules editor: Fix versions.

## System settings

None.

## Scale

- The GIN index serves `@>` and `&&` for the Releases view and JQL.
- The backfill is one statement over today's data.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: an item gets two fix versions; a version of another project is refused (400); history records the change |
| R2 | Migration test: an item with `release_id` has a one-element list after the migration, one without has `{}` |
| R3 | Server test: `fixVersion = A`, `in (A, B)`, `is EMPTY` and `!=` over items with none, one and two versions |
| R4 | Web unit test: an item in two versions counts in both |
| R5 | Server or web unit test: releasing A with moveTo C turns an unresolved item's `[A, B]` into `[C, B]` (or `[B, C]`); resolved items keep A |
| R6 | Server test: deleting a version removes it from fix and affects versions |
| R7 | Server test: set-field and copy-from-parent on fix versions; migration test converts a stored rule |
| R8 | Server test: the export lists two versions; the import accepts a list and the old single value |
| R9 | Existing testing tests stay green |

A browser journey sets two fix versions on an item and finds it with JQL.

## Strand branch

Same rules. The issue row and the migrations differ as usual.

## Out of scope and deliberate divergences

- **Versions:** moving items when a version is deleted, merging versions, and archiving versions are spec 0304.
- **CSV import of several fix versions:** Jira's importer maps repeated columns. This waits for the importer (0802).

## Open questions

None. Jira's behaviour is followed throughout.

## Changelog
