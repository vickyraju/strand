# 08 · Acceptance test plan

Each suite names the feature IDs (`01`) and findings (`02`) it proves.

**Existing tests that already count as evidence** are cited by title. Unless stated otherwise, titles come from `server/test/api.test.ts`.

**A "new" test** must be committed to the repository and run in CI before its feature can be marked VERIFIED_IMPLEMENTED.

## 1. Functional

| Suite | Tests | Proves | Existing |
|---|---|---|---|
| F-item | Create, edit, clone, delete, restore through the UI and API; history entries for every field; keys never reused | A01–A03, A07 | *"project → issue lifecycle with workflow, versions and undo"* (partial) |
| F-hier | Parent depth limit; cycles refused; links shown from both ends; links to invisible items hidden | A05, A06 | — |
| F-wf | Allowed and forbidden transitions through PATCH, bulk, automation, import and API token; conditions (role, group); validators (required fields); post functions in the same transaction; workflow per type | B01–B07 | *"bulk edit, delete and restore… workflow still enforced"*, *"workflow override…"* |
| F-wf-admin | An invalid graph is refused by the server; status remap of 50k items as a job; version history; impact count | B09, B10 | — |
| F-sprint | Start, complete with carry-over, scope change recorded, one active sprint | C03, C04 | *"sprints: one active at a time, completion snapshots and carries over unfinished work"* |
| F-search | Key, title and description matches; each filter; paging; saved and shared views; results only from projects the user can see | D01–D08 | *"paging never repeats or skips rows…"*, *"search can ask for unassigned work…"* |
| F-report | Burndown, velocity, cumulative flow, cycle time and created-vs-resolved on a **fixed reference dataset with hand-calculated expected values**, through the server API, with the full history | E02–E06, F-01 | `src/data/analytics.test.ts` (local mode only) |
| F-notify | One notification per event; mentions; watchers; preferences; no notification for a project the recipient cannot see | F01–F03, F05, F06 | Both *"mentions: …"* tests, *"due soon…"* |
| F-export | CSV export equals a search with the same filters; recorded in the audit log | E10, G07 | — |
| F-admin | Users, groups, roles and audit search in the Administration area | G08 | — |

## 2. Security and authorization

| Suite | Tests | Proves | Existing |
|---|---|---|---|
| S-matrix | **Table-driven: every route in the OpenAPI document × {outsider, viewer, member, project admin, global admin, deactivated user, PAT of each}, with the expected status code.** The test fails if any route has no row (enumerated from `server/openapi.json`). | G03, G06, J03 | *"project access: outsiders see nothing…"*, *"project members: …"* (partial) |
| S-revoke | Remove a member while they have an open live stream, an open item, a presigned URL and unread notifications. Within 60 s: the stream is closed, the API returns 404, notifications are hidden, and no new events arrive. | F06, G11, F-02 | — |
| S-issue-sec | Restricted items are invisible in search, links, notifications, live stream, reports, export and child items. | G04 | — (if used) |
| S-auth | Forged, expired and wrong-audience tokens are refused; an email cannot be claimed by another account; SCIM deactivation blocks login and PATs. | G01, G02 | *"login: …"* (2), *"SCIM: …"*, *"tokens: a deactivated owner…"* |
| S-automation | Automation cannot assign outside the project or make a forbidden transition. | F-03, F-05 | — |
| S-files | Type allow-list or scan; size limit; presigned URL expiry; no access after the item is restricted. | I06, F-10 | — |
| S-audit | Each auditable action writes exactly one append-only record, and records cannot be changed through the API. | G07 | — |
| S-ratelimit | Requests over the limit get 429; the limit applies per token. | I05 | — |

## 3. Data integrity and concurrency

| Suite | Tests | Proves |
|---|---|---|
| C-edit | Two clients PATCH the same item with the same `If-Match`: exactly one succeeds and the other gets 409. | A08 (*"…versions…"* partial) |
| C-rank | 20 clients reorder neighbouring items at the same time: the final order is identical for every reader. 10k inserts at the same position never collide (forces rebalancing). | C02, C10, F-09 |
| C-sprint | Complete a sprint while items are edited and moved: no item is lost, duplicated or left in a closed sprint unless intended. | C03, C04 |
| C-bulk | A bulk edit over items being edited concurrently is all or nothing, with no partial writes. | C07 |
| C-retry | Retrying a create, comment or import batch with the same client id never duplicates. | A08, K10 (*"create accepts a client id…"*, *"comments, sprints and settings items accept client ids"*) |
| C-sse | Kill the API pod or the database connection during edits: after reconnect the client matches the server (compare a snapshot). | F07, F-04 |
| C-delete | Delete and restore an item with children, links, attachments and a sprint: all relationships are back exactly. | A01, A12 |

## 4. Migration

| Suite | Tests | Proves |
|---|---|---|
| M-dry | A dry run produces a complete report and writes nothing. | K09 |
| M-idem | Kill the load at random points (10 runs) and resume: the final state is identical to a clean run. | K10 |
| M-recon | The `06` §5 checks pass on the R2 dataset. | K03–K06 |
| M-perm | Visibility for a sample of users is equal between source and target. | K02, G03, G04 |
| M-delta | A delta after R3 reconciles. | K12 |

## 5. Performance (volumes from Q-VOL in `03`; placeholders until known)

| Scenario | Target (to confirm in M0) |
|---|---|
| Board open for the largest project | p95 < 1.5 s |
| Search over all items | p95 < 1 s at the source's total item count |
| Item PATCH | p95 < 300 ms at 50 concurrent editors |
| Live event delivery | p95 < 2 s with 500 open streams per pod |
| Reports for a project of the largest size | p95 < 3 s |
| Migration throughput | Fits the agreed freeze window (R3 measured) |

## 6. Accessibility

Automated axe checks, with 0 serious or critical violations, on: Your work, Board, Backlog, List, Item detail, Workflow editor, Search, Inbox, Project settings › People, Administration. Manual keyboard-only and screen-reader runs of the create item, move card, plan sprint and change role journeys. Proves J05 and C12.

## 7. Backup and recovery

| Test | Pass condition | Proves |
|---|---|---|
| Point-in-time restore drill (database and S3) to a scratch environment | Restored within the agreed RTO, with data loss within the agreed RPO; the reconciliation sample matches | I01, I10 |
| Project-delete backup restore | A deleted project is restored completely: items, history, attachments | A12 |
| Failed migration rollback | The release rolls back following the procedure | I02, I11 |

## 8. End-to-end journeys (browser, committed, run in CI)

1. Sign in → create a project → add people with roles → a viewer cannot edit.
2. Create an item with an attachment, a link, a sub-item and a mention → the mentioned user sees it in the inbox.
3. Edit the workflow → add a condition and a validator → a forbidden move is refused in the UI and the API.
4. Plan a sprint by dragging, using mouse and keyboard → start → move cards → complete with carry-over → the burndown is correct.
5. Search → save a shared view → another member opens the link.
6. Remove a member mid-session → their open tabs lose access.

These prove J02 and F-12.

## 9. Release acceptance matrix (M4 gate)

| Area | Evidence required | Signed by |
|---|---|---|
| Functional acceptance | §1 and §8 pass; every P0/P1 row in `01` is V | PO |
| Security and authorization | §2 passes; penetration test report with no open high findings | Security |
| Data integrity | §3 passes | Eng lead |
| Integration dependency inventory | K08 complete; every dependency given a disposition | Jira admin lead |
| Performance and concurrency | §5 and §3 pass at source volumes | Platform |
| Backup and restore | §7 drill record | Platform |
| Operations and support | Runbooks, alerts, on-call rota, support channel | Platform, support lead |
| Migration sign-off | §4 and the `06` reconciliation report per wave | Jira admin lead, PO |
| User acceptance | Pilot report (M3) with agreed measures met | Pilot team leads |
