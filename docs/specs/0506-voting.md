# 0506 Voting

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC** (an issue's **Vote** button; General configuration › **Voting**):
  - Anyone who can see an issue can vote for it, once, and take the vote back. **You can't vote for an issue you reported**, and **votes on resolved issues can't change**.
  - The issue shows how many votes it has; who voted shows to people with **View Voters and Watchers**.
  - Voting can be turned off for the whole instance (votes are kept); the webhook `option_voting_changed` says so.
  - JQL: `votes` (a number), `issue in votedIssues()`, `ORDER BY votes`.
- **Before this spec:** no voting; the app's permission table already has View voters and watchers (viewer).

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22vote%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | The app |
|---|---|---|---|
| [JRASERVER-24988](https://jira.atlassian.com/browse/JRASERVER-24988) Voting per project | 447 | Not being considered | **Proposal P1** |
| [JRASERVER-5383](https://jira.atlassian.com/browse/JRASERVER-5383), [JRASERVER-7522](https://jira.atlassian.com/browse/JRASERVER-7522) My votes as a filter; search what I voted for | | Gathering interest | **Built:** `issue in votedIssues()` (R3) |
| [JRASERVER-66924](https://jira.atlassian.com/browse/JRASERVER-66924) Reporters voting for their own issues | 58 | Gathering interest | Not proposed (Jira's rule kept) |
| [JRASERVER-3731](https://jira.atlassian.com/browse/JRASERVER-3731) Move votes to the issue a duplicate points to | 43 | Gathering interest | **Proposal P2** |

**Proposals for the product owner** (not built until chosen):

- **P1: Voting per project** (a project setting under the workspace's switch).
- **P2: Carry votes to the original** when an item is resolved as a duplicate of it.

## Rules

- **R1: Voting.** Anyone who can see an item can vote for it and take the vote back, except its reporter, and not once it has a resolution (as Jira's). The item shows its vote count; who voted shows to people who hold View voters and watchers.
- **R2: The switch.** System settings › **Voting** turns voting on or off for everyone (on by default, as Jira's). Off: the vote button goes and voting is refused; votes are kept. Turning it on or off sends Jira's `option_voting_changed` webhook.
- **R3: JQL:** `votes` with `=`, `!=`, `<`, `<=`, `>`, `>=`; `issue in votedIssues()`; `ORDER BY votes`.
- **R4: Webhooks and the item's API** carry Jira's `votes` (`votes`, `hasVoted`).

## Permissions

Browse projects to vote; View voters and watchers (viewer) to see who voted.

## Data model and migration

- `issue_votes`: item, person, when.
- The `voting` System setting.

## API

- `PUT`, `DELETE /issues/:key/vote`; `GET /issues/:key/votes` (who voted).
- Items gain `votes` and `hasVoted`.

## Screens

The item's details: a vote button with the count, and who voted.

## Scale

The count comes from an index on the item.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R4 | Server test: vote and unvote; the reporter and resolved items refused; the switch, its webhook |
| R3 | Server test: votes, votedIssues(), ORDER BY votes |
| R1 | Browser journey: someone votes for an item and sees the count |

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
