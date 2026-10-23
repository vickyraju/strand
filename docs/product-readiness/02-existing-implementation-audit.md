# 02 · Existing implementation audit

Repository: branch `aws-jira`, commit `352d749`, read on 23 October 2026. This document is a read-only audit; no application code was changed.

## Scope and method

- **Inventory:**
  - 78 HTTP routes in `server/src/routes/*.ts`: 70 under `/api/v1`, 7 SCIM and 1 GitHub webhook.
  - 33 distinct tables created by 11 migrations in `server/migrations/`. One was later dropped (`dashboards`) and one rebuilt (`labels`), leaving 32 live tables, 6 of which belong to the paused GitHub integration.
  - 44 React components in `src/components/`.
- **Tests:** 61 server tests in `server/test/*.test.ts` and about 130 web unit tests in `src/**/*.test.ts` and `scripts/**/*.test.mjs`. There are no committed end-to-end browser tests.
- **Tracing:** each capability was followed from the UI component to the route, the authorization and validation, the SQL and its transaction, the tests, and the error path, as far as the code allowed.
- **Statuses** use the seven values required by the brief. `VERIFIED_IMPLEMENTED` is used only where a committed automated test exercises the behaviour through the API.

### The brief's claims versus the code

| Reported capability | Finding |
|---|---|
| "Reports, dashboards" | **Dashboards were removed on purpose**: migration `20261026090000_drop_dashboards.sql`, test *"dashboards are gone: no endpoints, no table…"*. The product owner decided that a project's Summary is its dashboard. This conflicts with checklist item E07, so it is logged as decision D-07 in `09`. |
| "server-enforced transition rules" | **Only the allowed-transition graph is enforced** (`server/src/routes/issues.ts`: `applyPatch` checks `transitions` `from_ids`/`to_id`). Transition **rules** (conditions, validators, post functions) are **not implemented**; the work was paused. |
| "Reports … computed correctly" | **Defect found**: see F-01 below. |
| "Live updates" | They work, but a stream is never re-authorized after it opens (F-02), and events are not replayed after a disconnect (F-04). |

## Findings that block a pilot or need a decision

Severity: **High** means data is exposed, numbers are wrong, or data can be lost. **Medium** means a correctness or robustness gap at scale.

| ID | Severity | Finding | Evidence | Feature IDs |
|---|---|---|---|---|
| F-01 | High | **Flow reports are calculated from incomplete history when connected to the server.** Status history is read from `state.activity`, but when the app is connected to the API, `activity` starts empty and is filled only by the item detail views a user opens. Cumulative flow and cycle time therefore treat most items as never having changed status. Burndown and created-vs-resolved also read `state`, so they need verifying too. | `src/data/analytics.ts` `statusHistory()` reads `state.activity`; `src/api/map.ts` `mapWorkspace()` sets `activity: []`; `src/components/ReportsView.tsx` calls `cumulativeFlow(state, …)` and `cycleTimes(state, …)` | E02–E06, E08 |
| F-02 | High | **The live event stream is authorized only when it opens.** Someone removed from a project keeps receiving that project's events until they reconnect. | `server/src/events.ts` `subscribe()` stores the reply per project with no later check; `GET /projects/:key/events` checks the role once | G11, F06 |
| F-03 | High | **Automation can move an item through a transition the workflow forbids.** The `status` action updates `status_id` directly. | `server/src/rules.ts` `case 'status'`: `update issues set status_id = $2` | B02 |
| F-04 | Medium | **Events missed during a disconnect are lost.** Events carry no ID and are not replayed. The client reconnects with a back-off, but no full reload of the project after a reconnect was found. | `server/src/events.ts` (no `id:` field); `src/api/presence.ts` reconnect loop | F07 |
| F-05 | Medium | **Automation can assign work to someone outside the project.** The `assign` action takes any user id without the project-membership check that manual assignment uses. | `server/src/rules.ts` `case 'assign'`, compared with `server/src/access.ts` `canJoinWork()` in `applyPatch` | G06, H02 |
| F-06 | High | **No administrative audit log.** Changes to membership, roles, workflows, settings, automation rules and project deletion are not recorded anywhere. Per-item field history exists in `activity`, but only for items. | No audit table in the migrations; `server/src/routes/members.ts` and `projects.ts` write no audit rows | G07, B12, H09 |
| F-07 | High | **Deleting a project is permanent and keeps no backup.** It is limited to global admins, and the backup is an open product TODO. | `DELETE /projects/:key` in `server/src/routes/projects.ts` (`requireAdmin`); product decision recorded 23 Oct 2026 | A12, I01 |
| F-08 | Medium | **Custom field values are not validated against their definitions.** The patch schema accepts any `{string: string or number}` map; no check against the field kind or select options was found. | `server/src/routes/issues.ts` `custom: z.record(z.string(), z.union([z.string(), z.number()]))`; `field_defs.kind`/`options` in migration `20261011205352` | A10 |
| F-09 | Medium | **Ranking can run out of precision.** Rank is a `double precision` number placed between its neighbours, with no rebalancing. Repeated inserts at the same spot halve the gap each time; after about 50 such inserts the neighbours collide. | `issues.rank double precision` ("fractional; a move touches one row") in `20261011202354_core_schema.sql`; no rebalancing code found | C02, C10 |
| F-10 | Medium | **Attachments can be orphaned in both directions.** The database row is created before the upload, so a failed upload leaves a row with no file. The file is deleted after the row with no retry, so a failed delete leaves a file with no row. Soft-deleted items keep their files indefinitely. There is a 25 MB size limit but no file-type allow-list or malware scan. | `server/src/routes/files.ts` (`POST /issues/:key/attachments`, `DELETE /attachments/:id`, `MAX_BYTES`); no attachment tests | I06, K06 |
| F-11 | Medium | **No rate limiting.** No limiter plugin is registered. | `server/src/app.ts` | I05 |
| F-12 | Medium | **No end-to-end tests are committed.** Browser checks were run during development but kept only in a temporary folder. | No e2e directory in the repository | J02 |
| F-13 | Medium | **Reports need the whole project loaded in the browser.** Calculations iterate over every item held in client state, which limits project size and couples the numbers to what happens to be loaded. | `src/data/analytics.ts` | E04–E06, I08 |
| F-14 | Low | **Due-date reminders can be duplicated.** They are created when someone opens their notifications, with a "not exists" check but no unique constraint, so two API pods can both create one. | `server/src/routes/misc.ts` `ensureDueNotifications` (`and not exists (…)`) | F03 |
| F-15 | Info | **A status that is still in use cannot be deleted.** The database refuses because of the foreign key. How that error reaches the user was not traced. | `issues.status_id uuid not null references statuses` | B10 |

## Status by workstream

The evidence column cites files, symbols and test titles. Unless stated otherwise, test titles are from `server/test/api.test.ts`.

### A · Work items and data model

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| A01 | Create, view, edit, clone, delete, restore | PARTIALLY_IMPLEMENTED | `issues.ts` (`POST /projects/:key/issues`, `PATCH /issues/:key`, `DELETE`, `POST /issues/:key/restore`); tests *"project → issue lifecycle with workflow, versions and undo"*, *"bulk edit, delete and restore…"* | **Clone is missing** (no route or UI). There is no permanent purge of soft-deleted items. |
| A02 | Unique keys, readable IDs, stable internal IDs | VERIFIED_IMPLEMENTED | `uuid_v7()` ids, `projects.key` unique per workspace, `issues.key`; test *"issues and projects can be addressed by key or by id"* | Renaming a project key is not supported; whether that is acceptable is decision D-11. |
| A03 | Standard fields | PARTIALLY_IMPLEMENTED | `issues` columns in `20261011202354_core_schema.sql`; Markdown descriptions (`src/components/markdown.tsx`) | **No Resolution field.** "Rich text" is Markdown. The priority list is fixed. **No remaining estimate.** |
| A04 | Types: epic, story, task, bug, plus configurable types | PARTIALLY_IMPLEMENTED | `check (type in ('epic','story','task','bug'))` | **Configurable types are missing.** Adding a type needs a schema change. |
| A05 | Hierarchy, subtasks, links | IMPLEMENTED_NEEDS_TESTING | `issues.parent_id`, `issue_links`; `POST/DELETE /issues/:key/links` | The depth rules (epic › item › sub-item) are enforced in the client only; the server rule was not found. |
| A06 | Configurable link types | MISSING | `issue_links.type check (type in ('blocks','relates'))` | Duplicates, clones, causes and any source-specific link types are not supported. |
| A07 | Comments, mentions, attachments, history | IMPLEMENTED_NEEDS_TESTING | Comments, activity and attachment routes; mention tests *"mentions: …"* (2) | **Attachments have no automated tests** (they need S3); see F-10. |
| A08 | Version checks, conflicts, retries, undo/restore | IMPLEMENTED_NEEDS_TESTING | `If-Match` version check in `applyPatch` (409); create with a client id is idempotent (test *"create accepts a client id; reusing it conflicts…"*); undo in `src/data/history.ts` | Undo is per browser session only. There is no test of two people editing concurrently through the UI. |
| A09 | Work logs, estimates, remaining, permissions | PARTIALLY_IMPLEMENTED | `worklogs`; `DELETE /worklogs/:id` only for your own entry; `estimate`, `time_estimate` | **Remaining estimate is missing.** Editing a work log is missing. |
| A10 | Custom fields | PARTIALLY_IMPLEMENTED | `field_defs` (text, number, select, date) per project; `issues.custom jsonb` | F-08 (no validation). **Server search cannot filter by custom field.** There is no multi-select, user or cascading field type. |
| A11 | Components, affects/fix versions, resolutions | PARTIALLY_IMPLEMENTED | `releases` with a single `issues.release_id` (a fix version) | Components, affects versions and resolution are **missing**. |
| A12 | Archive, retention, controlled permanent delete | PARTIALLY_IMPLEMENTED | Project archive and restore (test *"…archive hides a project without deleting it"*); item soft delete | F-07. No retention policy and no purge job. |

### B · Workflows and configuration

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| B01 | Statuses and permitted transitions | VERIFIED_IMPLEMENTED | `statuses`, `transitions`; `src/data/workflow.ts` (32 tests in `workflow.test.ts`); server enforcement in the lifecycle test | — |
| B02 | Enforced on the server | IMPLEMENTED_NEEDS_TESTING | `applyPatch` checks transitions for single and bulk edits (test *"bulk … workflow still enforced"*) | **F-03**: automation bypasses the workflow. The `x-workflow-override` header is allowed only for project admins (test *"workflow override…"*). |
| B03 | Restrictions by role, group or permission | MISSING | — | Needs transition conditions. Groups do not exist yet (G02). |
| B04 | Required fields and validators | MISSING | — | — |
| B05 | Actions that set fields | PARTIALLY_IMPLEMENTED | Automation can react to a status change with `assign`, `priority`, `label` or `comment` (`server/src/rules.ts`) | These are project-wide automations, not post functions attached to a transition. |
| B06 | Parent/child state constraints | MISSING | — | For example, "cannot complete a parent with open children" is not enforced. |
| B07 | Workflow by project and work-item type | PARTIALLY_IMPLEMENTED | One workflow per project | **A workflow per type is missing.** |
| B08 | Reusable workflows and field configurations | MISSING | — | This was a deliberate simplification (one workflow per project); see decision D-04. |
| B09 | Safe publishing, validation, versioning, impact | PARTIALLY_IMPLEMENTED | Client-side `validateWorkflow()` (errors and warnings) and an editor with undo, saved as one update | No server-side validation of the whole graph, no version history, no draft/publish, no impact preview. |
| B10 | Mapping items when statuses change | PARTIALLY_IMPLEMENTED | The client moves items off a deleted status and then deletes it (override header); F-15 shows the database refuses to strand items | There is no server test of the remap step. |
| B11 | Terminal status, resolution, reopening | PARTIALLY_IMPLEMENTED | The "done" category acts as resolved; reopening works through ordinary transitions | **No resolution value or resolution date**, which affects reports and migration. |
| B12 | Workflow administration audit | MISSING | — | F-06. |

### C · Boards, backlog and sprints

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| C01 | Kanban columns mapped to statuses | IMPLEMENTED_NEEDS_TESTING | `BoardView.tsx`; `boardDnd.test.ts` (9) | Each column is exactly one status; several statuses per column is not supported. |
| C02 | Stable, persistent backlog rank | PARTIALLY_IMPLEMENTED | `issues.rank`; paging is stable (test *"paging never repeats or skips rows…"*) | F-09. |
| C03 | Create, plan, start and complete sprints | VERIFIED_IMPLEMENTED | Sprint routes; test *"sprints: one active at a time, completion snapshots and carries over unfinished work"* | Verified through the API only; not tested in a browser. |
| C04 | Incomplete work and scope changes | IMPLEMENTED_NEEDS_TESTING | Carry-over at completion (same test) | Scope added mid-sprint is not tracked on the server; burndown depends on F-01. |
| C05 | Quick filters, card layout, swimlanes | IMPLEMENTED_NEEDS_TESTING | `boardPrefs`; `src/components/filters.tsx` | Client-only; no tests. |
| C06 | WIP limits | PARTIALLY_IMPLEMENTED | `statuses.wip_limit`; `BoardView.tsx` shows "Max n" and highlights an over-limit column | The limit is only shown; going over it is not blocked or confirmed. |
| C07 | Bulk move, assign, edit, reprioritise | IMPLEMENTED_NEEDS_TESTING | `POST /issues/bulk/edit` (all or nothing); `BulkBar.tsx` | The bulk assignee picker is not limited to project members (open TODO). |
| C08 | Epic grouping and parent/child navigation | IMPLEMENTED_NEEDS_TESTING | Backlog grouping, epic filter, breadcrumbs in `WorkItemDetail.tsx` | — |
| C09 | Parallel sprints, advanced boards | NOT_APPLICABLE | One active sprint per project (server rule) | Becomes P2 only if source teams need it. |
| C10 | Stable drag-and-drop ordering under concurrent use | PARTIALLY_IMPLEMENTED | `backlogDnd.test.ts`, `boardDnd.test.ts` cover the client logic | No test of two people reordering at once; F-09. |
| C11 | Board access control, multi-project boards | PARTIALLY_IMPLEMENTED | Boards are per project and follow project roles | **Boards spanning several projects are missing**; see D09 and K07. |
| C12 | Accessible board and backlog interaction | IMPLEMENTED_NEEDS_TESTING | dnd-kit pointer, touch and keyboard sensors (`src/components/boardDnd.ts`) | No accessibility checks committed to the test suite. |

### D · Search and saved filters

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| D01 | Global search | IMPLEMENTED_NEEDS_TESTING | `GET /search`: `websearch_to_tsquery('simple')` over a GIN index, plus trigram `title ilike` | The `simple` configuration has no stemming. Whether descriptions are searched depends on how the `search` column is built (not traced). |
| D02 | Standard field filters | IMPLEMENTED_NEEDS_TESTING | `server/src/routes/misc.ts` `/search` query schema; test *"search can ask for unassigned work…"* | — |
| D03 | Filter by custom field and hierarchy | MISSING | — | — |
| D04 | Nested AND/OR | MISSING | Filters are combined with a flat AND | — |
| D05 | Sort, paging, saved view state | IMPLEMENTED_NEEDS_TESTING | Cursor paging (test *"paging never repeats or skips rows…"*); `src/api/remoteList.ts` | — |
| D06 | Saved personal and shared filters | PARTIALLY_IMPLEMENTED | `saved_views(owner_id, shared, filters)`; `/views` routes | "Shared" means the whole workspace; there is no sharing with a group or project, and no ownership transfer. |
| D07 | Results respect permissions | IMPLEMENTED_NEEDS_TESTING | `visible()` in `server/src/access.ts` is applied to `/search`, `/me/*` and `/labels`; test *"project access: outsiders see nothing…"* | Issue-level security does not exist (G04). |
| D08 | Stable URLs, ownership | PARTIALLY_IMPLEMENTED | `src/router.ts` encodes the query and view in the URL | When the owner of a shared view is removed, the view is deleted (`owner_id on delete cascade`). |
| D09 | JQL compatibility | SOURCE_CONFIGURATION_UNKNOWN | — | Depends on how many saved filters and boards in the source use JQL. |
| D10 | Highlighting, empty states, large results | PARTIALLY_IMPLEMENTED | Empty states in `SearchView.tsx` | No highlighting and no performance test. |

### E · Reports, dashboards and planning

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| E01 | Project summary | IMPLEMENTED_NEEDS_TESTING | `GET /projects/:key/summary`; `SummaryView.tsx` | — |
| E02–E06 | Burndown, velocity, cumulative flow, cycle time, created vs resolved | PARTIALLY_IMPLEMENTED | `src/data/analytics.ts` (4 tests against the sample data in local mode) | **F-01** and F-13. Velocity is taken from sprint snapshots on the server and is probably correct. |
| E07 | Configurable dashboards | BUSINESS_DECISION_REQUIRED | Removed on purpose (see above) | Decision D-07. |
| E08 | Charts driven by saved filters | MISSING | — | — |
| E09 | Calendar, timeline, releases | IMPLEMENTED_NEEDS_TESTING | `CalendarView.tsx`, `TimelineView.tsx`, `ReleasesView.tsx`; `POST /projects/:key/releases/:id/release` | — |
| E10 | CSV export of permitted records | MISSING | Only a whole-workspace JSON export exists, and only when running without a server (`SettingsView.tsx`) | No server export, and no export governed by permissions. |
| E11 | Cross-project and portfolio planning | SOURCE_CONFIGURATION_UNKNOWN | — | P2 unless source teams use Advanced Roadmaps or Plans. |

### F · Collaboration and notifications

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| F01 | Comments, mentions, watchers, activity | VERIFIED_IMPLEMENTED | Mention tests (2); watch routes; activity endpoint (test *"issue detail: expand … comments and history have their own paged endpoints"*) | — |
| F02 | In-app notifications and inbox | IMPLEMENTED_NEEDS_TESTING | `notifications` table; `/notifications`, read-all, archive (test *"…notifications can be read and archived"*) | — |
| F03 | Read/unread, preferences, deduplication | PARTIALLY_IMPLEMENTED | Read and archive; one notification per mention (tested) | **No notification preferences.** F-14. |
| F04 | Email | MISSING | — | Decision D-09. |
| F05 | Deep links | IMPLEMENTED_NEEDS_TESTING | `src/router.ts`; inbox items open the work item | — |
| F06 | Restricted items and revoked access | PARTIALLY_IMPLEMENTED | New notifications go only to people who can see the project (`note()`); the list is filtered by `visibleAs()` | **F-02** (live stream). Old notification text is still stored after access is revoked, even though it is hidden. |
| F07 | Live updates, reconnect, recovery | PARTIALLY_IMPLEMENTED | LISTEN/NOTIFY to SSE; the listener reconnects (`server/src/events.ts`); test *"live stream over real HTTP…"* | F-04. |

### G · Administration, access and governance

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| G01 | Corporate authentication and sessions | VERIFIED_IMPLEMENTED | Entra ID JWT validated against JWKS (`server/src/auth.ts`); tests *"login: only a valid Entra token gets in…"*, *"login: the Entra admin role claim decides admin rights…"* | Session lifetime and refresh are handled by MSAL in the browser (`src/api/auth.ts`); conditional access is not tested. |
| G02 | User lifecycle, groups, deactivation | PARTIALLY_IMPLEMENTED | SCIM `/scim/v2/Users`; test *"SCIM: token required, provisioning and deactivation block login"* | **Groups are missing**: no SCIM `/Groups` and no group grants. |
| G03 | Global permissions, project roles, project permissions | IMPLEMENTED_NEEDS_TESTING | `project_members` (admin, member, viewer), `server/src/access.ts`; tests *"project access…"* and *"project members…"* | Fixed roles with no custom permissions, and no permission schemes; decision D-03. |
| G04 | Issue-level security | MISSING | — | P0 if the source uses security levels (S07). |
| G05 | Comment and work-log visibility | MISSING | — | Same dependency on the source. |
| G06 | Authorization on every endpoint | IMPLEMENTED_NEEDS_TESTING | Role checks in the shared loaders `projectByKey()`, `issueByKey()`, attachments `owned()` | F-02, F-05. No permission matrix test covers every route (J03). |
| G07 | Audit logs | MISSING | — | F-06. |
| G08 | Administration and controlled configuration | PARTIALLY_IMPLEMENTED | Project settings limited to project admins; global admin taken from the Entra role claim | No global admin console: people, roles, deactivation and audit are not in the UI. |
| G09 | Retention and export controls | MISSING | — | — |
| G10 | SSO and provisioning | PARTIALLY_IMPLEMENTED | Entra OIDC and SCIM Users | SAML is not supported; whether it is required is decision D-10. |
| G11 | Access control for files, search, reports, SSE | PARTIALLY_IMPLEMENTED | Attachments: presigned URLs valid for 5 minutes, issued after a role check. Search and labels are scoped. | F-02. Reports are client-side, so they show only what was loaded, which is already scoped. |

### H · Automation, bulk operations, templates

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| H01 | Rules run reliably | IMPLEMENTED_NEEDS_TESTING | `runRules()` runs inside the request's transaction; test *"automation rule, notifications and search"* | The edit and the rule commit or fail together; that is good. |
| H02 | Triggers, conditions, actions | PARTIALLY_IMPLEMENTED | Triggers: created, assigned, status. Actions: assign, priority, label, status, comment. | **No conditions.** F-03, F-05. |
| H03 | Validate and test before enabling | MISSING | — | — |
| H04 | Execution history and diagnostics | MISSING | — | Compare monday.com Automations Activity (M7) and Jira "Rule executions" (J10). |
| H05 | Retry, idempotency, loop protection | PARTIALLY_IMPLEMENTED | Actions never trigger further rules (no loops); running in the transaction gives atomicity | No time-based or asynchronous triggers, so no retry mechanism exists. |
| H06 | Bulk operations with permissions | IMPLEMENTED_NEEDS_TESTING | The bulk routes go through `issueByKey` per item | Not covered by the permission matrix test. |
| H07 | Templates | IMPLEMENTED_NEEDS_TESTING | `item_templates`; `TemplatesImport.tsx` | — |
| H08 | CSV import/export with error reports | PARTIALLY_IMPLEMENTED | CSV is parsed and mapped in the browser (`src/data/csv.ts`, 2 tests) and then created item by item | No server validation, no downloadable error report, no export. |
| H09 | Automation audit and ownership | MISSING | — | — |

### I · Reliability and operations

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| I01 | Backups and proven restore | BUSINESS_DECISION_REQUIRED | Nothing in the repository (Aurora configuration lives outside it) | A restore drill is required; F-07. |
| I02 | Migration safety and rollback | PARTIALLY_IMPLEMENTED | `server/scripts/migrate.ts` (test *"migrate: applies every migration once…"*); migration Job `deploy/k8s/migrate-job.yaml` | No down migrations and no rule for expand/contract changes. |
| I03 | Durable background processing | MISSING | Automation runs inline; due reminders are lazy | Needed for imports (K10), email (F04) and purges (A12). |
| I04 | Logs, errors, metrics, alerts | PARTIALLY_IMPLEMENTED | Fastify JSON logs; 5xx errors logged (`server/src/app.ts`) | No metrics, tracing or alerting configuration. |
| I05 | Rate limits, paging, performance controls | PARTIALLY_IMPLEMENTED | Keyset paging; 20 MB request body limit | F-11. |
| I06 | File validation, storage access, orphan cleanup | PARTIALLY_IMPLEMENTED | Presigned URLs; SSE-KMS by bucket default | F-10. |
| I07 | Concurrency tests | PARTIALLY_IMPLEMENTED | Tests: first sign-in under concurrency (`first-login.test.ts`), tokens created in parallel, client-id reuse | Missing for ranking, simultaneous edits, sprint completion during edits, and bulk edits during edits. |
| I08 | Performance tests at realistic volume | MISSING | — | — |
| I09 | Health checks, deployment, runbooks | PARTIALLY_IMPLEMENTED | `/health`, `/ready`; `deploy/k8s/jira-build.yaml` | No runbooks. |
| I10 | RTO/RPO agreed | BUSINESS_DECISION_REQUIRED | — | — |
| I11 | Upgrade and rollback | PARTIALLY_IMPLEMENTED | Rolling deployment manifests | No rollback procedure written for releases that include migrations. |

### J · Quality, accessibility, UX

| ID | Capability | Status | Evidence | Gap or failure mode |
|---|---|---|---|---|
| J01 | Unit and API integration tests | IMPLEMENTED_NEEDS_TESTING | 61 server tests run against real Postgres; around 130 web tests | Coverage is not measured. |
| J02 | End-to-end journeys | MISSING | — | F-12. |
| J03 | Permission matrix tests | PARTIALLY_IMPLEMENTED | The two project-access tests | Need a table-driven test of role × route. |
| J04 | Regression tests for bulk, delete, restore, concurrency | PARTIALLY_IMPLEMENTED | The bulk test | Concurrency tests are missing. |
| J05 | Keyboard and accessible patterns | IMPLEMENTED_NEEDS_TESTING | Shortcuts, command palette, dnd keyboard sensors | No automated axe run in the test suite. |
| J06 | Loading, empty, error, success and denied states | PARTIALLY_IMPLEMENTED | Toasts and empty states; read-only state for viewers (`WorkItemDetail.tsx`, `src/data/access.ts`) | Some routes return 404 for no access and others 403; the UI copy for each was not reviewed. |
| J07 | Consistent design system | IMPLEMENTED_NEEDS_TESTING | CSS tokens in `src/index.css`; shared `src/components/ui.tsx` | — |
| J08 | Undo and recovery | IMPLEMENTED_NEEDS_TESTING | `src/data/history.ts` (2 tests); restore for items and projects | — |
| J09 | Browser support, usability testing | MISSING | — | — |

### K · Jira Data Center migration

| ID | Capability | Status | Evidence | Gap |
|---|---|---|---|---|
| K01–K13 | Inventory, mapping, history, attachments, dry run, idempotent import, cutover, rollback | MISSING (K01, K02, K07, K08: SOURCE_CONFIGURATION_UNKNOWN) | `POST /import` accepts only this app's own JSON export (test *"import: moves a reducer v4 state in with ids remapped"*); CSV import is in the browser | **There is no Jira importer.** See `06-migration-readiness.md`. |

## Summary counts

There are 117 capability IDs in total: 104 in workstreams A to J (A12, B12, C12, D10, E11, F7, G11, H9, I11, J9) and 13 in K. The tables above give E02–E06 one shared row.

The counts below were computed from those tables. The 13 migration items are counted separately: K01, K02, K07 and K08 are SOURCE_CONFIGURATION_UNKNOWN, and the other nine are MISSING.

| Status | Count (A–J) | Share |
|---|---|---|
| VERIFIED_IMPLEMENTED | 5 (A02, B01, C03, F01, G01) | 5% |
| IMPLEMENTED_NEEDS_TESTING | 27 | 26% |
| PARTIALLY_IMPLEMENTED | 44 | 42% |
| MISSING | 22 | 21% |
| NOT_APPLICABLE | 1 | 1% |
| BUSINESS_DECISION_REQUIRED | 3 | 3% |
| SOURCE_CONFIGURATION_UNKNOWN | 2 | 2% |
| **Total** | **104** | |
