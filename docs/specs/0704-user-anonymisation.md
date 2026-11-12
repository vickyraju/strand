# 0704 User anonymisation

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC 8.7 and later** ([Anonymizing users](https://confluence.atlassian.com/adminjiraserver/anonymizing-users-992677655.html), DC 11.3, checked 10 Nov 2026).
  - A Jira administrator anonymises a user, active or deleted (User management › … › **Anonymize user**).
  - The **Anonymize user** page first lists what will be transferred, anonymised or deleted, without changing anything.
  - **Anonymised:** username (to an alias such as `jirauser80900`), full name (`user-ca31a`), email, avatar, sessions, settings. Comments, work logs, history, the audit log and board admin lists stay, showing the alias. Mentions in comments show the alias.
  - **Transferred** to a chosen person: project lead, component lead, filter subscriptions.
  - **Deleted:** personal project roles, personal filter subscriptions, the person in notification and permission schemes.
  - **Users from an external directory** (LDAP, Crowd) must be removed from it and synchronised first.
  - It can't be undone. It is audited. If it fails part way, running it again finishes the rest.
- **Before this spec:** people can be deactivated, never deleted; there is no anonymisation.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22anonymiz*%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | The app |
|---|---|---|---|
| [JRASERVER-66880](https://jira.atlassian.com/browse/JRASERVER-66880) Anonymise user activity (GDPR right to be forgotten) | 18 | Fixed in 8.7 | **Built:** this spec |
| [JRASERVER-71251](https://jira.atlassian.com/browse/JRASERVER-71251) Anonymising times out on large instances | 17 | Gathering impact | **Built:** it runs as a background job in batches, with progress, and can be run again (R6) |
| [JRASERVER-70748](https://jira.atlassian.com/browse/JRASERVER-70748) Anonymise LDAP users | 15 | Gathering interest | **Built:** a directory user can be anonymised once their directory no longer has them (R2), with no manual synchronisation step |
| [JRASERVER-71153](https://jira.atlassian.com/browse/JRASERVER-71153) Names left in issue history | 0 | Fixed in 8.12 | **Built:** history shows the person by id, so it shows the alias (R3) |
| Jira's documented limit: JQL with personal data isn't anonymised | | Documented limit | **Built:** saved views naming the person are listed as "actions required" (R4) |
| [JRASERVER-77578](https://jira.atlassian.com/browse/JRASERVER-77578) Anonymise in bulk | 3 | Gathering interest | **Proposal P1** |
| [JRASERVER-75714](https://jira.atlassian.com/browse/JRASERVER-75714) Anonymise by conditions (for example, inactive for two years) | | Gathering interest | **Proposal P2** |
| [JRASERVER-72397](https://jira.atlassian.com/browse/JRASERVER-72397) Anonymise a single work item | | Suggestion | Not proposed |

**Proposals for the product owner** (not built until chosen):

- **P1: Anonymise several people at once** from People (bulk), as one background job.
- **P2: A retention rule:** anonymise people deactivated for longer than N days, automatically (a System setting, off by default).

## Rules

- **R1: Who and where.** A system admin (signed in themselves, not with a token) anonymises a deactivated person from Administration › People. Active people must be deactivated first. It can't be undone.
- **R2: Directory users.** A person whose user directory still has them can't be anonymised: the next synchronisation would bring their details back. Once the directory no longer has them (they are deactivated by its synchronisation), they can be.
- **R3: What changes.**
  - Their name becomes an alias (`user-` and six letters or digits), their initials `AU`, their email `anonymised-…@invalid`.
  - Their username, title, Entra id, directory link, password, avatar colour and last-activity times are cleared.
  - Their sign-in sessions, access tokens, password links, notification settings, stars and recent views go.
  - Their comments, work logs, history, audit entries, board administration and group memberships stay, showing the alias.
  - Mentions of their name in comments and descriptions (`@Name`) become `@alias`.
  - The audit log's entries naming their email show the alias.
- **R4: The preview.** Before anything changes, the dialog shows:
  - what will be transferred: projects they lead, components they lead, shared views they own, groups they alone own;
  - what will change: the counts of their comments, items they report or are assigned, mentions;
  - actions required: views whose query names them (JQL isn't rewritten).
- **R5: Transfers.** Projects and components they lead, and shared views they own, go to a person the admin chooses (required when there are any). Their private views are deleted. Groups they own keep their other owners; a group they alone own passes to the chosen person.
- **R6: Running it.** A background job, in batches, with progress. It is audited at the start and at the end. If it stops part way, running it again finishes it.

## Permissions

System admins, signed in themselves.

## Data model and migration

- `users.anonymised_at`.

## API

- `GET /admin/users/:id/anonymise` (the preview).
- `POST /admin/users/:id/anonymise` `{ transferTo }`: 202 with the job.

## Screens

People › a deactivated person's **Anonymise…** action: the preview, the transfer picker, and a confirmation that types their alias.

## System settings

None.

## Scale

Mentions are rewritten in batches of 1,000 rows inside the job, so a person with years of comments doesn't time out a request (JRASERVER-71251).

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: an active person refused; a directory person still in the directory refused; a token refused |
| R3, R5, R6 | Server test: after the job, the user row, sessions, tokens, mentions, audit strings, lead, component lead and shared views; running it again is harmless |
| R4 | Server test: the preview's counts and actions required. Browser journey: an admin anonymises a deactivated person |

## Out of scope and deliberate divergences

- **Deleting people:** The app never deletes people; anonymising a deactivated person is how their personal data goes.
- **Jira's alias for the username** (`jirauser…`): The app clears the username instead.

## Open questions

None.

## Changelog
