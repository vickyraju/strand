# 0006 People administration and SCIM provisioning

Status: Implemented

## Context and Jira reference

People reach the app from the organisation's Microsoft Entra: they sign in, and Entra provisions and deprovisions them over SCIM 2.0. Administration › People lets system administrators see everyone and change many people at once. The app is built for tens of thousands of people, so the list is searched, filtered and paged on the server. This spec describes the base. Extended by specs 0704 (anonymising), 0710 (bulk changes and refused sign-ins kept after License cleanup went), 0712 (user directories), 0714 (local users) and 0717 R5 (Jira administrators).

- **Jira DC:** Administration › User management lists users with filters, and [Create, edit, or remove a user](https://confluence.atlassian.com/adminjiraserver/create-edit-or-remove-a-user-938847025.html) covers one person at a time. Users from an external directory are kept in line with it by [synchronizing](https://confluence.atlassian.com/adminjiraserver/synchronizing-data-from-external-directories-938847057.html); an inactive user can't sign in, and their work keeps their name.
- **The app follows Jira:** deprovisioning deactivates, never deletes.
- **Where it differs:** people come from Entra by SCIM push rather than a directory sync, and changes to many people (for example everyone idle for a year) run in the background.

## Rules

- **R1: SCIM needs its token.** Every `/scim/v2` request carries `Authorization: Bearer` with the server's `SCIM_TOKEN`, compared in constant time. A wrong or missing token, or no token configured, is 401 "Invalid SCIM token".
- **R2: Provisioning a person.** `POST /scim/v2/Users` makes a person and answers 201:
  - the email is `userName`, in lower case;
  - the name is `displayName`, or the given and family names;
  - `externalId` is their Entra object id;
  - they are active unless `active` says otherwise.

  `GET /scim/v2/Users?filter=userName eq "x"` finds them by email, whatever its case. Lists page with `startIndex` and `count` (at most 200).
- **R3: Deprovisioning.** `PATCH` with `active` false (also Entra's text "False") or `DELETE` deactivates the person. Nothing they did is removed. From then on, their sign-in is refused with 403 "Account is deactivated".
- **R4: The People list.** System administrators list everyone in the workspace, each with:
  - name, email, title;
  - role: `owner`, `admin` (in system-administrators) or `member`;
  - whether they are active, when they were last active and last signed in;
  - their groups, and how many projects they have a role in.

  Anyone else gets 403 "Admin only".
- **R5: Search, filters and pages.** `GET /admin/users` filters on the server by:
  - `query`, in the name or email;
  - `status`: all, active or deactivated;
  - `inactive`: unused for at least that many days, or `never`;
  - `group` or `notInGroup`.

  It answers in name order with the `total` the filter matches, `limit` 50 by default and at most 200, and `next` as the cursor. A cursor that can't be read is a 400.
- **R6: Changing everyone a filter matches.** `POST /admin/users/bulk` takes either `userIds` (up to 1,000, changed at once) or a `filter`; both or neither is a 400. The actions are deactivate, reactivate, add to a group and remove from a group.
  - With a filter it answers 202 with the job and how many people `matched`.
  - The job changes 200 people at a time, each batch in its own transaction, and keeps `progress.done`. Its result says how many `changed`.
  - Anyone but a system administrator gets 403.

  What a bulk change guards (never yourself, always an active system administrator, directory groups refused): specs 0710 R3 and 0104 R7.
- **R7: The People page.**
  - It shows the first 50 matches: "Showing 50 of 70", with "Load 20 more".
  - The search box searches as you type.
  - **Choosing everyone:** "Select everyone shown", then "Select all 70 matching". The bulk action applies to everyone matching, in the background, and a message says how many changed.
  - "Add to group…" finds the group by search.

## Permissions

| Action | SCIM token | Anyone signed in | System admin |
|---|---|---|---|
| Provision, update, deactivate people | ✓ | – | – |
| List, search and filter people | – | – | ✓ (Jira administrators too, spec 0717 R5) |
| Change people in bulk | – | – | ✓ |

## Data model

- `users` (`server/migrations/20261011202354_core_schema.sql`): `entra_oid`, `email` (unique), `name`, `title`, `active`. `last_active_at` (`20261116090000_license_cleanup.sql`) is written at most once an hour; `last_sign_in_at` (`20261115090000_system_groups.sql`).
- `memberships (workspace_id, user_id, role)`: who is in the workspace.
- A bulk change by filter is a `users.bulk` job (spec 0026), with `progress { total, done }`.

## API

- **SCIM** (`/scim/v2`, bearer `SCIM_TOKEN`): `GET /ServiceProviderConfig`, `GET` and `POST /Users`, `GET`, `PUT`, `PATCH` and `DELETE /Users/:id`. Groups: spec 0005 R10.
- `GET /admin/users?query&status&inactive&group&notInGroup&cursor&limit` → `{ items, total, next }`.
- `POST /admin/users/bulk` `{ userIds | filter, action, groupId }` → `{ changed, unchanged }`, or 202 `{ jobId, matched }`; follow the job at `GET /jobs/:id`.
- `GET /admin/users/refused-sign-ins`: spec 0710 R3.

## Screens

- **Administration › People:** search, the Inactive, Status and group filters, the table, the bulk bar and its confirmation, **Create user** (spec 0714) and Edit or Anonymise (specs 0714, 0704).
- **Jira equivalent:** Administration › User management › Users.

## Scale

- **The list:** one count and one keyset page on `(lower(name), id)`, with trigram indexes on name and email.
- **Bulk changes:** a filter's matches change in a background job, 200 per transaction, so any number of people can change without a long request.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a wrong SCIM token is 401 |
| R2 | Server test: SCIM makes a person, and finds them by their email in lower case |
| R3 | Server test: SCIM deactivates them, and their sign-in is then refused (403) |
| R4 | Server test: an admin lists a member with role, status and one project, and a deactivated person; the owner is `owner`; a member is refused |
| R5 | Server test: 230 people come 100 at a time in name order, each once, with the total; the inactive and status filters count right; a bad cursor is 400. Browser journey: the search pages through 70 people |
| R6 | Server test: deactivating everyone idle for a year is a job that changes 115 people; neither people nor a filter is 400; a member is 403. Browser journey: all 70 matching are added to a group in the background |
| R7 | Browser journey: "Showing 50 of 70", "Load 20 more", select all matching, add to a group found by search, "Changed 70" |

## Out of scope and deliberate divergences

- **Creating, editing and passwords for people in the app:** spec 0714. **User directories:** spec 0712. **Anonymising:** spec 0704.
- **Deleting people:** never. Deprovisioning deactivates, so history keeps its names.
