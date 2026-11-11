# 0605 Notification schemes; bulk change without notifying

Status: Approved (PO, 10 Nov 2026: "yes go ahead and build complete everything whatever is pending")
Parity rows: NT-01, ISS-20

## Context and Jira reference

- **Jira DC** (Administration › Issues › **Notification schemes**; a project's settings › Notifications; Bulk change's **Send mail for this update**):
  - A notification scheme lists, for each **event**, who hears about it. Jira's events: Issue Created, Issue Updated, Issue Assigned, Issue Resolved, Issue Closed, Issue Commented, Issue Comment Edited, Issue Comment Deleted, Issue Reopened, Issue Deleted, Issue Moved, Work Logged On Issue, Work Started On Issue, Work Stopped On Issue, Issue Worklog Updated, Issue Worklog Deleted, Generic Event. A workflow transition fires one of them (Resolve fires Issue Resolved; most fire Generic Event).
  - **Recipients:** Current Assignee, Reporter, Current User, Project Lead, Component Lead, Single User, Group, Project Role, All Watchers, User Custom Field Value, Group Custom Field Value (and a single email address).
  - **Default Notification Scheme:** every event goes to All Watchers, Current Assignee and Reporter. A new project gets it; a project's scheme can be changed by a Jira administrator, or set to **None** (no notifications).
  - Only what the scheme says is sent; people don't hear about their own changes (a personal preference); people only hear about issues they can see. @mentions are sent whatever the scheme says.
  - **Bulk change**: "Send mail for this update" (on by default); turning it off needs Jira administrator or the project's administrator rights for every issue.
- **Strand today:** fixed notifications: the assignee on assignment, watchers (with assignee and reporter) on comments and status changes, mentions, due reminders and automation failures; each person chooses Inbox and email per kind. No schemes; bulk changes always notify.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22notification%20scheme%22%20OR%20summary%20~%20%22bulk%20change%20notification%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | Strand |
|---|---|---|
| [JRASERVER-41046](https://jira.atlassian.com/browse/JRASERVER-41046), [JRASERVER-64151](https://jira.atlassian.com/browse/JRASERVER-64151) Work logs and deleted comments notify though the scheme says not | Bugs | **Built:** only the scheme decides (R3) |
| [JRASERVER-24184](https://jira.atlassian.com/browse/JRASERVER-24184), [JRASERVER-28210](https://jira.atlassian.com/browse/JRASERVER-28210) Choose the scheme new projects get | Suggestions | **Built:** an administrator marks which scheme is the default (R1) |
| [JRASERVER-68496](https://jira.atlassian.com/browse/JRASERVER-68496) Set None through the API | Suggestion | **Built** (R2) |
| [JRASERVER-62907](https://jira.atlassian.com/browse/JRASERVER-62907) Groups as recipients | Suggestion | **Built:** Group (R1) |
| [JRASERVER-38979](https://jira.atlassian.com/browse/JRASERVER-38979), [JRASERVER-43161](https://jira.atlassian.com/browse/JRASERVER-43161) Project admins pick their project's scheme | Suggestions | **Proposal P1** |
| [JRASERVER-12544](https://jira.atlassian.com/browse/JRASERVER-12544), [JRASERVER-2115](https://jira.atlassian.com/browse/JRASERVER-2115), [JRASERVER-40522](https://jira.atlassian.com/browse/JRASERVER-40522) Recipients by work type, priority or other conditions | Suggestions | **Proposal P2** |
| [JRASERVER-14052](https://jira.atlassian.com/browse/JRASERVER-14052) Previous Assignee as a recipient | Suggestion | **Proposal P3** |
| [JRASERVER-1739](https://jira.atlassian.com/browse/JRASERVER-1739) A mail server per scheme | Suggestion | Not proposed (the platform sends mail) |

**Proposals for the product owner** (not built until chosen):

- **P1: Project admins choose** their project's scheme from the schemes an administrator offers.
- **P2: Conditions on a recipient** (only for some work types or priorities).
- **P3: Previous Assignee** as a recipient of Issue Assigned.

## Rules

- **R1: Schemes.** Administration › Notification schemes: create, copy, rename, delete (not one in use or the default), and mark one as the default for new projects. Each lists Jira's 17 events with their recipients; add and remove: Current Assignee, Reporter, Current User, Project Lead, Component Lead, Single User, Group, Project Role (Admin, Member, Viewer), All Watchers, User Custom Field Value, Group Custom Field Value. A workspace starts with Jira's Default Notification Scheme (every event: All Watchers, Current Assignee, Reporter), the default.
- **R2: Projects.** Every project has a scheme, or None; existing projects get the Default Notification Scheme, new ones the default. A system administrator changes it (project settings › Notifications shows it to project admins).
- **R3: Who hears.** An event goes to the recipients its project's scheme gives it: once each, never to whoever made the change, only to people who can see the item (a restricted comment: who may read it), and only active people. Each person's Settings › Notifications still chooses Inbox and email per kind. @mentions, due reminders and automation failures are sent as before, whatever the scheme.
- **R4: Events.** Creating, editing, assigning (an edit that only changes the assignee), commenting, editing and deleting comments, logging, changing and deleting work, deleting and moving fire Jira's events. A transition fires Issue Resolved when it goes into a Done status, Issue Reopened when it leaves one, and Generic Event otherwise; webhooks carry the same `issue_event_type_name`. Issue Closed, Work Started and Work Stopped are listed for schemes brought from Jira but Strand never fires them.
- **R5: Bulk changes without notifying.** Bulk edit, move and delete take **Send notifications** (on by default). Off needs system administrator or project admin rights in every item's project; then the change notifies nobody (webhooks still go).
- **R6: Records.** Scheme changes and a project's scheme changing are audited.

## Permissions

System administrators manage schemes and change a project's; project admins see their project's.

## Data model and migration

- `notification_schemes`: name, description, default.
- `notification_scheme_entries`: scheme, event, recipient kind, its value (a person, group, role or field).
- `projects.notification_scheme_id` (none: None).
- `notification_prefs` kinds gain `updated` (other changes to work I hear about).
- The migration creates each workspace's Default Notification Scheme and gives it to every project.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET`, `POST /admin/notification-schemes`; `GET`, `PATCH`, `DELETE /admin/notification-schemes/:id`; `POST /admin/notification-schemes/:id/copy`; `POST`, `DELETE /admin/notification-schemes/:id/entries[/:entryId]`.
- `GET`, `PUT /projects/:key/notification-scheme` (`schemeId`, null for None).
- `sendNotifications` on `POST /issues/bulk/edit`, `/bulk/move`, `/bulk/delete`.

## Screens

- Administration › Notification schemes: the list (projects using each, the default) and a scheme's events with their recipients.
- Project settings › Notifications: the scheme (system administrators change it).
- The bulk bar: a **Send notifications** checkbox (on) for those allowed, used by its field changes and Move. Bulk delete from the API takes it too; the bar's delete always notifies.

## Scale

Recipients are worked out once per event in one query; a group recipient adds its members. Schemes are few; projects point to one.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R6 | Server test: the default scheme and projects using it; create, copy, entries, default, delete refused while used; a project's scheme and None; audited; non-admins refused |
| R3, R4 | Server test: each event reaches its recipients (assignee, reporter, watchers, lead, component lead, a person, a group, a role, a user field); not the actor; not those who can't see; restricted comments; None sends nothing; mentions still sent |
| R5 | Server test: bulk edit with notifications off notifies nobody; refused for those without rights |
| R1 | Browser journey: an admin adds a group to Issue Commented and a member hears about a comment |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **A single email address** as a recipient: Strand only notifies people with accounts.
- **Choosing a transition's event:** the event follows where the transition goes (R4).

## Open questions

None.

## Changelog
