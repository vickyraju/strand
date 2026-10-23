# 06 · Migration readiness

**Current state:** there is no Jira importer. `POST /api/v1/import` accepts only Strand's own JSON format (test *"import: moves a reducer v4 state in with ids remapped"*), and CSV import runs in the browser (`src/data/csv.ts`). Every row below is therefore new work, except where noted.

**Do not assume that every Jira object migrates perfectly.** Each object type gets an explicit treatment, recorded in the table in §1, and anything not migrated needs a named approver.

## 1. Data coverage and mapping

| Source object | Target in Strand | Mapping rules | Fidelity risk | Treatment if unsupported | Feature |
|---|---|---|---|---|---|
| Projects (key, name, lead, category, archived) | `projects` | **Keep the key.** The lead becomes a project admin. Archived projects are imported as archived, or not at all (D-19). | Key collision with a project created in Strand before the migration. | Keys must be frozen in Strand during the migration window. | K03 |
| Issues (id, key, type, summary, description, dates, priority, reporter, assignee, labels, estimates) | `issues` | **Keep the issue key and number.** Store the Jira id in a mapping table. Convert the description from Jira wiki markup to Markdown. | Wiki markup macros (panels, `{code}`, tables) have no exact Markdown equivalent. | Keep the original markup as an attachment or hidden field (D-05). | A02, A03, K03 |
| Issue types | `issues.type` (fixed: epic, story, task, bug) | Map each source type to a target type. | **Custom types are lost** until A04 is built. | Map to the nearest type and keep the original in a label (needs approval), or build A04 first. | A04 |
| Statuses and workflows | `statuses`, `transitions` per project | Create the project workflow from the source workflow of the dominant type. | Workflows per type (B07), conditions, validators and post functions (B03–B05) are not supported. | List each lost rule and get an approval for each. | B01–B07 |
| Resolution, resolved date | — | — | **Not supported** (A11, B11). Reports on resolution would be wrong. | Build A11/B11 before migration, or map to the done category and keep the original as a label. | A11, B11 |
| Custom fields | `field_defs`, `issues.custom` | Map each field to text, number, select or date. | Multi-select, cascading, user and version pickers are not supported. | Flatten to text (loses filtering) or build the type first. | A10 |
| Components, affects/fix versions | `releases` (single fix version) | Fix version becomes the release when there is exactly one. | Several fix versions, affects versions and components are lost. | Labels as a stopgap (approval needed) or build A11. | A11 |
| Parents, sub-tasks, epics | `parent_id` | Epic Link or Parent Link, and sub-task parent, become `parent_id`. | Hierarchies deeper than Strand allows (e.g. Advanced Roadmaps levels above epic). | Flatten and record it (approval needed). | A05 |
| Issue links | `issue_links` (blocks, relates) | Map each link type. | Other link types are lost (A06). | Use relates plus a label, or build A06. | A06 |
| Comments | `comments` | Keep author and timestamps, convert markup. | Restricted comment visibility is not supported (G05). | **Do not migrate restricted comments without G05**, or they become visible to everyone. | A07, G05 |
| Change history | `activity` | One row per changed field, with author, time, from and to. | Volume: large instances have tens of millions of change items. | Optional cut-off date with an archive export (D-19). | K04 |
| Work logs | `worklogs` | Keep author, date and duration. | Work-log visibility restrictions are lost (G05). | Same as restricted comments. | A09 |
| Attachments | S3 plus `attachments` | Stream from the source file store, record a SHA-256 checksum, and keep the uploader and date. | Large files (above 25 MB, the current limit) and missing files on the source. | Raise the limit for migration only, and report missing files. | K06, I06 |
| Watchers, votes | `issue_watchers`; votes not supported | — | Votes are lost. | Approval needed. | — |
| Sprints | `sprints` | Keep name, dates, state and membership; closed sprints keep their completion snapshot. | Items that were in several sprints keep only the last one, so velocity history needs the snapshot data. | Import historical sprint reports as snapshots. | C03, E03 |
| Boards | Project board configuration | Single-project boards map to the project. | **Boards spanning projects are not supported** (C11). | A decision for each board (D-14). | C11 |
| Saved filters | `saved_views` | Convert JQL into the filter model. | Nested logic and functions are not supported (D04, D09). | Each filter is either converted, rewritten by hand or dropped, with its owner informed. | D06, D09 |
| Dashboards | None (D-07) | — | Not supported by design. | Map popular gadgets to Summary and saved views; report the rest. | E07 |
| Users and groups | `users` via SCIM, `project_members` | Match users by email or immutable id to Entra; project roles become project members. | Accounts that no longer exist; Jira groups used in grants. | Placeholder "former user" accounts, and groups once G02 exists. | K02, G02 |
| Permission and issue security schemes | `project_members` | Grants become roles in each project. | Groups, issue roles and security levels are not supported. | **Block migration of projects that use issue security until G04 exists.** | G03, G04 |
| Notification schemes | Fixed rules | — | Custom schemes are lost. | Approval needed. | F03 |
| Automation rules, ScriptRunner | `rules` (limited) | Rebuild by hand, where possible. | Most rules cannot be rebuilt today. | Inventory and treat each as DEFERRED (M5). | H, K08 |
| Marketplace apps, webhooks, API consumers | — | — | — | Inventory them as later integration dependencies (M5). | K08 |

## 2. Migration tool requirements (to build in M2)

1. **Extract:** a read-only exporter using the Data Center REST API (paged, throttled) and a stream of the attachments directory. No direct database writes to the source.
2. **Staging:** load raw source data into staging tables (`jira_src_*`), so that transformation and reconciliation can run without the source.
3. **Mapping files:** one file per project (types, statuses, fields, link types, users), versioned and reviewed (K03).
4. **Load:** idempotent by source id (upsert on `jira_id`), in batches, in dependency order: users › projects › issues › links › comments, history, work logs › attachments › sprints, filters. Restartable from any batch (K10).
5. **Modes:** `dry-run` (validate only, write a report), `load`, `delta` (changes since the last load, using `updated >= t`).
6. **Report per run:** counts per object type, rejected rows with reasons, unsupported items, time taken. These are stored and shown in an import history (UX from L8).

## 3. Rehearsal plan

| Step | Content | Exit criterion |
|---|---|---|
| R1 | Dry run of one small project | Report with zero unexplained rejections |
| R2 | Full load of a representative set: the largest project, the most configured project, and one project per high-risk feature (issue security, custom types, JQL boards) | Reconciliation (§5) passes; pilot teams accept their data |
| R3 | Full production-size rehearsal, timed | Duration fits the agreed freeze window |
| R4 | Delta rehearsal (changes after R3) | The delta reconciles |
| R5 | Second full rehearsal on the final build | Same as R3 |

## 4. Cutover

1. **Announce** the freeze window, the read-only period and support contacts (communications owner: PO).
2. **Freeze:** set the source projects to read-only, using a Jira permission scheme change that is documented and reversible.
3. **Final delta** load, then reconcile (§5).
4. **Sign-off** gate: PO, Jira admin and Security.
5. **Switch:** links and bookmarks redirect. Issue keys are unchanged, so `/browse/KEY-123` must redirect to `/project/KEY/…` (a redirect service is needed, decision D-20).
6. **Hypercare** for 2 weeks, with a daily review of support tickets.

## 5. Reconciliation (evidence for K09)

| Check | Method | Pass condition |
|---|---|---|
| Counts | Per project, compare source and target counts of issues, comments, change items, work logs, attachments, links, sprints | Equal, or the difference fully explained by approved exclusions |
| Keys | Every source key resolves in the target | 100% |
| Sample fidelity | Random 1% (at least 50 per project): every field, comment, history entry and attachment checksum compared | 100% match on migrated fields |
| Permissions | For a sample of users, the issues visible in the source equal those visible in the target | Equal |
| Totals | Sum of story points per sprint; open items per assignee | Equal |
| Attachments | SHA-256 for every file | 100%, or listed exceptions |

## 6. Rollback and recovery

- **Rollback trigger:** reconciliation fails, or a P0 defect is found in hypercare that has no workaround. **Trigger owner:** PO with the Jira admin.
- **Rollback action:** unfreeze the source (reverse the permission scheme change). Changes made in Strand after cutover are exported for manual re-entry, so the rollback window must be short and agreed in advance (D-21).
- **Point of no return:** when the source is decommissioned. This must be before **28 March 2029** (S01) and after hypercare.
