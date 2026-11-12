# 0302 One rank order for all work items

Status: Implemented (approved 9 Nov 2026)

## Context and Jira reference

- **Jira:** Rank is one global field: every issue in the system has a place in a single order, kept by LexoRank.
  - A board or backlog that spans projects shows them in that order. Ranking an issue on one board moves it on every board that shows it.
  - When the rank values grow too long, a background job rebalances them, and ranking keeps working meanwhile.
  - Sources, checked 9 Nov 2026: [Managing LexoRank](https://confluence.atlassian.com/adminjiraserver/managing-lexorank-938847803.html) and [Troubleshooting LexoRank](https://confluence.atlassian.com/jirakb/troubleshooting-new-ranking-system-issues-779159221.html). There is one rank table per Rank field, with a minimum and a maximum marker row.
  - New issues go to the bottom. This is inferred from the maximum marker row; Atlassian's pages don't state it outright.
- **Before this spec:**
  - Ranks are fractions. A new item gets its own project's highest rank + 1000.
  - When ranks get too close, the whole project is renumbered (`keepRanksApart` in `server/src/routes/issues.ts`). Renumbering one project shuffles its items against other projects' items on a board that spans both.
  - The web app sends its own guess at a new item's rank: the project's highest + 1.

## Rules

- **R1: One order.** All work items in a workspace share one rank order. A board, backlog or JQL `ORDER BY rank` across projects shows them in it. A move made on one board shows on every board with both items.
- **R2: New items go last.** A new item is ranked after every item in the workspace, whether it is created, cloned or imported from CSV. The server decides; the web app no longer sends a rank when creating.
- **R3: Imports keep their order, at the end.** A project imported from an app file keeps its items' order, placed after the workspace's existing items.
- **R4: Only neighbours are respread.**
  - When a move leaves ranks too close to tell apart, only the items around it are spread out again: 50 on each side in the workspace order, and more if those are also too close.
  - Everything else keeps its rank, so the order across projects never changes.
  - Open boards in the affected projects reload, as today.
  - This differs from Jira's whole-system rebalancing job: same result, bounded work, no job needed.
- **R5: Existing ranks.** The migration renumbers each workspace once, keeping the current order of ranks with ties broken by id. Items that tie today, from different projects, then have distinct ranks.

## Permissions

Unchanged: ranking needs Edit issues in the item's project. Ranking an item moves it only relative to others; no other item is edited, apart from respreading (R4).

## Data model and migration

- An index on `issues (workspace_id, rank, id) where deleted_at is null`, for R2, R4 and boards spanning projects.
- R5's renumbering is one statement (`row_number() over (partition by workspace_id order by rank, id) * 1024`). The app has no production data yet; the importer (0802) writes ranks in Jira's order directly.

## API

- `POST /projects/:key/issues`: a `rank` sent with a create is ignored (R2). The response gives the server's rank, as today.
- `PATCH /issues/:key` with `rank`: unchanged; R4 replaces the per-project renumbering.

## Screens

None change. Boards spanning projects show a stable order.

## System settings

None.

## Scale

- **R2:** reads the workspace's highest rank through the new index, one row.
- **R4:** touches about 100 rows, or a few hundred in the rare case that the wider window is needed. It never touches the whole workspace.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R4 | Server test: in two projects with interleaved items, forcing ranks too close respreads only the neighbours, and the order across both projects is unchanged |
| R2 | Server test: an item created in project A after items in project B ranks after them, even when the request sends a lower rank |
| R3 | Server test: an imported project's items keep their order and come after the existing ones |
| R5 | Migration test: two workspaces with tied ranks are renumbered in order, ties broken by id |

## Out of scope and deliberate divergences

- **LexoRank's string format and background rebalancing:** The app keeps fractional numbers with local respreading (R4). The order, which is what people see, is the same.
- **Several Rank fields** (Jira allows more than one): out of scope.

## Open questions

None.

## Changelog
