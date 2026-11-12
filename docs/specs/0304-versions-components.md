# 0304 Versions and components: move work when deleting, merge versions, archive versions

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC**, from [Managing versions](https://confluence.atlassian.com/adminjiraserver/managing-versions-938847201.html) (checked 9 Nov 2026):
  - **Deleting a version:** a confirmation page asks what happens to the issues tied to it: assign them to another version, or just remove the references. Jira asks separately for Fix Version and Affects Version.
  - **Merging versions:** moves the issues of one or more versions into another version. The merged versions are removed. REST: `PUT /rest/api/2/version/{id}/mergeto/{moveIssuesTo}`.
  - **Archiving a version:**
    - hides an old version from reports and the UI;
    - an archived version can't be changed until it's unarchived;
    - archived versions can't be added to or removed from an issue's fix and affects versions.
  - **Releasing and unreleasing:** already in the app.
- **Jira DC components:** deleting a component offers to move its issues to another component, or to remove it from them.
- **Before this spec:**
  - Deleting a version or a component removes it from every item; there is no choice.
  - There is no merge and no archive.

## Rules

- **R1: Deleting a version** asks, when items use it:
  - **Fix versions:** move them to another version, or remove the version from them.
  - **Affects versions:** the same choice, made separately.
  - An item that already has the target version doesn't get it twice.
- **R2: Deleting a component** asks, when items use it: move them to another component, or remove the component from them.
- **R3: Merging versions.** A project admin merges one or more versions into another. Their items' fix and affects versions point to the target instead, and the merged versions are deleted. The audit log records it.
- **R4: Archiving a version.**
  - A project admin archives or unarchives a version.
  - **Releases view:** archived versions are hidden, behind a "Show archived" switch.
  - **Pickers:** the item's fix and affects versions, the transition screen and the release dialogs don't offer them.
  - **Items:** an item keeps an archived version. The version can't be added to or removed from items: 400 "Version 2.3 is archived".
  - **Search:** JQL still finds it.
  - **Editing:** an archived version can't be edited (except to unarchive it), released or merged.
- **R5: Screens.**
  - The delete dialogs show how many items use the version or component, with the choices above.
  - The Releases view gains Merge and Archive.

## Permissions

Administer projects, as for every version and component change today.

## Data model and migration

- `releases.archived boolean not null default false`.

## API

- **`DELETE /projects/:key/releases/:id`:** gains `?fixTo=<id>&affectsTo=<id>`. Without them the version is removed from items, as today.
- **`DELETE /projects/:key/components/:id`:** gains `?moveTo=<id>`.
- **New `POST /projects/:key/releases/:id/merge` `{ from: [ids] }`:** merges those versions into `:id`.
- **`PATCH /projects/:key/releases/:id`:** gains `archived`.
- **New `GET /projects/:key/releases/:id/usage` → `{ fix, affects }`** and **`GET /projects/:key/components/:id/usage` → `{ items }`:** counts for the dialogs.

## Screens

Releases view: delete dialog, Merge dialog, Archive and Unarchive, and the "Show archived" switch. Project settings › Components: delete dialog. Jira equivalents: the Versions page actions (Delete, Merge, Archive) and the component delete dialog.

## System settings

None.

## Scale

Each change is one statement over the project's items, using the GIN-indexed arrays. Merging touches only the items that have the merged versions.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: deleting with fixTo/affectsTo moves each field separately, without duplicates; without them, removes |
| R2 | Server test: deleting a component with moveTo moves its items |
| R3 | Server test: merging two versions into a third rewrites fix and affects versions and deletes them, audited |
| R4 | Server test: an archived version can't be added to or removed from an item, can't be edited or merged; JQL still finds it; unarchive restores |
| R5 | Browser journey: deleting a version used by items offers the move; merging from the Releases view |

## Out of scope and deliberate divergences

- **Version reports** (version, release burndown): 0411.

## Open questions

None.

## Changelog

- 9 Nov 2026, while building (within the approved rules):
  - "Mark as unreleased" was only changed in the browser. It now reaches the server (`PATCH … { released: false }`) and clears the release date, as Jira's Unrelease does.
  - The release dialog's last choice now reads "Leave it in <version>", matching 0301 R5.
