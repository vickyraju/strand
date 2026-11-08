# 0203 The rest of Jira's default permission scheme: sprints, attachments, comments, sharing, reporter, watchers, assignees

Status: Ported (aws-jira `7a00960`, strand `e57e756`), approved by the PO on 9 Nov 2026 (0203–0207 merged); awaiting verification
Parity rows: PRM-03, PRM-04, PRM-05, PRM-06, PRM-07, PRM-08, PRM-09

## Context and Jira reference

Spec 0201 put Jira's project permissions in one table and marked where Strand differs from Jira's default permission scheme. Spec 0202 changed Delete issues. This spec changes the rest, so Strand's three roles hold what Jira's default scheme gives.

**Sources (checked 9 Nov 2026):**
- [Managing project permissions](https://confluence.atlassian.com/adminjiraserver/managing-project-permissions-938847145.html) (DC 11.3).
- Default grants as listed by [Default Jira project permissions](https://www.jirastrategy.com/default-jira-project-permissions/).
- [Sprint permissions](https://confluence.atlassian.com/adminjiraserver/sprint-permissions-and-defined-processes-983794894.html).
- [Saving your search as a filter](https://confluence.atlassian.com/jirasoftwareserver/saving-your-search-as-a-filter-939938748.html): a filter is shared with groups or roles you belong to.

| Permission | Jira's default | Strand before this spec |
|---|---|---|
| Manage sprints | Administrators | members, in every project the board covers (0101) |
| Delete all attachments | Administrators | members |
| Edit all comments, Delete all comments | Administrators | nobody |
| Modify reporter | Administrators | nobody (the creator is always the reporter) |
| Manage watchers | Administrators | nobody (people watch or unwatch themselves only) |
| Assignable user | any user with access | viewers too |

On comment visibility and sharing, Jira limits a person to the groups and project roles they belong to.

## Rules

- **R1: Manage sprints.** It moves to **project admins**. The 0101 rule stays: the person needs it in every project the board's filter names, or in every project for an open filter. Members can no longer create, edit, start, complete or delete sprints.
- **R2: Delete all attachments.** It moves to **project admins**. Members delete only attachments they added (Delete own attachments, unchanged).
- **R3: Edit all and Delete all comments.** Project admins hold them: they can edit and delete anyone's comment. Each such edit or delete by someone other than the author is in the audit log. Authors keep editing and deleting their own (Edit own and Delete own comments, unchanged).
- **R4: Comment visibility.** A comment can be limited only to:
  - a group the commenter belongs to;
  - a project role the commenter holds, where Strand's roles stack: an admin may limit to admins or members, a member to members, a viewer to neither.

  Anything else is refused (400). Global admins may choose any group or role.
- **R5: Filter sharing.** A saved view can be shared only with:
  - groups the owner belongs to;
  - projects the owner can see;
  - people in the workspace, as today.

  Other entries are refused (400). Global admins may share with any. Entries already on a view stay when it is saved again, so an owner who left a group can still edit the view.
- **R6: Modify reporter.** Project admins hold it: they can change an item's reporter to anyone who can see the project. Others can't change it (403). The change is in the item's history.
- **R7: Assignable user.** It moves to **member**: viewers can no longer be given work. Items already assigned to a viewer keep their assignee, as in Jira, until someone changes it.
- **R8: Manage watchers.** Project admins hold it: they can add or remove other people as watchers, if those people can see the project. Everyone still watches and unwatches themselves.
- **R9: Screens follow the table.**
  - The sprint actions, an attachment's Delete, and Edit or Delete on someone else's comment show only to those who may use them.
  - The comment visibility choices and the share dialog's groups offer only what R4 and R5 allow.
  - The Reporter field is editable for project admins.
  - The Watchers field lets project admins add and remove people.
  - The assignee picker offers only assignable people.

## Permissions

| Action | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|
| Manage sprints (in every covered project) | – | – (was ✓) | ✓ | ✓ |
| Delete own attachments | – | ✓ | ✓ | ✓ |
| Delete others' attachments | – | – (was ✓) | ✓ | ✓ |
| Edit or delete own comment | ✓ | ✓ | ✓ | ✓ |
| Edit or delete others' comments | – | – | ✓ (new) | ✓ |
| Change the reporter | – | – | ✓ (new) | ✓ |
| Add or remove other watchers | – | – | ✓ (new) | ✓ |
| Be assigned work | – (was ✓) | ✓ | ✓ | ✓ |

## Data model and migration

None. Existing comments, views and assignments keep what they have (R5, R7).

## API

- **Sprint routes, `DELETE /attachments/:id`, `PATCH/DELETE /comments/:id`:** the rules above, through the permission table.
- **Comments:**
  - `POST /issues/:key/comments` checks visibility (R4).
  - A comment edited or deleted by someone other than its author is audited (`comment.moderated`).
- **Views:** `POST /views` and `PATCH /views/:id` check sharing (R5).
- **Reporter:** `PATCH /issues/:key` accepts `reporterId` from project admins only (R6).
- **Watchers:** new `PUT /issues/:key/watchers/:userId` and `DELETE /issues/:key/watchers/:userId` (R8). They return 204, and 403 without Manage watchers.
- **Assignees:** `canJoinWork` and the people pickers use Assignable user (R7).

## Screens

Listed in R9. Jira equivalents: the comment's Edit/Delete for admins, the Reporter field, Manage Watchers, and the visibility lock on a comment.

## System settings

None.

## Scale

Checks are a table lookup plus one membership query each. Nothing pages differently.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a member of every covered project is refused sprint actions; a project admin of each succeeds. Permission table test updated |
| R2 | Server test: a member deletes their own attachment and is refused another's; an admin deletes any |
| R3 | Server test: an admin edits and deletes a member's comment, audited; a member is refused another's comment |
| R4 | Server test: a member can't limit a comment to admins or to a group they're not in; can limit to members and to their group |
| R5 | Server test: sharing a view with a group the owner isn't in is refused; an existing entry stays on a later save; a global admin may |
| R6 | Server test: an admin changes the reporter (history records it); a member is refused |
| R7 | Server test: assigning a viewer is refused; an item already assigned to one keeps it |
| R8 | Server test: an admin adds and removes another watcher; a member is refused; someone who can't see the project can't be added |
| R9 | Browser journey: a member sees no Delete on another's attachment, no Edit on another's comment, and no admins-only visibility; an admin edits another's comment and changes the reporter |

## Strand branch

Same rules. Set issue security stays with members (0201).

## Out of scope and deliberate divergences

- **Viewers comment** (Strand's read-and-comment role), as before.
- **Jira's narrower sprint permissions** (Start/Complete sprints, Edit sprints) are granted to nobody by default in Jira, so they aren't added.

## Open questions

None.

## Changelog

- 9 Nov 2026, while building (within the approved rules): an admin's edit or delete of someone else's comment is also allowed in the browser's copy, so it reaches the server.
- 9 Nov 2026: specs 0203–0207 merged into this one at the product owner's request.
