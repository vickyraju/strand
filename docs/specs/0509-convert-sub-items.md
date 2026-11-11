# 0509 Convert to and from sub-items

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: ISS-14

## Context and Jira reference

- **Jira DC** (an issue's More › **Convert to sub-task** and a sub-task's More › **Convert to issue**):
  - **To sub-task:** choose the parent (an issue of the same project, not itself a sub-task), the sub-task type, a new status if the type's workflow lacks the current one; then confirm. An issue with sub-tasks can't become one; an epic can't either.
  - **To issue:** choose the issue type and, if needed, the status; the sub-task leaves its parent.
  - Both go into the issue's history; the key, comments, attachments and work logs stay.
- **Strand today:** an item becomes a sub-item, or stops being one, by changing its Parent; the level rules (spec 0303) already refuse what Jira refuses. There's no Convert action.

## Community and Atlassian backlog

Spec 0501's research applies: [JRASERVER-15259](https://jira.atlassian.com/browse/JRASERVER-15259) (move a sub-task to a parent in another project, 105 votes) is that spec's proposal P2.

## Rules

- **R1: Convert to sub-item.** An item (not an epic, not a sub-item, without sub-items) has **Convert to sub-item…**: pick its parent among the project's items that aren't epics or sub-items, and optionally its work type; the status follows the workflow rules of a type change (spec 0303). Its epic goes, since its parent decides it.
- **R2: Convert to item.** A sub-item has **Convert to item**: it leaves its parent, keeping its type unless one is chosen.
- **R3: Records.** History says "Converted to a sub-item of KEY" or "Converted to an item"; the key, comments, attachments and work logs stay. The webhook is Jira's `jira:issue_updated` with a `Parent` changelog item.

## Permissions

Edit issues, as for changing the parent.

## Data model and migration

None.

## API

`POST /issues/:key/convert` `{ parentKey?: string | null, type? }` (a `parentKey`: to sub-item; null: to item).

## Screens

The item's menu: **Convert to sub-item…** (a parent picker) and **Convert to item**.

## Scale

Nothing new.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Server test: both ways; an epic, an item with sub-items, a parent in another project refused; history |
| R1 | Browser journey: convert an item to a sub-item and back |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Sub-task types:** Strand's work types serve both items and sub-items, so there's no separate sub-task type to choose.

## Open questions

None.

## Changelog
