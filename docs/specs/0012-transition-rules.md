# 0012 Transition rules

Status: Implemented

## Context and Jira reference

A transition can carry rules: who may use it, what must be true to make it, what to ask for while making it, and what it changes. The rules live in a shared workflow's transitions (spec 0010), so they reach every project that uses the workflow. One pure module (`server/src/shared/transitionRules.ts`) decides them for the server and the web app alike, so the two always agree.

Extended by spec 0305 R6 (a "Set field → Resolution" action resolves under classic workflows), spec 0715 R6 (the "Trigger a webhook" action) and spec 0718 (triggers).

- **Jira DC:** [Working with workflows](https://confluence.atlassian.com/adminjiraserver/working-with-workflows-938847362.html): a transition has conditions (who and when; a transition whose conditions fail isn't shown), validators (checked when it is made), a transition screen, and post functions (changes made after it). The app follows Jira, under Jira Cloud's names: Restrict, Validate, Ask for input and Perform actions.

## Rules

- **R1: Rules on a transition.** A transition's `rules` have four parts: `restrict`, `validate`, `screen` and `actions`.
  - They are saved by publishing the workflow, and applied to each project with the statuses they name mapped to the project's own.
  - A rule that can't work is refused when saved, and nothing is saved (400): a field rules don't know, an action setting a field that can't be set (Type), or a custom field (projects have their own, and the workflow is shared).
  - Limits per transition: 10 groups, nested at most 3 deep, 50 rules in a group, 50 validators, 50 actions, 30 screen fields.
- **R2: Restrict: who may move.** Conditions:
  - the mover is the item's assignee, its reporter, or the project lead;
  - the mover is one of some people, has one of some project roles (admin, member), or is in one of some groups;
  - a field is empty, not empty, is a value, or is not a value (a list field "is" a value it contains);
  - every child item is done;
  - hidden: nobody (only automation).

  Conditions sit in groups that must all ("Must be all") or any ("Can be any") be met, and groups nest. With no conditions, anyone who may edit the item may use the transition.
- **R3: Automation is not a person.** For automation (no mover) the conditions about who moves are met, "hidden" is met only by it, and conditions about the item (fields, children done) still apply.
- **R4: Hidden, and refused.** `GET /issues/:key/transitions` lists only the transitions this person may use from the item's status, for its work type, loops included (`toId: null`). The web app offers the same. Moving through a transition whose Restrict fails is refused: 403 "You can’t make this move: …", ending "only automation makes it" for a hidden one, "its child items must be done first" for children done alone, else "the workflow limits who can make it, or when".
- **R5: Validate: what a move needs.** Validators, checked on the item as it will be after the move:
  - fields (or a comment) are required: "Due date is required for this move";
  - a field is changed in the move: "Change priority as part of this move";
  - the parent is in one of some statuses: "The parent item must be in In Progress first", or "This move is only for items with a parent".

  A move that fails is refused, 400 "“Finish” needs more information", with one error per field, and nothing is saved. `GET /issues/:key/transitions` gives each transition's `problems` up front.
- **R6: Ask for input: the transition screen.** `screen` lists fields (and a comment) to fill in while moving.
  - `POST /issues/:key/transitions { transitionId, fields, comment }` makes a transition: the fields are saved with the move, the comment is added, and its actions run, all or nothing.
  - The transition must be for the item's work type (404) and start from its status (409 "“Log progress” doesn’t start from this item’s status").
  - In the web app a move whose transition has a screen, or would fail its validators, opens a dialog with the fields and the problems; its button stays off until they are met.
- **R7: Perform actions.** After the move, in the same transaction:
  - assign to the mover, the reporter, the project lead, someone chosen, or nobody;
  - set a field to a value, or clear it (`null`); `today` for a date field is today's date;
  - copy a field from the parent;
  - add a comment.

  The history says "“Finish” changed resolution". An assignee who isn't in the project is skipped, and the history says so. Automation is nobody, so "assign to the mover" assigns nobody under it.
- **R8: Loops.** A transition with no To status (`toId: null`) leaves the item where it is: its comment is added, its actions run, and the history names it ("“Log progress”"). It is made only through `POST /issues/:key/transitions`. The item's Actions menu offers it; its screen opens as for a move, and "Log progress: done" confirms it.
- **R9: Every way of moving follows them.**
  - A status edit (`PATCH /issues/:key`) uses a transition from the item's status to the new one that this person may use.
  - A bulk edit refuses the whole change when any item refuses it.
  - Automation's status changes skip a transition its validators refuse, and the history says "Automation skipped a status change: …"; its actions run when it moves.
  - The web app applies the same rules before it saves.
- **R10: The editor's Rules tab.** In the workflow editor (spec 0011) a transition's Rules tab has Restrict transition, Validate details, Ask for input and Perform actions (and Triggers, spec 0718). "Add rule" adds a condition, such as "Only a project role" (admins).

## Permissions

- Rules are part of workflows: system administrators change them (spec 0010).
- Making a transition needs the right to change the item (spec 0201's table), and then its Restrict rules.

## Data model

`transitions.rules jsonb not null default '{}'`: `server/migrations/20261101090000_transition_rules.sql`. In a shared workflow, the rules are in `workflows.transitions` (`20261118090000_workflow_library.sql`).

## API

- `POST /admin/workflows/:id/publish`: transitions' `rules` (400 for a rule that can't work).
- `GET /issues/:key/transitions`: `[{ id, name, toId, screen, problems }]`.
- `POST /issues/:key/transitions`: 403 restricted, 400 validators, 404 not for its type, 409 not from its status.
- `PATCH /issues/:key` and `POST /issues/bulk/edit`: the same 403 and 400.

## Screens

- Administration › Workflows › a workflow › a transition › Rules.
- A work item: the Change status picker (only usable moves), the transition dialog (its screen and problems), and the Actions menu (loops).

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: bad rules are refused when saved, and nothing is saved |
| R2 | Server unit tests: who may move; field values; groups all and any, nested |
| R3 | Server unit test: automation is not a person. Server test: a hidden Reopen is automation's to use |
| R4 | Server test: the owner isn't offered a restricted move and is refused 403. Browser journey: a member isn't offered it. Unit test (web): hidden from those it isn't for |
| R5 | Server unit test: required fields and comment, a changed field, the parent's status. Server test: GET says so up front, PATCH and POST refuse with field errors. Unit test (web): refused until the checks pass |
| R6 | Server test: the screen's fields saved with the move. Browser journey: the dialog asks for the due date first. Server unit test: a screen needs input |
| R7 | Server unit test: assign, set and clear, today, copy from the parent, comment. Server test: the actions resolve, reassign and comment |
| R8 | Server test: a loop stays, comments and acts, and can't start from elsewhere. Browser journey: a loop from the Actions menu. Unit test (web): loops act without moving |
| R9 | Server test: bulk edit all or nothing; automation skips a move its validators refuse. Unit test (web): the same rules in the browser |
| R10 | Browser journey: a system admin adds "Only a project role" in the editor |

## Out of scope and deliberate divergences

- **Custom fields in rules (R1):** a shared workflow can only name the standard fields.
- **Names:** the app uses Jira Cloud's names for the four parts; Data Center calls them conditions, validators, the transition screen and post functions.
