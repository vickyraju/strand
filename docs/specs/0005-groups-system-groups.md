# 0005 Groups and system groups

Status: Implemented

## Context and Jira reference

A group is a set of people. A project admin can give a whole group a role in their project, so a team joins or leaves many projects in one step. Two system groups decide who uses the app and who administers it. This spec describes groups as built first. Extended by specs 0104 (directory groups and unique names), 0106 (deleting a group used by comments) and 0717 (global permissions granted to groups).

- **Jira DC:** [View, create or delete a group](https://confluence.atlassian.com/adminjiraserver110/view-create-or-delete-a-group-1627460049.html). Jira administrators make and delete groups and add people to them; a group's name can't be changed. New people join their application's default group (for example `jira-software-users`). Admin rights come from groups granted the System administrators and Jira administrators global permissions ([managing global permissions](https://confluence.atlassian.com/adminjiraserver/managing-global-permissions-938847142.html)). Project roles can hold groups.
- **The app follows Jira** for system groups, fixed names and groups in project roles.
- **Where it differs:**
  - Anyone may make a group, unless System settings › Groups says only system administrators may.
  - A group made in the app has **owners**, who manage it alongside system administrators.

## Rules

- **R1: System groups.**
  - **users-access:** everyone joins it on their first request (spec 0001 R5). Someone taken out stays out until their next sign-in (`POST /me/sign-in`), which puts them back and records the time. A personal access token isn't a sign-in: 400 "A personal access token isn’t a sign-in".
  - **system-administrators:** its members are system administrators: Administration, System settings and every project. The very first person joins it (spec 0001 R4).
  - The app knows both by their system role, not their name.
- **R2: Admin rights follow the group.** Whether someone is a system administrator is read from system-administrators on every request, with any sign-in or token. Added to it, they administer from their next request; taken out, they no longer do.
- **R3: Entra's admin role at sign-in.** Each sign-in (`POST /me/sign-in`) with a Microsoft Entra token carrying the `JiraBuildPoc.Admin` app role puts the person back in system-administrators. For someone already known, the role gives nothing until they sign in. A newcomer with the role joins on their first request: spec 0001 R3.
- **R4: System groups are protected.**
  - Only system administrators add or remove their members (others 403 "Only system administrators can change this group").
  - They can't be deleted: 409 "<name> is a system group and can’t be deleted".
  - system-administrators keeps at least one active member: 409 "Jira Build POC needs at least one system administrator".
  - Directory provisioning can't see or change them (spec 0104 R3).
- **R5: Making a group.** Anyone signed in makes a group, with a name of 1–100 characters and a description of up to 500. A name already used, ignoring case, is refused with 409 "There is already a group with that name". The maker becomes its owner and a member. With System settings › Groups › "Who may make a group" set to system administrators, anyone else gets 403.
- **R6: Managing a group made in the app.**
  - Its owners and system administrators add people (up to 500 at once, active people of the workspace only, otherwise 400), remove people, add owners (up to 50) and change its description. Anyone else gets 403 "Only the group’s owners and system administrators can change it".
  - **Name:** fixed once made: 400 "A group’s name can’t be changed once it is made: make a new group instead".
  - **Leaving:** anyone may leave a group made in the app.
  - **Owners:** the last owner can't step down (409 "A group needs an owner: add another owner first, or delete the group"); a system administrator may remove them.
- **R7: Roles for groups in projects.** A project admin gives a group a role (admin, member or viewer) in their project, changes it or takes it away.
  - Everyone in the group has that role there, as if it were their own: they see the project, work in it and can be assigned work. With a role of their own as well, the higher one counts.
  - Leaving the group, or the group losing the role, takes the access away at once.
  - A group already in the project keeps its role when added again. An unknown group is 400 "No such group".
  - **Admins:** a group's admin role counts for spec 0004 R6. Taking someone out of a group, or deleting the group, when that would leave a project with no admin is refused with 409 "KEY would have no admin left: give someone else the admin role there first".
  - Each change is audited (`project.group.added`, `.role_changed`, `.removed`).
- **R8: A group's page.** `GET /groups/:id` shows its kind (system, directory or local), owners, member count, whether I may manage it, its first 50 members, and its roles in the projects **I** can see. Everyone can see who owns a group, since owners decide who has its roles.
- **R9: At scale.**
  - `GET /groups`: system groups first, then by name; `query` matches the name; `limit` 100 by default and at most 200, with a cursor.
  - `GET /groups/:id/members`: by name; `query` matches name or email; `limit` 50 by default and at most 200, with a cursor.
  - A cursor that can't be read is a 400.
- **R10: Groups from the directory.** Microsoft Entra provisions groups over SCIM (`/scim/v2/Groups`):
  - `POST` makes a group with its members (unknown people are left out);
  - `GET ?filter=displayName eq "Name"` finds one;
  - `PATCH` adds members, removes them (by value, or with a `members[value eq "id"]` path, as Entra sends), or replaces them all.

  Such groups are read-only in the app and their names unique: spec 0104.
- **R11: Records.** Every change to a group is audited: `group.created`, `group.updated`, `group.members_added`, `group.member_removed`, `group.owners_added`, `group.owner_removed`, `group.deleted`; from SCIM, `group.provisioned` and `group.members_changed`.
- **R12: Administration asks first.**
  - Removing a member says what they lose: "They lose the roles this group gives in 1 project, unless they have a role there another way."
  - Deleting a group that gives roles in projects needs its name typed to confirm.

## Permissions

| Action | Anyone signed in | Group owner | Project admin | System admin |
|---|---|---|---|---|
| See groups, their owners and members | ✓ (spec 0717 narrows it) | ✓ | ✓ | ✓ |
| Make a group | ✓ (unless System settings say admins only) | | | ✓ |
| Change a group made in the app: people, owners, description, delete | – | ✓ | – | ✓ |
| Leave a group made in the app | ✓ | ✓ | ✓ | ✓ |
| Change a system group's people | – | – | – | ✓ |
| Give a group a role in a project | – | – | ✓ (their project) | ✓ |
| Change a directory group | – (spec 0104 R7) | – | – | – |

## Data model

- `groups (id, display_name, external_id, created_at)`, `group_members (group_id, user_id)`, `project_group_roles (project_id, group_id, role, added_at, added_by)` and the `project_access` view: `server/migrations/20261030090000_groups.sql`.
- `groups.description`, `groups.system_role` (`default-users` or `system-admins`, unique), `groups.created_by`, `group_owners (group_id, user_id)`, the two system groups and `is_system_admin(uid)`: `20261115090000_system_groups.sql`.
- `groups.source` (local, directory, system): spec 0104.

## API

- `GET /groups?query&mine&cursor&limit`, `GET /groups/:id`, `GET /groups/:id/members?query&cursor&limit`, `POST /groups` `{ name, description }`, `PATCH /groups/:id` `{ description }`, `DELETE /groups/:id`.
- `POST /groups/:id/members` `{ userIds }`, `DELETE /groups/:id/members/:userId`, `POST /groups/:id/owners` `{ userIds }`, `DELETE /groups/:id/owners/:userId`.
- `GET /groups/search?query` (for the project picker, 30 at most), `GET`, `POST /projects/:key/groups` `{ groupId, role }`, `PATCH` and `DELETE /projects/:key/groups/:groupId`.
- `POST /me/sign-in`.
- SCIM: `GET`, `POST /scim/v2/Groups`, `GET`, `PATCH`, `DELETE /scim/v2/Groups/:id`.

## Screens

- **Administration › Groups** (system administrators) or **Configuration › Groups** (everyone else): the paged list, **New group**, and a group's page at `/admin/groups/:id` with its people, owners and projects.
- **Project settings › People › Groups:** **Add a group** with a searchable picker that says who manages each group ("managed by Maya Member").
- **Jira equivalents:** Administration › User management › Groups; Project settings › Users and roles.

## System settings

**Groups** › Who may make a group: everyone (default) or system administrators only.

## Scale

Groups and members page with keysets on name and id, since a directory can bring thousands of groups and members. The project picker searches on the server.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a newcomer is in users-access; taken out, they rejoin only at sign-in, not with a token |
| R2 | Server test: added to system-administrators, a person (and their token) reaches Administration; taken out, they don't. Browser journey: a newcomer isn't an administrator and sees no Administration |
| R3 | Server test: with Entra's admin role, sign-in brings a person back into system-administrators, and not before. Browser journey: someone with the role sees Administration |
| R4 | Server test: an owner can't add to system-administrators; it can't be deleted or emptied of its last administrator; SCIM can't see it |
| R5 | Server test: a user makes mobile-developers and owns it; a name taken in another case is 409; with the setting, only system administrators make groups. Browser journey: a member makes a group |
| R6 | Server test: the owner adds people, others can't; the name can't change, the description can; members leave; the last owner can't step down. Browser journey: the maker adds a colleague |
| R7 | Server tests: a project admin gives a group Member and its people work there; the higher of two roles counts; leaving the group takes access away; a group that is the only admin route can't lose it or be deleted; the changes are audited. Browser journey: the group's colleague works in the project |
| R8 | Server test: a group's projects show only those the viewer can see |
| R9 | Server test: 150 groups and 120 members come a page at a time, searchable, system groups first; a bad cursor is 400 |
| R10 | Server test: SCIM makes a team with members, finds it by name, adds one member and removes another by path |
| R11 | Server test: the audit log has each group change |
| R12 | Browser journey: removing a member says what access they lose; deleting a group with project roles needs its name typed |

## Out of scope and deliberate divergences

- **Directory groups, unique names, SCIM renames and deletes:** spec 0104.
- **Deleting a group that comments are restricted to:** spec 0106.
- **Global permissions granted to groups, Jira administrators:** spec 0717.
- **Group owners and groups made by anyone:** the app's own, so teams manage themselves.
