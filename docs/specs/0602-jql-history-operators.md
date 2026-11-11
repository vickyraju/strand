# 0602 JQL history operators

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: SR-01

## Context and Jira reference

- **Jira DC** ([advanced searching: operators](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-operators-reference-939938745.html), checked 11 Nov 2026):
  - **WAS**, **WAS IN**, **WAS NOT**, **WAS NOT IN** find issues that have, or once had, a value (WAS NOT: never had it). WAS IN is WAS joined with OR; WAS NOT IN is WAS NOT joined with AND.
  - **CHANGED** finds issues whose field was changed.
  - All five work on **Assignee, Fix Version, Priority, Reporter, Resolution and Status**.
  - Predicates: `AFTER "date"`, `BEFORE "date"`, `BY "user"`, `DURING ("date1", "date2")`, `ON "date"`; CHANGED also takes `FROM "old"` and `TO "new"`. Dates take functions (`startOfDay()`, `-7d`…); BY takes `currentUser()`.
  - A value matches the name it had when the field was changed, or its id ("4" as well as "Resolved").
  - WAS IN and WAS NOT IN take at most 3,000 values.
- **Strand today:** none; spec 0601 now records every change with its names and indexes the six fields.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22WAS%20operator%22%20OR%20summary%20~%20%22CHANGED%20operator%22%20OR%20summary%20~%20%22change%20history%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | Strand |
|---|---|---|
| [JRASERVER-62522](https://jira.atlassian.com/browse/JRASERVER-62522) WAS doesn't find a renamed user | Bug | **Built:** people match by who they are (id, email or today's name) as well as the name kept in the history (R2) |
| [JRASERVER-42219](https://jira.atlassian.com/browse/JRASERVER-42219), [JRASERVER-65843](https://jira.atlassian.com/browse/JRASERVER-65843) WAS on assignee fails for inactive people | Bugs | **Built:** deactivated people match like anyone else (R2) |
| [JRASERVER-65345](https://jira.atlassian.com/browse/JRASERVER-65345) NOT with WAS IN broke board filters | Bug | **Built:** NOT works over every history clause (R1) |
| [JRASERVER-27641](https://jira.atlassian.com/browse/JRASERVER-27641), [JRASERVER-34103](https://jira.atlassian.com/browse/JRASERVER-34103) WAS and CHANGED for custom fields | Suggestions | **Proposal P1** |
| [JRASERVER-63292](https://jira.atlassian.com/browse/JRASERVER-63292) CHANGED on other fields | Suggestion | **Proposal P1** |
| [JRASERVER-12825](https://jira.atlassian.com/browse/JRASERVER-12825) Reporting on status history | Suggestion | Built before: Control chart and time in status (spec 0411) |

**Proposals for the product owner** (not built until chosen):

- **P1: History search on more fields:** Sprint, Labels, Components, Type, Parent and single-choice custom fields (spec 0601 records them already).

## Rules

- **R1: The operators.** `field WAS value`, `WAS IN (…)`, `WAS NOT value`, `WAS NOT IN (…)` and `field CHANGED`, on `assignee`, `fixVersion`, `priority`, `reporter`, `resolution` and `status` (and their other JQL names). Other fields: a 400 naming the six. They combine with AND, OR, NOT and parentheses like any clause. At most 3,000 values (as Jira's).
- **R2: What a value matches.** The name it had when it was set (spec 0601), or its id or key; a person also by email, today's name or `currentUser()`, and `membersOf("group")`; `EMPTY` (or `null`) for no value. WAS covers the value an item was created with and the one it has now.
- **R3: Predicates.** After WAS…: `AFTER d` (held at some moment after d), `BEFORE d` (held before d), `ON d` (held during that day), `DURING (d1, d2)` (held at some moment in between), `BY person` or `BY (p1, p2)` (set by them; the value an item was created with counts as set by its reporter). After CHANGED: the same, applied to the change, plus `FROM v` and `TO v` (from and to, in the same change). Dates are JQL dates: `2026-10-01`, `-7d`, `now()`, `startOfDay()`, `endOfDay()`, `startOfWeek()`.
- **R4: Fix versions.** An item WAS in a version while the version was among its fix versions; `fixVersion WAS EMPTY` while it had none; `CHANGED FROM "1.0" TO "2.0"` when one change took 1.0 off and put 2.0 on.
- **R5: Searches stay fast.** A clause without predicates reads the indexes of spec 0601; with predicates it reads only the history of items the rest of the query keeps.

## Permissions

Unchanged: search finds what the searcher can browse.

## Data model and migration

None (spec 0601).

## API

JQL wherever JQL is accepted (search, filters, boards, exports, the JQL check).

## Screens

None new; the JQL editor's suggestions offer WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED after the six fields.

## Scale

Without predicates, an index lookup per value; with predicates, per-item history (at most an item's own changes to one field).

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: WAS, WAS IN, WAS NOT, WAS NOT IN, CHANGED on status, assignee and priority; by the old name after a rename, by id; other fields refused; NOT |
| R3 | Server test: AFTER, BEFORE, ON, DURING, BY (and currentUser()), FROM and TO |
| R4 | Server test: fix version WAS, WAS EMPTY, CHANGED FROM … TO … |
| R1 | Unit test: the parser reads every form; errors point at the mistake |
| R1 | Browser journey: search `status WAS "In Progress"` finds an item that has moved on |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
