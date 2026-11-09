# 0408 Flagging a work item

Status: Approved (PO, 9 Nov 2026: "proceed")
Parity rows: ISS-21

## Context and Jira reference

- **Jira DC:** [Flagging an issue](https://confluence.atlassian.com/jirasoftwareserver/flagging-an-issue-938845533.html), checked 9 Nov 2026.
  - **Where:** in the Scrum backlog, active sprints, the Kanban board or its backlog. Use the issue's cog menu or right-click: "Add flag" or "Remove flag", or "Add flag and comment" / "Remove flag and add comment".
  - **How it looks:** a flagged card turns yellow, and a flag icon replaces the priority icon.
  - **Storage:** the "Flagged" checkbox field, whose one value is Impediment. JQL: `Flagged = Impediment`.
- **Strand today:** no flagging.

## Rules

- **R1: Flag and unflag.** Anyone who may edit the item (Edit issues) can, from three places:
  - the item's menu, on its page and on board cards: "Add flag" or "Remove flag";
  - "Add flag and comment" / "Remove flag and add comment", which asks for a comment and adds it with the change.

  The change is in the item's history.
- **R2: How it looks.** A flagged item's card on boards, and its row in the backlog, are yellow, and show a flag in place of the priority icon. The item's page shows "Flagged" next to its status.
- **R3: Search.** JQL `flagged = Impediment` (and `flagged is EMPTY` / `is not EMPTY`) finds flagged items, as in Jira.
- **R4: Import.** The JSON and CSV imports carry the flag: in CSV, a "Flagged" column whose value is "Impediment".

## Permissions

Edit issues in the item's project.

## Data model and migration

- `issues.flagged boolean not null default false`.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `PATCH /issues/:key` accepts `flagged`, and responses return it.
- Bulk edit accepts it too.

## Screens

R1, R2. Jira equivalent: Add flag / Remove flag.

## System settings

None.

## Scale

A boolean column. JQL on it is a filter on the item row.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a member flags and unflags with history; a viewer can't |
| R3 | Server test: `flagged = Impediment`, `is EMPTY` |
| R4 | Server test: CSV import with a Flagged column |
| R1, R2 | Browser journey: Add flag from a card's menu; the card turns yellow and shows the flag |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog

- 9 Nov 2026, while building (within the approved rules): the browser-only CSV import (a workspace kept in this browser) doesn't read the Flagged column. The server's import does (R4).
