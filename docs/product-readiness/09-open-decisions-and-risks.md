# 09 · Open decisions and risks

## Decisions

Each decision names its owner, the feature IDs it unblocks, and a recommendation where the evidence supports one.

| ID | Decision | Owner | Unblocks | Options | Recommendation |
|---|---|---|---|---|---|
| D-01 | Which teams are the pilot, and what share of real usage do they represent? | PO + business owners | M3 | — | Choose teams covering Scrum and Kanban, the largest project, and at least one heavily configured project. |
| D-02 | Target cutover window, given the read-only date of 28 Mar 2029 and the last purchase date of 30 Mar 2028 | PO + finance | M4 | — | Plan cutover with the source still licensed and writable, with rollback possible. Do not set a date until after M0. |
| D-03 | Permission model: fixed roles (admin, member, viewer) and groups, or Jira-style permission schemes and custom roles? Multiple roles per person? | Security + Jira admin | G03, G04, G05, B03 | (a) Keep fixed roles and add groups; (b) custom roles; (c) full schemes | Decide from Q-S. Prefer (a) plus issue security if used. Schemes multiply the testing burden. |
| D-04 | Workflows: one per project, per type, or shared between projects? | PO + Jira admin | B07, B08 | — | Decide from Q-W1. Build "per type" if the source uses type-specific workflows. Sharing only if many projects use the same one. |
| D-05 | Description format: Markdown (current) or a rich-text document model; what happens to unconvertible wiki markup | PO | A03, K03 | — | Keep Markdown if a conversion test on R1 data loses less than an agreed share; keep the originals as attachments. |
| D-06 | Catalogue of types, fields, link types, resolutions, components and versions to support | Jira admin + PO | A04, A06, A10, A11, B11 | Required, simplify or drop per item | From Q-T, Q-F and the link inventory. |
| D-07 | **Dashboards:** the product owner removed them (Summary is the dashboard). Does the source dashboard inventory confirm that is acceptable? | PO | E07, E08 | (a) Summary plus saved-view filters; (b) a dashboard builder | (a), unless Q-D shows widely used gadgets that (a) cannot express. |
| D-08 | Backup on project delete: where it goes (S3 bucket, other), format, retention, who can restore. A global-admin setting. | PO + Platform | A12 | — | **Already requested by the PO (TODO, 23 Oct 2026).** |
| D-09 | Is email notification required? | PO + communications | F04 | — | Decide from the source notification usage. |
| D-10 | Identity: SAML needed, or Entra OIDC enough? SCIM Groups? Conditional access? | Corporate IT / Security | G02, G10 | — | OIDC with Entra is implemented; confirm and add SCIM Groups. |
| D-11 | Can project keys be renamed after creation? | PO | A02 | — | No for launch; keys match the source. |
| D-12 | Can project admins or global admins bypass transition conditions? | PO + Security | B03 | — | Only global admins, through an explicit, audited override (as today's override header). |
| D-13 | Parallel sprints per board? | PO | C03, C09 | — | Only if Q-A shows they are used. |
| D-14 | JQL compatibility and boards spanning projects | Jira admin + PO | D09, C11 | Converter; compatible syntax; manual rewrite | Decide from the number of JQL-dependent filters and boards found in Q-FL and Q-A. |
| D-15 | Portfolio and cross-project planning (Advanced Roadmaps/Plans) | PO | E11 | — | P2 unless used. |
| D-16 | Audit log retention; whether the source audit log is migrated or archived | Security / compliance | G07, G09, K | — | Archive the source audit export (it is limited to 100k events per CSV export, S11). Keep the new audit log according to the corporate retention policy. |
| D-17 | RTO and RPO for the database and attachments | Platform + PO | I01, I10 | — | Set with the infrastructure team. |
| D-18 | File handling: type allow-list, malware scanning, size limits | Security | I06 | — | — |
| D-19 | Archived projects and history depth: migrate everything, use a cut-off, or archive the rest as export files | PO + compliance | K04, A12 | — | Decide from Q-VOL. |
| D-20 | Old `/browse/KEY-123` links: redirect service? | Platform | K12 | — | Yes, because keys are kept. |
| D-21 | Rollback window after cutover and how changes made in it are handled | PO + Jira admin | K13 | — | A short window (e.g. 48 h) with a documented export of the changes made in it. |

## Questions for stakeholders

**Jira administrators:**
- the full `03` §3 inventory;
- which workflow rules are actually relied on;
- which apps are used, by whom;
- which filters are subscribed to;
- known misconfigurations that could be simplified.

**Platform engineering:**
- backup and point-in-time restore for Aurora and S3;
- observability stack;
- rate-limit standards;
- the redirect service;
- the freeze-window constraints.

**Security:**
- the permission model (D-03);
- audit requirements and retention (D-16);
- file scanning (D-18);
- the penetration test timeline;
- the identity standard (D-10).

**Representative product teams:**
- the reports they use for decisions;
- their sprint practices (parallel sprints, scope changes);
- the fields they actually fill in;
- the JQL they type by hand;
- what slows them down in Jira today.

## Risks

| ID | Risk | Likelihood | Impact | Mitigation | Feature |
|---|---|---|---|---|---|
| R-01 | The source uses issue security or restricted comments, and Strand migrates them as visible | Medium | **Critical** (data exposure) | Block such projects until G04/G05 exist; S-issue-sec test | G04, G05 |
| R-02 | Reports show wrong numbers (F-01), and teams lose trust in the pilot | High until fixed | High | Fix before the pilot; reference-dataset tests | E02–E06 |
| R-03 | The scope of workflow rules is larger than assumed (app conditions, ScriptRunner validators) | Medium | High | M0 workflow XML analysis; simplify with approvals | B03–B05, K08 |
| R-04 | History volume makes migration too slow for the freeze window | Medium | High | Staging tables, delta loads, history cut-off (D-19); timed rehearsal R3 | K04, K10 |
| R-05 | JQL-dependent boards and filters cannot be converted | Medium | Medium–High | Inventory; converter for common patterns; manual rewrites with owners | D09, C11 |
| R-06 | A removed member keeps live access (F-02) | High until fixed | High | Fix in M1 step 1; S-revoke test | G11 |
| R-07 | Project deletion loses data (F-07) | Low | Critical | Backup on delete (D-08); restore test | A12 |
| R-08 | Ranking precision collapses in busy backlogs (F-09) | Medium | Medium | Rebalancing; C-rank test | C02 |
| R-09 | No end-to-end tests are committed, so regressions reach the pilot | High | Medium | J02 in M1 | J02 |
| R-10 | Shadow use of Jira during the pilot | Medium | Medium | Freeze the pilot projects in the source | M3 |
| R-11 | Data Center licensing ends before cutover is safe | Low (if M0 starts now) | Critical | D-02; plan backwards from 30 Mar 2028 and 28 Mar 2029 | — |
| R-12 | Competitor-driven scope creep (AI, forms, triage) delays P0 | Medium | Medium | P2 rule in `01`; only add with a demonstrated need | — |
| R-13 | Research coverage gaps (no source access; partial Mobbin coverage, especially sprint completion) | Certain | Medium | `03` inventory; repeat Mobbin research for the gaps listed in `04` | — |
