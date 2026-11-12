# 0717 Global permissions

Status: Ported (aws-jira `d11592d`, strand `a657fd9`), pending work the PO asked to complete on 11 Nov 2026; awaiting verification
Parity rows: PRM-10

## Context and Jira reference

- **Jira DC** (Administration › System › Security › Global permissions, [managing global permissions](https://confluence.atlassian.com/adminjiraserver/managing-global-permissions-938847142.html)). Global permissions are granted to groups (or Anyone on the web):
  - **Jira System administrators:** all administration.
  - **Jira administrators:** most administration. Since 11.2 the groups `jira-administrators` and `jira-system-administrators` are separate.
  - **Browse users and groups:** lists of people and groups in pickers, and @mentions.
  - **Create shared objects:** share a filter or dashboard globally or with groups; also who can create a board.
  - **Manage group filter subscriptions.**
  - **Bulk change:** bulk edit, move, transition and delete, each also subject to project permissions.
  - Only system administrators grant or revoke Jira System administrators.
- **Strand today:**
  - System administrators are the `system-administrators` group, or the Entra `Strand.Admin` role.
  - Everyone else can browse people and groups, share views, bulk change and subscribe groups. The last of these is a System setting (spec 0604).

## Community and Atlassian backlog

- **Migrations from Jira:** directory groups such as `jira-administrators` keep their rights, because a directory's groups can be granted (R1).
- **Grants to individual people:** not offered, as in Jira, which grants to groups only.

## Rules

- **R1: Grants.** Administration › **Global permissions** lists five permissions and the groups each is granted to. A system administrator adds a group to a permission or removes one.
  - **System administrators:** always the `system-administrators` group (it can't be removed), plus any groups granted. A directory's group, such as an imported `jira-administrators`, can be granted. Its members administer Strand from their next request.
  - **Browse users and groups:** without it, a person picker finds someone only by their exact email address. Group lists show only the groups the person is in or owns. Pickers of a project's people (assignee, members) are unaffected, as in Jira, because they follow project permissions.
  - **Create shared objects:** without it, a saved view stays private: it can't be shared with the workspace, projects, groups or people.
  - **Manage group filter subscriptions:** without it, a person subscribes only themselves. This replaces System settings › Filter subscriptions › "Who may subscribe a group".
  - **Bulk change:** without it, the selection bar's bulk actions are refused: edit, move, transition, watch, delete, archive and restore. Single-item actions are unaffected.
  - System administrators hold every permission.
- **R2: Defaults.** Existing and new workspaces grant the last four to the default users group, so nothing changes until an administrator narrows them. The existing filter-subscription setting carries over: "System administrators only" becomes no grant.
- **R3: The person's own.** `GET /me` lists the person's global permissions. The app hides what they can't use: bulk actions, sharing, and group subscriptions.
- **R4: Records.** Every grant and removal is audited.

- **R5: Jira administrators** (P1, chosen 12 Nov 2026). A sixth global permission, **Jira administrators**, granted to groups like the others and held by every system administrator. Its holders get **Administration** with:
  - **Groups:** every group except the system groups.
  - **People:** they see everyone, and create, edit, activate, deactivate and set passwords, but not for a system administrator.
  - **Configuration:**
    - Project categories.
    - Workflows and workflow schemes.
    - Custom fields, field configurations and screens.
    - Notification schemes.
    - Global automation rules.
    - Link types, priorities and resolutions.

  System administrators keep the rest, as Jira keeps them for its System administrators:
  - Global permissions;
  - Authentication methods and user directories;
  - System settings, look and feel, and webhooks;
  - Incoming mail and the Jira importer;
  - Development tools, backups and the audit log.

  A Jira administrator doesn't see every project: Browse projects stays per project, as in Jira.

## Permissions

- Grants and removals: system administrators.

## Data model and migration

- `global_permissions (workspace_id, permission, group_id)`, unique per permission and group.
- `is_system_admin()` also counts members of groups granted System administrators.
- Seeded per R2, for existing and new workspaces. The setting `filterSubscriptions.groupSubscribers` goes.

## API

- `GET /admin/global-permissions`, `POST /admin/global-permissions` `{ permission, groupId }`, `DELETE /admin/global-permissions/:id`.
- `GET /me` adds `globalPermissions`.
- Refusals are 403s naming the permission.

## Screens

Administration › **Global permissions**: one section per permission, with its groups, Add group (a searchable group picker) and Remove.

## Scale

- One indexed query per check. Group pickers search on the server.
- `is_system_admin()` is still one indexed query per request.

## Acceptance

| Rule | Proved by |
|---|---|
| R5 | Server test: a member of a group granted Jira administrators makes a workflow, a custom field, a priority, a link type and a category, edits a person and a group, but not a system administrator, not system settings, global permissions or webhooks; a non-holder gets 403. Browser journey: a Jira administrator sees Administration with its sections and not System settings |
| R1–R4 | Server test: defaults; removing each grant refuses its action (person search beyond exact email, group list, share, group subscription, bulk edit) and granting it back allows it; a group granted System administrators makes its members admins; the system-administrators group can't be removed; a non-admin can't grant; audit |
| R1, R3 | Browser journey: an admin removes Bulk change from the default users group; a member's selection bar says so |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Anyone on the web:** Strand has no anonymous access.
- **Create shared objects and boards:** Strand's boards are made by project administrators and named board admins (decided 4 Nov 2026, AG-15), not through this permission.

## Proposals (not built until chosen)

- **P1: Jira administrators:** chosen by the PO on 12 Nov 2026, now R5.

## Open questions

None.

## Changelog
