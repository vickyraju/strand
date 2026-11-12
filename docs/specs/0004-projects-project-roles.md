# 0004 Projects and project roles

Status: Implemented

## Context and Jira reference

A project holds work items, boards, versions and settings. Who may see and change it is decided per project: each person has one of three roles there, or none. System administrators see and administer every project. This spec describes projects and their roles as built first. Extended by specs 0102 (archiving), 0201 and 0203 (the permission table), 0308 and 0703 (keys, categories, avatars) and 0310 (templates). Roles given to whole groups: spec 0005.

- **Jira DC:** [Managing project permissions](https://confluence.atlassian.com/adminjiraserver/managing-project-permissions-938847145.html). A permission scheme grants each project permission to project roles, groups or people. People without Browse projects don't see the project at all. Project administrators add people and groups to the project's roles (Project settings › Users and roles).
- **The app** keeps three fixed roles, Viewer, Member and Admin, which hold what Jira's default permission scheme gives (spec 0201).
- **Where it differs:**
  - Only Jira administrators create projects; the app follows Jira (R4).
  - Roles and permission schemes can't be edited (spec 0201).

## Rules

- **R1: Outsiders see nothing.** A project exists only for people with a role in it and for system administrators. For anyone else, every route that names the project or one of its items answers 404 "Project not found", and the project is missing from every list.
- **R2: Three roles.** One role per person per project:
  - **Viewer:** reads the project and its work, comments, watches and stars.
  - **Member:** also creates, edits and moves work.
  - **Admin:** also changes the project's settings, its people and its groups.

  What each role may do is spec 0201's table. A refusal is a 403 that names the permission. The web app hides what the role can't do: a viewer's item page says "You have view-only access to this project. You can comment, but not change the work item." and its fields are read-only.
- **R3: Global admins.** System administrators (spec 0005) see and administer every project in their workspace without being listed in it. `GET /projects/:key` gives them the role `admin`. They aren't in the project's people list. In the web app, a person is a global admin when the server says so; in a workspace kept in the browser, everyone is.
- **R4: Creating a project.** As Jira's Create project, only administrators create projects: people with the Jira administrators global permission, which system administrators hold too (spec 0717). Anyone else is refused (403 "Only administrators can create projects"), and the web app doesn't offer Create project to them. Its creator, and its lead when that is someone else, become its admins. The new project opens in the web app at `/project/KEY`. The creation is audited (`project.created`).
- **R5: Adding people.** A project admin adds up to 100 people at once, all with one role. Everyone added must be an active person in the workspace; otherwise nothing is added and the answer is 400 "Everyone you add must be an active member of the workspace". Someone already in the project keeps their role. A project admin changes a person's role. Each addition, role change and removal is audited (`project.member.added`, `.role_changed`, `.removed`, `.left`), with the role before and after.
- **R6: A project keeps an admin.** A project always has at least one active admin, through a person's own role or a group's. Demoting or removing the last one is refused with 409 "A project needs at least one admin. Make someone else an admin first."
- **R7: Leaving.** Anyone in a project may remove themselves (leave it). Removing someone else needs a project admin (403). The person loses access at once. Their stars of the project and their "recently viewed" entries for its items are deleted.
- **R8: Listing and finding projects.**
  - `GET /projects`: the live projects I can see, by name, the first 1,000, each with my star and its count of open items.
  - `GET /projects/search`: projects whose name or key contains the query, ignoring case. `%` and `_` are plain characters.
  - Results come in name order, a page at a time: `limit` 30 by default and at most 100, and `next` as the cursor for the next page. A cursor that can't be read is a 400.
- **R9: Finding people.** `GET /users/search` finds active people in the workspace whose name or email contains the query, in name order, paged like R8. Who may search beyond exact email addresses: spec 0717.
- **R10: Deleting in a workspace kept in the browser.** Deleting a project removes its work items with their comments, history and notifications, its sprints and its star. A saved view filtered on the project loses that filter and keeps the others. Deleting on a server: spec 0027.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| See the project and its work | – (404) | ✓ | ✓ | ✓ | ✓ |
| Comment, watch, star | – (404) | ✓ | ✓ | ✓ | ✓ |
| Create and change work | – (404) | – (403) | ✓ | ✓ | ✓ |
| Change settings, people and groups | – (404) | – (403) | – (403) | ✓ | ✓ |
| Leave the project | – | ✓ | ✓ | ✓ (not the last admin) | ✓ (when listed) |
| Create a project | – (403) | – (403) | – (403) | – (403) | ✓ (and Jira administrators) |

Every other project permission: spec 0201's table.

## Data model

- `projects` (`server/migrations/20261011202354_core_schema.sql`): `workspace_id`, `key`, `name`, `description`, `color`, `template`, `lead_id`, `created_at`. Indexes for name order and "contains" search on name and key: `20261016090000_project_archive_and_search.sql`.
- `project_members (project_id, user_id, role, added_at, added_by)`, one row per person, `role` in `admin`, `member`, `viewer` (`20261027090000_project_members.sql`).
- `project_access` view: each person's role in each project, the highest of their own and their groups' (`20261030090000_groups.sql`). Every access check reads it.
- `memberships (workspace_id, user_id, role)`: who is in the workspace; `owner` for the first person.
- `stars (user_id, project_id)` and `issue_views (user_id, issue_id, viewed_at)`.

## API

- `POST /projects`, `GET /projects`, `GET /projects/search?query&cursor&limit`, `GET /projects/:key`, `PATCH /projects/:key` (project admins), `PUT` and `DELETE /projects/:key/star`.
- `GET /projects/:key/members` (anyone who can see the project), `POST /projects/:key/members` `{ userIds, role }`, `PATCH /projects/:key/members/:userId` `{ role }`, `DELETE /projects/:key/members/:userId`.
- `GET /users/search?query&cursor&limit`.
- **Errors:** 404 "Project not found" for an outsider; 403 naming the permission; 409 for the last admin; 400 for people outside the workspace or a bad cursor.

## Screens

- **Create** in the menu opens the new-project dialog (name, key, template), for administrators. Others are told to ask an administrator.
- **Project settings › People:** everyone with a role and a role picker for each (project admins change them), **Add people** (search, pick several, one role), and "What each role can do".
- **Item page:** the view-only notice for viewers.
- **Jira equivalent:** Project settings › Users and roles.

## Scale

Project and people searches page with a keyset on `(lower(name), id)`, backed by the name indexes and trigram indexes on name, key and email.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: an outsider gets 404 for the project, its item, its people and a comment, and doesn't see it or its labels. Server test: the permission matrix refuses outsiders on every project route with 404 |
| R2 | Server test: a viewer reads and comments but can't create or edit; a member works but can't manage people. Server test: the permission matrix. Web unit test: `canEdit` and `canAdmin` per role. Browser journey: a viewer added in the app reads and comments, and is refused an edit |
| R3 | Server test: the workspace owner is admin of a project without being listed in it. Web unit test: global admin from the server, everyone in a browser workspace |
| R4 | Browser journey: a project created in the app opens at its address; a newcomer isn't offered Create project. Server test: the backup of a deleted project holds its creator's membership. Server test: the permission matrix lets only administrators create one. Server test: the audit log has `project.created` |
| R5 | Server test: a project admin adds an outsider, who can then see the project, and changes their role; bulk add keeps existing roles and refuses an unknown person. Server test: the audit log has the additions and role changes. Browser journey: Add people as a viewer |
| R6 | Server test: the last admin can't demote or remove themselves (409) |
| R7 | Server test: a member can't remove the admin (403); leaving removes the person's stars and recently viewed items, and the project is then 404 for them |
| R8 | Server test: project search pages in name order, matches the key, treats `%` literally and refuses a bad cursor |
| R9 | Server test: people search pages in name order |
| R10 | Web unit tests: deleting a project removes its items, comments and history; a saved view loses the project filter |

## Out of scope and deliberate divergences

- **Archiving:** spec 0102. **Deleting and backups:** spec 0027.
- **Project keys, categories, avatars:** specs 0308 and 0703. **Templates:** spec 0310.
- **Who may be assigned work:** spec 0203 R7.
- **Editable roles and permission schemes:** not built (spec 0201).

## Changelog

- R4: creating a project is for administrators only, as in Jira DC; before, anyone signed in could.
