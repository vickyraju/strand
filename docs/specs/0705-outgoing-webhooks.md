# 0705 Outgoing webhooks

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC** ([Webhooks](https://developer.atlassian.com/server/jira/platform/webhooks/), checked 10 Nov 2026).
  - Administration › System › **WebHooks**: a name, a URL, an optional JQL filter for issue events, the events, **Exclude body**, and enabled.
  - **Events** (`webhookEvent`): `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`; `comment_created`, `comment_updated`, `comment_deleted`; `worklog_created`, `worklog_updated`, `worklog_deleted`; `issuelink_created`, `issuelink_deleted`; `project_created`, `project_updated`, `project_deleted`; `jira:version_created`, `jira:version_updated`, `jira:version_released`, `jira:version_unreleased`, `jira:version_deleted`; `sprint_created`, `sprint_started`, `sprint_closed`, `sprint_updated`, `sprint_deleted`; `board_created`, `board_updated`, `board_deleted`; `user_created`, `user_updated`.
  - **URL variables** such as `{issue.key}`, `{project.key}`, `{sprint.id}`, `{version.id}`, `{board.id}`, `{modifiedUser.name}`.
  - **The body:** `webhookEvent`, `timestamp`, `user`, and the entity. For issues: `issue` (as REST returns it), and `changelog.items` (field, from, fromString, to, toString) on updates. A 2xx answer is success.
  - **Delivery:** asynchronous since DC 10; no retries; no signature.
  - **REST** under `/rest/webhooks/1.0/webhook` (Jira admins). A workflow post function **Trigger a Webhook**.
- **Before this spec:** none. Automation rules (spec 0709) act inside the app only.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22webhook*%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | The app |
|---|---|---|---|
| [JRASERVER-31953](https://jira.atlassian.com/browse/JRASERVER-31953) Basic authentication for webhooks | 283 | Not being considered | **Proposal P1** (with custom headers) |
| [JRASERVER-41388](https://jira.atlassian.com/browse/JRASERVER-41388) Webhooks fail silently | 192 | Fixed 2022 (logs only) | **Built:** each webhook shows its recent deliveries, with status, answer and error (R7) |
| [JRASERVER-68174](https://jira.atlassian.com/browse/JRASERVER-68174) Creating and updating issues is slow with webhooks | | Bug | **Built:** a change only queues the event; matching and sending happen in background jobs (R6) |
| [JRASERVER-70300](https://jira.atlassian.com/browse/JRASERVER-70300) Retry failed webhooks | 67 | Gathering interest | **Built:** retries with growing waits (R6) |
| [JRASERVER-69110](https://jira.atlassian.com/browse/JRASERVER-69110) Custom headers | 50 | Gathering interest | **Proposal P1** |
| [JRASERVER-59980](https://jira.atlassian.com/browse/JRASERVER-59980), [JRASERVER-70277](https://jira.atlassian.com/browse/JRASERVER-70277) The JQL filter ignored for comment, worklog and link events | | Bugs | **Built:** the filter applies to every issue-related event (R4) |
| [JRASERVER-41463](https://jira.atlassian.com/browse/JRASERVER-41463), [JRASERVER-67460](https://jira.atlassian.com/browse/JRASERVER-67460) Webhook logging, see the queue and errors | | Suggestion | **Built:** R7 |
| [JRASERVER-63205](https://jira.atlassian.com/browse/JRASERVER-63205) A custom JSON body | | Gathering interest | Not proposed |
| [JRASERVER-36879](https://jira.atlassian.com/browse/JRASERVER-36879) Project admins configure webhooks | 32 | Gathering interest | **Proposal P2** |
| Jira has no way to prove a call came from Jira | | | **Built:** each webhook has a secret; calls carry an HMAC signature (R5) |

**Proposals for the product owner** (not built until chosen):

- **P1: Custom headers**, including `Authorization` for basic auth, stored encrypted like directory passwords.
- **P2: Project webhooks:** project admins add webhooks limited to their project's events.
- **P3: Workflow post function "Trigger a webhook"** (Jira's). The app's transition rules (spec 0103) would gain the action.

## Rules

- **R1: The page.** Administration › **Webhooks** (system admins, signed in themselves). Each webhook has:
  - a name, a description, a URL, enabled;
  - the events: all, or chosen from Jira's list above;
  - an optional JQL filter;
  - **Exclude body**.

  Every change is audited.
- **R2: The URL.**
  - It must be `https://`, or `http://` only for hosts the server allows (`WEBHOOK_HTTP_HOSTS`, for an intranet).
  - **It may never reach the server's own network:** loopback, link-local (cloud metadata), and private addresses are refused when the URL is saved and again when it is called, after the name is resolved. Private hosts the server allows (`WEBHOOK_PRIVATE_HOSTS`) are the exception.
  - URL variables `{issue.key}`, `{issue.id}`, `{project.key}`, `{project.id}`, `{sprint.id}`, `{version.id}`, `{board.id}` and `{modifiedUser.name}` are filled in, encoded.
- **R3: The body**, in Jira's shape:
  - `webhookEvent`, `timestamp` (milliseconds);
  - `user`: who did it (`name`, `displayName`, `emailAddress`);
  - the entity: `issue` (key, id, and Jira's `fields`: summary, status, issuetype, priority, assignee, reporter, project, labels, created, updated), `comment`, `worklog`, `issueLink`, `project`, `version`, `sprint` or `board`;
  - on `jira:issue_updated`, `changelog.items` with `field`, `from`, `fromString`, `to`, `toString`.

  With **Exclude body**, the call has no body.
- **R4: The JQL filter** limits every issue-related event (issue, comment, worklog, link) to items it matches when the event is sent. It is checked when saved (a mistake is a 400 saying where).
- **R5: The signature.** Each webhook has a secret, shown once when made (and when regenerated). Every call carries `X-the app-Signature: sha256=<hex>`, the HMAC-SHA256 of the body with that secret, and `X-the app-Webhook-Id` and `X-the app-Delivery` headers.
- **R6: Delivery.** A change only queues its event (in the same transaction, so a change that fails sends nothing). Background jobs find the matching webhooks, build the bodies and send them.
  - 10-second timeout; a 2xx answer is success.
  - Anything else is retried up to 5 times, waiting longer each time (10 s, 20 s, 40 s…).
- **R7: Deliveries.** Each webhook shows its last 50 deliveries: the event, when, the answer's status or the error, how many attempts. **Test** sends a `ping` event now. **Redeliver** sends a delivery again.
- **R8: A disabled webhook** receives nothing.

## Permissions

System admins, signed in themselves (not with a token).

## Data model and migration

- `webhooks`: workspace, name, description, URL, events (array; empty means all), JQL, exclude body, enabled, secret (encrypted with `SECRET_KEY`), created and updated.
- `webhook_calls`: webhook, event, delivery id, status code or error, attempts, the body sent, created and finished. The last 50 per webhook are kept.

## API

- `GET`, `POST /admin/webhooks`; `GET`, `PUT`, `DELETE /admin/webhooks/:id`.
- `POST /admin/webhooks/:id/secret` (regenerate), `POST /admin/webhooks/:id/test`.
- `GET /admin/webhooks/:id/calls`, `POST /admin/webhooks/:id/calls/:callId/redeliver`.

## Screens

Administration › Webhooks: the list (status, last delivery), the editor (events as Jira's groups, JQL with a check), the secret shown once, and the deliveries.

## System settings

None. The two allowlists are server settings (`WEBHOOK_HTTP_HOSTS`, `WEBHOOK_PRIVATE_HOSTS`), because they decide what the server's network can be reached from.

## Scale

- An event is one queued job; fan-out and sending are further jobs, so a busy board isn't slowed down.
- The JQL filter is one indexed query per webhook per event, for the one item.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R4 | Server test: create, edit, audit; a bad JQL refused; a filtered webhook gets only matching items' events, comments included |
| R2 | Server test: http, loopback, link-local, private and DNS-to-private refused; variables filled and encoded |
| R3, R5 | Server test: a stand-in receiver checks the body's shape, the changelog and the signature; Exclude body |
| R6, R7, R8 | Server test: a failing receiver retried then shown failed; redeliver; ping; disabled sends nothing |
| All | Browser journey: an admin adds a webhook, sees the secret once, sends a test and sees the delivery |

## Out of scope and deliberate divergences

- **`user_deleted`:** The app never deletes people.
- **Configuration events** (`option_voting_changed`…): not sent.

## Open questions

None.

## Changelog
