# 04 · Mobbin flow, screen and section inventory

Research date: 23 October 2026. Tool: the connected Mobbin MCP server (`search_flows`, `search_screens`, `search_sections`), web platform only. Every reference below is an ID that Mobbin returned, so a reviewer can open it at `https://mobbin.com/flows/<id>`, `https://mobbin.com/screens/<id>` or `https://mobbin.com/sites/sections/<id>`.

## How Mobbin represents the material

| Unit | What it is | How it is cited here |
|---|---|---|
| **Flow** | A recorded multi-step journey in one app (e.g. "Creating a task", 13 screens). It has a name, action tags (e.g. "Adding & Creating") and an ordered list of screen IDs. | `flow <id>` with name and screen count |
| **Screen** | One captured screen of an app, with its own ID. Screens are shared between flows. | `screen <id>` |
| **Section** | A section of a **marketing website** (hero, features, pricing). Sections are not product UI. | `section <id>` |

Two consequences for this research:
- **Sections are of little use for product UX.** Mobbin's sections cover public websites, not the logged-in apps, so `search_sections` was used once to confirm this.
- **Coverage depends on what Mobbin has captured.** Capture dates vary. For example, the Jira screens mix the 2025 "Spaces / Work items" naming and the older "Projects / Issues" naming. Results that look outdated are marked as such.

## Search log

27 searches were made: 5 flow searches, 21 screen searches and 1 section search. Two "deep" screen searches for monday.com timed out after about 440 s with no response; both were rerun in "standard" mode and returned results. Every search had more pages available (`has_next_page: true`), and only the first page was read. **Coverage is therefore a sample, not a complete inventory of these products.**

### Jira Cloud (web)

| # | Tool · query | Returned | Key observations |
|---|---|---|---|
| J1 | flows · "Jira creating an issue" | flow `11542f77-547b-4c12-a1a4-584e8795edcd` "Creating a task" (13 screens); flow `2be33b17-791d-428b-97d3-99560561f51c` "Creating a task" (7); flow `d96238de-2b5f-4904-8c0a-593ae150c88a` "Adding tags" (6); flow `b7408832-03d2-45e2-a1ce-9e4b75249bc1` "Adding a priority" (5) | **Create modal:** "Required fields are marked with an asterisk"; Space* and Work type* first; Status shows "This is the initial status upon creation"; "Similar work items" duplicate hint under Summary; Attachment drop zone; Linked work items (link-type select plus target); **"Restrict to: Select Roles"** (issue-level restriction at creation); "Create another" checkbox; the modal can be minimised or expanded. **Board create:** per-column "+ Create", a popover with the status preset to the column, and "Assign to me". **Admin:** Priorities table with schemes, added through a right-hand drawer. |
| J2 | flows · "Jira editing a workflow" | flow `3eb97151-8e13-4b1a-8db9-1665e69b92e1` "Workflow management" (4); flow `bfc1c61a-2041-4052-bb80-80f05c98d8da` "Adding a workflow" (8); flow `6e667a2d-c82a-4bda-854c-58155df696f7` "Updating a status name" (4); flow `dbfd5e2f-5541-45e3-8e12-2c7053d9831c` "Adding a status" (5) | **New editor:** reached from the board "…" menu (Manage workflow); full screen; toolbar Add status / Add transition / Add rule; "Update workflow" stays disabled until something changes; Diagram/Text toggle; "Any" pills mark global transitions; minimap with zoom. **Company-managed admin:** Active/Inactive workflow tabs, "Included in project(s)" and "Included in workflow scheme(s)" columns, and new workflows start INACTIVE. Each transition has a panel with **Properties, Triggers, Conditions, Validators, Post functions**. **Statuses:** a global list with Category and "N associated workflows". Adding a status offers "Allow all statuses to transition to this one", and a status with no outgoing transition shows a warning. |
| J3 | flows · "Jira managing project access and people permissions" | flow `62b0ecd3-30f5-4679-8eea-1290c478f937` "Updating a project access" (6); flow `44b88f15-4d0a-4679-8d83-0239b2444e3c` "Updating a role" (4); flow `4a50b54b-a720-40d8-962e-16d7ed55fc7f` "Updating a role" (4) | Project settings → Access shows the access level (Open / Limited / Private) explained in one sentence. Changing it opens a warning dialog that says who will gain access, with the button "Save and make open". The people table has Name / Email / Role / Remove. **The role selector is multi-select**: Administrator, Member and Viewer, each with a one-line description, shown as "Multiple (2 roles)". There is a "Manage roles" link, an "Access requests (n)" tab, and an illustrated empty state. |
| J4 | flows · "Jira completing a sprint" | **No sprint-completion flow.** Returned Plans/Quickstart flows `f358b0b8-62c0-49ce-af5e-1205bdd0ba1b`, `00a599e1-3275-4390-9a22-352a0c7a632e`, `fde7e31c-6cfa-46bc-a985-107c8c091efe` | Plans (an Atlassian Cloud premium feature): team timeline with sprint lanes; team capacity ("30 points", "2 weeks"); a dependency graph with lag ("blocks (+14d)") where violated dependencies show in red; edits held as "Unsaved changes" until saved. |
| J5 | screens · "Jira complete sprint dialog" | **No complete-sprint dialog.** Screens `f4377fa5-75e7-4d09-b73f-c6b947dcea65`, `1f63d977-4b7f-418a-a0a0-31f124fd905f`, `644fb651-a5c4-4422-811d-4f44dae2471a` | **Bulk operation wizard**: "Step 2 of 4: Choose bulk action" (Edit, Move, Transition, Delete permanently, Watch, Stop watching) with a left-hand stepper. **Move work item**: "Select destination project and issue type", with the warning that the destination may use different workflows and fields and data may be lost. |
| J6 | screens · "Jira backlog with sprints" | screens `994f09c1-4ca4-4127-8039-af78b1801a94`, `3bfc03fd-9085-46ca-bacc-db3a15c9c837`, `bb434910-8aa7-46c1-bdad-cc6c98a9a6ce` | These are Plans "Program" boards, not a team backlog: sprint columns per team showing capacity "0 / 30 points", and a "Drag work items to schedule" panel. **The team backlog itself was not captured.** |
| J7 | screens · "Jira advanced search with JQL filter" | screens `b4aced51-7f03-4045-a297-a820c8f0b9cc`, `11303a55-9ff5-4130-9b70-45aeb9526837`, `657a94c4-cb6a-452c-ba0b-f935d13e8c01` | The filter popover has Basic, Advanced and JQL tabs, and Shift+F toggles it. Board custom filters are written in JQL (`assignee = currentUser() AND status != Done ORDER BY priority`). The list view has a Resolution column (Unresolved/Done), shows a "9 of 9" result count and strikes through done keys. |
| J8 | screens · "Jira automation rule builder" | screens `44047820-2b7b-4719-8cda-e13110b97bad`, `d5ff79df-b18c-4dd9-a5df-38cd80bbf7b5`, `d92671ac-ba3a-4fe3-9202-d45c2b7cd7f0` | The rule builder is a vertical chain: When (trigger) → IF (condition) → THEN (action) → FOR EACH (branch). **Rule details**: Owner* ("receives emails when the rule fails"), Actor* (whom the actions run as), Notify on error, "Who can edit this rule?". The scope can only be changed in global administration. Actions include Delay, Log action, Send email, Send web request and Lookup work items (JQL). |
| J9 | screens · "Jira notifications panel" | screens `f7eb5777-1125-4f47-bdcc-39931e19cfeb`, `f09233f3-fab0-470e-bcdb-193fdb1ba056`, `47876e24-d14b-4826-915c-e702bd1851ad` | **Inbox popover**: Direct / Watching tabs, "Only show unread" toggle, grouping ("+12 updates from Alex Smith"), inline comment preview with reactions and Reply, "That's all your notifications from the last 30 days", arrow-key navigation. **Project notification scheme**: Event → Recipients table (watchers, assignee, reporter) that personal preferences can override. |
| J10 | screens · "Jira work item detail view with comments and history" | screens `a8611730-2236-4853-aa5a-a2ddf217fe8b`, `99dad4b0-167f-4944-85e8-1158ff0c1593`, `463a7839-be99-4cf5-b2ce-42a1316c0534` | **Detail page**: breadcrumb with "Add epic"; previous/next; status button plus an automation bolt; Subtasks table with a "% Done" bar; link composer ("is blocked by" plus "Type, search or paste URL"); Activity tabs All / Comments / History / Work log; "press M to comment"; Details side panel; "Rule executions" panel; restrict (lock) icon; watcher count. |

### monday.com (web)

| # | Tool · query | Returned | Key observations |
|---|---|---|---|
| M1 | flows · "monday.com creating a board item" | flow `a4fe2f46-d24f-4a99-b68e-8e1b41040298` "Adding a table" (5); flow `27b25bdf-8181-4241-b280-26906a71eee8` "Adding a task" (5) | A table-first board with groups ("This month"). Items are added with an inline "+ Add task" row; the name is edited in place, with an "Open" affordance to the item panel. Status cells are colour blocks, and each group footer has a status summary bar. The item side panel has Updates / Files / Activity Log tabs, a rich-text update showing "Draft saved", and a mention button. |
| M2 | screens · "monday.com board permissions settings" (deep) | **Timed out** (443 s) | Rerun as M3. |
| M3 | screens · same query (standard) | screens `fd0efcc4-24ae-47ae-afd1-95e75f55b4fa`, `fca4659a-2030-4dd5-95ed-8bd5eeb443e2`, `fa78ae97-7418-4ddf-af14-4c5d6fa849a6` | "Board Members" is a single search box with results grouped People / Teams ("Everyone at …") plus "Invite a new member by email". Administration → Security has Login / Audit / Compliance / Advanced tabs, with SSO, SCIM and IP restriction plan-gated. **Per-board permission levels were not captured.** |
| M4 | screens · "monday.com automation center" (deep) | **Timed out** (441 s) | Rerun as M5. |
| M5 | screens · same query (standard) | screens `fe64bc42-b339-4a0b-8ccc-b20df22359e5`, `fe24943e-7619-4eb8-8ea1-88322bb524e1`, `efcd031a-e926-4c66-8e4f-bea04cd626bc` | **Sentence recipes**: "When [status] changes to [something], send an [email] to [someone]". Each blank is an inline picker, and "Add to board" stays disabled until every blank is filled. There is a recipe gallery. Updates made by automations appear in the Home inbox with a board › group › item breadcrumb. |
| M6 | screens · "monday.com dashboard with chart widgets" | screens `fcb49357-560f-4513-946b-5a85332bd447`, `ee06b799-d633-40c7-a459-6f3116e9f732` | The Dashboard is a board view tab with widgets (pie chart, bar by status, Numbers, Battery "10% Done"), "Add widget" and per-widget filters. Home shows recently visited boards and the Inbox. |
| M7 | screens · "monday.com item activity log" | screens `c8a2cc05-0f97-49c0-8031-0103e89bacbc`, `6d4324d6-f6fc-4656-98c6-ab3e5c16fe99` | The item Activity Log has a person filter and rows of the form "field: old → new", with links to "Automations Activity". **Automations Activity (Beta)** lists each run with Status (Successful), time, board and the rule sentence, and each row expands to "Item name … [View item]". |
| M8 | screens · "monday.com import data from Excel or Jira" | Jira screens only: `f5d232ff-9937-4667-88bd-03b49175a2b0`, `f5765278-e5c5-432c-a999-5d5c30033f19` | **No monday.com import journey was found.** The Jira results show "Add epic: Work items can only belong to one parent at a time" and list columns Resolution / Created / Updated. |

### Linear (web)

| # | Tool · query | Returned | Key observations |
|---|---|---|---|
| L1 | flows · "Linear creating an issue" | flow `b49200b2-cfac-4c16-aae9-55aecdb91d09` "Creating an issue" (5); flow `3528703d-a543-414c-8f6e-ccf2442bff2f` "Creating a new issue" (10) | A compact modal: title and description, then a **row of property chips** (Status, Priority, Assignee, Project, Estimate, Labels, "…"). The "…" menu has Set due date, Link to URL (Ctrl L) and Add sub-issue, each with its shortcut shown. There is a "Create more" toggle and "Save as draft". The issue page has "1 / 11" previous/next, a Properties sidebar, Sub-issues "0/1", Links, and Activity with Unsubscribe. |
| L2 | screens · "Linear team workflow statuses settings" | screens `fea37c46-ab06-4d46-86c7-333ffb0db455`, `ef9e1029-1437-4774-a7cf-ca3d2a657f83` | **The statuses screen was not captured.** The team General settings show the Identifier "Used in issue IDs" (with a toast on change), a Timezone that sets when cycles start, and the estimate scale. The settings navigation groups Issues, Projects, Features and Administration (Members, Security, API, Import & export). |
| L3 | screens · "Linear cycles view" | screens `ef9e1029-…`, `d6b950f4-f779-40bf-86db-fa631004b54f` (Project updates) | **No cycle screen.** Cycles are covered from official docs only (see 10-source-register). |
| L4 | screens · "Linear inbox notifications" | screens `fbb07294-5214-4769-97e0-f2bd9f8cb36a`, `f5906fed-ff32-4d80-b48d-063c19d2b844` | Notification settings: digest format, "Delay low priority emails outside of work hours", per-category toggles (Assignments, Status changes, Comments, Mentions, Subscriptions…). Pulse has a workspace default schedule with a personal override. **The Inbox itself was not captured.** |
| L5 | screens · "Linear command menu" | screens `f71cec1e-a119-485b-9164-969169030e1a`, `f1e8745b-81b7-4a78-85e1-a325f4843f42` | These are context menus, not the Cmd-K palette, and every item shows its shortcut (Move to ⇧P, Rename ⇧R…). The "Move to" picker is filterable and grouped. |
| L6 | screens · "Linear members and roles settings" | screens `fea37c46-…`, `f3134ca3-b7e5-47ab-a283-92ce2db403db` | **The members screen was not captured.** The estimate settings explain each toggle in one sentence (e.g. "Count unestimated issues as 1 point"). |
| L7 | screens · "Linear issues list with filter and display options" | screens `fd1b4d88-f021-49a3-98af-4cd3a87e1d29`, `ef923b0e-9a40-4fdd-80f2-f3aafb4f36ce` | Team Issues has All / Active / Backlog tabs. The project issue list is grouped by status with counts ("Todo 2/3"), sub-issues show "› parent", and the parent shows "8/8". |
| L8 | screens · "Linear import issues from Jira" | screens `938149bc-0e08-4f17-92ab-bf98681e805c`, `13eef89b-e17e-4ee7-bde4-8d3afa7455d4` | Settings → Import & export has an import assistant (Asana, Shortcut, GitHub, **Jira**, Linear), a CLI importer (Jira CSV) and CSV export with an emailed link. **"Previous imports" shows "15 issues and 0 users imported — Completed"**, i.e. an import report. |
| S1 | sections · "project management product features section" | sections `310c96f7-e776-47d5-bcbf-4871dcda726a`, `ca262897-ccf7-45b6-922f-3e68519c1119` | Linear marketing site: milestones and dependencies, "predict project outcomes" (scope and velocity over time), parent and sub-issues, automated backlog (auto-close and auto-archive), workflows per team. These are marketing claims, not observed UI. |

## Coverage matrix (21 workflows × 3 products)

**C** = confirmed by at least one captured screen of that journey · **P** = partially seen (an entry point or a related screen only) · **—** = not found in Mobbin; any statement about it in this package relies on official documentation or is marked unknown.

| Workflow | Jira Cloud | monday.com | Linear | References |
|---|---|---|---|---|
| A. Navigation and information architecture | C | C | C | J1–J10, M1, L1, L7 |
| B. Project creation, configuration, archiving | P | P | P | J3 settings nav; M3; L2 |
| C. Create and edit a work item | C | C | C | J1, M1, L1 |
| D. Detail view, inline edit, comments, files, history | C | C | C | J10, M1/M7, L1 |
| E. Parents, subtasks, links, dependencies | C | — | P | J1, J4, J10, M8; L1, L7 |
| F. Statuses and workflows | C | — | — | J2 |
| G. Custom fields, columns, forms, layouts | P | P | P | J2 admin nav; M1 columns; L6 |
| H. Project access and admin permissions | C | P | — | J3; M3 |
| I. Board creation, columns, cards, filters, swimlanes | P | P | — | J2 board menu, J7 |
| J. Backlog, prioritisation, drag-and-drop, bulk | P | — | P | J5, J6; L7 |
| K. Sprint/cycle planning, start, complete | — | — | — | (J4/J6 show Plans only) |
| L. Global search, filters, saved views, queries | C | P | P | J7; M1 toolbar; L7 |
| M. Reports, project health, dashboards | — | C | P | M6; S1 (marketing) |
| N. Releases, versions, milestones, timeline | P | P | P | J4; M1 timeline tab; S1 |
| O. Automation rules, conditions, actions, debugging | C | C | — | J8, J10; M5, M7 |
| P. Notifications, inbox, mentions, activity | C | P | P | J9; M5/M6; L4 |
| Q. Archive, deletion, restoration, undo | P | — | P | J5; L5 |
| R. Keyboard, command palette, shortcuts | P | — | P | J7, J9, J10; L1, L5 |
| S. Admin settings, user management | P | C | P | J1/J2; M3; L2 |
| T. Import and migration | — | — | C | L8 |
| U. Empty, loading, error, validation, confirmation | C | P | P | J1, J2, J3; M5; L2 |

Totals: 63 cells, of which **20 are confirmed (32%)**, 28 partial (44%) and 15 not found (24%). Per product, confirmed / partial / not found: Jira Cloud 10 / 8 / 3, monday.com 6 / 8 / 7, Linear 4 / 12 / 5.

## Limitations

1. **Only first pages were read.** All 27 searches had more results. A complete inventory would need paging to the documented maximum of 20 pages per search.
2. **Gaps to close with Mobbin before UX sign-off:** sprint/cycle completion in all three products (the most important gap, because sprint completion is P0 for Scrum teams); the Jira team backlog; Linear statuses, members and Inbox; monday.com per-board permissions and import.
3. **Mobbin shows Jira Cloud, not Jira Data Center.** Nothing here proves how our Data Center instance behaves; see `03-jira-source-requirements.md`.
4. **Preview images are low resolution.** Text was read from them, but small labels may be misread. Statements are limited to what was legible.
5. **Image URLs expire after 30 days.** Cite the `mobbin_url` (flow, screen or section ID), not the image URL.
