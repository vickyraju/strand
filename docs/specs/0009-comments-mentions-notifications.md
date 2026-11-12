# 0009 Comments, mentions and notifications

Status: Implemented

## Context and Jira reference

People discuss an item in its comments, call someone in with an `@mention`, and hear about what concerns them in their Inbox and, when an administrator turns it on, by email. Extended by spec 0203 (who may limit a comment, and edit or delete others'), 0601 R6 (comment edit history), 0605 (who hears about each event), 0606 (batched email, Autowatch) and 0607 (comments from email).

- **Jira DC:** comments can be limited to a project role or a group ([invisible comments](https://support.atlassian.com/jira/kb/resolving-invisible-comments-issue-in-jira-due-to-incorrect-group-level-settings/)). `@mention` notifies the person by email. Notifications go by email. The app follows Jira for comments and mentions, with these differences:
  - **Inbox:** an addition. Each person chooses, per kind, the Inbox, email, both or neither.
  - **Due reminders:** an addition. Jira users build them from filter subscriptions or automation.

## Rules

- **R1: Comments.** `POST /issues/:key/comments` adds a comment of 1 to 20,000 characters. Viewers may comment.
- **R2: Who reads a limited comment.**
  - A comment limited to a role is read by people with that role in the project and by its author. A comment limited to Administrators is also read by system administrators.
  - A comment limited to a group is read by the group's members and its author.
  - The item's detail, the comments list and notifications all follow this: a person mentioned in a comment they can't read isn't told.
  - A group that doesn't exist is refused: 400 "No such group". Who may limit a comment to what: spec 0203 R4.
- **R3: Mentions.** `@Full Name` in a comment mentions that person, who gets a "mentioned" notification ("mentioned you in a comment").
  - Only a whole name counts: "@Mention Anna" doesn't mention "Mention Ann". Punctuation after the name still counts.
  - Characters such as `.`, `'` or `(` in a name are just characters.
  - The author, deactivated people and people who can't see the project are never mentioned. A name that matches nobody is ignored.
- **R4: Never the actor, never twice.** Nobody is notified of their own change. A person mentioned in a comment gets "mentioned", not also "commented". Who else hears about an event: spec 0605.
- **R5: The Inbox.**
  - `GET /notifications` lists my newest 200, each with its item's key and title and its project's key. They can be filtered by kind, project and archived.
  - Notifications about projects I can no longer see are left out.
  - I mark them read or archived, or all read.
- **R6: One sentence each.**
  - The server stores a phrase ("commented on a work item"); the Inbox puts the person's name in front: "Maya Chen commented on a work item".
  - With nobody behind it (a due date), the item's key goes in front: "PAY-12 is due on 2026-10-25".
  - A text that is already a sentence is left as it is.
- **R7: Due reminders.**
  - When I load my notifications, each open item assigned to me that is due between 3 days ago and tomorrow gets a "due" notification: "is due on 2026-10-25".
  - Each item gets one per due date; a new due date is news again.
  - Finished items, items without a due date and other people's items are left out.
  - The window is set in **System settings › Due dates**.
- **R8: One reminder, whatever the number of servers.** Several requests at once, from several API servers, still make one "due" notification per item and due date: the database refuses a second one.
- **R9: Notification settings.**
  - **Settings › Notifications** lists each kind: assigned, mentioned, commented, status, updated, due, automation. For each, the person chooses the Inbox and email; both are on until changed.
  - Every notification, from any code path, passes this choice: with the Inbox off, it doesn't reach the Inbox. Other kinds still do.
- **R10: Email.**
  - Email is off until an administrator turns it on in **System settings › Email notifications**, with a sender ("Say who the emails come from" otherwise, 400).
  - Then each notification a person wants by email is queued as a background job and sent:
    - subject: `[PAY-12] Title`;
    - body: who did what, the item and project, and a link to `<app address>/i/PAY-12`.
  - Without a way to send (`EMAIL_TRANSPORT`), the job fails with "No email transport is set up" and stays for retry, so nothing is lost silently.

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| Read comments (unlimited ones) | 404 | yes | yes | yes | yes |
| Add a comment | 404 | yes | yes | yes | yes |
| Turn email on | no | no | no | no | yes |

Everyone signed in reads their own notifications and chooses their own settings; nobody reads another person's.

## Data model

- `comments` (`server/migrations/20261011205352_rest_of_schema.sql`): `issue_id`, `author_id`, `body`, `created_at`, `edited_at`; `visibility` (`20261110090000_issue_security.sql`): `{ kind: 'role', role }` or `{ kind: 'group', id }`.
- `notifications` (`20261011205352_rest_of_schema.sql`): `user_id`, `actor_id`, `issue_id`, `kind`, `text`, `read`, `archived`. A unique index on `(user_id, issue_id, text)` for `kind = 'due'` (`20261028120000_due_reminders_once.sql`).
- `notification_prefs` (`20261109090000_notification_prefs.sql`): `user_id`, `kind`, `inbox`, `email`. The `notifications_route` trigger drops an Inbox entry the person turned off and queues the email job.

## API

- `POST /issues/:key/comments` `{ body, visibility? }`; `GET /issues/:key/comments`; `PATCH` and `DELETE /comments/:id` (spec 0203).
- `GET /notifications?kind=&project=&archived=`, `PATCH /notifications/:id` `{ read, archived }`, `POST /notifications/read-all`.
- `GET` and `PUT /me/notification-prefs` `{ prefs: [{ kind, inbox, email }] }`.
- `PUT /admin/settings/email` `{ enabled, from, appUrl }`.

## Screens

- The item's comment box, with `@` to mention, and each comment's visibility.
- **Inbox:** notifications grouped by item, filters by kind, Mark all read, Archive and the archive view.
- **Settings › Notifications:** a row per kind with Inbox and Email switches; "Notification settings saved".
- **Administration › System settings:** Email notifications and Due dates.

## System settings

- **Due dates:** `enabled` (on), `daysAhead` 0–30 (1), `daysLate` 0–90 (3).
- **Email notifications:** `enabled` (off), `from`, `appUrl` (an `https://` address, for links).

## Scale

- The Inbox reads the newest 200.
- Each API server checks one person's due items at most every 10 minutes (`DUE_SCAN_INTERVAL_MS`); the unique index keeps servers from repeating each other.
- Emails are background jobs, retried up to 8 times.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: comments are added and read back. Browser journey: Maya mentions Sam in a comment |
| R2 | Server test: a comment limited to Administrators is read by its author and an admin, not by a member; an unknown group is refused |
| R3 | Server test: whole names only, odd characters, a deactivated person, no such person. Browser journey: the mention reaches Sam's Inbox |
| R4 | Unit test (web): an assignment notifies the assignee only; a mention gives "mentioned", not also "commented" |
| R5 | Browser journey: the mentioned person's Inbox lists the item |
| R6 | Unit test (web): phrases get the person or the key in front; sentences are left alone |
| R7 | Server test: due tomorrow, today and 3 days late notify; 2 days ahead, 5 days late, no date, finished and someone else's don't; loading again adds nothing; a new due date does |
| R8 | Server test: five requests at once make one reminder; a second insert is refused |
| R9 | Server test: email only, then neither. Browser journey: Inbox off for assignments stops them; a mention still arrives |
| R10 | Server test: Inbox only while email is off; a sender is required; the email's addressee, sender, subject, text and link; a missing transport fails the job |

## Out of scope and deliberate divergences

- **The Inbox and due reminders** are additions; Jira DC notifies by email.
- **Email format** (HTML or text) is not a choice: each email carries both.
