# 03 · Jira Data Center source requirements

**Our Data Center instance is the source of truth, and it has not been examined yet.** No configuration export, version number, app list, database statistics or usage data were available to this research. So:

- §1 lists what is known: the platform facts from Atlassian's Data Center documentation.
- §2 lists every behaviour that will become a requirement **only if our instance uses it**. Each is marked `SOURCE_CONFIGURATION_UNKNOWN` until the inventory in §3 answers it.
- §3 is the inventory the Jira administrators need to produce. It is the first task of milestone M0.

**Nothing here describes Jira Cloud behaviour as if it were our source.** Cloud appears only where the documents say "Cloud".

## 1. Known facts (Jira Data Center platform)

| # | Fact | Planning consequence | Source |
|---|---|---|---|
| K-1 | Jira DC becomes **read-only on 28 March 2029** (23:59 PST). Existing customers can buy new subscriptions, apps and expansions until **30 March 2028**. Support and critical security fixes continue until end of life. Extended maintenance is available only by exception. | This is the latest date for cutover with the source still writable. Any delay past March 2028 limits options to renewals that end on 28 March 2029. **No release date is set for this product.** | S01 |
| K-2 | Workflows have conditions (whether a user may run a transition, hidden on failure), validators (input checks; on failure neither the transition nor post functions run) and post functions (run after the transition). Conditions can be grouped and nested. Apps can add their own. | Strand has none of the three (B03–B05). How much we need depends on how many workflows use them (§3 Q-W2). | S03, S04 |
| K-3 | Permissions come in three layers: **global**, **project** (permission schemes granting to users, groups, project roles, issue roles and picker fields) and **issue security** (security schemes). **There are no field-level permissions.** | Strand has fixed project roles only (G03). Groups, issue roles and schemes are missing. We do not need field-level security for parity. | S06 |
| K-4 | Issue security levels restrict who can see an item. Sub-tasks inherit the level. Switching scheme requires mapping the levels. | If the source uses them, G04 is P0, because missing it would expose restricted items after migration. | S07 |
| K-5 | Project roles are defined globally and filled per project. They are used in permission schemes, notification schemes, issue security, **comment visibility** and **workflow conditions**. | Role usage beyond permissions drives G05 and B03. | S08 |
| K-6 | The audit log records configuration changes and some issue events (at the Advanced and Full levels); it **does not record field updates**, which are in each issue's changelog. Audit export is limited to 100k events (CSV), with REST also available. | The history to migrate is the issue changelog (K04). Whether to migrate the source audit log is decision D-16. | S10, S11 |
| K-7 | Issue history is available through REST `GET /rest/api/2/issue/{key}?expand=changelog`. | This is the primary history extraction path (version to confirm). | S12 |
| K-8 | An XML backup **excludes attachments**; attachments live on the file system and are backed up separately. Restoring a single project needs its attachments restored as part of that import. | Attachment migration is a separate pipeline with checksums (K06). | S13, S14 |
| K-9 | Jira 11.2 deprecates Browse Projects permission properties in favour of issue security plus automation. | If the source is ≥ 11.2 and uses this pattern, it means issue security (G04) is in use. | S09 |

## 2. Behaviours that become requirements only if the source uses them

| Area | Source behaviour to check | If used, then | Feature ID | Status |
|---|---|---|---|---|
| Issue types | Custom issue types; sub-task types; per-project issue type schemes | Configurable types are P0 | A04, B07 | SOURCE_CONFIGURATION_UNKNOWN |
| Fields | Custom fields by type: multi-select, cascading select, user picker, group picker, version picker, labels-like, date-time, number, URL, text area; field contexts per project | Their types must be supported and searchable | A10, D03 | SOURCE_CONFIGURATION_UNKNOWN |
| Field configuration | Required fields; hidden fields; screens per operation (create, edit, transition) | Required fields and transition screens | B04 | SOURCE_CONFIGURATION_UNKNOWN |
| Workflows | Conditions, validators and post functions in use, and which ones (built-in or app) | B03–B05 are P0 for those projects | B03–B05 | SOURCE_CONFIGURATION_UNKNOWN |
| Workflow schemes | Different workflows per issue type within a project; workflows shared by projects | B07, B08 | B07, B08 | SOURCE_CONFIGURATION_UNKNOWN |
| Resolutions | Resolution values, and reports or filters that use `resolution` or `resolved` | Resolution field and date | A11, B11, E06 | SOURCE_CONFIGURATION_UNKNOWN |
| Components and versions | Components (with leads, default assignee); affects/fix versions | A11 | A11 | SOURCE_CONFIGURATION_UNKNOWN |
| Link types | Every link type name and its two directions | A06 | A06 | SOURCE_CONFIGURATION_UNKNOWN |
| Permissions | Permission schemes, grants to groups, issue roles (reporter, assignee), custom-field grants | Groups (G02) and a richer permission model (D-03) | G02, G03 | SOURCE_CONFIGURATION_UNKNOWN |
| Issue security | Security schemes and levels, and the number of restricted issues | G04 is P0 | G04 | SOURCE_CONFIGURATION_UNKNOWN |
| Comment visibility | Comments restricted to a role or group | G05 is P0 | G05 | SOURCE_CONFIGURATION_UNKNOWN |
| Agile | Board types (Scrum or Kanban); boards built on JQL that span several projects; parallel sprints; estimation statistic (points or time) | C09, C11, D09 | C09, C11 | SOURCE_CONFIGURATION_UNKNOWN |
| Filters | Number of saved filters; shared filters; filter subscriptions (scheduled emails); JQL functions in use (including app functions) | D06, D09, F04 | D06, D09 | SOURCE_CONFIGURATION_UNKNOWN |
| Dashboards | Number of dashboards and gadget types in active use | Decision D-07 | E07 | SOURCE_CONFIGURATION_UNKNOWN |
| Notifications | Notification schemes; email reliance; personal preferences | F03, F04 | F03, F04 | SOURCE_CONFIGURATION_UNKNOWN |
| Time tracking | Time tracking switched on; remaining estimate; work-log visibility | A09, G05 | A09 | SOURCE_CONFIGURATION_UNKNOWN |
| Automation | Automation for Jira rules (count, triggers, actions); ScriptRunner listeners and scripts | H01–H05, DEF-1/DEF-3 | H | SOURCE_CONFIGURATION_UNKNOWN |
| Apps | Marketplace apps installed and **actually used** (e.g. Tempo, Zephyr/Xray, ScriptRunner, Structure, Advanced Roadmaps) | Each is listed as a later dependency (DEF-3) or a migration exception | K08 | SOURCE_CONFIGURATION_UNKNOWN |
| API consumers | Applications, scripts and webhooks that call Jira's API (CI, chatbots, reporting tools) | A list of integrations to rebuild in M5; a compatibility decision | K08 | SOURCE_CONFIGURATION_UNKNOWN |
| Identity | User directory (AD/LDAP, Crowd, SSO), groups used in permissions, number of inactive users | G02, K02 | G02, K02 | SOURCE_CONFIGURATION_UNKNOWN |
| Volumes | Projects, issues, comments, change items, attachments (count and GB), the largest project | Performance tests (I08); migration sizing | I08, K10 | SOURCE_CONFIGURATION_UNKNOWN |
| Archived | Archived projects and issues (a DC feature) | Decide whether to migrate, export or drop them | A12, K | SOURCE_CONFIGURATION_UNKNOWN |

## 3. Inventory to produce (owner: Jira administrators, milestone M0)

Each item needs the **count, the projects affected and the teams that depend on it**. For each item that is used, record whether it is required, can be simplified (with the stakeholder who approves that), or can be dropped.

| # | Question | Suggested method (to be confirmed against the source version's documentation) |
|---|---|---|
| Q-V | Jira version, deployment (single node or cluster), database engine | Administration › System info |
| Q-P1 | List of projects with key, lead, type, issue count, last-updated date, archived flag | REST `/rest/api/2/project` plus a JQL count per project; database statistics |
| Q-T | Issue types and issue type schemes per project | REST `/rest/api/2/issuetype`; admin UI |
| Q-F | Custom fields: type, contexts, number of issues with a value, used in which screens, filters and boards | REST `/rest/api/2/field`; admin "Custom fields" (shows usage counts in recent DC versions) |
| Q-W1 | Workflows and workflow schemes per project | Admin › Workflows, export as XML |
| Q-W2 | Conditions, validators and post functions per transition, and which apps supply them | Workflow XML export (search for `condition`, `validator`, `function` elements) |
| Q-S | Permission schemes, grants, project role membership | REST `/rest/api/2/permissionscheme`; `/rest/api/2/project/{key}/role` |
| Q-IS | Issue security schemes, levels and the number of issues per level | Admin; JQL `level is not EMPTY` |
| Q-CV | Number of comments with restricted visibility | Database query, or REST sampling |
| Q-A | Boards (type, filter, projects covered), sprints (active and closed counts) | REST `/rest/agile/1.0/board` |
| Q-FL | Saved filters: owner, sharing, subscriptions, JQL text | REST `/rest/api/2/filter/search` (if available in the version); database |
| Q-D | Dashboards and gadgets, with last-viewed data where available | Admin; database |
| Q-AU | Automation rules and ScriptRunner scripts or listeners | Automation export; ScriptRunner admin |
| Q-AP | Installed apps and licensed users per app | Universal Plugin Manager |
| Q-API | API consumers: personal access tokens, application links, webhooks, access log analysis by user agent | Admin › Webhooks, Application links; access logs |
| Q-U | Users (active and inactive), groups, directory source | Admin › User management; directory configuration |
| Q-VOL | Volumes: issues, comments, change items, work logs, attachments (count, GB, largest file) | Database statistics; attachments directory size |

## 4. Gate

Milestone M0 is complete only when every row in §2 has moved from `SOURCE_CONFIGURATION_UNKNOWN` to one of:
- **Required**, with a feature ID and priority;
- **Simplify**, with the approver named;
- **Drop**, with the approver named.

The priorities in `01` marked "P0 if used" are then fixed.
