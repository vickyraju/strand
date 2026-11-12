# 0715 Webhooks: every Jira DC event, Jira's payloads

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC's webhook events** ([Webhooks](https://developer.atlassian.com/server/jira/platform/webhooks/), checked 10 Nov 2026):
  - **Issue:** `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, and `jira:worklog_updated` ("fires if a worklog is updated or deleted").
  - **Issue link:** `issuelink_created`, `issuelink_deleted`.
  - **Worklog:** `worklog_created`, `worklog_updated`, `worklog_deleted`.
  - **Comment:** `comment_created`, `comment_updated`, `comment_deleted`.
  - **Project:** `project_created`, `project_updated`, `project_deleted`.
  - **Version:** `jira:version_released`, `jira:version_unreleased`, `jira:version_created`, `jira:version_moved`, `jira:version_updated`, `jira:version_deleted` ("deleted, merged": a merge sends the delete with the version it was merged into).
  - **User:** `user_created`, `user_updated`, `user_deleted`.
  - **Jira configuration:** `option_voting_changed`, `option_watching_changed`, `option_unassigned_issues_changed`, `option_subtasks_changed`, `option_attachments_changed`, `option_issuelinks_changed`, `option_timetracking_changed`.
  - **Jira Software:** `sprint_created`, `sprint_deleted`, `sprint_updated`, `sprint_started`, `sprint_closed`; `board_created`, `board_updated`, `board_deleted`, `board_configuration_changed`.
  - **URL variables:** `{board.id}`, `{issue.id}`, `{issue.key}`, `{mergedVersion.id}`, `{modifiedUser.key}`, `{modifiedUser.name}`, `{project.id}`, `{project.key}`, `{sprint.id}`, `{version.id}` (with or without `$`).
  - **Post function:** a workflow transition can **trigger a webhook**. The call is `jira:issue_updated` with the transition (`workflowId`, `workflowName`, `transitionId`, `transitionName`, `from_status`, `to_status`).
  - **REST:** `/rest/webhooks/1.0/webhook` (list, create, read, change, delete) with `name`, `url`, `events`, `filters` (`issue-related-events-section`: the JQL), `excludeBody`, `enabled`. Integrations often register their own webhooks this way.
- **The body** (same page and Jira's REST representations):
  - `timestamp`, `webhookEvent`, and for issue events `issue_event_type_name` (the Jira event behind it: `issue_created`, `issue_updated`, `issue_assigned`, `issue_generic`, `issue_commented`, `issue_comment_edited`, `issue_comment_deleted`, `issue_worklogged`, `issue_worklog_updated`, `issue_worklog_deleted`, `issue_deleted`).
  - `user`: Jira's user (`self`, `name`, `key`, `emailAddress`, `displayName`, `active`, `timeZone`).
  - `issue`: as Jira's REST `GET /rest/api/2/issue` returns it: `id`, `self`, `key`, `fields` with Jira's field ids and shapes (`summary`, `issuetype`, `status` with `statusCategory`, `priority`, `assignee`, `reporter`, `creator`, `project`, `labels`, `components`, `fixVersions`, `versions`, `created`, `updated`, `duedate`, `resolution`, `resolutiondate`, time tracking in seconds, `parent`, `subtasks`, `issuelinks`, `comment`, `worklog`, Jira Software's custom fields).
  - `changelog` on `jira:issue_updated`: `id`, `items` of `field`, `fieldtype`, `from`, `fromString`, `to`, `toString`, in Jira's field names.
  - `comment` when the change carried one. Other events carry `comment`, `worklog`, `issueLink`, `project`, `version` (with `mergedTo` on a merge), `user`, `sprint` (with `oldValue` on an update), `board` or `configuration`.
  - In Jira, a comment, a new work log or a transition also fires `jira:issue_updated` (with its `issue_event_type_name`); a work log changed or deleted fires `jira:worklog_updated`.
- **The app today** (spec 0705): 29 of Jira's events, a body in Jira's outline but with the app's names inside it (changelog fields `title`, `statusId`; issue type keys; status categories `todo`), no `issue_event_type_name`, no post function, no Jira REST.

## Community and Atlassian backlog

Spec 0705's research applies. Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22webhook*%22%20ORDER%20BY%20votes%20DESC):

| Atlassian issue | Status | The app |
|---|---|---|
| [JRASERVER-59980](https://jira.atlassian.com/browse/JRASERVER-59980) The JQL filter doesn't work for comment and worklog events | Bug | **Built (0705):** it does |
| Jira 10 refuses `$` in URL variables | Change in Jira 10 | **Better:** both forms work, so URLs from Jira 9 and 10 both carry over |
| Custom field ids differ in every Jira | Documented | **Built:** Jira Software's field ids are a System setting, so an integration reading `customfield_10106` gets Story Points (R5) |

## Rules

- **R1: Every event.** Webhooks can subscribe to every event above, and the app sends each one when its change happens, except:
  - `jira:version_moved`: The app orders versions by date, so nothing moves them;
  - the configuration events for options the app has no switch for (voting, watching, unassigned issues, sub-tasks, issue linking, time tracking).

  Those can be chosen (so webhooks from Jira carry over) and are marked "never sent: The app has no such change".
- **R2: When.**
  - `jira:issue_updated` also fires for a comment added, edited or deleted, a work log added, and a transition, as Jira's does.
  - `jira:worklog_updated` (not `jira:issue_updated`) fires when a work log is edited or deleted, as Jira's does.
  - `user_deleted` fires when a person is anonymised (The app never deletes people; anonymising is how their data goes).
  - `board_configuration_changed` fires when a board's columns, filter, estimation or swimlanes change; `board_updated` when its name or admins do.
  - `option_attachments_changed` fires when attachments are turned on or off.
- **R3: `issue_event_type_name`** on every issue event:
  - `issue_created` and `issue_deleted`;
  - `issue_assigned` when only the assignee changed;
  - `issue_generic` for a transition (as Jira's default workflows fire);
  - `issue_commented`, `issue_comment_edited`, `issue_comment_deleted`;
  - `issue_worklogged` (on `jira:issue_updated`); `issue_worklog_updated` and `issue_worklog_deleted` (on `jira:worklog_updated`);
  - otherwise `issue_updated`.
- **R4: Jira's representations.**
  - **People:** `name` is the username (else the email), `key` is the person's id, `emailAddress`, `displayName`, `active`, `timeZone`.
  - **Dates and times:** Jira's `2026-11-10T09:30:00.000+0000`. Dates are `2026-11-10`. Time tracking is in seconds.
  - **Issue type, priority and resolution:** each by its name, with an `id`.
  - **Status:** with Jira's `statusCategory` (`new`, `indeterminate`, `done`).
  - **Versions:** `id`, `name`, `description`, `archived`, `released`, `releaseDate`, `projectId`.
  - **Sprints:** `id`, `state` (`future`, `active`, `closed`), `name`, `startDate`, `endDate`, `completeDate`, `originBoardId`, `goal`.
  - **Changelog items** use Jira's field names (`summary`, `status`, `assignee`, `priority`, `issuetype`, `labels`, `Fix Version`, `Version`, `Component`, `duedate`, `resolution`, `timeoriginalestimate`, `timeestimate`, `Sprint`, `Epic Link`, `Story Points`, `Flagged`, `Epic Status`, `Rank`) with Jira's `from` (id or value) and `fromString` (what people read).
  - `self` is the item's address in the app's API when the server knows its own address (`PUBLIC_API_URL`), else null.
- **R5: Jira Software's fields** go in `issue.fields` under ids set in System settings › Webhooks (Sprint, Epic Link, Epic Name, Epic Status, Epic Colour, Story Points, Rank, Flagged), in Jira DC's shapes (Sprint as Jira's sprint strings, Epic Status and Flagged as options). Defaults are given; an admin sets their Jira's ids so integrations read the same keys. The app's own custom fields go out as `customfield_<field id>`.
- **R6: The post function.** A transition's Actions can **trigger a webhook** (a chosen one). It is sent when the move is made, as `jira:issue_updated` with `issue_event_type_name` `issue_generic`, the changelog of the move, and Jira's `transition` object. It is sent even if the webhook doesn't subscribe to issue events, and its JQL filter still applies; a disabled webhook sends nothing.
- **R7: Jira's REST.** `/rest/webhooks/1.0/webhook` lists, creates, reads, changes and deletes webhooks in Jira's shape (`self`, `name`, `url`, `events`, `filters`, `excludeBody`, `enabled`, `lastUpdatedUser`, `lastUpdatedDisplayName`, `lastUpdated`), for system admins, with an access token too, since integrations register themselves.
  - A webhook made there gets a signing secret like any other; it is shown in Administration › Webhooks (Regenerate).
  - Every change is audited.
- **R8: URL variables** add `{mergedVersion.id}` and `{modifiedUser.key}`.

## Permissions

- Administration › Webhooks and the post function: as spec 0705 and spec 0103.
- Jira's REST: system admins, including with an access token (Jira's admins use basic auth there).

## Data model and migration

- The `webhooks` System setting: Jira Software's field ids.

## API

- `/rest/webhooks/1.0/webhook`, `/rest/webhooks/1.0/webhook/:id` (Jira's).
- Transition actions gain `{ kind: 'webhook', webhookId }`.

## Screens

- Administration › Webhooks: every Jira event in Jira's groups, the never-sent ones marked.
- System settings › Automation: spec 0709's limits (missing until now).
- The transition editor's Actions: **Trigger a webhook**.
- System settings › Webhooks: Jira Software's field ids.

## System settings

`webhooks`: `fieldIds` (sprint, epicLink, epicName, epicStatus, epicColour, storyPoints, rank, flagged).

## Scale

- The body is taken once per change, as before. The item's comments and work logs are capped at their latest 100, links at 100.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3 | Server test: each event is sent when its change happens, with its `issue_event_type_name` |
| R4, R5 | Server test: the issue body's Jira fields and the changelog's Jira names; custom field ids from the setting |
| R6 | Server test: a transition triggers its webhook with Jira's `transition` |
| R7 | Server test: Jira's REST round trip; non-admins refused |
| R8 | Server test: the new URL variables |

## Out of scope and deliberate divergences

- **`jira:version_moved`** and the option events the app has no switch for: listed, never sent (R1).
- **Avatars** (`avatarUrls`): The app has no avatar images for people.

## Open questions

None.

## Changelog

- 10 Nov 2026, while building: work log changes fire `jira:worklog_updated` rather than `jira:issue_updated`, as Jira maps its events; System settings › Automation (spec 0709's limits) gained its page.
