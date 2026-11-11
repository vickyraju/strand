# 0801 Jira inventory tool, run by the product owner

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: IN-03

## Context and Jira reference

- **Why:** before moving from Jira Data Center, the product owner needs to know what their Jira holds and what of it Strand takes as it is. The product owner never shares their Jira data; they run the tool themselves.
- **Jira DC's REST** (`/rest/api/2`, `/rest/agile/1.0`, the app manager's `/rest/plugins/1.0`) answers every count needed, read-only, with a personal access token (Jira 8.14 and later) or a user and password.
- **Strand today:** a CSV importer (spec 0101); no way to see a Jira's size or gaps.

## Community and Atlassian backlog

Not applicable: this is Strand's own tool for leaving Jira. Atlassian's equivalent (the Jira Cloud Migration Assistant's assessment) only targets Jira Cloud.

## Rules

- **R1: What it reads.** The Jira's version; every project (archived too) with its work items, versions and components; work items in total; issue types, statuses, priorities, resolutions and link types; custom fields with their types; workflows; permission, notification and issue security schemes; people (active and not) and groups; boards (scrum and kanban); installed apps. Only GET requests, with paging; a part the token can't read is reported and the rest carries on.
- **R2: What maps.** Each custom field type is matched to Strand's (spec 0502), or to Strand's own field for Jira Software's and Xray's (Sprint, Epic Link, Rank, Story points, Epic Status, test steps…). Apps whose work Strand does itself (Xray, Jira Software, development tools) are marked so.
- **R3: The report.** `jira-inventory.md` (totals, what needs a decision, projects by size, custom fields, apps, the lists) and `jira-inventory.json` (everything counted), written where it runs. "What needs a decision": custom field types Strand lacks, Advanced Roadmaps' fields, service projects, other apps, and anything not read. The token is never written down and nothing is sent anywhere but the Jira.

## Permissions

Whatever the token may read in Jira; a Jira administrator's sees everything.

## Data model and migration

None: a script in `scripts/jira-inventory/`, no dependencies (Node's own `fetch`).

## API

None. Run: `JIRA_URL=… JIRA_TOKEN=… node scripts/jira-inventory/inventory.mjs [--out dir]` (or `JIRA_USER`, `JIRA_PASSWORD`).

## Screens

None.

## Scale

Paged reads (people a thousand at a time, boards fifty); one search per project for its count. 6,000 projects take a few minutes.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Test against a made-up Jira: only GETs with the token; the counts; the mapping; a part refused (403) reported, the rest read; the report's tables; the token appears in neither file |

## Strand branch

Same tool.

## Out of scope and deliberate divergences

- **Attachments' total size** and **filters**: Jira DC's REST has no cheap way to list them all; the importer (spec 0802) counts them as it goes.

## Open questions

None.

## Changelog
