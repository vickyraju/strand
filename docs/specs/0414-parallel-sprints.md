# 0414 Parallel sprints

Status: Approved (pending work, 12 Nov 2026)
Parity rows: AG-06

## Context and Jira reference

- **Jira DC** ([Using Parallel Sprints](https://confluence.atlassian.com/spaces/JIRASOFTWARESERVER/pages/938845513/Using+Parallel+Sprints)):
  - **Switch:** Administration › Applications › Jira Software configuration › **Parallel Sprints**. A Jira administrator turns it on, for every board at once. It's off by default.
  - **On:** a Scrum board can have more than one active sprint, for example two teams working from one backlog, each in its own sprint.
  - **Board:** the active sprints board has a sprint picker to show one sprint or all of them (product knowledge; the page doesn't describe it).
  - **Limitation Atlassian lists:** the Velocity Chart doesn't split velocity by team.
  - **Turning it off:** isn't described on the page. Jira refuses it while a board has more than one active sprint (product knowledge, on the verification list).
- **Strand today:**
  - One active sprint per board, enforced by the database.
  - The Jira importer keeps only one active sprint per board and closes the others (spec 0802).

## Community and Atlassian backlog

| Ticket | Kind | What people ask | Here |
|---|---|---|---|
| Community: "Parallel sprints" (Data Center discussions) | Question | Why it's all boards or none | P1 |

## Rules

- **R1: The switch.** System settings › **Sprints** › **Parallel sprints**, off by default. System administrators set it. It can't be turned off while a board has more than one active sprint; the refusal names the boards.
- **R2: Starting.** With it on, a sprint starts even when another sprint of its board is active. With it off, the start is refused, as before.
- **R3: Board and backlog.**
  - The backlog shows every active sprint, each with its own Complete sprint.
  - The active sprints board shows the work of all active sprints, with a **Sprint** picker to show one of them.
  - Complete sprint on the board completes the sprint picked. It's offered when one sprint is picked or only one is active.
- **R4: Elsewhere.**
  - Reopening a sprint follows the same rule as starting one.
  - `openSprints()` covers every active sprint.
  - Reports pick their sprint as before. The Velocity Chart totals per sprint; it doesn't split by team, as in Jira.
  - The Jira importer keeps every active sprint when the switch is on.

## Permissions

- The switch: system administrators.
- Starting and completing sprints: as before (spec 0101).

## Data model and migration

- The unique index on one active sprint per board goes. The server enforces R2 under a lock on the board.
- New setting `sprints` `{ parallel: boolean }` (public, so the backlog knows when Start is allowed).

## API

- `PUT /admin/settings/sprints` `{ parallel }`. Turning it off is a 409 while any board has more than one active sprint.
- `POST /projects/:key/sprints/:id/start` follows R2.

## Screens

- System settings › **Sprints**.
- The backlog's Start sprint stays enabled while another sprint is active when the switch is on.
- The active sprints board's **Sprint** picker.

## Scale

Nothing new.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R4 | Server test: off, a second start is refused; on, two sprints are active, the board shows both sprints' work and `openSprints()` finds both; turning it off is refused, then allowed after one completes; reopening follows the rule |
| R3 | Browser journey: start a second sprint from the backlog; the board's picker shows one sprint's work |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Velocity by team:** not split, as in Jira.

## Proposals (not built until chosen)

- **P1: Parallel sprints per board**: a board setting under the global switch. The Community asks why it's all boards or none.

## Open questions

None.

## Changelog
