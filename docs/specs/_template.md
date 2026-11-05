# NNNN Title

Status: Draft
Parity rows: (ids in `../jira-parity.md`)

## Context and Jira reference

Why this change, in a few lines.

- **Jira DC:** what Jira does, with the Atlassian page (URL), the Jira version it describes and the date it was checked.
- **Strand today:** what Strand does, with `file:line`.

## Rules

- **R1** One behaviour, stated so a test can check it.
- **R2** …

## Permissions

| Action | Outsider | Viewer | Member | Project admin | Global admin |
|---|---|---|---|---|---|
| … | | | | | |

## Data model and migration

Tables and columns. How existing data is brought over (a background job when it can be large), whether it can be undone, and the same migration for `strand` (`supabase/migrations`).

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

## Strand branch

Anything different on `strand`: issue security levels, the development sign-in, `supabase/migrations`.

## Out of scope and deliberate divergences

Each with its reason; the same entries go into `../jira-parity.md`.

## Open questions

Each with the Jira-way answer, which applies unless the product owner decides otherwise.

## Changelog

Changes after approval, with the date of re-approval.
