# 0604 Filter subscriptions

Status: Ported (aws-jira `f98019d`, strand `b4ad527`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: SR-05

## Context and Jira reference

- **Jira DC** (a filter's **Details › New subscription**; Manage filters' Subscriptions column):
  - **Recipients:** yourself (a personal subscription), or a group. Subscribing a group needs the global permission **Manage group filter subscriptions**, which Jira's default global permissions give everyone with application access.
  - **Schedule:** Daily, Days per week or Days per month (a day number, or "the second Wednesday", or the last day), once at a time or every so many minutes or hours. Advanced takes a cron expression, which is how Jira stores every schedule: Quartz cron (`seconds minutes hours day-of-month month day-of-week [year]`), in the server's time zone.
  - **"Email this filter, even if there are no issues found"**: off by default, so an empty result sends nothing.
  - **The email:** the filter's results as each recipient may see them, with a link to the filter.
  - **Run now**; edit and delete the subscription. Deleting the filter deletes its subscriptions.
- **Strand today:** saved views (Jira's filters) with sharing (spec 0203); emails go through queued jobs (`email.ts`); no subscriptions.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22filter%20subscription%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search and Atlassian's documentation pages on subscriptions couldn't be read by the tools that day.

| Atlassian issue | Type | Strand |
|---|---|---|
| [JRASERVER-61543](https://jira.atlassian.com/browse/JRASERVER-61543), [JRASERVER-74338](https://jira.atlassian.com/browse/JRASERVER-74338), [JRASERVER-68697](https://jira.atlassian.com/browse/JRASERVER-68697) A large group's subscription stops mail or runs out of memory | Bugs | **Built:** one queued job per recipient (Scale) |
| [JRASERVER-23462](https://jira.atlassian.com/browse/JRASERVER-23462) A deactivated person's subscriptions keep sending | Bug | **Built:** they stop (R3) |
| [JRASERVER-24647](https://jira.atlassian.com/browse/JRASERVER-24647) Duplicate emails for people in several groups | Suggestion | **Built:** one email per person per run (R3) |
| [JRASERVER-77637](https://jira.atlassian.com/browse/JRASERVER-77637) Subscription results differ from the search | Bug | **Built:** each run is the live search (R3) |
| [JRASERVER-33334](https://jira.atlassian.com/browse/JRASERVER-33334) Change the most results in the email | Suggestion | **Built:** a System setting (R4) |
| [JRASERVER-5697](https://jira.atlassian.com/browse/JRASERVER-5697) Show the next run | Suggestion | **Built** (R2) |
| [JRASERVER-41269](https://jira.atlassian.com/browse/JRASERVER-41269) Administrators manage others' subscriptions | Suggestion | **Built** on a view (R1); an all-subscriptions page is **Proposal P1** |
| [JRASERVER-12397](https://jira.atlassian.com/browse/JRASERVER-12397) Send only when the results changed | Suggestion | **Proposal P2** |
| [JRASERVER-36645](https://jira.atlassian.com/browse/JRASERVER-36645) Results as an attachment | Suggestion | **Proposal P3** |
| [JRASERVER-35006](https://jira.atlassian.com/browse/JRASERVER-35006), [JRASERVER-60160](https://jira.atlassian.com/browse/JRASERVER-60160) Opt out of a group's subscription | Suggestions | **Proposal P4** |
| [JRASERVER-16864](https://jira.atlassian.com/browse/JRASERVER-16864) Subscribe a project role | Suggestion | **Proposal P5** |
| [JRASERVER-60154](https://jira.atlassian.com/browse/JRASERVER-60154) The filter's own columns | Suggestion | Partly: the view's order; fixed columns (R4) |
| [JRASERVER-34166](https://jira.atlassian.com/browse/JRASERVER-34166) Send to people outside Jira | Suggestion | Not proposed (results would leave the permission model) |

**Proposals for the product owner** (not built until chosen):

- **P1: Administration › Filter subscriptions:** every subscription, a page at a time, with remove.
- **P2: Only when changed:** send only when the results differ from the last run.
- **P3: Attach the results as CSV.**
- **P4: Opt out** of a group's subscription, per person.
- **P5: Subscribe a project's role** (its admins, members or viewers).

## Rules

- **R1: Subscribing.** Anyone who can see a saved view subscribes to it: themselves, or a group when they hold Manage group filter subscriptions (System settings › Filter subscriptions: everyone, as Jira's default, or system administrators only). A subscription's creator, or a system administrator, changes or deletes it; deleting the view deletes its subscriptions.
- **R2: Schedule.** Daily, days of the week, or a day of the month (a number, the first to fourth or last weekday, or the last day), at a time or every 15, 30 minutes or 1, 2, 3, 4, 6, 12 hours; or Advanced: a Quartz cron expression, as Jira stores them (seconds, minutes, hours, day of month, month, day of week, optional year; `*`, `?`, lists, ranges, steps, `L`, `W` not supported, `#`, day and month names). Times are the server's time zone. The next run shows with the subscription.
- **R3: Who gets it.** A personal subscription: its creator. A group's: each active member who can see the view, once. Each recipient gets the items they may see: the view runs as them, live. A deactivated creator's subscriptions send nothing.
- **R4: The email.** Subject "[Strand] Subscription: view name". The first items (System settings › Filter subscriptions: at most 200 by default) in the view's order, with key, summary, status, assignee and priority, then "and N more" and a link to the view. With no results nothing is sent unless "Email even if there are no work items" is on. Nothing is sent while email is off (spec 0105).
- **R5: Run now** sends it straight away; the schedule carries on.
- **R6: Records.** Each run notes when it ran; subscribing a group, and an administrator's change to someone else's subscription, are audited.

## Permissions

Seeing the view to subscribe; Manage group filter subscriptions (the setting) to subscribe a group; the creator or a system administrator to change or delete.

## Data model and migration

- `filter_subscriptions`: view, creator, group (none: personal), cron, email when empty, next run, last run.
- The `filterSubscriptions` System setting.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET`, `POST /views/:id/subscriptions` (creators see theirs; system administrators see all).
- `PATCH`, `DELETE /subscriptions/:id`; `POST /subscriptions/:id/run`.

## Screens

A saved view's **Subscribe** button: its subscriptions (who, schedule, next run, Run now, edit, delete) and the form (personal or a group; Daily, Days per week, Days per month or Advanced; time or interval; the empty-result checkbox).

## Scale

Each run queues one job per recipient (a group of thousands sends a job each), and each runs the view as that person with the item limit. Runs are queued jobs at their time, not a timer per subscription.

## Acceptance

| Rule | Proved by |
|---|---|
| R2 | Unit test: Jira's cron forms give the right next runs (daily, weekdays, day of month, 2#1, L, intervals, year) and bad ones are refused |
| R1, R3, R4, R5, R6 | Server test: personal and group subscriptions; recipients see only their items; deactivated people and those who can't see the view skipped; empty results; the limit; Run now; the setting; who may change |
| R1 | Browser journey: subscribe to a view daily, Run now, the email arrives |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Per-person time zones:** Strand has none; schedules use the server's, as Jira's do by default.

## Open questions

None.

## Changelog

- 12 Nov 2026: "Who may subscribe a group" became the Manage group filter subscriptions global permission (spec 0717). A workspace that had chosen system administrators only keeps that, through no grant.
