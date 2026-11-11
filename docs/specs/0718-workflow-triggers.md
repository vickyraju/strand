# 0718 Workflow triggers from development tools

Status: Approved (pending work, 12 Nov 2026)
Parity rows: WF-06

## Context and Jira reference

- **Jira DC** ([configuring workflow triggers](https://confluence.atlassian.com/adminjiraserver/configuring-workflow-triggers-938847513.html)): a transition in the workflow editor can have **triggers**. When a connected development tool reports one of these events for an issue, the issue moves through that transition.
  - **Events:** branch created, commit created, pull request created and pull request merged. Pull request declined and reopened also exist but are Bitbucket only.
  - **Atlassian's examples:**
    - Start progress (To Do → In Progress) on branch or commit created.
    - Start review on pull request created or reopened.
    - Done on pull request merged.
  - **Rules:** "When a transition is triggered automatically, it ignores any conditions, validators or permissions configured on the transition." Post functions still run.
  - **User:** the transition runs as the Jira user mapped from the tool's email and username. Without a match it runs anonymously.
  - **Duplicates:** duplicate commit and branch events are removed.
  - **Issue's status:** an issue whose status has no transition with that trigger stays where it is.
- **Strand today:** GitHub's branches, commits and pull requests reach the Development panel (spec 0707). Workflows have no triggers.

## Community and Atlassian backlog

| Ticket | Kind | What people ask | Here |
|---|---|---|---|
| [JSWSERVER-14577](https://jira.atlassian.com/browse/JSWSERVER-14577) | Suggestion (56 votes) | Conditions on development triggers, such as only pull requests merged into a given branch | P1 |
| [JSWCLOUD-14579](https://jira.atlassian.com/browse/JSWCLOUD-14579) | Suggestion | Triggers that respect conditions, because unwanted reopenings happen | P2 |

## Rules

- **R1: Triggers on a transition.** The workflow editor's transition rules gain **Triggers**:
  - Branch created;
  - Commit created;
  - Pull request created;
  - Pull request merged;
  - Pull request declined (closed without merging);
  - Pull request reopened.

  GitHub reports the last two too, so Strand offers them for GitHub as well; Jira offers them for Bitbucket only.
- **R2: Firing.**
  - When GitHub reports one of these events for a work item it links (the item's key in the branch, commit or pull request, spec 0707), the item moves through the first transition from its current status, for its work type, that has the trigger.
  - Conditions, validators and permissions are skipped, as in Jira. Post functions run.
  - Each event fires once: a branch or commit when first seen, a pull request when its state changes.
  - An item with no such transition from where it is stays.
  - An archived or deleted item never moves.
- **R3: Records.**
  - The item's history says "“Done” by GitHub: pull request merged", with no person behind it. Strand doesn't keep GitHub email addresses, so it can't map a person, as Jira's anonymous case.
  - Webhooks and notification schemes hear it as any status change: Issue Resolved into Done, Issue Reopened out of it, otherwise Generic Event.
  - Boards update live.

## Permissions

- Workflows: system administrators, as before.
- Firing needs no permission, as in Jira.

## Data model and migration

None: triggers live in a transition's rules (`rules.triggers`), so they travel with the workflow to its projects.

## API

- Workflow transitions' `rules` accept `triggers: ('branch_created' | 'commit_created' | 'pr_created' | 'pr_merged' | 'pr_declined' | 'pr_reopened')[]`.
- Firing comes from the GitHub webhook (spec 0707).

## Screens

The workflow editor's transition rules: **Triggers**, a checkbox per event, with a note that triggered moves skip conditions and validators.

## Scale

One query per linked item per event, inside the delivery's transaction.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R3 | Server test: a branch moves an item from To do to In progress; the same branch again doesn't; a pull request opened, then merged, moves it on to Done (resolved, with a webhook-visible history line) past a condition no person meets; a post function runs; an item whose status has no such transition stays; a malformed trigger is refused when saved |
| R1 | Browser journey: an admin ticks "Pull request merged" on a transition in the workflow editor |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **GitLab and Bitbucket:** Strand connects GitHub only (spec 0707).
- **Reviews (Crucible, Fisheye):** no such tools are connected.

## Proposals (not built until chosen)

- **P1: Branch conditions:** fire only for pull requests into, or branches named like, a pattern (JSWSERVER-14577).
- **P2: Respect conditions:** a per-trigger switch to apply the transition's conditions (JSWCLOUD-14579).

## Open questions

None.

## Changelog
