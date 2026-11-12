# 0020 Automation rules

Status: Implemented

## Context and Jira reference

A project's automation rules do routine changes: when a work item is created, assigned or moved to a status, a rule assigns it, sets its priority, adds a label, moves it or comments. Rules act as a person would: they follow the workflow and the project's membership. A dry run shows what a rule would do, and an audit log shows every run.

- **Jira DC:** [Automation for Jira DC](https://confluence.atlassian.com/automation): a rule is a trigger, conditions and actions, with an audit log of each run; project admins manage their project's rules. The app follows Jira for the triggers and actions it has; the dry run is the app's own.
- Extended by spec 0709 (JQL conditions, scheduled and global rules, smart values, branches, the 90-day audit log and failures).

## Rules

- **R1: A rule.** A name, an on/off switch, a trigger and its actions in order. Project admins add and change their project's rules; the rule's owner is whoever made it.
  - **Triggers:** an item is created; an item is assigned (its assignee changes to someone); an item moves to a chosen status.
  - **Actions:** assign it (to a person, the reporter, the project lead, or nobody); set its priority (one of the list, spec 0305); add a label (one word, spec 0307); move it to a status; add a comment.
- **R2: When rules run.** Each enabled rule whose trigger matches runs once for the event, on the server in the same save as the change that fired it. A disabled rule doesn't run. A rule's own changes never fire other rules. Each run adds one to the rule's run count. A workspace kept in the browser runs its rules the same way.
- **R3: Rules act as a person would.**
  - A status action follows the workflow: a move the workflow doesn't allow is skipped, and so is one the transition's rules refuse. An allowed move runs the transition's actions.
  - An assignment to someone who isn't in the project is skipped.
  - Each skip is written to the item's history ("Automation skipped a status change the workflow does not allow", "Automation skipped an assignment: that person is not in this project"); the other actions still run.
  - Its changes are real history, with no person as the actor ("Automation changed assignee"), so reports and audits see them. Its comments have no author.
- **R4: What each action did.** Each action is done, unchanged (the item already had it) or skipped; a run is a success, some skipped, no change, or failed.
- **R5: Dry run.** A project admin tries actions on a work item of the project, by its key, and sees what each would do, with nothing changed (404 "No such work item in this project" for another key).
- **R6: Audit log.** A project admin lists the project's runs, newest first (50 by default, at most 200), narrowed by rule or result: when, the rule, the item, the trigger, what each action did, and the error of a failed run.

## Permissions

| Action | Outsider | Viewer | Member | Project admin, global admin |
|---|---|---|---|---|
| Add, change or delete a project's rules | 404 | No | No | Yes |
| Dry run, audit log | 404 | No | No | Yes |
| Fire a rule (by changing work) | | | Yes | Yes |

## Data model

- `rules` (`server/migrations/20261011205352_rest_of_schema.sql`): `project_id`, `name`, `enabled`, `trigger` (`{ kind: created | assigned | status, to? }`), `actions` (`[{ kind, … }]`), `runs`.
- `rule_runs`, `rules.owner_id`, `rules.failures` (`server/migrations/20261108090000_automation_runs.sql`): `rule_id`, `issue_id`, `trigger`, `result`, `steps` (`[{ action, outcome, note? }]`), `error`, `at`.

## API

- `POST /projects/:key/rules`, `PATCH /projects/:key/rules/:id`, `DELETE /projects/:key/rules/:id`: project admins; 400 for a priority not in the list or a label with a space.
- `POST /projects/:key/automation/dry-run` `{ issue, actions }`: `{ steps, error }`, nothing changed.
- `GET /projects/:key/automation/runs?rule=&result=&limit=`.

## Screens

- **Project settings › Automation** (`/project/KEY/settings/automation`): the rules; "Create rule" with its trigger, actions, and "Dry run" on a work item; "Audit log".
- The item's history shows what automation did and skipped.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: a rule on a status change sets the priority and comments. Unit test (web): a rule on creation |
| R2 | Unit tests (web): a rule fires once per event; a disabled rule doesn't; a rule on creation runs for new items. Server test: a new assignee fires "assigned" |
| R3 | Server test: a move the workflow doesn't allow and an outsider's assignment are skipped and noted in the history; the rest runs; an allowed move happens |
| R4 | Server test: the actions done and skipped on one item. Browser journey: the dry run shows "label: done" |
| R5 | Browser journey: a dry run shows what a rule would do, and nothing changes |
| R6 | Browser journey: the audit log shows each run and a failure |

## Out of scope and deliberate divergences

- **Rule actor:** Jira runs rules as a configured user; the app's changes have no person as actor, and it applies the workflow's and membership's checks itself.
- **Conditions, schedules, global rules, smart values, branches, failures and how long runs are kept:** spec 0709.
