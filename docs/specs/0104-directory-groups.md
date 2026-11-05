# 0104 Groups from the directory: unique names, directory groups only, renames that keep their grants

Status: In review
Parity rows: PRM-17, PRM-18

## Context and Jira reference

Groups made in Strand have a fixed name since `20bfae4`. Groups from Entra (SCIM) have gaps:
- SCIM can rename any group, including one made in Strand.
- SCIM can create a second group with a name that's already taken; nothing in the database stops it.
- SCIM can delete a group made in Strand.
- A SCIM-made group that arrives without an `externalId` looks like a Strand group.

`membersOf("name")` in JQL finds groups by name, so a duplicate name makes queries ambiguous.

- **Jira DC:**
  - **Names:** a group is identified by its name.
  - **Directory rename:** a rename in the directory (LDAP or Active Directory) looks to Jira like a new group, and the old one like a deleted group. "Any permissions relying on the old group are broken." Atlassian's workaround is to grant the new name first, then remove the old group once it's empty ([Community answer on renaming LDAP groups](https://community.atlassian.com/forums/Crowd-questions/Renaming-LDAP-Groups-and-consequences-for-Confluence-JIRA/qaq-p/2221342); [JRASERVER-76143](https://jira.atlassian.com/browse/JRASERVER-76143); checked 5 Nov 2026).
  - **Group names:** Jira's own groups can't be renamed ([JRASERVER-1391](https://jira.atlassian.com/browse/JRASERVER-1391)).
  - **Deleting a group** ([View, create or delete a group](https://confluence.atlassian.com/adminjiraserver110/view-create-or-delete-a-group-1627460049.html), DC 11.0, checked 5 Nov 2026): members are removed, and "the users themselves will not be deleted". Admins should check where the group is used (permission schemes, notification schemes, security levels, saved filters) before deleting it. The only default group of an application can't be deleted.
  - **Directories are separate:** a directory sync never changes groups of Jira's internal directory.
- **Strand today:**
  - **SCIM group routes** are in `server/src/routes/scim.ts`. They list, change and delete every group that isn't a system group, Strand-made ones included. `POST /Groups` doesn't check the name. `PATCH` "replace displayName" renames in place.
  - **Kind of group:** it's worked out from `external_id` (`kindOf` in `server/src/routes/groups.ts`).
  - **Name uniqueness** is checked only when a group is made in Strand (`POST /groups`), case-insensitively. There is no database constraint (`server/migrations/20261030090000_groups.sql`).

## Rules

- **R1:** Group names are unique across the workspace, ignoring case, whatever the group's kind (made here, from the directory, or a system group). The database enforces it. Groups that already share a name keep the oldest's name. The others become "Name (2)", "Name (3)" and so on, each change recorded in the audit log.
- **R2:** Every group records where it came from: made in Strand, from the directory (SCIM), or a system group. A group SCIM creates is a directory group even when Entra sends no `externalId`. Existing groups:
  - groups with an `externalId` are directory groups;
  - groups with no creator that aren't system groups are directory groups (Strand never deletes people, so only SCIM leaves the creator empty).
- **R3:** SCIM sees and changes only directory groups.
  - Groups made in Strand and system groups aren't listed by `GET /Groups`. Reading, changing or deleting one returns 404.
  - The directory never changes Strand's own groups, as Jira's directory sync never changes its internal groups.
- **R4:** SCIM `POST /Groups` with a name that's already taken is refused with 409 (SCIM `uniqueness`), and nothing is made. Entra then matches the existing directory group by name, as it does for users.
- **R5:** A rename from the directory (SCIM "replace displayName") keeps the group, its members and the roles it gives:
  - **New name taken:** if the new name already belongs to another group, the rename is refused with 409, and nothing changes.
  - **Searches:** `membersOf("old name")` stops matching and `membersOf("new name")` matches, as in Jira after a directory rename.
  - **Audit:** the rename is recorded (`group.renamed`, before and after).
  - **In Strand:** the name still can't be changed in Strand (`20bfae4`). Only the directory renames its groups.
- **R6:** A delete from the directory (SCIM `DELETE /Groups/:id`) removes the group, as in Jira: the directory is the source.
  - **Effect:** its members lose the roles it gave and are not removed from Strand.
  - **Audit:** it's recorded with the projects where the group had a role, and those left with no project admin, so a system administrator can fix them. It is not refused, because Entra would keep retrying.

## Permissions

| Action | SCIM (Entra) | System admin in Strand | Group owner | Others |
|---|---|---|---|---|
| Create a directory group, change its members and name, delete it | ✓ | – (members and name come from the directory) | – | – |
| See, change or delete a group made in Strand, or a system group | – (404) | as today | as today | as today |

## Data model and migration

- `groups.source text not null check (source in ('strand', 'directory', 'system'))`, set for existing rows as R2 describes.
- A unique index on `lower(display_name)`. Before creating it, the migration renames duplicates as R1 describes and writes one audit row for each renamed group.
- The same migration goes into `supabase/migrations` for `strand`.

## API

SCIM (`/scim/v2/Groups`):
- `GET`, `GET :id`, `PATCH :id` and `DELETE :id`: directory groups only (R3).
- `POST`: 409 `uniqueness` for a taken name (R4).
- `PATCH` with a taken name: 409 (R5).

Strand's own `/groups` API shows `kind` from `source` instead of `external_id`, with no change of shape. `POST /groups` with a taken name stays a 409, now backed by the database.

## Screens

None change. Administration › Groups already shows each group's kind and keeps directory groups read-only.

## System settings

None.

## Scale

- The `lower(display_name)` index makes the name checks a single lookup.
- SCIM's list filters on `source = 'directory'`. Thousands of directory groups page as today.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Migration test: two groups named "Ops" and "ops" become "Ops" and "ops (2)", with an audit row. Server test: making a group in Strand with a taken name is refused by the database too |
| R2 | Migration test: groups with an `externalId`, or made with no creator, are directory groups; a SCIM group made without `externalId` is a directory group |
| R3 | Server test: a Strand-made group and a system group are absent from SCIM's list; SCIM `GET`, `PATCH` and `DELETE` on them return 404 and change nothing |
| R4 | Server test: SCIM `POST` with a name taken by a Strand group returns 409 (`uniqueness`) |
| R5 | Server test: a SCIM rename keeps members and project roles; `membersOf` matches the new name and not the old; a rename to a taken name returns 409; the audit has `group.renamed` |
| R6 | Server test: SCIM deleting the only group giving a project admin removes it; the audit lists that project as left without an admin; members are still in Strand |

## Strand branch

Same rules. Security levels that name a deleted group stop letting its members in, as they do today.

## Out of scope and deliberate divergences

- **R5 keeps the grants**, where Jira breaks every permission on the old name. This does automatically what Atlassian's workaround does by hand (grant the new name, remove the old). The group's members and roles stay; searches by name behave as in Jira. Recorded in `../jira-parity.md` (PRM-17).
- **Comments restricted to a deleted group:** today they become visible to their author only. Jira's documentation doesn't say what happens, so this is left as it is (PRM-18).
- **Default groups of an application:** Strand's system groups already can't be deleted.

## Open questions

1. **R5, a rename from the directory.** Jira way: the renamed group is treated as new, and every role given to the old name is lost until someone grants the new one. Proposed: keep the group and its roles under the new name. It's what Atlassian advises admins to arrange by hand, and searches by name end up the same as in Jira. Choose the Jira way if you'd rather a directory rename never carries access over.

## Changelog

—
