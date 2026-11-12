# 0024 Link types and issue links

Status: Implemented

## Context and Jira reference

A link joins two work items and reads differently from each side: PAY-1 "blocks" PAY-2, and PAY-2 "is blocked by" PAY-1. Link types are the workspace's list of such pairs of words. Remote (web) links are spec 0507.

- **Jira DC:** Administration › Issues › Issue linking lists the link types (Blocks, Cloners, Duplicate, Relates to start with). Administrators add, rename and delete them; deleting one in use asks whether to move its links to another type or remove them. The app follows Jira, with test management's Defect and Test types added. Blocks, Cloners, Defect and Test can't be deleted: the app relies on them.

## Rules

- **R1: The types to start with.** Every workspace starts with these, in this order:

  | Id | Outward | Inward |
  |---|---|---|
  | blocks | blocks | is blocked by |
  | clones | clones | is cloned by |
  | duplicates | duplicates | is duplicated by |
  | relates | relates to | relates to |
  | defect | has defect | is a defect of |
  | tests | tests | is tested by |

  Blocks, Cloners, Defect and Test are built in.
- **R2: Reading them.**
  - Everyone reads the list (`GET /link-types`).
  - With `uses=1`, system administrators also get how many links each type has. Anyone else asking for that is refused (403); without it, the counts are empty.
- **R3: Adding one.**
  - Administrators add a type with a name, an outward and an inward wording (1 to 60 characters each). Its id is made from its name ("Causes" → `causes`).
  - A name already used, in any case, is refused: 409 "A link type with that name already exists".
  - Others are refused (403).
- **R4: Renaming one.** Administrators change a type's name or wording. Its id stays, so its links keep their type.
- **R5: Linking two items.**
  - `POST /issues/:key/links` `{ type, targetKey }` links this item to the target with that type's outward words (204).
  - A type the workspace doesn't have is refused: 400 "No such link type". An item can't be linked to itself (400).
  - The same link made again changes nothing.
- **R6: Removing a type.**
  - **Built in:** a built-in type is refused: 409 "Blocks is built in: the app relies on it".
  - **In use:** a type with links needs a choice, or is refused: 409 "2 links use Causes: choose a type to move them to, or remove them".
    - `moveTo=<id>` gives its links the other type. Two items already linked by that type keep one link.
    - `removeLinks=1` deletes its links.
- **R7: Recorded.** Adding, changing and removing a type are in the audit log (`link_type.created`, `link_type.updated`, `link_type.deleted`).
- **R8: Links on an item.** An item's links (`expand=links`) show both ways: each with its type, `out` or `in`, and the other item's key and title. Links to deleted items, or items in projects I can't see, are left out.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Read link types | yes | yes | yes | yes | yes |
| Link counts (`uses=1`) | no | no | no | no | system administrators |
| Add, change, remove a type | no | no | no | no | Administer Jira (spec 0717) |
| Link items | 404 | no | yes (Link issues, on the source; Browse on the target) | yes | yes |

## Data model

- `link_types` (`server/migrations/20261102090000_link_types.sql`): `workspace_id`, `id` (a short key), `name`, `outward`, `inward`, `builtin`, `position`. Defect and Test are added by `20261113090000_test_runs.sql` and `20261114090000_test_coverage.sql`.
- `issue_links` (`20261011202354_core_schema.sql`): `issue_id`, `target_id`, `type`; one row per pair and type.

## API

- `GET /link-types?uses=1`.
- `POST /admin/link-types` `{ name, outward, inward }` (201); `PATCH /admin/link-types/:id`; `DELETE /admin/link-types/:id?moveTo=&removeLinks=1`.
- `POST /issues/:key/links` `{ type, targetKey }`; `DELETE /issues/:key/links?type=&target=`.
- Errors: 400 (unknown type, self-link, no other type to move to), 403, 404, 409 (name taken, built in, in use).

## Screens

- **Administration › Link types:** the list with each type's links, Add, Edit and Delete (with the move or remove choice).
- The item detail's Links section: add a link by type and key; each link reads in the item's own direction.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: the six types, in order, with their wordings |
| R2 | Server test: counts for a system administrator; empty for a member, who is refused `uses=1` |
| R3 | Server test: Causes added as `causes`; the name again refused; a member refused |
| R4 | Server test: a new inward wording, links keep their type |
| R5 | Server test: links made with a new and a built-in type; an unknown type refused |
| R6 | Server test: in use refused; moved, merging with a link already there; built-in refused; removed with its links |
| R7 | Server test: the audit log has the four entries |
| R8 | Server test: the links read `in` from the target. Server test (clone): the copy's links read `out` |

## Out of scope and deliberate divergences

- **Built-in types** can't be deleted, where Jira lets an administrator delete any.
