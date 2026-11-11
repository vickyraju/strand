# 0803 Planning like Advanced Roadmaps (decision)

Status: In review (with the product owner: the index has said "decision after 0802" since the roadmap was set)
Parity rows: AG-14

## Context and Jira reference

- **Jira DC** ([Advanced Roadmaps](https://confluence.atlassian.com/jirasoftwareserver/discover-advanced-roadmaps-for-jira-1044784153.html), checked 11 Nov 2026): part of the Jira Software Data Center licence since 8.15 (February 2021). "Big picture planning" across projects and teams:
  - **Plans** draw work from boards, projects and filters, in "a sandbox environment": changes are made in the plan and saved back to Jira when ready.
  - **Hierarchy above epic** (Initiative, Theme…), joined by the **Parent Link** field; **Target start** and **Target end** dates.
  - **Teams** with their capacity (story points per sprint, or hours), sprints and releases in the plan, **auto-scheduling**, **dependencies** (from issue links), **scenarios**, and saved views.
- **Jira Cloud** ([Jira Premium](https://www.atlassian.com/software/jira/premium), checked 11 Nov 2026):
  - Every plan has a timeline, limited to "a **single team and project**".
  - **Premium** adds plans ("advanced planning"), to "plan and track work across **multiple teams and projects**", with "managing team capacity, mapping dependencies, and exploring alternative scenarios".
  - Cloud's plans keep Jira's sandbox (product knowledge, not re-checked against a page).
- **Strand today** (`TimelineView.tsx`, spec 0303):
  - Each project's Timeline: epics and items with start and due dates, dragged to move or resize; undated sprint work spans its sprint.
  - A fixed hierarchy: epic, item, sub-item.
  - No cross-project view, no dependency lines, no capacity.
- **Who uses it:**
  - The inventory (spec 0801) shows whether the product owner's Jira has Advanced Roadmaps' fields in use ("Advanced Roadmaps" under "What needs a decision").
  - The importer (spec 0802) leaves those fields out for now.

## How other tools do it

Checked 11 Nov 2026 on each tool's documentation, feature and pricing pages.

| Tool | Cross-project plan | Level above epic or project | Dependencies | Capacity | Edits | Tier |
|---|---|---|---|---|---|---|
| **Jira DC** | Plans from boards, projects, filters | Custom levels (Initiative…), Parent Link | From issue links, auto-schedule | Teams, story points or hours per sprint | **Sandbox**, saved back on review; scenarios | Included (8.15+) |
| **Jira Cloud** | Timeline: one team and project; **Plans**: many teams and projects | Custom levels (Premium) | Premium plans | Premium plans | Sandbox, scenarios | Premium |
| **[Linear](https://linear.app/docs/timeline)** | A **timeline of projects** across teams ("specifically designed to only surface projects"), grouped by initiative; a team's cycles shown on it | **[Initiatives](https://linear.app/docs/initiatives)** "group projects around company objectives": status, owner, lead team, target date, health from project updates; sub-initiatives | **[Project dependencies](https://linear.app/docs/project-dependencies)** (end → start), lines on the timeline, red when violated; dragging a project moves linked planned ones | **[Cycle capacity](https://linear.app/docs/use-cycles)** "calculated from the velocity of the previous three completed cycles" | Live | Initiatives on all plans |
| **[Plane](https://docs.plane.so/core-concepts/projects/initiatives)** | **Initiatives** (workspace level) group projects and work items, with list, board and **timeline** layouts (drag to change dates); per-project timeline (Gantt) | Initiatives above projects; Epic is a work item type above Task, within a project | "Dependencies in Timeline", critical path | Cycles with burn-down, estimates; no capacity view | Live | Initiatives, dependencies: Pro |
| **[ClickUp](https://clickup.com/features/gantt-chart-view)** | Gantt per list or project; [Goals](https://clickup.com/features/goals) collect tasks "from different teams" | Custom task types (such as Initiative); Goals with targets | Finish-to-start, start-to-start, finish-to-finish, start-to-finish; "every downstream date adjusts automatically"; **critical path**, slack, **baselines** | **Workload view** per person | Live | Gantt from Core; Workload and critical path from Business ([pricing](https://clickup.com/pricing)) |
| **[monday.com](https://monday.com/pricing)** | **Portfolio**: "connect projects to a unified portfolio with real-time health snapshots" | A portfolio board above project boards | Dependencies (Pro); [Gantt](https://monday.com/features/gantt) with critical path, baselines, milestones | **Resource management**: "optimize capacity across projects" | Live | Timeline and Gantt from Standard; dependencies from Pro; portfolio and resources Enterprise only |

**What they have in common:**

1. **A level above projects or epics.** Linear's and Plane's Initiatives, Jira's custom levels, monday's portfolio, ClickUp's goals and custom types. Every tool has one.
2. **A timeline across projects at that level.** Linear and Plane show projects and initiatives on it, not every issue.
3. **Dependencies drawn on the timeline**, flagged when broken (Linear, Plane, ClickUp, monday).
4. **Edits are live everywhere but Jira.** Only Jira, DC and Cloud, keeps a sandbox with scenarios.
5. **Capacity is the least alike:**
   - Linear works from each team's cycle velocity.
   - ClickUp and monday have workload views, and monday's capacity planning is Enterprise only.
   - Plane has none.
   - Only Jira's plans have teams with a capacity per sprint.

The ClickUp and monday.com help centres refused automated reads, so their rows rest on their feature and pricing pages.

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

- **A. Jira's Advanced Roadmaps as it is.**
  - Plans with custom hierarchy levels, teams and capacity, and auto-scheduling.
  - A sandbox with scenarios, saved back on review.
  - Matches Jira DC and Cloud Premium most closely.
  - The largest piece of work Strand would take on, needing several specs: levels, plans and their sources, teams and capacity, scheduling, scenarios.
- **B. Initiatives and a cross-project timeline, live (recommended).** What every other tool converged on:
  - **Initiative**, one level above epic. Jira's Parent Link maps to it, so imported plans keep their structure.
  - **Plans** at workspace level that pick projects or a saved view.
  - A **timeline** of initiatives, epics and items, with **Target start** and **Target end** as ordinary date fields: searchable, and shown on the item, which is what Jira's users ask for (above).
  - **Dependency lines** from "blocks" links, red when broken.
  - Releases and sprints across projects.
  - A **health and progress roll-up**, as Linear and Plane have.
  - Edits save straight to the items, as everywhere else in Strand.
  - Plans show only what each person may see.
- **B+. B, then capacity.** Teams with a capacity per sprint (Jira's), shown on the plan. Only if the inventory shows Advanced Roadmaps' Team field in use.
- **C. Not now.** Keep the per-project Timeline; the importer keeps leaving Advanced Roadmaps' fields out (the inventory reports them).

**Recommendation: B, with B+ as a follow-up spec if the inventory shows teams in use.**
- The sandbox and scenarios exist only in Jira, and Jira's own users find changes that look saved but aren't confusing. They would stay a recorded divergence.
- Jira's Parent Link and Target dates migrate directly under B, as the parity principle requires.

## Rules

To be written once an option is chosen.

## Open questions

1. A, B or C? (B recommended.)
2. Does the inventory show teams and capacity in use in your Jira (Advanced Roadmaps' Team field on work items)? If yes, B+ follows B.

## Changelog

- 11 Nov 2026: how Jira Cloud, Linear, Plane, ClickUp and monday.com handle cross-project planning added; options revised (B now initiatives and a live cross-project timeline; B+ for capacity).
