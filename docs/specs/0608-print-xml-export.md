# 0608 Print and XML export

Status: Ported (aws-jira `1d48871`, strand `8b9d3ff`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: SR-06

## Context and Jira reference

- **Jira DC** (the issue navigator's **Export** menu; an issue's **Export** menu):
  - Search results: **Printable**, **Full content**, **XML**, **RSS**, **RSS (with comments)**, **Word**, **CSV (all fields)**, **CSV (current fields)**. These views return at most 1,000 issues by default (`jira.search.views.default.max`).
  - One issue: **XML**, **Word**, **Printable**.
  - Jira's XML is an RSS 0.92 document whose `item`s carry the issue's fields (key, summary, type, priority, status, resolution, assignee, reporter, labels, dates, versions, components, votes, watches, comments, links, sub-tasks, custom fields); Word is the issue's HTML saved as a `.doc`.
- **Strand today:** CSV export of a search (spec 0101), capped by System settings.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22export%20word%22%20OR%20summary%20~%20%22printable%22%20OR%20summary%20~%20%22XML%20view%22%20OR%20summary%20~%20%22export%20excel%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | Strand |
|---|---|---|
| [JRASERVER-31977](https://jira.atlassian.com/browse/JRASERVER-31977), [JRASERVER-20361](https://jira.atlassian.com/browse/JRASERVER-20361) XML shows version ids, or user ids without names | Bug, Suggestion | **Built:** names with their ids (R2) |
| [JRASERVER-64028](https://jira.atlassian.com/browse/JRASERVER-64028) The history in the printable view | Suggestion | **Built:** Full content and an item's Printable include its history (R3) |
| [JRASERVER-44537](https://jira.atlassian.com/browse/JRASERVER-44537) Web links left out of exports | Bug | **Built:** Word and Full content carry web links (R3) |
| [JRASERVER-21182](https://jira.atlassian.com/browse/JRASERVER-21182) Σ time fields missing from XML | Bug | **Built:** aggregate time fields (R2) |
| [JRASERVER-38896](https://jira.atlassian.com/browse/JRASERVER-38896), [JRASERVER-62196](https://jira.atlassian.com/browse/JRASERVER-62196), [JRASERVER-27567](https://jira.atlassian.com/browse/JRASERVER-27567) A real Excel file | Suggestions | **Proposal P1** |
| [JRASERVER-10156](https://jira.atlassian.com/browse/JRASERVER-10156) Images in the Word export | Suggestion | **Proposal P2** |
| [JRASERVER-1781](https://jira.atlassian.com/browse/JRASERVER-1781) Export work logs | Suggestion | **Proposal P3** |

**Proposals for the product owner** (not built until chosen):

- **P1: Excel (.xlsx)** export of a search.
- **P2: Pictures** in Word and printable exports.
- **P3: A work log export** (who logged what, when, on which items).

## Rules

- **R1: The menus.** A search's **Export**: CSV, Printable, Full content, XML, RSS, RSS with comments, Word. A work item's menu: Export XML, Word, Printable. Each shows the items the person may see, in the search's order, at most the System settings limit (1,000 by default, as Jira's); a larger search is refused, as the CSV export is.
- **R2: XML and RSS** in Jira's shape: an `rss` 0.92 document with a `channel` and an `item` per work item carrying Jira's elements (names with their ids, the Σ time fields); RSS items carry title, link, description and date, and with comments their comments. A comment limited to a role or group is left out for those who may not read it.
- **R3: Printable and Full content.** Printable lists the items (key, summary, type, status, priority, assignee, updated); Full content shows each item's fields, description, comments, links, web links and history; an item's Printable is its Full content. They open ready to print.
- **R4: Word** is the Full content as a Word document.
- **R5: Records.** Every export is in the audit log, as the CSV export is.

## Permissions

Browse projects: only items the person can see.

## Data model and migration

The `searchAndBulk` System setting gains `viewsMaxItems` (1,000).

## API

- `GET /search/export.{xml,rss,doc,html}` with the search's filters (`comments=1` for RSS with comments; `full=1` for Full content as HTML).
- `GET /issues/:key/export.{xml,doc,html}`.

## Screens

The search's Export menu; the work item's menu; printable pages open in a new tab and start printing.

## Scale

At most the limit per export (1,000 by default); each item is read as webhooks read it, a few queries per item.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R5 | Server test: XML parses, its items have Jira's elements; RSS with and without comments; only visible items; the limit; audited |
| R3, R4 | Server test: Printable lists the items; Full content and Word carry the description, comments, web links and history |
| R1 | Browser journey: export a search as XML; open an item's Printable |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **CSV (current fields):** Strand's CSV has a fixed set of columns (spec 0101).

## Open questions

None.

## Changelog
