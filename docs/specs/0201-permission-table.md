# 0201 One table of Jira's project permissions for the app's three roles

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

The product owner decided on 5 Nov 2026 that the app keeps its three project roles (admin, member, viewer) and gives them what Jira's default permission scheme gives, as one fixed table. Editable permission schemes are out of scope.

Today each route decides on its own, mostly through "reading needs any role, changing needs member" (`minFor` in `server/src/access.ts`), and the web app guesses with `canEdit` and `canAdmin` (`src/data/access.ts`). Some of today's answers differ from Jira's defaults (listed below), and specs 0202–0207 change them one at a time. This spec only creates the table, so those changes become one line each, made the same way on the server and in the web app.

- **Jira DC** ([Managing project permissions](https://confluence.atlassian.com/adminjiraserver/managing-project-permissions-938847145.html), DC 11.3, checked 8 Nov 2026) lists the project permissions.
- **Jira's default permission scheme** (Jira Server/DC 8.15, as listed by [Default Jira project permissions](https://www.jirastrategy.com/default-jira-project-permissions/), checked 8 Nov 2026) grants each permission to either:
  - the **Administrators** project role, or
  - **Application access**, meaning any logged-in user who can browse the project.

  Some permissions are granted to nobody: Set issue security, Edit sprints, Start/complete sprints, and archiving.
- **The app mapping:**
  - "Application access" maps to **member**. The app's viewer role reads and comments, a deliberate subset.
  - "Administrators" maps to **admin**.
  - Global admins hold every permission.

## Rules

- **R1:** One table, `server/src/shared/permissions.ts`, lists the Jira project permissions the app has, by Jira's names. For each it gives the lowest the app role that holds it, and Jira's default. The server and the web app both read it; nothing else decides these permissions.
- **R2:** The server checks these permissions through the table, with `need(role, permission)`:
  - Browse projects; Create, Edit, Transition, Assign and Delete issues; Assignable user; Link issues.
  - Modify reporter; Manage watchers.
  - Add comments; Edit own and all comments; Delete own and all comments.
  - Create attachments; Delete own and all attachments.
  - Work on issues; Edit own and all work logs; Delete own and all work logs.
- **R3:** No behaviour changes. The table's roles are what the app does today (column "the app today" below). The permission matrix and every existing test pass unchanged.
- **R4:** The web app asks the same table with `can(project, permission)`. `canEdit` and `canAdmin` remain as the names for Edit issues and Administer projects. A local workspace (no roles) can do everything, as today.
- **R5:** A unit test pins the table: each permission's role and Jira default. So a change to it is deliberate and shows up in review.
- **R6:** Permissions the app doesn't have yet are listed with "none" and the spec that adds them, so the table is also the checklist: Move issues (0501), Modify reporter, Manage watchers (0207), Archive issues (0508).

## The table

| Jira permission | Jira default | The app today | Changed by |
|---|---|---|---|
| Browse projects | any user with access | viewer | — |
| Create issues | any user with access | member | — |
| Edit issues | any user with access | member | — |
| Transition, Resolve, Close, Schedule issues | any user with access | member | — |
| Assign issues | any user with access | member | — |
| Assignable user | any user with access | **viewer** | 0207: member |
| Link issues | any user with access | member | — |
| Move issues | any user with access | none | 0501 |
| Delete issues | Administrators | **member** | 0202: admin |
| Modify reporter | Administrators | none | 0207: admin |
| Manage watchers | Administrators | none | 0207: admin |
| View voters and watchers | any user with access | viewer | — |
| Add comments | any user with access | viewer | — (The app's viewers comment, as decided) |
| Edit own / Delete own comments | any user with access | viewer (the author) | — |
| Edit all / Delete all comments | Administrators | **none** | 0205: admin |
| Create attachments | any user with access | member | — |
| Delete own attachments | any user with access | member | — |
| Delete all attachments | Administrators | **member** | 0204: admin |
| Work on issues (log work) | any user with access | member | — |
| Edit own / Delete own work logs | any user with access | member (the author) | — |
| Edit all / Delete all work logs | Administrators | admin | — |
| Manage sprints | Administrators | **member, in every project the board covers** (0101) | 0203: admin |
| Administer projects | Administrators | admin | — |
| Archive issues | none | none | 0508 |

Bold marks where the app today differs from Jira's default. Those differences are what 0202–0207 change, each with its own review.

## Who loses what in 0202–0207

| Spec | Who can no longer do it | What |
|---|---|---|
| 0202 | Members | Delete work items, and restore deleted ones |
| 0203 | Members | Create, start, complete, edit and delete sprints |
| 0204 | Members | Delete attachments other people added |
| 0207 | Viewers | Being assigned work |

Gained: project admins edit and delete anyone's comments (0205), change the reporter (0207), and add or remove other people as watchers (0207).

## Permissions

The table above.

## Data model and migration

None.

## API

No change of routes or shapes. Error messages for a refusal name the permission, for example "You need the Delete issues permission in PAY", instead of "Read-only access".

## Screens

None change (R3). The web app's checks move to `can()`.

## System settings

None.

## Scale

A table lookup; no queries are added.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R5 | Unit test (`server/test/permissions.test.ts`): every permission has a role and a Jira default, and the values equal the table above |
| R2, R3 | The whole server suite and permission matrix pass unchanged; a server test checks one refusal's message names the permission |
| R4 | Web unit test: `can()` agrees with the table for each role, and allows everything in a local workspace |
| R6 | The unit test lists the permissions marked "none" with their spec |

## Out of scope and deliberate divergences

- **Editable permission schemes:** out of scope, decided 5 Nov 2026 (PRM-01).
- **Viewers comment:** The app's viewer role is read and comment, a deliberate subset of Jira's "any user with access".

## Open questions

None.

## Changelog

- 9 Nov 2026, while building: the table said Set issue security was held by admins today; in fact members choose an item's security level (one they are in). The row now says member, keeping R3 (no behaviour change).
- 9 Nov 2026: specs 0203–0207, named in the table above, were merged into one, [0203](0203-default-permissions.md), at the product owner's request.
