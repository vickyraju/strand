# 0303 The hierarchy is kept by the server: epic > item > sub-item

Status: Ported (aws-jira `e20b20f`, strand `dd53515`), approved by the PO on 9 Nov 2026; awaiting verification
Parity rows: ISS-02

## Context and Jira reference

- **Jira DC** has three levels:
  - **Epics** hold issues through the Epic Link. An epic can hold issues from other projects: the field offers any epic the person can see.
  - **Standard issues** (story, task, bug).
  - **Sub-tasks:** each is in its parent's project, under a standard issue. A sub-task has no sub-tasks and is never directly under an epic. Moving a parent moves its sub-tasks with it.
  - An epic has no Epic Link of its own.
  - Sources, checked 9 Nov 2026: Atlassian Community threads ([sub-tasks across projects](https://community.atlassian.com/forums/Jira-questions/Can-you-create-task-and-subtasks-across-multiple-projects/qaq-p/807478), [epics with children in other projects](https://community.atlassian.com/forums/Jira-questions/epics-with-children-in-different-projects/qaq-p/2103654)), plus Jira DC's behaviour as Strand has implemented it so far. They are Community answers, not DC documentation pages, and are marked as such.
- **Strand today:**
  - Only the web app keeps these levels: its parent picker offers this project's epics, and items that have no parent and no children.
  - The server checks only that an item isn't its own parent. An API call can make cycles, sub-items of sub-items, a parent in a project the person can't see, or an epic under an item.

## Rules

An item's level follows from its type and parent: an **epic**; an **item** (not an epic, with no parent or an epic parent); a **sub-item** (its parent is an item).

- **R1: Parents by level.** The server refuses each of these with 400 and a message saying why:
  - **Epics:** an epic has no parent.
  - **Items:** an item's parent is an epic.
  - **Sub-items:** a sub-item's parent is an item, not a sub-item.
  - **Children:** an item that has sub-items can't itself become a sub-item.
  - **Cycles:** no item can be its own ancestor.
- **R2: Same project for sub-items.** A sub-item is in its parent's project. An item's epic may be in another project, as in Jira.
- **R3: A parent you can see.** The parent must be an item the person can see: not deleted, in a project they can see, and (on strand) within their security level. Otherwise the server answers 400 "No such parent", without saying whether it exists.
- **R4: Type changes keep the levels.**
  - An item with a parent can't become an epic.
  - An epic with items can't become another type until its items are moved.
  - An item with sub-items can't become an epic.
- **R5: Existing data.** The migration finds rows that break R1 or R2 and detaches them, with an entry in each item's history: "Parent removed: it broke the work item hierarchy". It never deletes an item. The count is in the migration's output.
- **R6: Screens follow.** The parent picker already offers only allowed parents. When the server refuses a change, the field shows its message.

## Permissions

Unchanged: Edit issues in the item's project. Setting an epic from another project needs only Browse in that project, as in Jira.

## Data model and migration

- No new columns. The R5 fix-up is one statement per rule, recording history. Strand has no production data yet; the importer (0802) writes valid hierarchies.
- `strand` gets the same migration in `supabase/migrations`.

## API

`POST /projects/:key/issues`, `PATCH /issues/:key`, bulk update and clone apply R1–R4. CSV import has no parent column.

## Screens

None new (R6).

## System settings

None. Jira's hierarchy is fixed in DC without Advanced Roadmaps. Levels above epic are 0803.

## Scale

Each check reads the parent row and, for a sub-item, whether the item has children: a few primary-key lookups.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: epic under anything, item under a sub-item, sub-sub-item, an item with children made a sub-item, and a cycle are each refused |
| R2 | Server test: a sub-item in another project is refused; an epic from another project is allowed |
| R3 | Server test: a parent in a project the person can't see, or a deleted parent, gives 400 "No such parent" |
| R4 | Server test: type changes that would break levels are refused |
| R5 | Migration test: a sub-sub-item and an epic with a parent are detached with history; valid rows are untouched |
| R6 | Existing journeys of the parent picker stay green |

## Strand branch

Same rules. R3 includes security levels.

## Out of scope and deliberate divergences

- **Sprints:** sub-items following their parent's sprint is left for the agile phase (0401).
- **Levels above epic** (Advanced Roadmaps): 0803.

## Open questions

None.

## Changelog

- 9 Nov 2026, while building (within the approved rules):
  - **R6:** the parent picker didn't offer items that sit under an epic. It now offers them to an item without sub-items. The Type picker no longer offers Epic to an item with sub-items, nor other types to an epic with items.
  - **API:** the JSON project import (Strand's own browser-workspace file) is left unchecked, because the screens that wrote it kept the levels. R5's fix-up covers anything older.
