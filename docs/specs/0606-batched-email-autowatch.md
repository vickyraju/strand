# 0606 Batched email, autowatch, mentions don't make watchers

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC 8.0 and later: batched email notifications** ([JRASERVER-1369](https://jira.atlassian.com/browse/JRASERVER-1369), fixed in 8.0.0): an instance-wide setting, off by default. When on, a person gets one email for all changes to an issue within a 10-minute window; @mentions are still sent straight away.
- **User preferences** ([Managing your user profile](https://confluence.atlassian.com/jirasoftwareserver/managing-your-user-profile-939938953.html); [autowatch](https://support.atlassian.com/jira/kb/how-to-stop-being-added-as-a-watcher-when-working-on-issues/), checked 11 Nov 2026):
  - **Autowatch:** Jira makes you a watcher of any issue you create or comment on; on by default.
  - **My Changes:** "Notify me" or "Do not notify me" about changes you make; Do not notify me by default.
  - A Jira administrator sets the defaults for everyone (Administration › System › User Interface › **Default User Preferences**); each person can change their own.
  - **@mentions** notify the person; they don't make them a watcher.
- **Before this spec:** every notification email goes out on its own; commenters and the people they mention become watchers; nobody hears about their own changes; no preferences beyond the per-kind Inbox and email choices.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22batch%22%20OR%20summary%20~%20%22autowatch%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | The app |
|---|---|---|
| [JRASERVER-1369](https://jira.atlassian.com/browse/JRASERVER-1369) Reduce Jira's email chattiness | Fixed in 8.0 | **Built** (R1) |
| [JRASERVER-28268](https://jira.atlassian.com/browse/JRASERVER-28268) Administrators disable or default autowatch | Suggestion | **Built:** Default user preferences (R5) |
| [JRASERVER-69305](https://jira.atlassian.com/browse/JRASERVER-69305), [JRASERVER-68967](https://jira.atlassian.com/browse/JRASERVER-68967) Adjust the batching window | Suggestions | **Built:** a System setting, 10 minutes by default (R1) |
| [JRASERVER-70759](https://jira.atlassian.com/browse/JRASERVER-70759) Batched emails leave no trace | Bug | **Built:** each batch is a job with its result (R1) |
| [JRASERVER-70125](https://jira.atlassian.com/browse/JRASERVER-70125), [JRASERVER-69137](https://jira.atlassian.com/browse/JRASERVER-69137) A mentioned person also gets the batch | Suggestions | **Built:** a mention goes at once and isn't repeated in the batch (R1) |
| [JRASERVER-69332](https://jira.atlassian.com/browse/JRASERVER-69332), [JRASERVER-69505](https://jira.atlassian.com/browse/JRASERVER-69505) Batching per person, opting out | Suggestions | **Proposal P1** |
| [JRASERVER-69010](https://jira.atlassian.com/browse/JRASERVER-69010), [JRASERVER-70020](https://jira.atlassian.com/browse/JRASERVER-70020) Batching per project | Suggestions | **Proposal P2** |
| [JRASERVER-36006](https://jira.atlassian.com/browse/JRASERVER-36006) Autowatch per project | Suggestion | **Proposal P3** |
| [JRASERVER-70206](https://jira.atlassian.com/browse/JRASERVER-70206) The work item's fields in batched emails | Suggestion | **Proposal P4** |

**Proposals for the product owner** (not built until chosen):

- **P1: Batching per person:** each person chooses immediate or batched (or a daily digest).
- **P2: Batching per project.**
- **P3: Autowatch per project.**
- **P4: The work item's main fields** (status, assignee, priority) at the top of a batched email.

## Rules

- **R1: Batched email.** System settings › Email notifications › **Batch notifications** (off by default, as Jira's) and the window (10 minutes by default). On: a person's notification emails about one work item wait for the window from the first one, then go as one email listing each change (who, what, when). @mentions are sent at once. Inbox entries are not batched.
- **R2: Autowatch.** Creating a work item or commenting on one makes you its watcher when your Autowatch is on (the default).
- **R3: Mentions don't make watchers.** A mention notifies the person (spec 0605); it no longer adds them as a watcher.
- **R4: My changes.** "Notify me about my own changes" (off by default): on, the events your own changes fire reach you too when the scheme names you (spec 0605).
- **R5: Defaults.** System settings › **Default user preferences** sets Autowatch and My changes for everyone who hasn't chosen; each person chooses in Settings › Notifications.

## Permissions

System administrators change the settings; everyone their own preferences.

## Data model and migration

- `user_preferences`: person, autowatch, notify own changes (unset: the default).
- `email_batch_items`: person, work item, who, what, when; removed when sent.
- The `emailBatching` and `userDefaults` System settings.

## API

`GET`, `PUT /me/notification-prefs` gain `autowatch` and `notifyOwnChanges` (null: the default) and give the defaults.

## Screens

- Settings › Notifications: **Watch work I create or comment on** and **Notify me about my own changes**, each showing the default.
- System settings: Email notifications batching; Default user preferences.

## Scale

A batch is one queued job per person and work item per window; its changes are rows removed once sent.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: batching on, three changes make one email listing them; a mention goes at once; batching off, one email each |
| R2, R3, R5 | Server test: creating and commenting make you a watcher; Autowatch off doesn't; a mention doesn't; the default |
| R4 | Server test: My changes on, your change reaches you; off, it doesn't |
| R2 | Browser journey: turn Autowatch off in Settings, comment, and you aren't watching |

## Out of scope and deliberate divergences

- **Email type** (HTML or plain text): The app sends both in one email; the reader's mail program shows one.

## Open questions

None.

## Changelog
