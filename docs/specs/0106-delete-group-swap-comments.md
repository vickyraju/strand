# 0106 Deleting a group used to restrict comments: move them to another group

Status: Ported (aws-jira `70ca8c0`, strand `8eb9030`), pending work the PO asked to complete on 11 Nov 2026; awaiting verification
Parity rows: PRM-18

## Context and Jira reference

- **Jira DC** (Administration › User management › Groups › Delete):
  - The page counts the comments and work logs restricted to the group. If there are any, the administrator chooses a **swap group**, and those comments move to it.
  - Without a swap group the delete is refused (`GroupService.validateDelete`). The REST API's `DELETE /rest/api/2/group?groupname=…&swapGroup=…` does the same.
  - The group also leaves notification schemes, permissions and project roles.
  - A group a directory removes (LDAP, Crowd) gets no swap. Its comments stay restricted to a group nobody is in, so only their authors see them. Atlassian's KB ["Resolving invisible comments"](https://support.atlassian.com/jira/kb/resolving-invisible-comments-issue-in-jira-due-to-incorrect-group-level-settings/) fixes them by hand in the database.
- **Strand today:** deleting a group takes its project roles away (spec 0104). Comments restricted to it quietly become visible only to their authors. Notification scheme entries for it stay, pointing at nothing.
- **Roles:** Strand's project roles are fixed (Administrators, Members, Viewers), so a role used by a comment can't be deleted. Jira's role swap has nothing to apply to.
- **Work logs:** Strand's work logs have no visibility, so only comments move.

## Community and Atlassian backlog

| Ticket | Kind | What people hit | Here |
|---|---|---|---|
| KB: invisible comments | Support | Comments restricted to a group that's gone are seen by nobody but their authors | R1 for groups deleted here; P1 for groups a directory removes |
| [JRASERVER-11699](https://jira.atlassian.com/browse/JRASERVER-11699) | Suggestion | Restrict a comment to a person, not a group | Out of scope |

## Rules

- **R1: Swap on delete.** Deleting a group shows how many comments are restricted to it. If there are any, the person chooses another group, and every one of those comments becomes restricted to that group, in every project. Without a choice the delete is refused.
- **R2: Tidy references.** The group leaves every notification scheme, as in Jira. As before (spec 0104), its project roles, board administration and filter subscriptions go too. Saved views shared with it are no longer shared through it.
- **R3: Records.** The audit log's `group.deleted` entry names the group the comments moved to and how many moved.

## Permissions

As for deleting the group (spec 0104): its owners and system administrators. A system administrator may choose any other group. An owner may choose only a group they're in or own, the same rule as restricting a comment (spec 0203).

## Data model and migration

An index on comments restricted to a group (`(visibility->>'id') where visibility->>'kind' = 'group'`), so counting and moving them doesn't scan every comment.

## API

- `GET /groups/:id` adds `restrictedComments` (for people who may delete the group; otherwise null).
- `DELETE /groups/:id?swapGroupId=<uuid>`: required when `restrictedComments` > 0. Otherwise it's a 409 that names the count.

## Screens

Groups › a group › Delete: if comments are restricted to it, the dialog says how many and asks for the group to move them to, through a searchable group picker.

## Scale

One indexed update per delete. The group picker searches on the server, since a directory can bring thousands of groups.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Server test: the count, a refused delete without a swap, the comments moved and readable by the new group's members, the notification entry gone, the audit entry |
| R1 | Browser journey: delete a group with a restricted comment, choosing a group to move it to |

## Strand branch

Same rules. Security levels that name the group keep their other members, and the deleted group's entry grants nothing.

## Out of scope and deliberate divergences

- **Groups a directory removes** (SCIM from Entra, LDAP sync): there's no one to ask, so as in Jira their comments stay with their authors only. See P1.

## Proposals (not built until chosen)

- **P1: A fallback for directory deletes.** System settings name a group that receives comments when a directory removes their group, so nothing becomes invisible the way Atlassian's KB describes.

## Open questions

None.

## Changelog
