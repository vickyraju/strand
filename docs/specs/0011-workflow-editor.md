# 0011 The workflow editor

Status: Implemented

## Context and Jira reference

A system administrator changes a shared workflow (spec 0010) in the workflow editor: a diagram of statuses and the arrows between them, or the same as a list. The editor works on a copy until it is published, checks the workflow before saving, and says what a save changes. Its operations are pure functions over a workflow value (`src/data/workflow.ts`), each returning a new value, or the very same one when nothing changes, so undo is cheap.

Extended by spec 0103 (an active workflow's name is read-only; a status with work can't leave), spec 0012 (the transition's Rules tab) and spec 0718 (Triggers).

- **Jira DC:** [Working with workflows](https://confluence.atlassian.com/adminjiraserver/working-with-workflows-938847362.html): the workflow designer adds statuses and transitions, marks a status "Allow all statuses to transition to this one", and publishes a draft. The app follows Jira's designer, with an undo history and a check before saving.

## Rules

- **R1: Adding a status.** A new status goes before the first Done status; a Done one goes last.
  - By default anything can move into it ("any status" transition named after it), and a status that isn't Done also gets one way on, "Move to <first In progress status>", so it is usable at once.
  - Without that it starts unconnected, and the check reports it unreachable (R9).
  - In the editor a name that matches a global status takes that status's colour and category.
- **R2: Changing a status.** Renaming a status also renames its "any status" transition while that still carries the old name; a transition someone named by hand keeps its name. An edit that changes nothing, or names an unknown status, changes nothing.
- **R3: Deleting a status.**
  - Its transitions in go; it leaves every From list; a transition left with no From status goes; its saved position goes.
  - The last status can't be deleted; an unknown one is ignored.
  - The delete dialog lists the transitions that go with it: those into and out of it, "any status" moves into it included.
  - The editor notes where the status's work would go, following a chain of later deletions to a status that still exists (a loop leads nowhere). Publishing doesn't send it: work in a removed status is spec 0103 R3.
- **R4: Order and start.** Statuses can be reordered (a position past the end is the end); the order is the board's column order. The first status is where new work starts; "Set as start" moves a status first.
- **R5: "Allow all statuses to move here"** adds or removes the status's "any status" transition, never twice.
- **R6: Transitions.**
  - A transition never starts where it ends, lists a From status once, and needs at least one From status (or any status); one that would have none isn't added.
  - Dragging from one status to another adds a transition named after the target (or the name given, trimmed). When a transition already allows that move, "any status" included, nothing is added and it is selected instead.
  - Transitions can be renamed, re-pointed and removed. Pointing one at a status in its From list takes that status out of the list; the check then reports it if none are left.
- **R7: Dragging an arrow's ends.**
  - The head moves the whole transition: every From status now leads to the new target, which leaves the From list. Refused when no From status would be left ("A transition needs at least one status to start from").
  - The tail swaps that one From status (merging with one already there; the target drops out). Refused when none would be left. An "any status" transition has no tail to drag.
- **R8: Drawing arrows and labels.**
  - One arrow per From status; none for "any status", for a loop, or for a status that doesn't exist.
  - Arrows between the same two statuses bend apart: opposite directions to opposite sides, several the same way fan out, a lone arrow stays straight.
  - An arrow leaves the side of a status that faces the other. Arrows side by side are 26 px apart, 50 px when running up or down, so labels fit.
  - A label sits at the middle of its arrow when that is free. Otherwise it slides along the arrow (to 0.4, 0.6, 0.3, 0.7, 0.22 or 0.78 of the way) to keep off other labels and the status boxes. When nothing is free it keeps the middle.
- **R9: Checking before saving.** Errors block saving ("Fix these before saving"); warnings don't ("Worth a look (you can still save)"); errors are listed first, and clicking one selects its status or transition.
  - Errors: no statuses; no Done status; a blank status name; a name used twice, ignoring case ("“b” is used by more than one status."); a status nothing can reach; a status that isn't Done and that work can't leave; a transition with a blank name; a transition with no From status.
  - Reachable means: the start status, any status an "any status" transition goes to, and everything those lead on to. A loop is no way out; an "any status" transition into another status is.
  - Warning: new work starts in a Done status.
- **R10: Positions and automatic layout.**
  - A status's position is stored as whole numbers; moving it to the same spot is no change.
  - Automatic layout runs left to right from the start status, which stays on the left even when work can be reopened into it. Positions sit on a 10 px grid; the same workflow always gets the same layout; boxes never overlap, with cycles, branches and loose statuses too.
  - A workflow made only of "any status" moves reads left to right in board order, on one row; a status with no arrows follows the one before it.
  - With nothing saved the editor lays the workflow out automatically. Saved positions are kept; a status without one goes to the right of everything saved; the saved position of a deleted status is ignored.
- **R11: Undo and redo.** Every change can be undone and redone (buttons, Ctrl+Z, Shift+Ctrl+Z, Ctrl+Y). A new change forgets what could be redone. Changes of the same kind within 800 ms (typing a name, dragging a box) are one step; another kind, or a pause, starts a new one. Setting the same value is no change. The last 100 steps are kept.
- **R12: Saving.** Update workflow is on only when the workflow differs from the published one (statuses, transitions or positions). It checks first (R9), then asks the server for a dry run and shows what changes in words, matched by id: "Adds the status “Done”", "Removes the status “Review”", "Renames “To do” to “Backlog”", "Adds the transition “Log”", "Changes the transition “Start” (where it goes, its rules or work types)". Moving boxes isn't listed. Discard changes goes back to the published workflow.

## Permissions

As spec 0010: system administrators edit and publish workflows.

## Data model

`workflows.layout` (status id → `{ x, y }`): `server/migrations/20261118090000_workflow_library.sql`.

## API

The editor uses spec 0010's routes: `GET /workflows/:id`, `GET /admin/statuses`, `POST /admin/workflows/:id/publish` (first with `dryRun`), `GET /workflows/:id/versions`.

## Screens

- Administration › Workflows › a workflow: Diagram and List tabs, Add status, Add transition, undo and redo, Arrange automatically, Show transition labels, Versions, Discard changes, Update workflow.
- The Properties panel for the selected status (name, description, category, colour, "Allow all statuses to move here", Set as start, Delete status) or transition (Details: name, From statuses or Any status, To status, Delete transition; Rules: spec 0012).

## Acceptance

| Rule | Test |
|---|---|
| R1 | Unit test (web): a status added before the Done ones, usable at once, the original untouched; a Done one last; without "global" unconnected |
| R2 | Unit test (web): renaming renames the "any status" transition, not one named by hand |
| R3 | Unit tests (web): deleting removes moves in and out and drops those left with no start; the last status stays; the transitions that go with a status; where its work goes |
| R4 | Unit test (web): reordering, clamped, and the first is the start |
| R5 | Unit test (web): switched on and off without duplicating |
| R6 | Unit tests (web): no transition into its own start, a status listed once, a From needed; connecting adds or reuses; rename, re-point, remove |
| R7 | Unit tests (web): dragging the head and the tail, refused when no start is left |
| R8 | Unit tests (web): arrows per From status; bent apart; the side facing the other status and lanes; labels slide apart and stay off boxes, or keep the middle |
| R9 | Unit tests (web): reachability; a sound workflow; each error, pointing at its culprit; the warning after the errors |
| R10 | Unit tests (web): whole-number positions; layout left to right on the grid, the same every time, no overlaps; "any status" workflows in board order; the start on the left; saved positions kept and new ones clear of them |
| R11 | Unit tests (web): undo and redo; joined steps; the same object is no change; capped at 100 |
| R12 | Unit tests (web): same content is the same workflow; the diff in words, ignoring layout |

## Out of scope and deliberate divergences

- **Drafts kept on the server:** spec 0103.
- **Undo history (R11) and the check before saving (R9):** the app's own; Jira's designer has neither.
