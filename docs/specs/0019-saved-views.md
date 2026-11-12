# 0019 Saved views and sharing

Status: Implemented

## Context and Jira reference

A saved view is a search kept under a name: its simple filters or its JQL. Its owner can share it with the whole workspace, or with projects, groups and people, each to view or to edit. Views outlive their owner: an administrator gives a departed owner's views to someone else.

- **Jira DC:** saved filters ([Saving your search as a filter](https://confluence.atlassian.com/jirasoftwareserver/saving-your-search-as-a-filter-939938748.html)) are shared with groups, projects (or project roles), users, or everyone, with view or edit rights. Administrators find shared filters and change their owner under [Managing shared filters](https://confluence.atlassian.com/adminjiraserver089/managing-shared-filters-1005347206.html). The app follows Jira; a project share covers everyone in the project, not one role.
- Extended by specs 0203 R5 (whom a view may be shared with), 0309 R3 (unique names; a new owner must see it), 0604 (subscriptions) and 0717 (Create shared objects).

## Rules

- **R1: A view.** A name and its filters (the simple filters, or `jql`), owned by whoever saved it.
- **R2: Who sees it.** Its owner; everyone in the workspace when it is shared with the workspace; and whoever is in a project, group or person list it is shared with (a project share: anyone who can see the project). Anyone else gets 404 ("View not found"), and the view isn't in their list.
- **R3: Who changes it.**
  - Each share is to `view` (the default) or to `edit`. The owner and those it is shared with to edit change its name and filters; others are refused (403 "Only its owner, or someone it is shared with to edit, can change this view").
  - Only the owner or a workspace admin changes whom it is shared with, or its owner (403 "Only its owner or a workspace admin changes who can see it"), and only they delete it. Someone with edit rights has no "Share…" in the view's menu.
- **R4: Shares must be real.** Each share names a project, group or person of the workspace, at most 50; an unknown one is a 400 ("No such user to share with").
- **R5: Giving a view a new owner.** A workspace admin gives a view to an active person of the workspace (400 "The new owner must be an active person in the workspace" otherwise). The change is audited as `view.owner_changed`. Deleting someone else's view is audited as `view.deleted`.
- **R6: Administration › Shared views.** Workspace admins list every view shared beyond its owner, and every view whose owner is deactivated: those whose owner left first, then by name, a page at a time (50 by default, at most 200), with the total. `ownerLeft=1` lists only those; `query` narrows by view or owner name.

## Permissions

| Action | Outsider to the view | Shared to view | Shared to edit | Owner | Workspace admin |
|---|---|---|---|---|---|
| See it | 404 | Yes | Yes | Yes | Yes, when it can see it |
| Change its name and filters | 404 | No | Yes | Yes | Yes, when it can see it |
| Change whom it is shared with, delete it | 404 | No | No | Yes | Yes, when it can see it |
| Give it a new owner | 404 | No | No | Yes | Yes, when it can see it |
| Administration › Shared views | | | | | Yes |

## Data model

- `saved_views` (`server/migrations/20261011205352_rest_of_schema.sql`): `owner_id`, `name`, `shared` (the whole workspace), `filters`.
- `saved_views.share` (`server/migrations/20261107090000_filter_sharing.sql`): `[{ kind: project | group | user, id, can: view | edit }]`. The owner can't be deleted while they own views; their views stay for a new owner.

## API

- `GET /views`: the views I can see, by name, each with `canEdit`.
- `POST /views` `{ name, filters, shared?, share? }`: 201; 400 for an unknown share.
- `PATCH /views/:id` `{ name?, filters?, shared?, share?, ownerId? }`: 403, 404 and 400 as above.
- `DELETE /views/:id`: 204; 403 for anyone but the owner or a workspace admin.
- `GET /admin/views?query=&ownerLeft=&cursor=&limit=`: `{ items, total, next }`.

## Screens

- **Search** (`/search?view=<id>`): the view's name as the title; "Save as view"; the view's menu with Rename and, for its owner, "Share…" (a project, a group or a person, and what they may do).
- **Administration › Shared views**, with "Change owner".

## Scale

Administration › Shared views pages on the server, keyed by owner status, name and id.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: views saved with their filters. Browser journey: a view saved and opened |
| R2 | Server test: each person sees the views shared with their project, group or themselves, and nobody else's; an outsider gets 404 |
| R3 | Server test: an editor renames the group's view, not one shared to view; an editor can't reshare or delete. Browser journey: a project member with edit rights renames the view and has no "Share…" |
| R4 | Server test: sharing with an unknown person refused |
| R5 | Server test: an admin gives a departed owner's view to someone active, not to someone inactive; audited |
| R6 | Server test: Administration lists views whose owner left |

## Out of scope and deliberate divergences

- **Project role shares:** a project share covers everyone in the project.
- **Whom a view may be shared with** (my groups and projects only): spec 0203 R5.
