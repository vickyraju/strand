# 00 · Executive summary: product readiness for replacing Jira Data Center

Date: 23 October 2026. Repository: `aws-jira` at `352d749`. This is a research and documentation package only; no application code was changed.

## Readiness in one paragraph

Strand is a substantial working product. Its core work-item, board, sprint, search, workflow-editor and project-permission features run against a real server with 61 API tests. **It is not yet ready for a secure pilot.**

- Of the 104 capabilities audited outside migration, **5 are verified by tests, 27 are implemented but need tests, 44 are partial and 22 are missing** (the remaining 6 need a decision or are not applicable; see `02`).
- Ten concrete defects (F-01 to F-10) affect report correctness, revocation of live access, workflow enforcement, auditability and data safety.
- **There is no Jira importer,** and **our Data Center configuration has not been inventoried.** Many priorities therefore cannot be fixed until the inventory exists.

## The nine questions

**1. What is implemented and verified?** A02 (keys and ids), B01 (statuses and transitions), C03 (sprints), F01 (comments, mentions, watchers) and G01 (Entra sign-in). Each is proven by a committed API test (`02`).

**2. What is present but needs stronger testing?** 27 capabilities, including the item lifecycle, server-side transition enforcement, version conflicts, boards, bulk edit, search and permission filtering, project roles, the inbox, automation and SCIM. Most lack browser end-to-end, concurrency or permission-matrix tests (`08`).

**3. What is actually missing?**
- **Admin audit log;** durable background jobs; groups;
- **Issue-level security;** comment/work-log visibility; transition conditions, validators and post functions;
- Configurable link types; filtering by custom field; nested AND/OR; filter-driven charts;
- Permission-governed CSV export; notification email and preferences; automation run history;
- Performance tests; committed end-to-end tests; the whole migration tool (`02`, `06`).

Two claims in the brief are not accurate:
- "Dashboards" were **removed by a product decision** (D-07).
- "Server-enforced transition rules": **only the transition graph is enforced; rules do not exist yet.**

**4. Which features are needed only because our Jira configuration uses them?** These are marked "P0 if used" and depend on the M0 inventory (`03` §2):
- configurable issue types, custom field types, link types, resolution, components and versions;
- workflow per type and transition rules;
- issue security and comment visibility;
- JQL compatibility, multi-project boards and parallel sprints;
- email notifications and SAML.

**5. Which competitor features are optional?** Each of these is P2 at most unless a team need is shown:
- AI suggestions, duplicate detection beyond a simple hint, triage inboxes, forms;
- Plans/portfolio views, configurable dashboard gadgets (decision D-07);
- multiple roles per person, Pulse-style digests.

UX patterns worth adopting are listed in `05` §3. Each one is tied to an existing requirement.

**6. What must be done before the first pilot?**
1. **Fix F-01 to F-10.** Reports must use the full history on the server. Live streams must close when access is revoked. Automation must obey the workflow and project membership. Ranks must be rebalanced. Custom field values must be validated. The attachment lifecycle must be made safe. Project delete must take a backup.
2. Build the audit log, the job runner and groups, plus issue security if used.
3. Build workflow conditions, validators and post functions; workflow per type if used; server-side validation of the workflow graph with an impact preview.
4. Add resolution and the resolved date.
5. Build permission-governed export and the Administration area.
6. Put operations in place: metrics, alerts, runbooks and a restore drill.
7. Complete the test suites in `08` §1–3 and §8.
8. Migrate the pilot projects with a passing reconciliation (`07` M1–M3).

**7. What must be done before switching off Jira?**
- Every P1 row in `01`.
- The migration tool, rehearsed at full size (R3–R5) with a passing reconciliation for every wave.
- The release acceptance matrix (`08` §9), signed.
- Hypercare completed.
- The source decommissioned **before 28 March 2029**, when Jira DC becomes read-only (S01). Purchases for existing customers end on 30 March 2028.

**8. What must be resolved before plugin and integration work starts?**
- M4 acceptance.
- The K08 inventory of Marketplace apps, ScriptRunner, webhooks and API consumers, with a disposition for each.
- A stable audit log and job runner: the integration foundation.
- The permission model decision (D-03), because integrations act as users or actors.

**9. What are the measurable conditions for declaring the replacement ready?** The `08` §9 matrix:
- every P0/P1 row has status V with a named test;
- 0 open high security findings;
- the permission matrix passes for every route;
- concurrency suites pass;
- performance targets are met at source volumes;
- a restore drill is within the agreed RTO and RPO;
- reconciliation is 100% (counts, keys, attachment checksums and permission samples) or differences are approved;
- the pilot measures are met, and each area's owner has signed.

## Biggest risks

| Risk | Why it matters |
|---|---|
| R-01 | Restricted Jira issues or comments could become visible after migration, if the source uses issue security. |
| R-02 / F-01 | Wrong report numbers would damage trust in the pilot. |
| R-06 / F-02 | A removed member keeps receiving live updates. |
| R-03 | The scope of workflow rules may be larger than assumed (apps, ScriptRunner). |
| R-04 | History volume versus the freeze window. |
| R-11 | Licensing timeline. |

## Critical decisions (see `09`)

- **D-03:** permission model.
- **D-06:** catalogue of types, fields and links.
- **D-07:** dashboards.
- **D-08:** backup on project delete, already requested.
- **D-14:** JQL and multi-project boards.
- **D-17:** RTO and RPO.
- **D-02:** cutover window.

## Recommended next steps

1. **Start M0 now:** the Jira administrators produce the `03` §3 inventory, and decisions D-01 to D-21 are scheduled.
2. **In parallel, fix F-01 to F-10.** They do not depend on the inventory, and the fixes are small.
3. Build the audit log and job runner, which almost every later item depends on.
4. Repeat the Mobbin research for the listed gaps, especially sprint and cycle completion (`04` limitations).

## Package contents

| File | Contents |
|---|---|
| `01-master-feature-checklist.md` | 117 capability rows plus deferred items, with priorities and acceptance criteria |
| `02-existing-implementation-audit.md` | Status per capability with code and test evidence; findings F-01 to F-15 |
| `03-jira-source-requirements.md` | Known DC facts, conditional requirements, inventory questions |
| `04-mobbin-flow-inventory.md` | 27 Mobbin searches, references, coverage matrix (32% confirmed) |
| `05-competitor-ux-analysis.md` | Interaction comparison and the recommended UX model |
| `06-migration-readiness.md` | Mapping per object type, tooling, rehearsals, cutover, reconciliation, rollback |
| `07-prioritized-roadmap.md` | Milestones M0–M5 by dependency, with backlog by priority |
| `08-acceptance-test-plan.md` | Functional, security, concurrency, migration, performance, accessibility, recovery tests; release matrix |
| `09-open-decisions-and-risks.md` | D-01 to D-21, stakeholder questions, R-01 to R-13 |
| `10-source-register.md` | Official sources with URLs, dates and confidence |
