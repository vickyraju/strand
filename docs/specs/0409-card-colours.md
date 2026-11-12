# 0409 Card colours on a board

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira DC:** [Customizing cards](https://confluence.atlassian.com/jirasoftwareserver100/customizing-cards-1442843361.html), checked 9 Nov 2026.
  - **Where:** each board (not globally), in Board › Configure › Card colors. Jira admins and board admins set it.
  - **"Colors based on"** one of:
    - **Issue types:** one colour per type;
    - **Priorities:** one per priority, by default the priorities' own colours;
    - **Assignees:** one per assignee;
    - **Queries:** one per JQL query; each card takes the first query it matches, and grey when it matches none; the queries can be reordered.
  - Switching method keeps the old method's settings.
  - The colour shows as a stripe on the card's left edge, on the board and in the backlog. This is Jira's look; the page doesn't describe it.
- **Before this spec:** no card colours. A blocked card has a red stripe on its left edge.

## Rules

- **R1: The setting.** Board configuration › Card colours: "Colours based on" None (the default for every existing board), Work types, Priorities, Assignees or Queries. Board admins and project admins change it.
- **R2: Colours.**
  - **Work types:** each type's own colour by default; a board can override it per type.
  - **Priorities:** each priority's colour from Administration › Priorities by default; overridable per priority.
  - **Assignees:** a colour per person, chosen on the board. Unassigned cards, and people without one, show no colour.
  - **Queries:** up to 30 JQL queries, each with a colour, in order. A card takes the first query it matches, else grey. Each query is checked when saved (400 saying where).
  - Switching method keeps the colours of the others.
- **R3: How it shows.** A 4-pixel stripe on the left edge of the card on the board, and of the row in the backlog. A blocked card's red stripe and a flagged card's yellow (0408) still show, and take precedence.

## Permissions

Board admins and project admins, as for the board's other settings.

## Data model and migration

- `boards.card_colors jsonb not null default '{"by": "none"}'`, shaped `{ by, types?: {key: colour}, priorities?: {key: colour}, assignees?: {userId: colour}, queries?: [{ id, jql, color }] }`.

## API

- `PATCH /boards/:id` accepts `cardColors`, and `GET /boards/:id` returns it.
- The board's items (`GET /boards/:id/items`) gain `color` for the query method: the id of the first matching query, or empty.

## Screens

Board configuration › Card colours, and the stripe (R3). Jira equivalent: Board › Configure › Card colors.

## System settings

None.

## Scale

- **Queries:** one SQL `CASE` in the board's item page query, as swimlane queries already do.
- **Other methods:** decided in the browser from the item.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: a board admin sets Queries with two queries; a bad query is a 400; the items carry the first matching query; switching to Priorities keeps the queries |
| R3 | Web unit test: the colour for each method (type default and override, priority, assignee, none); browser journey: a board set to Priorities shows the stripe |

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
