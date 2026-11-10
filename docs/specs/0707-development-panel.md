# 0707 Development panel

Status: Approved (PO, 10 Nov 2026: "move ahead with phase 7 … don't wait for my approval")
Parity rows: IN-02

## Context and Jira reference

- **Jira Software DC** (Development panel and [development fields in JQL](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-development-fields-reference-973491363.html), checked 10 Nov 2026).
  - **Connecting:** Administration › Applications › **DVCS accounts** connects GitHub, GitLab or Bitbucket accounts. Each account lists its repositories; linking can be turned off per repository. Jira reads the history once (a full synchronisation), then follows webhooks.
  - **The panel:** an item that a commit, branch or pull request names by its key shows a **Development** panel in its right column. It has one line per kind: "N branches", "N commits" (with when the latest was), "N pull requests" with one status lozenge (OPEN, else MERGED, else DECLINED), builds and deployments. Each line opens a dialog listing them by repository.
  - **Who sees it:** the **View Development Tools** permission. Jira's default permission scheme gives it to any logged-in user with access to the project.
  - **JQL:** `development[commits].all`, `development[branches].all`, `development[pullrequests].all|open|merged|declined` (numbers: `=`, `!=`, `>`, `>=`, `<`, `<=`), `development[pullrequests].status` (`open`, `merged`, `declined`; `=`, `!=`, `in`, `not in`), and `development[builds]…`, `development[deployments]…`, `development[reviews]…` from Bamboo and Crucible.
  - **Workflow triggers** (a transition fired by a branch, commit or pull request) are a separate feature (WF-06).
- **Strand today:** a signed GitHub receiver (`/integrations/github/webhook`) stores branches, commits and pull requests, links them to items by key (closing words, `skip KEY-1`), and serves `GET /issues/:key/development`. No screen shows it. An account has no way to be connected: the `integrations` row has to be written by hand, and deliveries from an unknown installation are dropped.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JSWSERVER%20AND%20(summary%20~%20%22development%20panel%22%20OR%20summary%20~%20%22DVCS%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JSWSERVER-15768](https://jira.atlassian.com/browse/JSWSERVER-15768) REST API for the Development panel's information | 194 | Gathering interest | **Built:** `GET /issues/:key/development` is part of the documented API (R6) |
| [JSWSERVER-14934](https://jira.atlassian.com/browse/JSWSERVER-14934), [JSWSERVER-14385](https://jira.atlassian.com/browse/JSWSERVER-14385) Show which branch a commit is on | 95 | Gathering interest | **Built:** the commits dialog shows each commit's branch (R3) |
| [JSWSERVER-21861](https://jira.atlassian.com/browse/JSWSERVER-21861) Pull requests grouped by status, with counts | 4 | Gathering interest | **Built:** the pull request line shows a count per status (R2) |
| [JSWSERVER-20977](https://jira.atlassian.com/browse/JSWSERVER-20977), [JSWSERVER-14026](https://jira.atlassian.com/browse/JSWSERVER-14026) The panel times out under load | | Bugs | **Built:** the panel reads Strand's own tables (indexed by item); nothing calls GitHub while the page loads |
| [JSWSERVER-21024](https://jira.atlassian.com/browse/JSWSERVER-21024), [JSWSERVER-21359](https://jira.atlassian.com/browse/JSWSERVER-21359) Synchronisation gets stuck on large organisations | | Bugs | **Built already:** GitHub pushes each change; no polling |
| [JSWSERVER-20117](https://jira.atlassian.com/browse/JSWSERVER-20117), [JSWSERVER-26265](https://jira.atlassian.com/browse/JSWSERVER-26265) Deleted branches still shown | | Bug, suggestion | **Built already:** a deleted branch is hidden |
| [JSWSERVER-20814](https://jira.atlassian.com/browse/JSWSERVER-20814) Use GitHub Apps instead of a person's OAuth | | Gathering interest | **Built already:** Strand receives a GitHub App's webhooks |
| [JSWSERVER-14577](https://jira.atlassian.com/browse/JSWSERVER-14577) Conditions on development triggers | 56 | Gathering interest | **Proposal P2** (with the triggers) |
| [JSWSERVER-14936](https://jira.atlassian.com/browse/JSWSERVER-14936) GitHub checks and whether a PR can merge | 3 | Won't fix | **Proposal P3** |
| Jira reads the history when an account is connected | | | **Proposal P1** |

**Proposals for the product owner** (not built until chosen):

- **P1: Read the history** when an account is connected (a background job over GitHub's API, with the App's private key), so items show work done before Strand was connected.
- **P2: Workflow triggers** (WF-06): a transition fires when a branch is created, a pull request is opened or merged; with conditions on the target branch (JSWSERVER-14577).
- **P3: GitHub checks** on pull requests and commits, shown as builds in the panel and searchable with `development[builds]…`.

## Rules

- **R1: Connecting GitHub.** Administration › **Development tools** (system admins, signed in themselves):
  - shows the address GitHub sends to and whether the server has its secret (`GITHUB_WEBHOOK_SECRET`);
  - lists GitHub accounts. A signed delivery from an installation Strand doesn't know adds it as **waiting**: nothing it sends is kept until an admin **connects** it. This stops anyone who installs a public GitHub App from adding their work to Strand's items;
  - an account can be **connected**, **paused** (its deliveries are acknowledged and dropped; what it sent stays) and **removed** (it and everything it sent goes, after a confirmation);
  - each repository can be limited to some projects (a key from another project isn't linked) or left open to all;
  - shows the last 50 deliveries with their event, status and error.

  Every change is audited.
- **R2: The panel.** An item's right column shows **Development** to anyone who can see the item (Jira's View Development Tools). It always offers the branch name (R4); when anything is linked to the item, it also shows:
  - "N branches", "N commits · latest 2 days ago", and "N pull requests" with a count per status (open, merged, declined);
  - each line opens its dialog.
- **R3: The dialogs** list by repository, newest first, each with a link to GitHub:
  - branches: the name, the pull requests from it;
  - commits: the short id, the first line of the message, the author, the branch, when;
  - pull requests: the title, the author, the status, the review state (approved, changes requested), from and to branches, when it last changed.
- **R4: Copy branch name.** The panel offers the branch name for the item (`pay-12-fix-login-redirect`) and its `git checkout -b` command, so the branch links itself.
- **R5: JQL**, as Jira's:
  - `development[commits].all`, `development[branches].all`, `development[pullrequests].all`, `.open`, `.merged`, `.declined` are numbers;
  - `development[pullrequests].status` is `open`, `merged` or `declined`;
  - `development[builds]…`, `development[deployments]…` and `development[reviews]…` are accepted, so saved filters from Jira run, and match as though no build, deployment or review exists (Strand has no build tool yet; P3).
- **R6: The API.** `GET /issues/:key/development` returns the branches, commits and pull requests (as today), with each commit's branch.

## Permissions

- The panel and `GET /issues/:key/development`: anyone who can see the item (the permission table gains **View development tools**: viewer).
- Development tools administration: system admins, signed in themselves (not with a token).

## Data model and migration

- `integrations.status` gains `pending` (waiting for an admin).
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET /admin/development` (receiver address, secret set, accounts with repositories, last 50 deliveries).
- `PUT /admin/development/accounts/:id` `{ status }` (`active` or `suspended`; connecting is `active`).
- `DELETE /admin/development/accounts/:id`.
- `PUT /admin/development/repositories/:id` `{ projectKeys }` (keys, not a picker: there can be thousands of projects).

## Screens

- Administration › Development tools.
- The item's Development panel and its three dialogs.

## System settings

None. The secret is a server setting (`GITHUB_WEBHOOK_SECRET`).

## Scale

- The panel's numbers are one query over `dev_links` (keyed by item).
- JQL's `development[…]` conditions are `exists`/`count` subqueries over the same index.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: an unknown installation waits and its deliveries aren't kept; connect, pause, remove; project limits; audit; non-admins refused |
| R2, R3, R6 | Server test: the development answer's counts and branches. Browser journey: an item with a pull request, a branch and a commit shows the panel and its dialogs |
| R4 | Server test (`links.test.ts`): the branch name. Browser journey: the panel shows it |
| R5 | Server test: each development field and operator; builds and deployments match nothing |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **GitLab and Bitbucket:** GitHub only, for now.
- **Reading the history** (P1), **triggers** (P2), **builds and deployments** (P3).

## Open questions

None.

## Changelog

- 10 Nov 2026, while building: repositories are limited by project key (a picker over thousands of projects doesn't scale); the panel is always there, for the branch name.
