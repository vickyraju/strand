# Strand as a Jira DC replacement: what's left (12 Nov 2026)

There are 65 specs: 63 are built and ported to both branches, 0101 is verified, and 0708 is a decision. This page lists everything still open, in the order it would get done.

## A. Feature work already queued (parity gaps)

| # | Spec | What | Parity row | State |
|---|---|---|---|---|
| 1 | 0609 | `~` text search as Jira's: stemming, indexing language, phrases, wildcards, AND/OR/NOT, fuzzy, a `comment` field, comments in `text ~` | SR-03 | Done (ported 12 Nov) |
| 2 | 0310 | Project templates beyond Scrum and Kanban: Basic and Business | PRJ-06 | Done (ported 12 Nov) |
| 3 | 0412 | Estimation by business value or a custom field; remaining-estimate burndown; team time zone | AG-07, AG-08 | Done (ported 12 Nov) |
| 4 | 0414 | Parallel sprints (Jira allows more than one active sprint) | AG-06 | Done (ported 12 Nov); B4 fixed with it |
| 5 | 0717 | Global permissions (Browse users, Create shared objects, Bulk change…) | PRM-10 | Done (ported 12 Nov) |
| 6 | 0718 | Workflow triggers from development tools (a merged pull request moves an item) | WF-06 | Queued |
| 7 | 0713 | Incremental directory sync (LDAP uSNChanged), "manage user status locally" | DIR-04 | Queued |
| 8 | 0804 | Xray test data import (steps, runs, results) | — | Queued |

## B. Making the Jira DC import complete (needed to move real data)

Today's importer (0802) brings projects, people, statuses, types, priorities, resolutions, custom fields, versions, components, sprints and items with their history, comments (with visibility), work logs, watchers, votes, links, web links, attachments, rank, flags and Parent Link. These are missing:

| # | Gap | Why it matters | Proposed fix |
|---|---|---|---|
| B1 | **Wiki markup isn't converted.** Jira DC descriptions and comments are wiki markup (`h1.`, `*bold*`, `{code}`, `[text\|url]`, `!image.png!`, `[~user]` mentions, tables) | Every imported description and comment shows raw markup | Convert wiki markup to Strand's Markdown on import: inline images point to the imported attachments, mentions to the people |
| B2 | **Old Jira links break.** `https://jira…/browse/KEY-1` in bookmarks, emails, Confluence and code | Links everywhere stop working at cutover | A `/browse/:key` route in Strand, plus a redirect rule for the old Jira host (an infrastructure step) |
| B3 | **No delta import for cutover.** A re-run skips what it already imported, so later changes in Jira aren't picked up | A large migration can't freeze Jira for the whole import | "Update since last run": re-read items changed after the last run (`updated >= …`) and apply their changes. Then a short freeze for the final delta |
| B4 | ~~Only one active sprint survives~~ | Done with spec 0414: every active sprint stays when parallel sprints are on | — |
| B5 | **Workflows arrive without transitions**: every status reachable from any, because Jira DC's REST doesn't expose transitions | Workflow rules are lost | Import the workflow XML an admin exports from Jira (Administration › Workflows › Export as XML): transitions, conditions, validators and post functions Strand has |
| B6 | **Boards come in as Strand's default board** | Columns, swimlanes, quick filters and board filters are lost | Jira Software's REST has `board/{id}/configuration`: import columns (status mapping), the filter, estimation and ranking |
| B7 | **Saved filters and subscriptions** aren't imported | People's searches are lost | Import the filters each person can see (REST `filter/{id}`, `filter/favourite`) with their sharing; translate JQL that refers to ids |
| B8 | **Notification schemes** aren't imported | The defaults apply instead | REST `notificationscheme`: map to Strand's schemes (spec 0605) |
| B9 | **Environment** and **issue security level** aren't imported; **custom fields' history** is imported as text only | Lost fields (strand branch: levels) | Environment becomes a text custom field; security levels on the strand branch; custom fields' changelog as `custom:<id>` rows with values, so number-field statistics (0412) read imported history |
| B10 | **Throughput at scale**: one job, project after project | 6,000 projects and millions of items take a long time | Several projects in parallel, attachment copies in a pool, progress and an estimated time to finish |
| B11 | **Apps' data** (Tempo, ScriptRunner, Structure, Service Management, Zephyr/Xray…) | Unknown until the inventory runs | Run the inventory (0801) on the real Jira; it decides what's needed |
| B12 | **Rehearsal and sign-off** | Proves the import before cutover | Import a copy, compare counts (reconciliation, 0802 R7), spot-check with users, then cut over |

## C. To do at the end (parked by the PO, 11 Nov 2026)

- Run the inventory (0801) on the real Jira DC. It decides B11 and whether the Team field is used, which decides 0803 B+ (teams and capacity).
- Compare Strand with the real Jira, screen by screen.
- Verify the 63 specs marked "awaiting verification".
- Review the 71 proposals (P1…) written into the specs and choose which to build.

## D. To develop later

| # | What | Notes |
|---|---|---|
| D1 | **Collapsed-sidebar logo**: System settings › Look and feel gets a third image, a small square logo shown when the sidebar is collapsed (and as the app icon on phones). Without one, Strand shows the favicon. | Logo and favicon upload already exist (spec 0702): PNG, JPEG or WebP, checked, audited, system administrators only. The collapsed sidebar now squeezes the full logo |
| D2 | 0803 B+: teams and capacity on plans | After the inventory |
| D3 | 0702 P1: a logo per project | Proposal |
