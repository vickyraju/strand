# 0806 Jira's addresses open in Strand

Status: Approved (PO, 12 Nov 2026)
Parity rows: (importer, spec 0802)

## Context and Jira reference

- **Jira DC's addresses** are in bookmarks, emails, chat, Confluence pages, commit messages and runbooks:
  - an issue: `/browse/PAY-12`, also with `?focusedCommentId=…`;
  - a project: `/browse/PAY`, `/projects/PAY` and its pages (`/projects/PAY/issues`, `/projects/PAY/summary`);
  - a search: `/issues/?jql=…`, and the older `/secure/IssueNavigator.jspa?jqlQuery=…`;
  - a board: `/secure/RapidBoard.jspa?rapidView=5`, with `&projectKey=PAY` when Jira knew it;
  - the dashboard: `/secure/Dashboard.jspa`.
- **Strand today:** its own addresses are `/i/PAY-12`, `/project/PAY`, `/search`. Jira's addresses show "Page not found".
- An item moved to another project, or a project whose key changed, already keeps its old key working (specs 0501, 0703).

## Rules

- **R1: Jira's addresses open Strand's pages.** The address bar then shows Strand's own address:
  - `/browse/KEY-N` opens the item, and `/browse/KEY` the project.
  - `/projects/KEY`, and any page under it, opens the project.
  - `/issues/?jql=…` and `/secure/IssueNavigator.jspa?jqlQuery=…` open Search with that JQL. Without JQL they open Search.
  - `/secure/RapidBoard.jspa` opens the project's board when the address names its project, otherwise the project list.
  - `/secure/Dashboard.jspa` opens Your work.
- **R2: Old keys follow.** An item or project known by an older key opens as before (specs 0501, 0703).
- **R3: Search links.** Strand's own `/search?jql=…` opens Search with that JQL, so links can be shared.

## Permissions

As for the pages they open. An item or project the person can't see is "not found", as with Strand's own addresses.

## Data model and migration

None.

## API

None: the web app reads the address.

## Screens

None new.

## Scale

Nothing new.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R3 | Unit test: each Jira address and the Strand address it opens |
| R1, R2 | Browser journey: `/browse/KEY-N` opens the item and the address becomes `/i/KEY-N`; `/issues/?jql=` shows the search with its JQL |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Pointing the old Jira host name at Strand** is part of the cutover, outside the app.
- **Jira's board and filter ids** (`rapidView=5`, `filter=10200`) don't name anything in Strand until boards and filters are imported (later import work). Until then such links open the project, or Search.

## Proposals (not built until chosen)

None.

## Open questions

None.

## Changelog
