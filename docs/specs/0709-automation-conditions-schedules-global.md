# 0709 Automation: conditions, schedules, global rules

Status: Approved (PO, 10 Nov 2026: "move ahead with phase 7 … don't wait for my approval")
Parity rows: AU-01

## Context and Jira reference

- **Automation for Jira DC** (bundled since Jira 9; [Automation for Jira DC docs](https://confluence.atlassian.com/automation), checked 10 Nov 2026).
  - **A rule** is a trigger, then conditions, then actions.
  - **Rule scope:** a single project, several projects, a project type, or global. Global and multi-project rules are made by Jira admins under Administration › System › **Global automation**. Project admins see them in their project's list but can't change them.
  - **Conditions:** the item matches a JQL query (**JQL condition**), the item's fields (**Issue fields condition**, which a JQL query can say too), the user, related items, and if/else blocks.
  - **Scheduled trigger:** runs every N minutes, hours or days (or on a cron expression), optionally over the items a JQL query finds, optionally **only items changed since the rule last ran**. Jira caps how many items one run handles.
  - **Rule actor:** the "Automation for Jira" user by default.
- **Strand today:** project rules only, three triggers (created, assigned, moved to a status), five actions, with a dry run, an audit log of each run (90 days) and the owner told on failure. No conditions, no schedules, no rules across projects.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JIRAAUTOSERVER%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JIRAAUTOSERVER-229](https://jira.atlassian.com/browse/JIRAAUTOSERVER-229) An official REST API to manage rules | 251 | Gathering interest | **Built:** project and global rules are part of the documented API (R4) |
| [JIRAAUTOSERVER-218](https://jira.atlassian.com/browse/JIRAAUTOSERVER-218) A rule for a project category | 216 | Gathering interest | **Built:** a global rule's scope can be a project category, so new projects in it are covered without editing the rule (R3) |
| [JIRAAUTOSERVER-254](https://jira.atlassian.com/browse/JIRAAUTOSERVER-254) The person who triggered the rule as its actor | 187 | Gathering interest | **Partly built:** `currentUser()` in a condition is the person whose change triggered the rule (R1). Acting as them is **Proposal P1** |
| [JIRAAUTOSERVER-53](https://jira.atlassian.com/browse/JIRAAUTOSERVER-53), [JIRAAUTOSERVER-22](https://jira.atlassian.com/browse/JIRAAUTOSERVER-22) Lookup issues, variables | | Gathering interest | **Proposal P2** (with smart values) |
| [JIRAAUTOSERVER-749](https://jira.atlassian.com/browse/JIRAAUTOSERVER-749), [JIRAAUTOSERVER-71](https://jira.atlassian.com/browse/JIRAAUTOSERVER-71) Branches (act on sub-items, parent, linked items) | | Gathering interest | **Proposal P3** |
| [JIRAAUTOSERVER-23](https://jira.atlassian.com/browse/JIRAAUTOSERVER-23) Delay a rule | | Gathering interest | Not proposed |
| [JIRAAUTOSERVER-16](https://jira.atlassian.com/browse/JIRAAUTOSERVER-16), [JIRAAUTOSERVER-20](https://jira.atlassian.com/browse/JIRAAUTOSERVER-20) More triggers (cloned, development) | | Gathering interest | **Proposal P4** |

**Proposals for the product owner** (not built until chosen):

- **P1: Run as the person who triggered it**, so the workflow's and the permission table's checks apply to them.
- **P2: Smart values** in comments (`{{issue.key}}`, `{{issue.summary}}`, `{{initiator.name}}`), then lookups.
- **P3: Branches:** act on the item's sub-items, parent or linked items.
- **P4: More triggers:** a field changed, a comment added, a development event (spec 0707's GitHub data).

## Rules

- **R1: Conditions.** A rule can have a JQL condition. The rule acts only when the item matches it at the moment the trigger fires; otherwise the run is recorded as **condition not met** and nothing changes.
  - JQL sees every item in scope.
  - `currentUser()` is the person whose change fired it (nobody, for a schedule).
  - The condition is checked when the rule is saved: a mistake is a 400 saying where.
  - The dry run reports whether the item matches.
- **R2: Scheduled rules.** Trigger **Scheduled**:
  - runs every N minutes, hours or days. The shortest interval is a System setting;
  - over the items a JQL query finds in the rule's scope (required, since every action acts on an item);
  - optionally **only items changed since the last run**;
  - at most N items a run, a System setting. The run log says when items were left out.
  - Each item is acted on in its own savepoint, as today. A scheduled run is a background job; the next one is queued when it ends, so runs never overlap.
- **R3: Global rules.** Administration › **Automation** (system admins, signed in themselves) holds rules whose scope is:
  - every project;
  - the projects in a category, including ones added to it later;
  - or chosen projects, by key.

  Status triggers and actions name a status by name, since each project has its own statuses. A project where the name doesn't exist is skipped and logged. Project admins see the global rules that apply to their project, read-only. Global rules' runs show in each project's audit log and on the admin page.
- **R4: The API.** Project rules keep their routes, gaining `condition` and the scheduled trigger. Global rules have their own routes (below). Every change to a global rule is audited.
- **R5: Unchanged:** rules never trigger each other; failures undo only the rule's own changes and tell its owner; runs are kept 90 days.

## Permissions

- Project rules: project admins (unchanged).
- Global rules: system admins, signed in themselves (not with a token).

## Data model and migration

- `rules.condition` (JQL), `rules.last_run_at`.
- `rules.project_id` becomes nullable: null is a global rule, with `rules.workspace_id` and `rules.scope` (`{ kind: 'all' }`, `{ kind: 'category', categoryId }`, `{ kind: 'projects', projectIds }`).
- `rule_runs.result` gains `condition_not_met`.
- The `automation` System setting: `minScheduleMinutes` (default 5), `maxItemsPerRun` (default 1,000).
- `strand` gets the same migration in `supabase/migrations`.

## API

- Project rules: `trigger` gains `{ kind: 'scheduled', everyMinutes, jql, changedSinceLastRun }`; rules gain `condition`.
- `GET`, `POST /admin/automation/rules`; `PUT`, `DELETE /admin/automation/rules/:id`; `GET /admin/automation/runs`.
- `GET /projects/:key/automation/global` (the global rules that apply to the project, read-only, for its admins).

## Screens

- **The rule editor:**
  - **If** (a JQL condition, with the JQL box);
  - **Scheduled** among the triggers, with its interval, JQL and "only changed items".
- **Administration › Automation:** the same editor, plus the scope.
- **A project's Automation:** the global rules that apply to it, read-only.

## System settings

`automation`: `minScheduleMinutes`, `maxItemsPerRun`.

## Scale

- A change looks up the project's rules and the global rules whose scope covers the project: one indexed query.
- Scheduled rules page through their JQL, up to `maxItemsPerRun`. A rule whose run takes longer than its interval starts again after it ends.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: a condition that matches and one that doesn't (condition not met, nothing changed); currentUser(); a bad condition refused; the dry run reports it |
| R2 | Server test: a scheduled rule acts on the JQL's items; only changed items; the item cap; a too-short interval refused |
| R3, R4 | Server test: global rules in each scope (a project added to the category later is covered), status by name, a project lacking the status skipped; project admins can't change them; audit; non-admins refused |
| R5 | Existing automation tests |
| All | Browser journey: an admin makes a global rule for a category; an item created in a project of that category gets its label |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Cron expressions:** intervals only.
- **User, related-items and if/else conditions:** a JQL condition covers most of them; the rest come with P2 and P3.

## Open questions

None.

## Changelog
