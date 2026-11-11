# 0510 Bulk transition, watch and stop watching

Status: Approved (pending work, 11 Nov 2026)
Parity rows: ISS-20

## Context and Jira reference

- **Jira DC** (Search › Tools › **Bulk Change**):
  - **Transition issues:** the selected issues are grouped by workflow and transition. The person picks one transition, fills its screen's fields and an optional comment, and every issue in that group moves. Issues the transition doesn't apply to are left alone. The resolution can be left as it is.
  - **Watch issues** and **Stop watching issues:** the person starts or stops watching every selected issue they can see.
  - **Send notification** is on every bulk operation (spec 0605 R6).
- **Strand today:** the selection bar edits, moves, deletes and restores. Its Status picker sets each item's status directly, outside the workflow (local mode only, with the API it went through PATCH). It has no bulk Watch.

## Community and Atlassian backlog

| Ticket | Kind | What people ask | Here |
|---|---|---|---|
| [JRASERVER-2429](https://jira.atlassian.com/browse/JRASERVER-2429) | Suggestion | Bulk Watch | R1 |
| [JRASERVER-2427](https://jira.atlassian.com/browse/JRASERVER-2427) | Suggestion | Bulk Workflow Transition | R2 |
| [JRASERVER-60304](https://jira.atlassian.com/browse/JRASERVER-60304) | Suggestion | A comment on a bulk transition whose transition has no screen | R2: the comment is always offered |
| [JRASERVER-9844](https://jira.atlassian.com/browse/JRASERVER-9844) | Bug | Validators silently break Bulk Transition | R2: every item's outcome, with the reason |
| [JRASERVER-34902](https://jira.atlassian.com/browse/JRASERVER-34902), [JRASERVER-43564](https://jira.atlassian.com/browse/JRASERVER-43564) | Suggestion | Bulk transition forces or overwrites the resolution | R2: the resolution is optional; the workflow's default applies |
| [JRASERVER-39446](https://jira.atlassian.com/browse/JRASERVER-39446), [JRASERVER-71848](https://jira.atlassian.com/browse/JRASERVER-71848) | Suggestion | Bulk transition through the REST API | API |

## Rules

- **R1: Watch and stop watching.** The selection bar has **Watch** and **Unwatch**. Each starts or stops the person watching every selected item. It needs only Browse projects, as watching one item does. Items already in that state stay as they are.
- **R2: Transition.** The selection bar has **Transition…**. The person chooses a status by name, a resolution if it's a Done status (optional), and a comment (optional).
  - Each item moves through a transition its own workflow allows from its current status to that status, with the same rules, validators and conditions as moving it alone.
  - One item failing doesn't stop the others. Each item gets one outcome:
    - **Moved**;
    - **Already there**;
    - **Skipped**, with the reason, when its workflow has no such transition;
    - **Not moved**, with the reason, when it can't be seen, the person may not transition it, or the transition refuses it.
  - **Send notifications** from the bar applies (spec 0605 R6).
- **R3: Results.** After a transition the dialog lists every item with its outcome, and the boards and backlogs reload.

## Permissions

- R1: Browse projects on each item.
- R2: Transition issues on each item; refusals are outcomes, not errors.
- Turning notifications off: as in spec 0605.

## Data model and migration

None.

## API

- `POST /issues/bulk/watch` `{ issues: string[], watching: boolean }` → `{ count }`.
- `POST /issues/bulk/transition` `{ issues: string[], toStatus: string, fields?, comment?, sendNotifications? }` → `{ results: { key, outcome: 'done' | 'unchanged' | 'skipped' | 'failed', reason?, errors? }[], done }`.
- Both take at most System settings › Search and bulk › bulk maximum.

## Screens

- The selection bar (lists, backlogs, boards): **Watch**, **Unwatch**, **Transition…**.
- The Status picker stays only for the browser-only demo, which has no workflows.

## Scale

Each item runs under its own savepoint within one transaction, at most the bulk maximum (default 200).

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2 | Server test: watch and stop watching as a viewer; an item outside their projects refused; transition across two projects with a resolution and a comment; already there, no such transition, and a viewer's refusal reported |
| R1, R2, R3 | Browser journey: stop watching and watch two items from the selection bar; transition them to Done with a comment; both shown as Moved |

## Strand branch

Same rules. Items behind a security level the person isn't in are reported as not found.

## Out of scope and deliberate divergences

- **One status, not one transition per workflow group:** Jira asks for a transition per group of issues that share a workflow and transition. Strand asks for the status once and finds each item's transition to it. The outcome is the same for the usual case (one target status), and items whose workflow can't get there are reported, not hidden.
- **Transition screens:** the dialog offers the resolution and a comment, not every field of each transition's screen. A field a validator requires shows as the item's reason.

## Proposals (not built until chosen)

- **P1: Choose the transition by name** when two transitions reach the same status (Jira's grouping), for workflows where the transition name matters (e.g. "Reject" and "Close" both to Done).

## Open questions

None.

## Changelog
