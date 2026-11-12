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
| PRM-10 | Global permissions | System admins, admins, browse users, create shared objects, bulk change, group filter subscriptions ([gperm]) | Administration › Global permissions: System administrators (the system-administrators group, the Entra role, plus groups granted), Browse users and groups, Create shared objects, Manage group filter subscriptions, Bulk change, each granted to groups | partial | match | 0717 | Jira administrators (the lesser admin) is proposal P1; boards keep Strand's rule (AG-15) |
| PRM-11 | Issue security levels | Schemes of levels ([perm]) | `strand` only; removed on `aws-jira` | partial | diverge | — | Low priority: one team per project. |
| PRM-12 | Groups: create, delete, owners | Admins manage groups; **no rename** ([KB](https://support.atlassian.com/jira/kb/how-to-rename-a-group-in-jira/)) | Owners, a creation policy, name fixed | better | match | — | Name fixed since `20bfae4`. Keep: groups test "its name is fixed once made". |
| PRM-17 | Groups from the directory | Read-only in Jira: "can only be modified via your directory server" ([LDAP](https://confluence.atlassian.com/adminjiraserver/connecting-to-an-ldap-directory-938847052.html)); names unique | Read-only in Strand (groups and members); SCIM changes only directory groups; names unique, ignoring case | match | match | 0104 | Renames don't happen in the directory (PO); one would keep the group's roles. |
| PRM-18 | Deleting a group or role used to restrict comments | Jira lists where it is used first ([roles](https://confluence.atlassian.com/adminjiraserver/managing-project-roles-938847166.html)) | Deleting a group asks for a group to move its restricted comments to, and it leaves notification schemes; roles are fixed, so none is deleted. A group a directory removes leaves its comments with their authors, as in Jira | match | match | 0104, 0106 | |
| PRM-13 | Users: deactivate, don't delete | Deactivate keeps history ([users](https://confluence.atlassian.com/adminjiraserver/create-edit-or-remove-a-user-938847025.html)) | Deactivate only, including SCIM delete (`scim.ts`) | match | match | — | |
| PRM-14 | User anonymisation (GDPR) | DC 8.7+ ([anonymize](https://confluence.atlassian.com/adminjiraserver/anonymizing-users-992677655.html)) | People › Anonymise: preview, transfers, alias everywhere (mentions and the audit log too), a background job safe to rerun; directory users once their directory no longer has them | match | match | 0704 | Bulk and retention rules are proposals |
| PRM-15 | SSO and provisioning | SAML/OIDC, directories, JIT ([saml](https://confluence.atlassian.com/adminjiraserver/saml-sso-for-jira-data-center-applications-938847031.html)) | Entra OIDC, SCIM users and groups | match | match | — | |
| PRM-16 | Personal access tokens | DC 8.14+, admins revoke ([PAT](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)) | Tokens, hash stored, System settings | match | match | — | |

## Projects

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| PRJ-01 | Archive a project | Jira admins only; archived data is read-only and hidden ([archiving](https://confluence.atlassian.com/adminjiraserver/archiving-a-project-938847621.html)) | Global admins only; read-only for everyone; hidden from lists, search and boards; Administration › Archived projects | match | match | 0102 | |
| PRJ-02 | Project key change | Admins can change it; old keys keep working ([key](https://confluence.atlassian.com/adminjiraserver/editing-a-project-key-938847080.html)) | System admins change it; old keys keep finding the project and its items (API, addresses, JQL, boards); no other project takes them | match | match | 0703 | Board filters keep working without edits (better than Jira) |
| PRJ-03 | Project key format | Uppercase letters by default ([key]) | System settings › Project keys: Jira's default pattern [A-Z][A-Z]+ and 10 characters; a new pattern must fit existing keys | match | match | 0308 | Digits need an admin to widen the pattern, as in Jira. |
| PRJ-04 | Categories, avatars | Yes | Project categories (one per project, JQL `category`, list filter); uploaded avatars | match | match | 0703 | Jira's avatar gallery not built |
| PRJ-05 | Delete a project | Permanent | Job with an S3 backup and restore | better | diverge | — | Keep: "project backups" test. |
| PRJ-06 | Templates | Scrum, Kanban, Basic, Business templates | Software: Scrum, Kanban, Basic; Business: Task, Project and Process management, each with its workflow scheme, work types and a board (`shared/templates.ts`) | match | match | 0310 | Business projects also get a board (as in Jira Cloud); Create with shared configuration is proposal P1 |
| PRJ-07 | Project roles to people and groups | Roles with default members | Admin, member and viewer, to people and groups | partial | diverge | 0201 | Fixed roles (PRM-01). |
| PRJ-08 | Project names | Unique, case-insensitive ([JRASERVER-3582](https://jira.atlassian.com/browse/JRASERVER-3582)) | Unique in the workspace, ignoring case | match | match | 0309 | |
| PRJ-09 | Who switches a project's workflow scheme | Jira admins ([managing workflows](https://confluence.atlassian.com/adminjiraserver/managing-your-workflows-938847410.html)) | Global admins | match | match | 0103 | |

## Work items and fields

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| ISS-01 | Fix version / affects version | Both multi-value | Both multi-value; releasing moves unresolved work by replacing the released version | match | match | 0301 | |
| ISS-02 | Hierarchy | Epic > standard > sub-task, enforced ([levels](https://confluence.atlassian.com/jiraportfolioserver/configuring-initiatives-and-other-hierarchy-levels-802170489.html)) | Kept by the server: epics have no parent, sub-items stay in their parent's project and have none, the parent must be visible | match | match | 0303 | |
| ISS-03 | Rank | One rank across projects (LexoRank) | One order per workspace; new work last; crowded ranks respread around the move only | match | match | 0302 | Fractions instead of LexoRank strings: same order, no rebalancing job. |
| ISS-04 | Priorities | Admin list, priority schemes, default | Administration › Priorities: names, colours, icons, order, default (Medium); delete moves items | match | match | 0305 | Priority schemes (per-project lists) not built. |
| ISS-05 | Resolutions | Admin list; set by transition screen or post function, independent of status category ([resolutions](https://confluence.atlassian.com/adminjiraserver/defining-resolution-field-values-938847105.html)) | Administration › Resolutions; each workflow resolves on reaching Done or only by transition rules | match | match | 0305 | Leaving Done always clears the resolution (deliberate). |
| ISS-06 | Labels | No spaces (*unconfirmed* for DC) | One word, at most 255 characters, checked everywhere; existing spaces became _ | match | match | 0307 | |
| ISS-07 | Custom field types | 20+ types ([cf]) | Jira's twenty: text (single, multi-line, read-only), number, date, date-time, URL, single and multiple select, radio, checkboxes, cascading, labels, user, users, group, groups, project, version, versions; JQL with cascadeOption(), currentUser(), membersOf() | match | match | 0502 | Three-level cascading, a yes/no field and an item picker are proposals |
| ISS-08 | Custom field contexts, field configurations | Global fields with contexts; required and hidden ([context](https://confluence.atlassian.com/adminjiraserver/configuring-a-custom-field-938847235.html)) | Global fields with Jira's contexts (projects or global, work types, options, default value); field configurations (description, hidden, required) and schemes per work type, enforced on create, edit, bulk edit and move; project admins may add a field for their project alone | match | match | 0503, 0504 | Renderers are a proposal |
| ISS-24 | Custom field type and options | The type can't be changed; options have ids: a rename carries to issues, a disabled option stays on issues, a deleted one is cleared ([editing custom fields](https://confluence.atlassian.com/adminjiraserver/editing-or-deleting-custom-fields-1047552719.html)) | Same: type fixed, option ids, rename/disable/delete carry through | match | match | 0105 | |
| ISS-26 | Change history | Field, old and new value and name per change; one item per version or component added or removed | Every change keeps its old and new value and name (as they read then), one change per list value; the History tab shows them; indexed for history search | match | match | 0601 | Comment edit history and watchers in the history are proposals |
| ISS-25 | Version and component names | Unique per project | Unique per project, ignoring case | match | match | 0309 | |
| ISS-09 | Screens and screen schemes | Create, edit and view screens | Screens with tabs, screen schemes (Create, Edit, View) and issue type screen schemes; the create dialog, edits and the item's view follow them; transition screens (0103) | match | match | 0505 | Better: the Default Screen shows every field, new ones included, until given tabs |
| ISS-10 | Move between projects | Yes; the old key redirects | Move… with Jira's preview: type, status, versions and components by name, custom fields by name and kind; sub-items move along; every earlier key keeps opening it (address, API, JQL, search) | match | match | 0501 | The sprint is cleared (Strand's sprints belong to a board) |
| ISS-11 | Voting | Yes | Vote once, not the reporter, not once resolved; who voted (View voters and watchers); the Voting switch with its webhook; JQL votes, votedIssues(), ORDER BY votes | match | match | 0506 | Voting per project is a proposal |
| ISS-12 | Remote links | Yes | Web links (add, edit, remove) and Jira's remote issue link REST (globalId upsert, application, relationship, status); history, webhook, JQL remoteLinksByGlobalId(); carried by moves and backups | match | match | 0507 | JQL on link text, web links at create and as a column are proposals |
| ISS-13 | Archive single issues | DC 8.1+ ([dc]) | System admins archive one item or many (sub-items with them); read-only, out of lists, boards, search and reports; opens by key; Archived work items list with Restore | match | match | 0508 | Project admins archiving and archiving by automation are proposals |
| ISS-14 | Convert to and from sub-task | Yes | Convert to sub-item (pick the parent) and Convert to item from the item's menu; epics, items with sub-items and parents in other projects refused; history | match | match | 0509 | Moving a sub-item to a parent in another project is spec 0501's proposal P2 |
| ISS-15 | Versions: merge, archive, delete with move, release moves unresolved items | Yes ([versions](https://confluence.atlassian.com/adminjiraserver/managing-versions-938847201.html)) | Delete moves fix and affects versions separately or removes them; merge; archive (hidden, locked on items); releasing moves unresolved work | match | match | 0301, 0304 | |
| ISS-16 | Components: delete with swap | Yes ([components](https://confluence.atlassian.com/adminjiraserver/managing-components-938847187.html)) | Delete moves items to another component or removes it | match | match | 0304 | |
| ISS-17 | Time tracking settings | Hours per day and days per week; `w` unit ([time](https://confluence.atlassian.com/adminjiraserver/configuring-time-tracking-938847808.html)) | System settings › Time tracking: hours per day, days per week, `w`, display format, default unit | match | match | 0306 | A bare number is now minutes (Jira's default); an admin can choose hours. |
| ISS-18 | Log work: remaining-estimate modes | Auto, leave, set, reduce ([log work](https://confluence.atlassian.com/jirasoftwareserver111/logging-work-on-issues-1652921625.html)) | Same four (`server/src/shared/estimates.ts`) | match | match | — | |
| ISS-19 | Clone | With links, sub-tasks, attachments | Children, links, sprint | match | match | — | |
| ISS-20 | Bulk change | Edit, move, transition, delete, watch; "send notification" option | Edit, move, transition (each item's outcome), watch and stop watching, delete, restore; Send notifications (off: system administrators or project admins) | match | match | 0501, 0605, 0510 | |
| ISS-21 | Flagging (impediment) | Yes | Add/remove flag (with a comment) from card and item menus; yellow card, flag icon; flagged = Impediment | match | match | 0408 | |
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
| WF-06 | Triggers from development tools | Branch, commit, PR | A transition's Triggers: branch created, commit created, pull request created, merged, declined, reopened (from GitHub); conditions, validators and permissions skipped, post functions run, once per event | match | match | 0718 | Declined and reopened are offered for GitHub too (Jira: Bitbucket only) |

## Boards and agile

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AG-01 | Several boards, filters across projects, board admins | Yes ([board]) | Yes | match | match | — | Built 4 Nov 2026. |
| AG-02 | Columns with min/max, swimlanes, quick filters, card layout | Yes ([board]) | Yes | match | match | — | |
| AG-15 | Who creates and configures boards | Anyone creates; board admins and Jira admins configure ([permissions](https://confluence.atlassian.com/jirasoftwareserver/permissions-overview-939938996.html)) | Project admins create; project admins and board admins configure | diverges | diverge | — | Decided with the product owner on 4 Nov 2026: project admins plus named board admins. |
| AG-03 | Sprint completion | Unfinished work goes to a future sprint, a new sprint, or the backlog; a Done parent with unfinished sub-tasks blocks completion ([completing](https://confluence.atlassian.com/jirasoftwareserver/completing-a-sprint-938845450.html)); done means the board's rightmost column | Future sprint, new sprint or backlog; completed means the board’s rightmost column; a completed parent with unfinished sub-items blocks | match | match | 0101, 0401 | |
| AG-04 | Reopen a sprint | From the sprint report ([reopen](https://confluence.atlassian.com/spaces/JIRASOFTWARESERVER/pages/938845456/Reopening+a+sprint)) | From the Sprint Report; not while another sprint is active on the board | match | match | 0403 | |
| AG-05 | Delete a sprint | Future or completed ([deleting](https://confluence.atlassian.com/jirasoftwareserver/deleting-a-sprint-938845460.html)) | Planned or completed; a completed one's unfinished work goes to the next planned sprint | match | match | 0403 | |
| AG-06 | Parallel sprints | A global setting ([parallel](https://confluence.atlassian.com/jirasoftwareserver/using-parallel-sprints-938845513.html)) | System settings › Sprints › Parallel sprints (off by default): a Scrum board can have several active sprints, the board picks one or shows all; can't be turned off while a board has two | match | match | 0414 | |
| AG-07 | Estimation statistic, time tracking per board | Yes ([estimation](https://confluence.atlassian.com/jirasoftwareserver/configuring-estimation-and-tracking-938845319.html)) | Story points, original time estimate, issue count or any number field (Business value…) per Scrum board, each sprint keeping its own; time tracking None or Remaining estimate and time spent (the burndown follows the remaining estimate) | match | match | 0404, 0412 | |
| AG-08 | Working days | Yes | Working weekdays, non-working dates and the team's time zone per board; burndown guideline is flat on days off, reports split days in the team's zone | match | match | 0405, 0412 | |
| AG-09 | Kanban backlog | Optional ([kanban backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-kanban-backlog-1688899675.html)) | Statuses in the Kanban backlog column leave the board; the Backlog tab ranks them with the first column, drag to move | match | match | 0406 | Shows the board's items up to its limit rather than Jira's first 100 |
| AG-10 | Epics and versions panels | In backlog ([scrum backlog](https://confluence.atlassian.com/jirasoftwareserver112/using-your-scrum-backlog-1688899657.html)) | Epics and Versions panels in the Scrum and Kanban backlogs: counts, progress, filter, drag to add, Create epic or version, epic colour, Epic Status with Mark as Done | match | match | 0407, 0716 | |
| AG-11 | Card colours | By type, priority, assignee or query ([cards](https://confluence.atlassian.com/jirasoftwareserver100/customizing-cards-1442843361.html)) | By work type, priority, assignee or JQL query (first match), a stripe on cards and backlog rows | match | match | 0409 | |
| AG-12 | Reports | Burndown, burnup, sprint, velocity, CFD, control, epic, epic burndown, release burndown, version, plus classic reports ([reports]) | Sprint report, burndown, burnup, velocity, CFD, created vs resolved, control chart, epic report, version report, epic burndown, release burndown, workload (estimates as they stood, as Jira's) | match | match | 0402, 0410, 0411 | Classic (non-agile) Jira reports are a later spec. |
| AG-13 | Dashboards and gadgets | Yes | Removed; Summary is the dashboard | absent | out | — | Product owner decision, Oct 2026. |
| AG-14 | Advanced Roadmaps (plans, teams, capacity, scenarios) | Bundled with DC ([roadmaps](https://confluence.atlassian.com/jirasoftwareserver/discover-advanced-roadmaps-for-jira-1044784153.html)) | Initiatives above epics (Parent Link); plans over projects or a saved view: a live timeline of initiatives, epics and items, dependency lines (red when broken), releases and sprints, progress and health | partial | diverge | 0803 | Option B chosen: edits are live (no sandbox or scenarios). Teams and capacity (B+) after the inventory; levels above Initiative and auto-scheduling are proposals |

## Search

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| SR-01 | JQL fields and operators | All fields; WAS, CHANGED, BY, DURING… ([jqlop]) | Most fields; WAS, WAS IN, WAS NOT, WAS NOT IN and CHANGED on Jira's six fields with AFTER, BEFORE, ON, DURING, BY, FROM and TO, over the indexed history | match | match | 0601, 0602 | History search on more fields is a proposal |
| SR-02 | JQL functions | About 35 ([jqlfn]) | All of Jira's outside Service Management: dates with increments, currentLogin, lastLogin, sprint, version, item (issueHistory, linkedIssues, watchedIssues, votedIssues, updatedBy, remote links), people and project, type functions; voter and watcher fields; Xray functions | match | match | 0603 | Service Management's approval and SLA functions are out (no service desk). linkedIssues for any item, quarters and role functions for another person are proposals |
| SR-03 | `~` text search | Word search with stemming | Words in the workspace's indexing language (stemming, stop words, Other), phrases, wildcards anywhere, AND/OR/NOT/+/-, fuzzy; `comment` and comments in `text`; quick search alike (`shared/textQuery.ts`, `jqlSql.ts`) | match | match | 0609 | Proximity and relevance ordering aren't kept; wildcards match the words as written (Jira misses `customiz*`) |
| SR-04 | Saved filters and sharing | View and edit sharing; admins change the owner | Same (`misc.ts`) | match | match | 0203 | Sharing limited to your own groups and projects (PRM-06). |
| SR-07 | Filter names and owner change | Unique per owner; a new owner must be able to see it and not already have one of that name ([shared filters](https://confluence.atlassian.com/adminjiraserver089/managing-shared-filters-1005347206.html)) | Unique per owner, ignoring case; the new owner must see it and not have one by that name | match | match | 0309 | |
| SR-05 | Filter subscriptions | Scheduled email | Yourself or a group; Daily, Days per week, Days per month or Advanced (Jira's Quartz cron); each recipient gets what they may see; empty results only if asked; Run now; the next run shown | match | match | 0604 | An all-subscriptions admin page, only-when-changed, attachments, opting out and project roles are proposals |
| SR-06 | Export | CSV, Excel, XML, Word, RSS, print | CSV; Printable, Full content, Jira's XML, RSS (with comments) and Word for a search; XML, Word and Printable for an item; capped by settings; restricted comments left out | match | match | 0608 | CSV (current fields) is out (fixed columns). Excel, pictures and a work log export are proposals |

## Notifications

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| NT-01 | Notification schemes | Events to recipients, per project ([schemes](https://confluence.atlassian.com/adminjiraserver081/creating-a-notification-scheme-970609070.html)) | Notification schemes with Jira's 17 events and recipients (assignee, reporter, current user, leads, a person, a group, a role, watchers, user and group fields); Jira's default scheme; a project's scheme or None; resolve and reopen events; personal preferences per kind on top | match | match | 0605 | A single email address isn't a recipient. Project admins choosing, conditions and Previous Assignee are proposals |
| NT-02 | Batched email | DC 8.x | Batched email (off by default): a person's emails about one work item go as one after the window (10 minutes, a setting); @mentions at once | match | match | 0606 | Batching per person or project is a proposal |
| NT-03 | Autowatch | A preference; mentions don't make watchers ([autowatch](https://confluence.atlassian.com/jirakb/how-to-stop-being-automatically-added-to-the-watcher-s-list-when-working-on-issues-298975297.html)) | Autowatch (create and comment) and My changes as preferences, with Default user preferences; mentions don't make watchers | match | match | 0606 | Autowatch per project is a proposal |
| NT-04 | Incoming mail handlers | Create issues and comments from email ([mail](https://confluence.atlassian.com/adminjiraserver/creating-issues-and-comments-from-email-938847641.html)) | Administration › Incoming mail: IMAP, Microsoft 365 (Graph) and message-file servers; Jira's five handlers and their parameters; key in the subject or the replied-to email; default reporter; attachments; each run's messages and outcomes | match | match | 0607 | Better: senders are trusted only when the mail server verified them (on by default), and email never acts with admin rights. POP, Create Users and Notify Users are left out; Outlook-aware replies, no-attachment handlers and same-project comments are proposals |
| NT-05 | In-app inbox | No (Cloud only) | Inbox with read and archive | better | diverge | — | Keep: inbox tests. |

## Automation and integrations

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AU-01 | Automation | A separately licensed app on DC | Rules per project and global rules (every project, a category including later projects, chosen projects), JQL conditions, scheduled rules, dry run, run log | better | diverge | 0709 | Keep: automation tests. Smart values, branches and more triggers are proposals |
| IN-01 | Outgoing webhooks | Admin page plus post function | Administration › Webhooks: every Jira DC event, Jira's payloads (issue_event_type_name, REST field shapes, Jira's changelog names, Jira Software's field ids), URL variables, JQL filter (comments and work logs too), Exclude body, the Trigger-a-webhook post function, Jira's /rest/webhooks/1.0 API; signed, retried, calls listed, private networks refused | match | match | 0705, 0715 | Custom headers are a proposal |
| IN-02 | Development panel | Branches, commits, PRs on the issue | Development panel (counts per pull request status, each commit's branch, the branch name to copy), its dialogs, Jira's `development[…]` JQL, Administration › Development tools (an unknown GitHub installation waits for an admin) | match | match | 0707 | GitHub only. Reading the history, triggers and builds are proposals |
| IN-03 | Importers | CSV, JSON, other trackers | CSV with a dry run, as a job; the Jira inventory (0801); Administration › Jira import from a Jira Data Center: dry run, import keeping keys, people, history, comments, work logs, watchers, votes, web links, attachments and links, run again safely, reconciliation | match | match | 0801, 0802 | Workflows' transitions, boards' settings, filters, schemes and Xray's test data aren't in Jira's REST or come later |
| IN-04 | Test management | An app (Xray) | Built in | better | diverge | — | Keep: testing tests. |
| IN-05 | REST API | v2 plus the Agile API | `/api/v1`, OpenAPI | partial | diverge | — | Strand's own API. Xray import endpoints are kept. |

## Administration and platform

| ID | Jira capability | Jira DC | Strand | Status | Decision | Spec | Notes |
|---|---|---|---|---|---|---|---|
| AD-01 | Audit log | Global and per project, coverage levels ([audit](https://confluence.atlassian.com/adminjiraserver/auditing-in-jira-938847740.html)) | Global and per project | match | match | — | |
| AD-02 | Announcement banner | Yes, public or private, HTML | System settings › Announcement banner: public or private, preview, closable until it changes | match | match | 0701 | Plain text with links, not HTML (no scripts) |
| AD-03 | Look and feel | Site title, logo, favicon, colours, date formats | Site title, logo, favicon, one brand colour with worked-out shades for light and dark themes (readability enforced), reset; a logo for the collapsed menu (0719) | match | match | 0702, 0719 | Date formats follow each browser |
| AD-04 | Rate limiting | Everyone, per node ([rate](https://confluence.atlassian.com/adminjiraserver/improving-instance-stability-with-rate-limiting-983794911.html)) | Everyone but the web app; Anonymous as one; per node | match | match | 0706 | |
| AD-05 | Language packs | Yes | English only (dates and numbers follow the browser) | absent | diverge | 0708 | PO, 10 Nov 2026: English only is all the tool needs |
| AUTH-01 | Authentication methods | Administration › System › Authentication methods: SSO configurations enabled or disabled, login form shown or hidden ([idp](https://confluence.atlassian.com/enterprise/using-multiple-identity-providers-1044779993.html)) | Entra configured and turned on or off in Administration; login form shown or hidden; at least one way in | match | match | 0711 | Entra is the only SSO provider (PO); SAML and other OIDC providers not built |
| AUTH-02 | Login form, sessions, failed logins | Username and password form, “Remember my login”, CAPTCHA after 3 failures, 5-hour session | The same form and message; 3 failures lock the username for 5 minutes; 300-minute idle sessions, 14 days remembered (System settings › Sign-in) | partial | diverge | 0711 | A temporary lock replaces CAPTCHA; no passwords kept by Strand (the form checks user directories, spec 0712) |
| AUTH-03 | Authentication fallback and recovery mode | `enable-authentication-fallback` and `/login.jsp?auth_fallback`; `-Datlassian.recovery.password` gives `recovery_admin` | `/?auth_fallback`; `STRAND_RECOVERY_PASSWORD` gives `recovery_admin`, with a banner | match | match | 0711 | |
| DIR-01 | User directories: Active Directory and LDAP | Connector with Jira's fields and presets, ordered, test, synchronise, disable ([ldap](https://confluence.atlassian.com/adminjiraserver/connecting-to-an-ldap-directory-938847052.html)) | The same fields and presets, order, Test settings, Synchronise now, disable | match | match | 0712 | Bind password stored encrypted (STRAND_SECRET_KEY), never returned |
| DIR-02 | Directory permissions | Read Only, Read Only with Local Groups, Read/Write | Read Only | partial | diverge | 0712 | Strand never writes to the directory |
| DIR-03 | Password sign-in against directories | The first directory in order with the username decides | The same, on the login form (spec 0711) | match | match | 0712 | |
| DIR-04 | Synchronisation | Full and incremental, every N minutes; removed users can't sign in | Full and incremental (Active Directory's uSNChanged), every N minutes, with a full run at least every N hours (24) that applies deletions; removed users deactivated, never deleted; a run that finds nobody changes nothing | match | diverge | 0712, 0713 | Deletions come from the regular full run, not AD's Deleted Objects; "Manage user status locally" not built |
| DIR-05 | Internal directory: create and edit users | Create user (username, password, full name, email, notification email), edit, set password ([users](https://confluence.atlassian.com/adminjiraserver/create-edit-or-remove-a-user-938847025.html)) | The same in Administration › People; directory users are edited in their directory | match | match | 0714 | Deleting users not built: deactivate, as Atlassian recommends |
| DIR-06 | Passwords of internal users | Kept by Jira; "Can't access your account?"; change in profile | Salted scrypt; the same link (24 hours, once); Settings › Password; minimum length in System settings | match | match | 0714 | |
| AD-07 | Background jobs at scale | Reindex and services | Job queue for wide changes | better | diverge | — | Keep. |
