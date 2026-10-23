# 01 · Master feature checklist

This checklist is the requirement baseline. Each row links to:
- `02` for the current status and code evidence;
- `03` for the source (Data Center) evidence;
- `04` and `05` for UX references;
- `08` for the tests that prove the acceptance criteria.

## Priorities

- **P0:** must be correct before a secure internal pilot.
- **P1:** required to switch off Jira for the whole organisation.
- **P2:** only with a demonstrated need.
- **DEFERRED:** plugins and integrations.

**"P0 if used"** means the row is P0 only if the source inventory (`03`) shows that a pilot team relies on it. Until then it is held at P1 and the decision is tracked in `09`. No priority here was raised just because Jira Cloud, monday.com or Linear has the feature.

## Column key

- **Status** is copied from `02`. The codes are: V = VERIFIED_IMPLEMENTED, T = IMPLEMENTED_NEEDS_TESTING, P = PARTIALLY_IMPLEMENTED, M = MISSING, NA = NOT_APPLICABLE, BD = BUSINESS_DECISION_REQUIRED, SU = SOURCE_CONFIGURATION_UNKNOWN.
- **Owner:** PO = product owner, Eng = engineering, JA = Jira administrators, Sec = security, Plat = platform engineering, QA, Pilot = pilot teams.
- **Migration impact:** H = data must be migrated faithfully; M = needs mapping or a simplification decision; L = no effect on migration.
- **Refs** are UX or documentation references (Mobbin IDs from `04`, sources S## from `10`).

## The acceptance rule that applies to every row

An action that succeeds in one place must show the same result everywhere else it appears: the detail view, board, backlog, search, reports, history, inbox and API, both after a reload and on another user's live view. An action that is refused must be refused the same way through the UI, a direct API call, bulk endpoints, automation and import.

## A · Work items and data model

| ID | Capability: user problem → required behaviour | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| A01 | Manage the item lifecycle: create, view, edit, **clone**, delete (soft), restore | P0 (clone P1) | P | Create, edit, delete and restore each give the same result in the UI, the API and bulk operations. A clone copies the chosen fields and links back to its source, with a new key and a fresh history. | Restoring an item whose parent was deleted. Restoring into a closed sprint. Deleting an item that has children. | A05, G06 | H | Eng | — | J1, L1 |
| A02 | Every item has a unique project key, a readable number and a stable internal id | P0 | V | Keys are never reused, even after deletion. Old keys still resolve (redirect) after an item moves between projects. | Two items created in the same millisecond. Importing an item that keeps its Jira key. | K03 | H | Eng | D-11 key changes | — |
| A03 | Standard fields: title, description, status, priority, assignee, reporter, labels, dates, estimates, **resolution**, **remaining estimate** | P0 (resolution and remaining estimate: P1, or P0 if used) | P | Each field can be validated on the server, filtered, exported and migrated. | Description at its maximum length; Markdown versus Jira wiki markup conversion. | K03 | H | Eng/PO | D-05 rich text | J1 |
| A04 | Types: epic, story, task, bug, plus **configurable types** | P0 (configurable: P0 if used) | P | An admin can add or rename a type per project without a schema change. The type drives its workflow (B07) and fields (A10). | Removing a type that is in use requires mapping its items. | B07 | M | PO/JA | D-06 type catalogue | S06 |
| A05 | Parent/child hierarchy, sub-items and links | P0 | T | The server enforces the hierarchy depth and stops cycles. Links are always shown from both ends. | Linking an item to itself. A cycle through parents. A link to an item the user cannot see is hidden, not leaked. | G04 | H | Eng | — | J10, L1 |
| A06 | **Configurable link types** (blocks, relates, duplicates, clones…) | P1 (P0 if used) | M | Admins define link types with both directions named. Source link types map 1:1 or by an approved merge. | Removing a link type that has links. | K05 | H | JA/Eng | D-06 | J1, S21 |
| A07 | Comments, @mentions, attachments, activity history | P0 | T | Every change writes history with who, when, from and to. Attachments can be uploaded, downloaded and deleted under the item's permissions. | Upload interrupted. An attachment on a deleted item. A mention of a deactivated user. | I06 | H | Eng | — | J10, M1, M7 |
| A08 | Version checks, conflicts, retries, safe undo and restore | P0 | T | A stale edit gets 409 and the UI offers to reload or merge. Retrying a create with the same client id never duplicates the item. | Two people editing the same field at once. A retry after a network timeout. | — | L | Eng | — | — |
| A09 | Work logs, original and remaining estimates, work-log permissions | P1 | P | People can add, edit and delete their own logs; admins can manage everyone's. Remaining estimate goes down by the time logged, or is set by hand. | A log on a deleted item. Restricted work-log visibility (G05). | G05 | H | Eng | — | J10 |
| A10 | **Custom fields** with validation, indexing and search | P0 if used, else P1 | P | Values are validated on the server against the field kind and options. Fields can be searched and exported. Removing an option requires mapping its values. | A select option renamed after use. A number field given text over the API. | D03 | H | Eng/JA | D-06 field catalogue | J2 |
| A11 | Components, affects and fix versions, resolution | P1 (P0 if used) | P | Each has the same multi-value behaviour as in the source, and filters and reports group by them. | An item in several fix versions. Releasing a version that still has open items. | B11 | H | JA/PO | D-06 | S03 |
| A12 | Archive, retention, controlled permanent deletion, **backup before project deletion** | P1 (backup: P0) | P | Deleting a project creates a restorable backup (data and files) at the location set by a global admin. Purges are logged in the audit log. | Deleting a project that has 100k items. Restoring that backup. | I01, I03, G07 | H | PO/Plat | D-08 | S13, S14 |

## B · Workflows and configuration

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| B01 | Configurable statuses and transitions | P0 | V | Can be edited in the diagram or as text. Statuses have categories. Global ("any") transitions are supported. | A status with no way out. A status that cannot be reached. | — | M | Eng | — | J2 |
| B02 | Enforced on the server for **every** write path | P0 | T | A forbidden move fails through the UI, a direct PATCH, bulk edit, automation, import and API token alike. | **Automation's status action (F-03).** CSV import into a status that cannot be reached. | H02 | M | Eng | — | S03 |
| B03 | Transition **conditions** (role, group, permission, reporter or assignee) | P0 | M | The transition is hidden in the UI and refused by the API (403) when the condition fails. Conditions can be combined with AND and OR. | Losing a role mid-session. The project admin bypass (D-12). | G02, G03 | M | Eng/JA | D-12 admin bypass | S03, J2 |
| B04 | **Validators** and required fields | P0 | M | A transition with a missing required field is refused with an error for that field, and the UI shows a transition screen to fill it in. | Bulk transition where some items fail validation: all or nothing. | B03 | M | Eng | — | S03 |
| B05 | **Post functions** (set or clear a field, assign, comment) | P1 | P | They run in the same transaction as the transition and are recorded in history as done by the transition. | A post function that fails rolls the transition back. | B04 | M | Eng | — | S03 |
| B06 | Parent/child state rules | P1 (P0 if used) | M | For example, "cannot close a parent while children are open". The rule is configurable and enforced on the server. | Bulk-closing a parent and its children in one call. | B04 | M | PO | — | — |
| B07 | Workflow chosen per project **and per work-item type** | P0 | P | Each type in a project can have its own workflow. Changing an item's type maps its status. | Changing type to one whose workflow has no equivalent status. | A04 | M | Eng | D-04 | S06 |
| B08 | Reusable (shared) workflows and field configurations | P1 | M | One workflow can be used by several projects, and an edit shows which projects it affects. | Editing a shared workflow while a project overrides it. | B09 | M | PO/JA | D-04 | J2 |
| B09 | Safe publishing: validation, draft, version history, impact preview | P0 | P | The server rejects an invalid graph. Saving shows how many items are affected. Every published version is kept and can be compared. | Two admins editing at once. Publishing while items are mid-transition. | G07 | L | Eng | — | J2 |
| B10 | Mapping existing items when statuses change | P0 | P | Removing or renaming a status requires mapping its items, done in one transaction, and items are never left without a valid status. | 50k items to remap. A failure halfway through. | I03 | M | Eng | — | J5 |
| B11 | Terminal status, resolution, reopening rules | P1 | P | Moving to a done status sets the resolution and resolved date, and reopening clears them. Reports use the resolved date. | Reopening an item in a closed sprint. | A11 | H | Eng | D-06 | J7 |
| B12 | Workflow administration audit | P1 | M | Every change to a workflow, status or rule is recorded with who, when and a before/after comparison. | — | G07 | L | Eng | — | S10 |

## C · Boards, backlog and sprints

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| C01 | Kanban board with columns mapped to statuses (**several statuses per column**) | P0 | T | Columns can be configured. Columns the workflow does not allow as a destination are disabled while dragging, and the server refuses the move anyway. | A status that is not mapped to any column. | B02 | M | Eng | — | J2, M1 |
| C02 | Stable, persistent ranking | P0 | P | The order survives reloads and is the same for every user. **Ranks are rebalanced** before precision runs out (F-09). | 10k inserts at the same position. | — | H | Eng | — | — |
| C03 | Create, plan, start and complete sprints | P0 if Scrum | V | One active sprint per board, or as decided in D-13. Completion asks where unfinished work goes. | Completing a sprint while someone is editing one of its items. | — | H | Eng | D-13 | — |
| C04 | Incomplete work and scope changes | P0 if Scrum | T | Items added or removed after the sprint starts are recorded and shown in the sprint report. | Removing an item from an active sprint. | E02 | H | Eng | — | — |
| C05 | Quick filters, card layouts, swimlanes | P1 | T | Saved per board and shared by all its users. | A swimlane keyed on a deleted user. | — | M | Eng | — | J7 |
| C06 | WIP limits | P1 | P | Shown on the column. Going over the limit is either blocked or asks for confirmation, as configured. | Going over the limit through a bulk move. | — | L | PO | — | — |
| C07 | Bulk move, assign, edit, reprioritise | P1 | T | All or nothing, with permission and workflow checks on every item. Pickers show only valid values. | 1,000 items. A mix of projects. | G06 | L | Eng | — | J5 |
| C08 | Epic grouping and parent/child navigation | P0 | T | — | An epic in another project. | A05 | H | Eng | — | J10 |
| C09 | Parallel sprints, advanced boards | P2 | NA | Only if source teams use them. | — | D-13 | M | PO | D-13 | J4, J6 |
| C10 | Stable drag-and-drop order under concurrent use | P0 | P | Two users reordering at the same moment end with the same order everywhere. Nothing is lost or duplicated. | Simultaneous moves next to each other. | C02, F07 | L | Eng | — | — |
| C11 | Board access control; boards spanning projects | P1 (multi-project: P0 if used) | P | A board shows only the items its viewer may see. | A board spanning a project the viewer cannot see. | G03, D09 | M | Eng | D-14 | — |
| C12 | Responsive, accessible board and backlog | P1 | T | No axe violations. Mouse, touch and keyboard each complete the same journeys. | — | — | L | QA | — | — |

## D · Search and saved filters

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| D01 | Global search across keys, titles and descriptions | P0 | T | Matches on the key, title and description, and only returns items the user can see. | Searching for a key the user cannot see returns nothing (no 403 that confirms it exists). | G06 | L | Eng | — | J7 |
| D02 | Filter by status, priority, type, assignee, reporter, labels, dates | P0 | T | — | — | — | L | Eng | — | J7 |
| D03 | Filter by custom fields and hierarchy | P1 | M | — | — | A10 | M | Eng | — | J7 |
| D04 | Nested AND/OR | P1 | M | — | — | D09 | M | Eng | — | J7 |
| D05 | Sort, paginate, keep view state | P0 | T | Paging never repeats or skips. Each view has a stable URL. | — | — | L | Eng | — | L7 |
| D06 | Saved personal and **shared** filters with controlled access | P0 | P | A filter can be shared with users, groups or projects, and shows each viewer only what they can see. | The owner is deactivated: ownership transfers instead of deleting the filter. | G02 | H | Eng | — | J7 |
| D07 | Results respect project (and issue-level) permissions | P0 | T | Covered by the permission matrix (J03). | — | G04 | L | Eng/Sec | — | — |
| D08 | Sharing, stable URLs, ownership | P1 | P | — | — | D06 | M | Eng | — | — |
| D09 | JQL conversion or compatibility | P1 (P0 if critical filters or boards depend on it) | SU | Every saved filter and board query in the source is converted or explicitly accepted as lost. | Functions (`currentUser()`, `openSprints()`). | K07 | H | JA/Eng | D-14 | J7 |
| D10 | Highlighting, empty states, performance with large results | P1 | P | p95 under 1 s for 100k items. | — | I08 | L | Eng | — | — |

## E · Reports, dashboards and planning

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| E01 | Project summary and progress | P0 | T | Totals match a search with the same filters. | — | — | L | Eng | — | M6 |
| E02 | Sprint burndown and burnup | P1 (P0 for Scrum pilot teams) | P | **Calculated on the server from the full history (fixes F-01).** Matches figures worked out by hand on reference data. | Scope changes, reopened items. | E08, B11 | H | Eng | — | — |
| E03 | Velocity and sprint completion trend | P1 | P | — | — | C03 | H | Eng | — | — |
| E04 | Cumulative flow and WIP trend | P1 | P | Same as E02. | — | — | H | Eng | — | — |
| E05 | Cycle time, lead time, throughput | P1 | P | Same as E02. Definitions follow the status categories and are documented. | — | B11 | H | Eng/PO | — | — |
| E06 | Created vs resolved; ageing work | P1 | P | Uses the resolved date (B11). | — | B11 | H | Eng | — | — |
| E07 | Configurable dashboards and gadgets | P1 per checklist; **product decision: none** | BD | Either the source dashboards are mapped to Summary plus saved filters, or dashboards are rebuilt. | — | — | M | PO | **D-07** | M6 |
| E08 | Charts driven by saved filters with consistent calculations | P1 | M | Each chart says which filter it uses, and the numbers match the list view. | — | D06 | M | Eng | — | M6 |
| E09 | Calendar, timeline, releases | P1 | T | — | — | — | H | Eng | — | J4 |
| E10 | CSV export of permitted records | P0 | M | Exports exactly what the user can see, and each export is recorded in the audit log. | 100k rows (asynchronous). | I03, G07 | L | Eng | — | L8 |
| E11 | Cross-project reporting, portfolio planning | P2 | SU | Only if Advanced Roadmaps or Plans are used. | — | — | M | PO | D-15 | J4 |

## F · Collaboration and notifications

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| F01 | Comments, mentions, watchers, activity | P0 | V | — | Mentioning someone who cannot see the project: nobody is notified. | — | H | Eng | — | J10 |
| F02 | Reliable in-app inbox | P0 | T | Every eligible event produces exactly one notification. | Two pods processing at once. | — | L | Eng | — | J9 |
| F03 | Read/unread state, preferences, deduplication | P1 | P | Per-category preferences. No duplicates (F-14). | — | — | L | Eng | — | J9, L4 |
| F04 | Email notifications | P1 (if required) | M | Delivered asynchronously with retries and an unsubscribe. | Mail server down. | I03 | L | PO/Plat | D-09 | J9, L4 |
| F05 | Deep links | P0 | T | Every notification opens the exact item or view. | A link to an item the user can no longer see shows "no access". | — | L | Eng | — | — |
| F06 | Correct behaviour when access is restricted or revoked | P0 | P | After revocation: no new notifications, existing ones hidden, **live stream closed (F-02)**. | Revoked while a stream is open. | G11 | L | Sec/Eng | — | — |
| F07 | Live updates, reconnects, recovery | P0 | P | After a reconnect the client is consistent again: missed events are replayed or the data refetched (F-04). | Database failover. Pod restart. | — | L | Eng | — | — |

## G · Administration, access and governance

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| G01 | Corporate authentication and sessions | P0 | V | Only Entra-issued tokens for this app are accepted. Sign-out and token expiry behave predictably. | Clock skew. A token from another tenant. | — | L | Sec | — | — |
| G02 | User lifecycle, **groups**, deactivation | P0 | P | SCIM Users **and Groups**. A deactivated user loses access at once (API, PATs, live stream). | Reactivation. Changing a user's email. | — | H | Sec/Plat | D-10 | M3, S06 |
| G03 | Global permissions, project roles, project permissions | P0 | T | The matrix in `08` passes in full. | Removing the last admin is blocked. | G02 | H | Eng | D-03 permission model | J3, S06, S16 |
| G04 | Issue-level security | P0 if used | M | Restricted items are invisible everywhere (search, links, notifications, live stream, reports, export). Sub-items inherit the restriction. | A link from an unrestricted item to a restricted one. | G03 | H | Sec/JA | D-03 | J1, S07 |
| G05 | Comment and work-log visibility | P1 (P0 if used) | M | — | — | G03 | H | Sec | D-03 | S08 |
| G06 | Authorization on every endpoint and resource path | P0 | T | An automated route × role matrix passes. No route is left out (enforced by a test that lists every route). | F-05. | — | L | Sec/Eng | — | — |
| G07 | Audit log for record, workflow, permission and admin changes | P0 | M | An append-only log of who, what, when, before/after and source IP, searchable and exportable by admins. | Bulk operations, automation actors. | — | M | Sec/Eng | D-16 retention | S10, M3 |
| G08 | Administrator console and controlled configuration | P0 | P | Global admins can manage users, groups, roles, projects and the audit log in the UI. | — | G07 | L | Eng | — | M3 |
| G09 | Retention and export controls | P1 | M | — | — | G07 | L | Sec | D-16 | — |
| G10 | SAML/OIDC SSO and automated provisioning as mandated | P0 if mandated | P | Matches corporate IT's standard. | — | G02 | L | Sec | D-10 | M3 |
| G11 | Reviewable access control for attachments, search, reports, SSE | P0 | P | Losing access closes every path within one minute. | F-02. | G06 | L | Sec | — | — |

## H · Automation, bulk operations and templates

| ID | Capability | Pri | Status | Acceptance criteria | Edge cases / failure tests | Depends | Mig | Owner | Decision | Refs |
|---|---|---|---|---|---|---|---|---|---|---|
| H01 | Existing automation runs reliably | P1 | T | — | — | — | M | Eng | — | J8 |
| H02 | Configurable triggers, conditions, actions | P1 | P | Actions obey the workflow and membership rules (F-03, F-05). | — | B02 | M | Eng | — | J8, M5 |
| H03 | Validate and dry-run before enabling | P1 | M | — | — | H04 | L | Eng | — | J8 |
| H04 | Execution history and failure diagnostics | P0 for a production automation engine | M | Every run records the trigger, item, actions taken, result and error. The rule owner is notified on failure. | — | G07 | L | Eng | — | J8, J10, M7, S24 |
| H05 | Retry, idempotency, loop protection, recoverable failures | P0 for a production engine | P | — | — | I03 | L | Eng | — | — |
| H06 | Bulk operations with correct permissions | P1 | T | — | — | G06 | L | Eng | — | J5 |
| H07 | Templates with field validation | P1 | T | — | — | A10 | L | Eng | — | — |
| H08 | CSV import/export with validation and error reports | P1 | P | The server validates rows, dry-run is the default, and an error report can be downloaded. | — | I03 | M | Eng | — | L8 |
| H09 | Automation configuration audit and rule ownership | P1 | M | Each rule has an owner and an actor. | — | G07 | L | Eng | — | J8 |
| DEF-1 | Automation actions that call external systems (webhook, email to outside addresses) | DEFERRED | — | — | — | M5 milestone | — | PO | — | J8 |

## I · Reliability and operations

| ID | Capability | Pri | Status | Acceptance criteria | Depends | Owner | Decision |
|---|---|---|---|---|---|---|---|
| I01 | Backups and a **proven** restore | P0 | BD | A restore drill recovers the database and attachments to a timestamp within the agreed RPO and RTO. | I10 | Plat | D-17 |
| I02 | Migration safety and rollback | P0 | P | Expand/contract rules are written down. Every migration is tested on a production-sized copy. | — | Eng | — |
| I03 | Durable background jobs | P0 where needed (import, export, purge, email) | M | Jobs are idempotent, retried and visible. | — | Eng | — |
| I04 | Structured logs, error reporting, metrics, alerts | P0 | P | Alerts on 5xx rate, latency, database health, SSE listener down and job backlog. | — | Plat | — |
| I05 | Rate limiting, paging, performance controls | P1 | P | Limits per token and per user. | — | Eng | — |
| I06 | File validation, storage access, orphan cleanup | P0 | P | An allow-list of file types or scanning (D-18). A reconciliation job between database rows and stored files. | — | Eng/Sec | D-18 |
| I07 | Concurrency and race tests | P0 | P | See `08` §3. | — | QA | — |
| I08 | Performance tests at realistic volumes | P0 | M | Volumes come from the source inventory (K01). | K01 | QA/Plat | — |
| I09 | Health checks, deployment, runbooks | P0 | P | Runbooks for database failover, SSE outage, S3 outage and a bad deploy. | — | Plat | — |
| I10 | Agreed RTO and RPO | P0 | BD | — | — | Plat/PO | D-17 |
| I11 | Upgrade and rollback procedure | P0 | P | Tested rollback of a release that includes a migration. | I02 | Plat | — |

## J · Quality, accessibility and UX

| ID | Capability | Pri | Status | Acceptance criteria | Owner |
|---|---|---|---|---|---|
| J01 | Unit and API integration tests for critical domain logic | P0 | T | Coverage of workflow, permission, sprint and ranking code measured and above 90% of lines. | Eng |
| J02 | End-to-end journeys (item, workflow, board, sprint) | P0 | M | Committed browser suite running in CI. | QA |
| J03 | Permission matrix tests | P0 | P | Table-driven: role × route × resource. | QA/Sec |
| J04 | Regression tests for bulk, delete, restore, concurrency | P0 | P | — | QA |
| J05 | Keyboard and accessible patterns | P1 | T | Automated axe check finds 0 serious violations on the 10 key screens. | QA |
| J06 | Clear loading, empty, error, success and access-denied states | P1 | P | Copy reviewed for each state. | PO |
| J07 | Consistent design system | P1 | T | — | PO |
| J08 | Undo and recovery | P1 | T | — | Eng |
| J09 | Browser support; usability tests with real teams | P1 | M | Tested with 5 users from each pilot team. | PO |

## K · Jira Data Center migration

All K items are P0 for the cutover of the teams concerned. Details are in `06-migration-readiness.md`.

| ID | Capability | Status | Acceptance criteria | Owner |
|---|---|---|---|---|
| K01 | Inventory projects, types, fields, workflows | SU | A complete inventory export is signed off by the Jira admins. | JA |
| K02 | Map Jira users and groups to the corporate directory | SU | 100% of active users mapped; inactive users mapped to placeholders. | JA/Sec |
| K03 | Map ids, keys, types, statuses, field values | M | Mapping file, reviewed per project. | JA/Eng |
| K04 | Migrate comments, history, authorship, timestamps | M | Counts and samples match (see `06` §5). | Eng |
| K05 | Hierarchy, links, sprints, releases | M | — | Eng |
| K06 | Attachments, with integrity checks | M | Checksums match, 100% transferred or listed as exceptions. | Eng/Plat |
| K07 | Filters, boards, dashboards, automation dependencies | SU | Each one converted or given an approved disposition. | JA/PO |
| K08 | Marketplace apps and scripts as dependencies | SU | Inventory complete; each one given a disposition. | JA |
| K09 | Dry-run reports, error logs, reconciliation | M | — | Eng |
| K10 | Restartable, idempotent large imports | M | Killing the import at any point and rerunning it produces the same result. | Eng |
| K11 | Test representative teams and high-risk configurations | M | — | Pilot |
| K12 | Freeze, delta, cutover steps | M | Rehearsed twice. | PO/JA/Plat |
| K13 | Rollback criteria and sign-off owners | M | Signed. | PO |

## Deferred: plugins and integrations (M5)

| ID | Item | Why deferred |
|---|---|---|
| DEF-1 | External automation actions (webhooks, outbound email to arbitrary addresses) | New external integration. |
| DEF-2 | GitHub development panel. The code exists but is paused (`server/src/routes/github.ts`, `development.ts`). | Integration; the user paused it. |
| DEF-3 | Replacements for Marketplace apps (ScriptRunner, Tempo, Zephyr, etc.) | Need the source inventory first (K08). |
| DEF-4 | Plugin platform or extension points | Out of scope until the core release criteria are met. |
| DEF-5 | Chat integrations (Slack, Teams) | New external integration. |
