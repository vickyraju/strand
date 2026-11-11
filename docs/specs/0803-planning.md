# 0803 Planning like Advanced Roadmaps (decision)

Status: In review (with the product owner: the index has said "decision after 0802" since the roadmap was set)
Parity rows: AG-14

## Context and Jira reference

- **Jira DC** ([Advanced Roadmaps](https://confluence.atlassian.com/jirasoftwareserver/discover-advanced-roadmaps-for-jira-1044784153.html), checked 11 Nov 2026): part of the Jira Software Data Center licence since 8.15 (February 2021). "Big picture planning" across projects and teams:
  - **Plans** draw work from boards, projects and filters, in "a sandbox environment": changes are made in the plan and saved back to Jira when ready.
  - **Hierarchy above epic** (Initiative, Theme…), joined by the **Parent Link** field; **Target start** and **Target end** dates.
  - **Teams** with their capacity (story points per sprint, or hours), sprints and releases in the plan, **auto-scheduling**, **dependencies** (from issue links), **scenarios**, and saved views.
- **Strand today:** each project's Timeline (start and due dates, epics and their items, releases); reports per board; no plans across projects, no levels above epic, no teams or capacity.
- **Who uses it:** the inventory (spec 0801) shows whether the product owner's Jira has Advanced Roadmaps' fields in use ("Advanced Roadmaps" under "What needs a decision"); the importer (spec 0802) leaves those fields out.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22Advanced%20Roadmaps%22%20OR%20summary%20~%20%22Portfolio%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | What it says |
|---|---|---|
| [JRASERVER-63875](https://jira.atlassian.com/browse/JRASERVER-63875), [JRASERVER-74676](https://jira.atlassian.com/browse/JRASERVER-74676) | Suggestions | Target dates should be ordinary dates, visible and searchable everywhere |
| [JRASERVER-77855](https://jira.atlassian.com/browse/JRASERVER-77855) | Suggestion | Plan fields on boards' item view |
| [JRASERVER-78238](https://jira.atlassian.com/browse/JRASERVER-78238) | Suggestion | Plans should respect project permissions |
| [JRASERVER-70448](https://jira.atlassian.com/browse/JRASERVER-70448) | Suggestion | JQL to keep items out of a plan |
| [JRASERVER-73028](https://jira.atlassian.com/browse/JRASERVER-73028) | Bug | Plans load slowly with some custom fields |

## Options

- **A. Full Advanced Roadmaps:** plans across projects, levels above epic, teams and capacity, auto-scheduling, dependencies, scenarios saved back. Matches Jira most closely; the largest piece of work Strand has taken on (several specs: hierarchy levels, plans and their sources, teams and capacity, scheduling, scenarios).
- **B. Plans without the sandbox (recommended):** cross-project plans built from Strand's existing pieces: a plan picks projects or a saved view; its timeline shows their epics and items with **levels above epic** (Initiative by default, as Jira's), **Target start and end** as ordinary date fields (what Jira's users ask for, above), **dependencies** from links, releases and sprints across projects; edits save straight to the items, as everywhere else in Strand. Teams and capacity come next if the inventory shows them in use. Covers what most Advanced Roadmaps users do; a fraction of A's size; data from Jira's Parent Link and Target dates migrates directly.
- **C. Not now:** keep the per-project Timeline; the importer keeps leaving Advanced Roadmaps' fields out (they're reported by the inventory).

**Recommendation: B**, then teams and capacity as a second step if the inventory shows them in use. Following Jira (as decided for parity) points to A; B keeps the parts people use and drops the sandbox, which Jira's own users find confusing (changes that look saved but aren't).

## Rules

To be written once an option is chosen.

## Open questions

1. A, B or C? (B recommended.)
2. If B: does the inventory show teams and capacity in use in your Jira (Advanced Roadmaps' Team field on work items)?

## Changelog
