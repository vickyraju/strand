# 0710 Remove License cleanup

Status: Ported (aws-jira `5811ed7`, strand `31d7aa1`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AD-06 (removed), PRM-17

## Context

- **Origin:** License cleanup came in with Administration › People (commit `6ee3111` on aws-jira, `52cdab7` on strand).
- **What it was:**
  - a count of seats in use;
  - a daily rule (`license.cleanup` job, 02:00 UTC) that deactivated people idle for a set number of days, or took them out of chosen groups;
  - warning emails, and a history of runs.
- **Why it goes:** Strand is built in-house. Nobody buys or pays for seats, so the feature has no purpose.
- **Kept:** the People features from the same commit stay:
  - last-active tracking and the Inactive filter;
  - bulk deactivate, reactivate and group changes;
  - the refused sign-ins list.

## Rules

- **R1: Nothing of License cleanup remains.**
  - The Administration menu has no License cleanup entry.
  - `/admin/license-cleanup*` answers 404.
  - System settings have no `licenseCleanup` setting, and saving one is refused as an unknown setting (404).
  - No `license.cleanup` job is scheduled or run.
- **R2: Its stored data goes.**
  - The migration drops the `license_cleanup_runs` table.
  - It deletes the `licenseCleanup` System settings rows and any queued `license.cleanup` jobs.
  - Old audit log entries stay: the audit log is never edited.
- **R3: People admin is unchanged.**
  - Activity still records `last_active_at`.
  - Bulk deactivate, reactivate and group changes work as before.
  - A deactivated person is refused at sign-in and appears in Refused sign-ins.
  - Signing in again puts a person back in users-access.

## Permissions

Unchanged for People. The removed routes are gone.

## Data model and migration

The deploy is rolling, so the migration happens in two releases (expand, then contract):

- **This release:**
  - a new migration drops `license_cleanup_runs`;
  - it deletes `system_settings` rows with key `licenseCleanup` and `jobs` rows of kind `license.cleanup`;
  - the code stops writing `users.cleanup_warned_at`.
- **Next release:** a separate migration drops `users.cleanup_warned_at`. Pods still running the old code write that column until the deploy finishes.
- `strand` gets the same migrations in `supabase/migrations`.

## API

The four `/admin/license-cleanup*` routes are removed. The OpenAPI document is regenerated.

## Screens

The Administration › License cleanup page and its menu entry are removed.

## System settings

`licenseCleanup` is removed.

## Scale

None.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: the routes answer 404, the setting is not listed and can't be saved. Browser journey: the Administration menu has no License cleanup |
| R2 | Server test: the table no longer exists after migrating |
| R3 | Server test: the People admin test (bulk deactivate, refused sign-in, back in users-access on sign-in, last active) |

## Strand branch

Same changes.

## Out of scope and deliberate divergences

None.

## Open questions

None.

## Changelog
