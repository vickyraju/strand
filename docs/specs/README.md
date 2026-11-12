# Specs

Jira Build POC is built spec first. Every behaviour starts as a spec in this folder and is approved before any code is written. The app replaces Jira Data Center, so a spec starts from what Jira does: it follows Jira, or it says why not.

## Principles

- **Core work behaves as in Jira.** People moving from Jira Data Center find the same rules and the same flow for their everyday work. Where the app does something Jira doesn't, Jira's behaviour wins.
- **Extras only add.** An app-only feature is welcome when it improves the experience on top of Jira's behaviour (Undo, a live count, a dry run). It never replaces or changes how Jira works.
- **Jira data moves in without loss.** Every data model and rule is designed so that data from Jira DC can be migrated directly, without reshaping it or dropping anything (multi-valued fields, keys, ranks, resolutions, history).
- **Better than Jira, not only the same.** Before a spec is written, look at what Jira's own users say about the feature and what Atlassian has left open: discussions on the [Atlassian Community](https://community.atlassian.com), and suggestions and bugs on [Atlassian's tracker](https://jira.atlassian.com). A spec lists them, with what the app could do better, in its **Community and Atlassian backlog** section. These improvements are proposals; each is chosen before it is built.
- **Limits are settings.** Defaults are Jira's defaults. A limit or policy is a System setting, never a constant in the code.
- **Built for scale.** 40,000 people and 6,000 projects: lists page on the server, and wide changes run as background jobs.

## How a spec moves

| Status | Meaning |
|---|---|
| Draft | Being written, from Jira's documentation and the code. |
| In review | Waiting for approval. An open question that isn't answered takes its "Jira way" default. |
| Approved (date) | Code may start. |
| Implemented | Built, with every rule covered by a test. |
| Verified (date) | Checked by hand against Jira and the rule coverage check below. |
| Decided | A decision with nothing to build. |

If building shows that the spec is wrong, the spec changes first (in its changelog) and is approved again.

## Writing one

- Copy `_template.md` to `NNNN-short-name.md`. The first two digits are the phase:
  - `00` foundations: the modules every later spec builds on (sign-in, projects, work items, workflows, boards, search…);
  - `01` correctness and security;
  - `02` permissions;
  - `03` data model;
  - `04` agile;
  - `05` issues and fields;
  - `06` search and notifications;
  - `07` administration and platform;
  - `08` Jira migration tools and planning.
- Each rule is one behaviour that a test can check, numbered `R1`, `R2`, and so on. Rules aren't renumbered: a dropped rule stays, marked as withdrawn.

## Tracing rules to tests

- Test titles start with the rule ids they prove: `test('[0101.R2] completing a sprint …')`. This applies to server tests, web unit tests and browser journeys. A permission matrix row carries a `// 0101.R1` comment.
- Commit messages name the spec they implement, with a trailer such as `Spec: 0101 R1-R4`.
- `python3 scripts/spec-coverage.py .` checks every spec: each rule must be cited by a test, or its spec's acceptance table must say why not.

## Index

Foundations come first; then, in roadmap order, bugs, the permission model, the data model (which must be right before any import), and breadth.

| Spec | Title | Phase | Status |
|---|---|---|---|
| [0001](0001-entra-sign-in-first-admin.md) | Signing in with Microsoft Entra; the first administrator | 00 | Implemented |
| [0002](0002-personal-access-tokens.md) | Personal access tokens | 00 | Implemented |
| [0003](0003-rest-api-conventions.md) | REST API and database conventions | 00 | Implemented |
| [0004](0004-projects-project-roles.md) | Projects and project roles | 00 | Implemented |
| [0005](0005-groups-system-groups.md) | Groups and system groups | 00 | Implemented |
| [0006](0006-people-administration-scim.md) | People administration and SCIM provisioning | 00 | Implemented |
| [0007](0007-work-items.md) | Work items | 00 | Implemented |
| [0008](0008-loading-and-saving.md) | The web app and the server: loading and saving | 00 | Implemented |
| [0009](0009-comments-mentions-notifications.md) | Comments, mentions and notifications | 00 | Implemented |
| [0010](0010-workflows-statuses-resolution.md) | Workflows, statuses and resolution | 00 | Implemented |
| [0011](0011-workflow-editor.md) | The workflow editor | 00 | Implemented |
| [0012](0012-transition-rules.md) | Transition rules | 00 | Implemented |
| [0013](0013-work-types.md) | Work types | 00 | Implemented |
| [0014](0014-boards.md) | Boards | 00 | Implemented |
| [0015](0015-backlog-sprints-ranking.md) | Backlog, sprints and ranking | 00 | Implemented |
| [0016](0016-time-tracking.md) | Time tracking | 00 | Implemented |
| [0017](0017-components.md) | Components | 00 | Implemented |
| [0018](0018-jql-search.md) | JQL search | 00 | Implemented |
| [0019](0019-saved-views.md) | Saved views and sharing | 00 | Implemented |
| [0020](0020-automation-rules.md) | Automation rules | 00 | Implemented |
| [0021](0021-reports-your-work.md) | Reports and Your work | 00 | Implemented |
| [0022](0022-csv-app-file-import-export.md) | Import and export: CSV and app files | 00 | Implemented |
| [0023](0023-attachments.md) | Attachments and file storage | 00 | Implemented |
| [0024](0024-link-types.md) | Link types and issue links | 00 | Implemented |
| [0025](0025-audit-log.md) | Audit log | 00 | Implemented |
| [0026](0026-background-jobs.md) | Background jobs | 00 | Implemented |
| [0027](0027-project-backups.md) | Project backups | 00 | Implemented |
| [0028](0028-administration-system-settings.md) | Administration and system settings | 00 | Implemented |
| [0029](0029-rate-limiting.md) | Rate limiting | 00 | Implemented |
| [0030](0030-test-management.md) | Test management (Xray compatible) | 00 | Implemented |
| [0031](0031-github-integration.md) | GitHub development integration | 00 | Implemented |
| [0032](0032-live-updates-presence.md) | Live updates and edit presence | 00 | Implemented |
| [0033](0033-dependency-release-age-notices.md) | Dependencies: release age and licence notices | 00 | Implemented |
| [0101](0101-sprint-actions-across-board-projects.md) | Sprint actions need a role in every project the board covers; completing as in Jira | 01 | Verified |
| [0102](0102-archived-projects-read-only.md) | Archived projects are read-only; only global admins archive | 01 | Implemented |
| [0103](0103-active-workflows.md) | Active workflows keep their name and statuses with work; only global admins switch a project's scheme | 01 | Implemented |
| [0104](0104-directory-groups.md) | Groups from the directory are read-only in the app; unique group names | 01 | Implemented |
| [0105](0105-custom-field-options.md) | Custom fields: type fixed once made; options that rename, disable and delete as in Jira | 01 | Implemented |
| [0106](0106-delete-group-swap-comments.md) | Deleting a group used to restrict comments: move them to another group | 01 | Implemented |
| [0201](0201-permission-table.md) | One table of Jira's project permissions for the app's three roles | 02 | Implemented |
| [0202](0202-deleting-items.md) | Deleting work items: project admins only, sub-items go too, epics' items stay; Undo kept for a set time | 02 | Implemented |
| [0203](0203-default-permissions.md) | The rest of Jira's default permission scheme: sprints, attachments, comments, sharing, reporter, watchers, assignees | 02 | Implemented |
| [0301](0301-fix-versions.md) | Several fix versions on a work item | 03 | Implemented |
| [0302](0302-global-rank.md) | One rank order for all work items | 03 | Implemented |
| [0303](0303-hierarchy.md) | The hierarchy is kept by the server: epic > item > sub-item | 03 | Implemented |
| [0304](0304-versions-components.md) | Versions and components: move work when deleting, merge versions, archive versions | 03 | Implemented |
| [0305](0305-priorities-resolutions.md) | Priorities and resolutions as admin lists | 03 | Implemented |
| [0306](0306-time-tracking.md) | Time tracking settings: hours per day, days per week, display format, default unit | 03 | Implemented |
| [0307](0307-labels.md) | Labels without spaces | 03 | Implemented |
| [0308](0308-project-key.md) | Project key pattern and length as System settings | 03 | Implemented |
| [0309](0309-unique-names.md) | Names that must be unique: projects, versions, components, filters per owner | 03 | Implemented |
| [0310](0310-project-templates.md) | Project templates: Basic software and Business | 03 | Implemented |
| [0401](0401-sprint-done-column.md) | Completing a sprint: done means the board's rightmost column | 04 | Implemented |
| [0402](0402-sprint-report.md) | Sprint Report | 04 | Implemented |
| [0403](0403-reopen-delete-sprint.md) | Reopen a completed sprint; delete a completed sprint | 04 | Implemented |
| [0404](0404-board-estimation.md) | Each Scrum board's estimation statistic: story points, original time estimate, or issue count | 04 | Implemented |
| [0405](0405-working-days.md) | Working days on a board | 04 | Implemented |
| [0406](0406-kanban-backlog.md) | Kanban backlog | 04 | Implemented |
| [0407](0407-epics-and-versions-panels.md) | Epics and versions panels | 04 | Implemented |
| [0408](0408-flagging.md) | Flagging a work item | 04 | Implemented |
| [0409](0409-card-colours.md) | Card colours on a board | 04 | Implemented |
| [0410](0410-control-chart.md) | Control chart | 04 | Implemented |
| [0411](0411-version-epic-release-reports.md) | Version, epic, epic burndown, release burndown and burnup reports | 04 | Implemented |
| [0412](0412-estimation-time-tracking-time-zone.md) | Estimation by any number field, remaining-estimate tracking, and the team's time zone | 04 | Implemented |
| [0414](0414-parallel-sprints.md) | Parallel sprints | 04 | Implemented |
| [0501](0501-move-items-between-projects.md) | Move items between projects | 05 | Implemented |
| [0502](0502-more-custom-field-types.md) | More custom field types | 05 | Implemented |
| [0503](0503-global-custom-fields-contexts.md) | Global custom fields with contexts | 05 | Implemented |
| [0504](0504-field-configurations.md) | Field configurations: required and hidden | 05 | Implemented |
| [0505](0505-screens.md) | Screens | 05 | Implemented |
| [0506](0506-voting.md) | Voting | 05 | Implemented |
| [0507](0507-remote-links.md) | Remote links | 05 | Implemented |
| [0508](0508-archive-single-items.md) | Archive single items | 05 | Implemented |
| [0509](0509-convert-sub-items.md) | Convert to and from sub-items | 05 | Implemented |
| [0510](0510-bulk-transition-watch.md) | Bulk transition, watch and stop watching | 05 | Implemented |
| [0601](0601-field-change-history.md) | Field change history, indexed | 06 | Implemented |
| [0602](0602-jql-history-operators.md) | JQL history operators | 06 | Implemented |
| [0603](0603-jql-functions.md) | Missing JQL functions | 06 | Implemented |
| [0604](0604-filter-subscriptions.md) | Filter subscriptions | 06 | Implemented |
| [0605](0605-notification-schemes.md) | Notification schemes; bulk change without notifying | 06 | Implemented |
| [0606](0606-batched-email-autowatch.md) | Batched email, autowatch, mentions don't make watchers | 06 | Implemented |
| [0607](0607-incoming-mail.md) | Incoming mail | 06 | Implemented |
| [0608](0608-print-xml-export.md) | Print and XML export | 06 | Implemented |
| [0609](0609-text-search-stemming.md) | Text search as Jira's: words, stemming and Lucene syntax | 06 | Implemented |
| [0701](0701-announcement-banner.md) | Announcement banner | 07 | Implemented |
| [0702](0702-look-and-feel.md) | Look and feel | 07 | Implemented |
| [0703](0703-project-key-categories-avatars.md) | Project key change, categories and avatars | 07 | Implemented |
| [0704](0704-user-anonymisation.md) | User anonymisation | 07 | Implemented |
| [0705](0705-outgoing-webhooks.md) | Outgoing webhooks | 07 | Implemented |
| [0706](0706-rate-limiting-for-everyone.md) | Rate limiting for everyone | 07 | Implemented |
| [0707](0707-development-panel.md) | Development panel | 07 | Implemented |
| [0708](0708-languages.md) | Languages (decision) | 07 | Decided: English only |
| [0709](0709-automation-conditions-schedules-global.md) | Automation: conditions, schedules, global rules | 07 | Implemented |
| [0710](0710-remove-license-cleanup.md) | Remove License cleanup | 07 | Implemented |
| [0711](0711-authentication-methods.md) | Authentication methods: Entra SSO configured in Administration, the login form, fallback and recovery | 07 | Implemented |
| [0712](0712-user-directories.md) | User directories: Active Directory and LDAP, Read Only, as in Jira | 07 | Implemented |
| [0713](0713-incremental-directory-sync.md) | Incremental directory synchronisation | 07 | Implemented |
| [0714](0714-local-users.md) | Local users: Jira's internal directory | 07 | Implemented |
| [0715](0715-webhooks-every-jira-event.md) | Webhooks: every Jira DC event, Jira's payloads | 07 | Implemented |
| [0716](0716-epic-status.md) | Epic Status | 07 | Implemented |
| [0717](0717-global-permissions.md) | Global permissions | 07 | Implemented |
| [0718](0718-workflow-triggers.md) | Workflow triggers from development tools | 07 | Implemented |
| [0719](0719-collapsed-menu-logo.md) | A logo for the collapsed menu | 07 | Implemented |
| [0801](0801-jira-inventory.md) | Jira inventory tool, run by the product owner | 08 | Implemented |
| [0802](0802-jira-importer.md) | Jira DC importer with dry run and reconciliation | 08 | Implemented |
| [0803](0803-planning.md) | Planning like Advanced Roadmaps (decision) | 08 | Implemented |
| [0805](0805-jira-text-formatting.md) | Jira's text formatting, imported | 08 | Implemented |
| [0806](0806-jira-addresses.md) | Jira's addresses open in the app | 08 | Implemented |
