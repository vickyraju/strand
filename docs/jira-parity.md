# Jira parity register

This register lists Jira Software Data Center capabilities. For each one it gives what Jira does, what Strand does, the decision, and the spec that deals with it. It replaces the October readiness package (`docs/product-readiness/`, still in git history). How specs are written and approved is described in `specs/README.md`.

Checked against Atlassian's Data Center documentation on 5 November 2026 (Jira Software DC 10.x/11.x).

- **Status:**
  - *match*: Strand does what Jira does.
  - *partial*: some of it.
  - *absent*: none of it.
  - *diverges*: Strand does it differently.
  - *better*: Strand does more than Jira DC without apps.
- **Decision:**
  - *match*: make or keep it like Jira.
  - *diverge*: keep it different on purpose (the reason is in the notes).
  - *out*: out of scope.
  - *open*: not decided yet.
- **Better rows:** each "better" row names the test that must keep passing, so that parity work doesn't take it away.

**Short links used below:**

| Short | Atlassian page |
|---|---|
| perm | https://confluence.atlassian.com/adminjiraserver/managing-project-permissions-938847145.html |
| gperm | https://confluence.atlassian.com/adminjiraserver/managing-global-permissions-938847142.html |
| cf | https://confluence.atlassian.com/adminjiraserver/adding-custom-fields-1047552713.html |
| board | https://confluence.atlassian.com/jirasoftwareserver/configuring-a-board-938845252.html |
| reports | https://confluence.atlassian.com/jirasoftwareserver100/reporting-1442844039.html |
| jqlfn | https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-functions-reference-939938746.html |
| jqlop | https://confluence.atlassian.com/spaces/JIRASOFTWARESERVER/pages/939938745/Advanced+searching+-+operators+reference |
| wf | https://confluence.atlassian.com/adminjiraserver/working-with-workflows-938847362.html |
| wfadv | https://confluence.atlassian.com/adminjiraserver/advanced-workflow-configuration-938847443.html |
| dc | https://confluence.atlassian.com/enterprise/jira-server-and-data-center-feature-comparison-953651628.html |

## Permissions and access

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| PRM-01 | Project permissions | About 35 permissions granted per project to roles, groups and users through permission schemes ([perm]) | Three fixed roles (`server/src/access.ts`) | diverges | diverge | 0201 | Decided 5 Nov 2026: the roles get what Jira's default scheme gives them, as one fixed table. Editable permission schemes are out of scope. |
| PRM-02 | Delete issues | Administrators by default; permanent; sub-tasks go too, an epic's issues stay ([perm]) | Project admins; sub-items go too, an epic's items stay; Undo and Project settings › Deleted work items until the retention period ends | match | match + diverge | 0202 | Undo, the list and the retention period are deliberate extras (PO, 5 and 9 Nov 2026). |
| PRM-03 | Manage sprints | Administrators default; needed in every project the board covers ([sprint permissions](https://confluence.atlassian.com/adminjiraserver/sprint-permissions-and-defined-processes-983794894.html)) | Project admins, in every project the board's filter names (0101, 0203) | match | match | 0101, 0203 | Leak fixed by 0101. |
| PRM-04 | Delete own / all attachments | Separate permissions; Delete all to Administrators ([perm]) | Members delete their own; project admins delete anyone's | match | match | 0203 | |
| PRM-05 | Edit / delete own and all comments | Separate permissions; Edit all and Delete all to Administrators ([perm]) | Authors edit and delete their own; project admins anyone's, audited as `comment.moderated` | match | match | 0203 | Viewers comment: Strand's read-and-comment role, as before. |
| PRM-06 | Comment visibility and filter sharing | Only groups and roles you belong to | Only your groups and roles (roles stack); views shared only with your groups and projects; existing entries stay; global admins any | match | match | 0203 | |
| PRM-07 | Modify reporter | A permission, Administrators by default ([perm]) | Project admins change the reporter to someone who can see the project | match | match | 0203 | |
| PRM-08 | Assignable user | Separate from Assign issues ([perm]) | Members and admins; viewers can't be given work, existing assignments stay | match | match | 0203 | |
| PRM-09 | Manage watchers | Add and remove other people; Administrators by default ([perm]) | Project admins add and remove others; everyone watches themselves | match | match | 0203 | |
| PRM-10 | Global permissions | System admins, admins, browse users, create shared objects, bulk change, group filter subscriptions ([gperm]) | The system-administrators group or the Entra role | partial | open | — | |
| PRM-11 | Issue security levels | Schemes of levels ([perm]) | `strand` only; removed on `aws-jira` | partial | diverge | — | Low priority: one team per project. |
| PRM-12 | Groups: create, delete, owners | Admins manage groups; **no rename** ([KB](https://support.atlassian.com/jira/kb/how-to-rename-a-group-in-jira/)) | Owners, a creation policy, name fixed | better | match | — | Name fixed since `20bfae4`. Keep: groups test "its name is fixed once made". |
| PRM-17 | Groups from the directory | Read-only in Jira: "can only be modified via your directory server" ([LDAP](https://confluence.atlassian.com/adminjiraserver/connecting-to-an-ldap-directory-938847052.html)); names unique | Read-only in Strand (groups, members, license cleanup); SCIM changes only directory groups; names unique, ignoring case | match | match | 0104 | Renames don't happen in the directory (PO); one would keep the group's roles. |
| PRM-18 | Deleting a group or role used to restrict comments | Jira lists where it is used first ([roles](https://confluence.atlassian.com/adminjiraserver/managing-project-roles-938847166.html)) | Comments restricted to it quietly become author-only (`access.ts`) | diverges | match | 0104 | |
| PRM-13 | Users: deactivate, don't delete | Deactivate keeps history ([users](https://confluence.atlassian.com/adminjiraserver/create-edit-or-remove-a-user-938847025.html)) | Deactivate only, including SCIM delete (`scim.ts`) | match | match | — | |
| PRM-14 | User anonymisation (GDPR) | DC 8.7+ ([anonymize](https://confluence.atlassian.com/adminjiraserver/anonymizing-users-992677655.html)) | Absent | absent | match | 0704 | |
| PRM-15 | SSO and provisioning | SAML/OIDC, directories, JIT ([saml](https://confluence.atlassian.com/adminjiraserver/saml-sso-for-jira-data-center-applications-938847031.html)) | Entra OIDC, SCIM users and groups | match | match | — | |
| PRM-16 | Personal access tokens | DC 8.14+, admins revoke ([PAT](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)) | Tokens, hash stored, System settings | match | match | — | |

## Projects

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| PRJ-01 | Archive a project | Jira admins only; archived data is read-only and hidden ([archiving](https://confluence.atlassian.com/adminjiraserver/archiving-a-project-938847621.html)) | Global admins only; read-only for everyone; hidden from lists, search and boards; Administration › Archived projects | match | match | 0102 | |
| PRJ-02 | Project key change | Admins can change it; old keys keep working ([key](https://confluence.atlassian.com/adminjiraserver/editing-a-project-key-938847080.html)) | Key fixed | absent | match | 0703 | Needs key history (0501). |
| PRJ-03 | Project key format | Uppercase letters by default ([key]) | System settings › Project keys: Jira's default pattern [A-Z][A-Z]+ and 10 characters; a new pattern must fit existing keys | match | match | 0308 | Digits need an admin to widen the pattern, as in Jira. |
| PRJ-04 | Categories, avatars | Yes | Colour only | absent | match | 0703 | |
| PRJ-05 | Delete a project | Permanent | Job with an S3 backup and restore | better | diverge | — | Keep: "project backups" test. |
| PRJ-06 | Templates | Scrum, Kanban, Basic, Business templates | Scrum, Kanban | partial | open | — | |
| PRJ-07 | Project roles to people and groups | Roles with default members | Admin, member and viewer, to people and groups | partial | diverge | 0201 | Fixed roles (PRM-01). |
| PRJ-08 | Project names | Unique, case-insensitive ([JRASERVER-3582](https://jira.atlassian.com/browse/JRASERVER-3582)) | Not unique | diverges | match | 0309 | JQL `project = "Name"` is ambiguous otherwise. |
| PRJ-09 | Who switches a project's workflow scheme | Jira admins ([managing workflows](https://confluence.atlassian.com/adminjiraserver/managing-your-workflows-938847410.html)) | Global admins | match | match | 0103 | |

## Work items and fields

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| ISS-01 | Fix version / affects version | Both multi-value | Both multi-value; releasing moves unresolved work by replacing the released version | match | match | 0301 | |
| ISS-02 | Hierarchy | Epic > standard > sub-task, enforced ([levels](https://confluence.atlassian.com/jiraportfolioserver/configuring-initiatives-and-other-hierarchy-levels-802170489.html)) | Kept by the server: epics have no parent, sub-items stay in their parent's project and have none, the parent must be visible | match | match | 0303 | |
| ISS-03 | Rank | One rank across projects (LexoRank) | One order per workspace; new work last; crowded ranks respread around the move only | match | match | 0302 | Fractions instead of LexoRank strings: same order, no rebalancing job. |
| ISS-04 | Priorities | Admin list, priority schemes, default | Fixed five, default none | diverges | match | 0305 | |
| ISS-05 | Resolutions | Admin list; set by transition screen or post function, independent of status category ([resolutions](https://confluence.atlassian.com/adminjiraserver/defining-resolution-field-values-938847105.html)) | Fixed four, set by the Done category (trigger); changing a status's category rewrites every item's resolution | diverges | match | 0305 | |
| ISS-06 | Labels | No spaces (*unconfirmed* for DC) | One word, at most 255 characters, checked everywhere; existing spaces became _ | match | match | 0307 | |
| ISS-07 | Custom field types | 20+ types ([cf]) | Text, number, select, date, per project | partial | match | 0502 | |
| ISS-08 | Custom field contexts, field configurations | Global fields with contexts; required and hidden ([context](https://confluence.atlassian.com/adminjiraserver/configuring-a-custom-field-938847235.html)) | Absent | absent | match | 0503, 0504 | |
| ISS-24 | Custom field type and options | The type can't be changed; options have ids: a rename carries to issues, a disabled option stays on issues, a deleted one is cleared ([editing custom fields](https://confluence.atlassian.com/adminjiraserver/editing-or-deleting-custom-fields-1047552719.html)) | Same: type fixed, option ids, rename/disable/delete carry through | match | match | 0105 | |
| ISS-25 | Version and component names | Unique per project | Versions not unique; components unique only case-sensitively | diverges | match | 0309 | |
| ISS-09 | Screens and screen schemes | Create, edit and view screens | Absent (transition screens exist) | absent | open | 0505 | Proposed: deliberately diverge. |
| ISS-10 | Move between projects | Yes; the old key redirects | Absent | absent | match | 0501 | |
| ISS-11 | Voting | Yes | Absent | absent | match | 0506 | |
| ISS-12 | Remote links | Yes | Absent | absent | match | 0507 | |
| ISS-13 | Archive single issues | DC 8.1+ ([dc]) | Absent | absent | match | 0508 | |
| ISS-14 | Convert to and from sub-task | Yes | Absent | absent | match | 0509 | |
| ISS-15 | Versions: merge, archive, delete with move, release moves unresolved items | Yes ([versions](https://confluence.atlassian.com/adminjiraserver/managing-versions-938847201.html)) | Delete moves fix and affects versions separately or removes them; merge; archive (hidden, locked on items); releasing moves unresolved work | match | match | 0301, 0304 | |
| ISS-16 | Components: delete with swap | Yes ([components](https://confluence.atlassian.com/adminjiraserver/managing-components-938847187.html)) | Delete moves items to another component or removes it | match | match | 0304 | |
| ISS-17 | Time tracking settings | Hours per day and days per week; `w` unit ([time](https://confluence.atlassian.com/adminjiraserver/configuring-time-tracking-938847808.html)) | System settings › Time tracking: hours per day, days per week, `w`, display format, default unit | match | match | 0306 | A bare number is now minutes (Jira's default); an admin can choose hours. |
| ISS-18 | Log work: remaining-estimate modes | Auto, leave, set, reduce ([log work](https://confluence.atlassian.com/jirasoftwareserver111/logging-work-on-issues-1652921625.html)) | Same four (`server/src/shared/estimates.ts`) | match | match | — | |
| ISS-19 | Clone | With links, sub-tasks, attachments | Children, links, sprint | match | match | — | |
| ISS-20 | Bulk change | Edit, move, transition, delete, watch; "send notification" option | Edit, delete, restore; always notifies | partial | match | 0605 | |
| ISS-21 | Flagging (impediment) | Yes | Absent | absent | match | 0408 | |
| ISS-22 | Edit presence | No | Who has the item open | better | diverge | — | Keep. |
| ISS-23 | Link types | Admin-configurable | Admin-configurable; delete moves or removes links | match | match | — | |

## Workflows

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| WF-01 | Name of an active workflow | Fixed while active; edited as a draft ([wf]) | Fixed while any project uses it; description can change | match | match | 0103 | |
| WF-02 | Remove a status that has issues from an active workflow | Refused in the draft ([wf]) | Refused (409), saying where the items are | match | match | 0103 | |
| WF-03 | Conditions, validators, post functions | Conditions and post functions; core validators are permission only ([wfadv]) | Nested all/any conditions, required/changed/parent validators, post functions | better | diverge | — | Keep: transition rules tests. |
| WF-04 | Workflow schemes per issue type | Yes | Yes | match | match | — | |
| WF-05 | Versions | Draft and publish, with a backup copy | Versions that can be loaded back; changes applied to every project as a job | better | diverge | — | Keep: "shared workflows" test. |
| WF-06 | Triggers from development tools | Branch, commit, PR | Absent (GitHub data is received) | absent | open | — | |

## Boards and agile

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AG-01 | Several boards, filters across projects, board admins | Yes ([board]) | Yes | match | match | — | Built 4 Nov 2026. |
| AG-02 | Columns with min/max, swimlanes, quick filters, card layout | Yes ([board]) | Yes | match | match | — | |
| AG-15 | Who creates and configures boards | Anyone creates; board admins and Jira admins configure ([permissions](https://confluence.atlassian.com/jirasoftwareserver/permissions-overview-939938996.html)) | Project admins create; project admins and board admins configure | diverges | diverge | — | Decided with the product owner on 4 Nov 2026: project admins plus named board admins. |
| AG-03 | Sprint completion | Unfinished work goes to a future sprint, a new sprint, or the backlog; a Done parent with unfinished sub-tasks blocks completion ([completing](https://confluence.atlassian.com/jirasoftwareserver/completing-a-sprint-938845450.html)); done means the board's rightmost column | Done category; future sprint or backlog | diverges | match | 0101, 0401 | 0101: the destinations and the sub-task rule. 0401: the rightmost column. |
| AG-04 | Reopen a sprint | From the sprint report ([reopen](https://confluence.atlassian.com/spaces/JIRASOFTWARESERVER/pages/938845456/Reopening+a+sprint)) | Absent | absent | match | 0403 | |
| AG-05 | Delete a sprint | Future or completed ([deleting](https://confluence.atlassian.com/jirasoftwareserver/deleting-a-sprint-938845460.html)) | Planned only | diverges | match | 0403 | |
| AG-06 | Parallel sprints | A global setting ([parallel](https://confluence.atlassian.com/jirasoftwareserver/using-parallel-sprints-938845513.html)) | One per board, no setting | partial | open | — | Only if asked. |
| AG-07 | Estimation statistic, time tracking per board | Yes ([estimation](https://confluence.atlassian.com/jirasoftwareserver/configuring-estimation-and-tracking-938845319.html)) | Story points only | partial | match | 0404 | |
| AG-08 | Working days | Yes | Absent | absent | match | 0405 | |
| AG-09 | Kanban backlog | Optional ([kanban backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-kanban-backlog-1688899675.html)) | Absent | absent | match | 0406 | |
| AG-10 | Epics and versions panels | In the backlog ([scrum backlog](https://confluence.atlassian.com/jirasoftwareserver/using-your-scrum-backlog-938845361.html)) | Absent | absent | match | 0407 | |
| AG-11 | Card colours | By type, priority, assignee or query ([cards](https://confluence.atlassian.com/jirasoftwareserver100/customizing-cards-1442843361.html)) | Absent | absent | match | 0409 | |
| AG-12 | Reports | Burndown, burnup, sprint, velocity, CFD, control, epic, epic burndown, release burndown, version, plus classic reports ([reports]) | Burndown, velocity, CFD, created vs resolved, cycle time, workload | partial | match | 0402, 0410, 0411 | |
| AG-13 | Dashboards and gadgets | Yes | Removed; Summary is the dashboard | absent | out | — | Product owner decision, Oct 2026. |
| AG-14 | Advanced Roadmaps (plans, teams, capacity, scenarios) | Bundled with DC ([roadmaps](https://confluence.atlassian.com/jirasoftwareserver/discover-advanced-roadmaps-for-jira-1044784153.html)) | Timeline only | partial | open | 0803 | P2. |

## Search

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| SR-01 | JQL fields and operators | All fields; WAS, CHANGED, BY, DURING… ([jqlop]) | Most fields; no history operators | partial | match | 0601, 0602 | |
| SR-02 | JQL functions | About 35 ([jqlfn]) | currentUser, now, startOfDay, endOfDay, startOfWeek, openSprints, closedSprints, membersOf, Xray functions | partial | match | 0603 | |
| SR-03 | `~` text search | Word search with stemming | Substring match (`jqlSql.ts`) | diverges | open | — | |
| SR-04 | Saved filters and sharing | View and edit sharing; admins change the owner | Same (`misc.ts`) | match | match | 0203 | Sharing limited to your own groups and projects (PRM-06). |
| SR-07 | Filter names and owner change | Unique per owner; a new owner must be able to see it and not already have one of that name ([shared filters](https://confluence.atlassian.com/adminjiraserver089/managing-shared-filters-1005347206.html)) | Not unique; owner change has no checks (`misc.ts`) | diverges | match | 0309 | |
| SR-05 | Filter subscriptions | Scheduled email | Absent | absent | match | 0604 | |
| SR-06 | Export | CSV, Excel, XML, Word, RSS, print | CSV, capped by a setting | partial | match | 0608 | |

## Notifications

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| NT-01 | Notification schemes | Events to recipients, per project ([schemes](https://confluence.atlassian.com/adminjiraserver081/creating-a-notification-scheme-970609070.html)) | Personal preferences per kind | partial | match | 0605 | |
| NT-02 | Batched email | DC 8.x | Absent | absent | match | 0606 | |
| NT-03 | Autowatch | A preference; mentions don't make watchers ([autowatch](https://confluence.atlassian.com/jirakb/how-to-stop-being-automatically-added-to-the-watcher-s-list-when-working-on-issues-298975297.html)) | Commenters and mentioned people become watchers; no preference (`issues.ts`) | diverges | match | 0606 | |
| NT-04 | Incoming mail handlers | Create issues and comments from email ([mail](https://confluence.atlassian.com/adminjiraserver/creating-issues-and-comments-from-email-938847641.html)) | Absent | absent | match | 0607 | |
| NT-05 | In-app inbox | No (Cloud only) | Inbox with read and archive | better | diverge | — | Keep: inbox tests. |

## Automation and integrations

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AU-01 | Automation | A separately licensed app on DC | Rules per project, dry run, run log | better | diverge | 0709 | Keep: automation tests. 0709 adds conditions, schedules and global rules. |
| IN-01 | Outgoing webhooks | Admin page plus a post function | Absent | absent | match | 0705 | |
| IN-02 | Development panel | Branches, commits, PRs on the issue | GitHub data received; no screen shows it | partial | match | 0707 | |
| IN-03 | Importers | CSV, JSON, other trackers | CSV with a dry run, as a job | partial | match | 0802 | A Jira DC importer that the product owner runs themselves. |
| IN-04 | Test management | An app (Xray) | Built in | better | diverge | — | Keep: testing tests. |
| IN-05 | REST API | v2 plus the Agile API | `/api/v1`, OpenAPI | partial | diverge | — | Strand's own API. Xray import endpoints are kept. |

## Administration and platform

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AD-01 | Audit log | Global and per project, coverage levels ([audit](https://confluence.atlassian.com/adminjiraserver/auditing-in-jira-938847740.html)) | Global and per project | match | match | — | |
| AD-02 | Announcement banner | Yes | Absent | absent | match | 0701 | |
| AD-03 | Look and feel | Logo and colours | Absent | absent | match | 0702 | |
| AD-04 | Rate limiting | Everyone, per node ([rate](https://confluence.atlassian.com/adminjiraserver/improving-instance-stability-with-rate-limiting-983794911.html)) | Token requests only | partial | match | 0706 | |
| AD-05 | Language packs | Yes | English only | absent | open | 0708 | |
| AD-06 | Licence cleanup | No | Rules, warnings, reports | better | diverge | — | Keep: licence cleanup tests. |
| AD-07 | Background jobs at scale | Reindex and services | Job queue for wide changes | better | diverge | — | Keep. |
