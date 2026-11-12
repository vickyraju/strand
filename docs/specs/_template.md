# NNNN Title

Status: Draft

## Context and Jira reference

Why this change, in a few lines.

- **Jira DC:** what Jira does, with the Atlassian page (URL), the Jira version it describes and the date it was checked.
- **Before this spec:** what the app does today, with `file:line`.

## Community and Atlassian backlog

What Jira's users say about this feature and what Atlassian has left open, with links:

- **Complaints and workarounds** on the Atlassian Community.
- **Open suggestions and bugs** on jira.atlassian.com (key, votes, status), and what was fixed in which version.
- **Proposed improvements:** each one a proposal to accept or decline. Accepted ones become rules below; core behaviour stays Jira's, and Jira data still migrates.

## Rules

- **R1: Short name.** One behaviour, stated so a test can check it.
- **R2: …** …

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| … | | | | | |

## Data model and migration

Tables and columns. How existing data is brought over (a background job when it can be large), and whether it can be undone.

## API

Routes added or changed, request and response shapes, error codes and their messages.

## Screens

What changes on which screen, and the Jira screen it corresponds to.

## System settings

New settings, with Jira's default as the default.

## Scale

What pages on the server, which indexes, and what runs as a job, at 40,000 people and 6,000 projects.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | server test / permission matrix row / web unit test / browser journey, or why not |

## Out of scope and deliberate divergences

Each with its reason.

## Open questions

Each with the Jira-way answer, which applies unless decided otherwise.

## Changelog

Changes after approval, with the date of re-approval.
