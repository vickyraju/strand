# 0713 Incremental directory synchronisation

Status: Implemented

## Context and Jira reference

- **Jira DC** ([connecting to an LDAP directory](https://confluence.atlassian.com/adminjiraserver/connecting-to-an-ldap-directory-938847052.html)), **Enable Incremental Synchronization** (Active Directory):
  - Jira reads only users and groups whose `uSNChanged` is higher than at the last run, following Microsoft's "Polling for changes using uSNChanged".
  - To see deletions, the service account must read the Deleted Objects container. By default only administrators can.
  - Jira runs a full synchronisation after a configuration change, and falls back to one when an incremental run fails.
  - `uSNChanged` isn't replicated across domain controllers, so the directory's server must stay the same.
- **Known problems:**
  - Groups deleted in AD aren't removed by incremental runs ([JSWSERVER-21235](https://jira.atlassian.com/browse/JSWSERVER-21235)).
  - New or deleted users and groups are missed until a full run ([KB](https://confluence.atlassian.com/jirakb/new-or-deleted-users-and-groups-from-active-directory-are-not-synchronised-in-jira-applications-269980444.html)).
  - Objects moved out of scope leave the cache inconsistent.
  - Atlassian's answer is to force a full synchronisation ([KB](https://support.atlassian.com/jira/kb/how-to-enforce-full-synchronization-between-jira-and-your-user-repository/)).
- **Before this spec:** every synchronisation reads every user and group (spec 0712). At 40,000 users that is the whole directory every hour.

## Rules

- **R1: Incremental runs.** An Active Directory with **Incremental synchronisation** on (the default for Active Directory, as in Jira) reads only the users and groups changed since the last run (`uSNChanged`).
  - Changed users are created, updated, linked, disabled or re-enabled as in a full run.
  - When any group changed, every group and its members are read again. Groups are few next to users, and this keeps memberships, nested groups and deleted groups exact.
- **R2: Full runs still happen.** A run is full when any of these holds:
  - it's the first run;
  - the directory's settings changed since the last full run, including its server;
  - the last run failed;
  - the directory doesn't report `uSNChanged`;
  - the last full run is older than **Full synchronisation every (hours)** (24 by default);
  - an administrator chose **Full synchronisation**.

  People deleted from the directory or moved out of scope are deactivated at the next full run, the zero-users guard included. The app doesn't need access to AD's Deleted Objects.
- **R3: Fallback.** An incremental run that fails becomes a full run at once. The result says why.
- **R4: Records.** Each run's result says whether it was full or incremental, and why a full run was chosen. Administration › User directories shows it.

## Permissions

System administrators, as for directories (spec 0712).

## Data model and migration

- `user_directories.sync_state jsonb` holds:
  - the highest `uSNChanged` seen;
  - a fingerprint of the settings at the last full run;
  - when that run was.
- `users.directory_dn` holds the person's DN in the directory, so a group's members are matched without reading every user.
- Directory settings gain `incremental` (Active Directory: on) and `fullSyncHours` (24).

## API

- `POST /admin/directories/:id/sync` `{ full?: boolean }`.
- Last-sync results gain `mode: 'full' | 'incremental'` and `why`.

## Screens

Administration › User directories:
- A directory's settings: **Incremental synchronisation** and **Full synchronisation every (hours)**.
- The directory's row: **Full synchronisation** beside Synchronise, and "Incremental" or "Full" in the last result.

## Scale

An incremental run reads only what changed, plus every group when one did. A full run reads everything, at most once per `fullSyncHours` unless asked.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R4 | Server test with a directory that reports `uSNChanged`: the first run is full; the next reads only a changed user (the search filter says so) and a newly disabled person is deactivated; a group change re-reads groups and memberships; a removed person stays until a full run, then is deactivated; a settings change, Full synchronisation and an out-of-date full run each force a full run; a failing incremental run falls back; a directory without `uSNChanged` is always full |
| R4 | Browser journey: Full synchronisation from the directory's row; the result says "Full" |

## Out of scope and deliberate divergences

- **Deleted Objects:** The app doesn't read AD's Deleted Objects container. Deletions are applied at the next full run (R2), which also catches objects moved out of scope, as Atlassian's KB recommends.
- **Generic LDAP:** incremental runs are for Active Directory, as in Jira.

## Proposals (not built until chosen)

None.

## Open questions

None.

## Changelog
