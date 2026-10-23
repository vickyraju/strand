# 07 · Prioritised roadmap

Work is grouped by dependency, not by size. **No delivery dates are given:** scope depends on the M0 inventory (`03`), and dates would be invented before then. The only fixed external date is Jira DC end of life, **28 March 2029** (S01).

## Dependency spine

```
M0 inventory ─┬─> decisions D-03..D-21 ─┬─> M1 core fixes and missing P0 ─> M2 migration tooling ─> M3 pilot ─> M4 rollout ─> M5 integrations
              │                         └─> M1 groups / issue security (only if used)
              └─> volumes ─> performance tests (I08) ─> M3
```

## M0 · Current-state and requirement audit

| | |
|---|---|
| Outcomes | The source inventory is complete; every "P0 if used" row is fixed; open decisions are resolved. |
| Required work | `03` §3 inventory (Q-V … Q-VOL); decisions D-01–D-21 (`09`); this research package reviewed. |
| Dependencies | Access to the DC admin console, REST API and database statistics. |
| Acceptance | Every row in `03` §2 is resolved (required, simplify or drop) with an approver; the `01` priorities are frozen as version 1.0. |
| Risks | The inventory takes longer than expected; app usage is hard to measure. |
| Approval | PO, Jira admin lead, Security. |
| Evidence | Signed inventory and decision log. |

## M1 · Complete and validate the core product

Grouped in dependency order. Items are listed by ID; P0 items come first.

| Step | Work | IDs | Why first |
|---|---|---|---|
| 1 | **Fix correctness and security defects** | F-01 (server-side history for reports), F-02 (re-authorize or close live streams on revoke), F-03 (automation obeys the workflow), F-05 (automation assignee membership), F-09 (rank rebalancing), F-08 (custom field validation), F-10 (attachment lifecycle), F-14 | They make current behaviour wrong or unsafe. Each one is small and has no dependencies. |
| 2 | **Audit log** (append-only, written by membership, role, workflow, settings, rule, delete and export events) | G07, B12, H09 | Needed by B09, A12 and E10, and by security review. |
| 3 | **Durable job runner** (Postgres-backed queue, idempotent, retried, visible) | I03 | Needed by imports (K10), exports (E10), purges (A12), email (F04) and status remapping at scale (B10). |
| 4 | **Groups** (SCIM Groups, grant a role to a group), then **issue security** and **comment/work-log visibility** if the source uses them | G02, G04, G05 | Permission model before migration; G04 is a hard blocker for projects that use it. |
| 5 | **Workflow rules**: conditions, validators/required fields, post functions; workflow per type; server-side graph validation, versions and impact preview | B03, B04, B05, B07, B09, B10 | Already designed (paused). Depends on groups for group-based conditions. |
| 6 | **Data model completions**: resolution and resolved date, configurable types, configurable link types, custom field types required by the source, remaining estimate, components and versions if used | A03, A04, A06, A10, A11, B11 | Needed for faithful migration and correct reports (E05, E06). |
| 7 | **Reports on the server** with documented definitions; filter-driven charts; Summary panels filtered by a saved view (if D-07 keeps no dashboards) | E02–E06, E08, E07 | Depend on B11 (resolved date) and step 1. |
| 8 | **CSV export governed by permissions**; server-validated CSV import with an error report | E10, H08 | Depend on I03 and G07. |
| 9 | **Backup before project delete; retention; purge** | A12 (global-admin setting), G09 | Depends on I03 and G07. Product-owner TODO. |
| 10 | **Administration area** (users, groups, roles, audit, backups, retention) | G08 | Front end for steps 2, 4 and 9. |
| 11 | **Operations**: metrics, alerts, rate limits, runbooks, restore drill, expand/contract migration rule, rollback procedure | I01, I02, I04, I05, I09, I10, I11 | In parallel with steps 1–10. |
| 12 | **Test suites**: committed browser end-to-end tests, permission matrix, concurrency, performance at source volumes, accessibility in CI | J02, J03, J04, I07, I08, J05 | Continuous; acceptance gate for M1. |

**M1 acceptance:** every P0 row in `01` has status V (verified) with its test listed in `08`. Findings F-01 to F-10 are closed. The `08` suites pass in CI.
**Risks:** workflow rules and issue security are the largest items, and their scope depends on M0.
**Approval:** PO, Security (permission model and audit), Platform (operations).

## M2 · Migration and reconciliation capability

| | |
|---|---|
| Outcomes | Repeatable, restartable migration with dry-run and reconciliation reports. |
| Required work | `06` §2 tool; mapping files per pilot project; rehearsals R1–R2. |
| Dependencies | M1 steps 2–6 (the target model must hold the data); M0 mapping decisions. |
| Acceptance | R2 reconciliation passes for the representative set (`06` §5). |
| Risks | History volume; wiki-markup conversion; attachment throughput. |
| Approval | Jira admin lead, PO. |
| Evidence | Dry-run and reconciliation reports stored with the import history. |

## M3 · Pilot

| | |
|---|---|
| Outcomes | 2–3 representative teams work only in Strand for at least two sprints. |
| Required work | Migration of the pilot projects (R3/R4 on their data); support channel; feedback loop; usability sessions (J09). |
| Dependencies | M1 and M2 complete for the features the pilot teams use. |
| Acceptance | No P0 defects open; agreed pilot measures met (e.g. task completion time, support tickets per user per week, and report numbers matching hand-calculated values). |
| Risks | The pilot teams are not representative; the parallel source is still used ("shadow Jira"). |
| Approval | Pilot team leads, PO. |
| Evidence | Pilot report with measures, defects and decisions. |

## M4 · Operational readiness and organisation rollout

| | |
|---|---|
| Outcomes | Production operation accepted; all teams migrated in waves; source frozen, then decommissioned. |
| Required work | Release acceptance matrix (`08` §9); rehearsals R3–R5 at full size; cutover plan (`06` §4); communications; hypercare. |
| Dependencies | M3 sign-off; RTO/RPO agreed and drilled (I01, I10). |
| Acceptance | Every row of the release acceptance matrix is signed. |
| Risks | Freeze window too short for the data volume; rollback window pressure. |
| Approval | PO, Security, Platform, Jira admin lead, business owners. |
| Evidence | Signed matrix, reconciliation reports per wave, restore drill record. |

## M5 · Plugins and additional integrations

Starts **only after M4 acceptance**. Scope comes from the K08 inventory: Marketplace app replacements, ScriptRunner equivalents, webhooks, external automation actions, chat, and the GitHub development panel (already built, paused). Each needs its own requirement, priority and security review.

## Backlog by priority (summary)

| Priority | Items (see `01`) |
|---|---|
| **P0 before pilot** | A01–A03, A05, A07, A08, A12 (backup); B01, B02, B03, B04, B07, B09, B10; C01–C04 (Scrum teams), C08, C10; D01, D02, D05–D07; E01, E10; F01, F02, F05–F07; G01–G03, G06–G08, G11; I01–I04, I06–I11; J01–J04; plus every "P0 if used" item confirmed in M0 (A04, A06, A10, A11, B06, C11, D09, G04, G05, G10). |
| **P1 before Jira is switched off** | A09, A11, A12 (retention); B05, B08, B11, B12; C05–C07, C12; D03, D04, D08–D10; E02–E09; F03, F04; G05, G09; H01–H09; I05; J05–J09; K01–K13 for every wave. |
| **P2** | C09, E11, and any competitor-inspired enhancement without a demonstrated need (e.g. AI suggestions, triage inbox, forms). |
| **DEFERRED (M5)** | DEF-1 … DEF-5. |
