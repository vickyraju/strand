# 0712 User directories: Active Directory and LDAP, Read Only, as in Jira

Status: Implemented (approved 10 Nov 2026)

## Context and Jira reference

- **Jira DC:** Administration › User management › **User directories**.
  - Directories are listed in order. Each can be edited, tested, synchronised, disabled, and moved up or down.
  - A connector for Microsoft Active Directory or another LDAP server has permissions: **Read Only**, Read Only with Local Groups, or Read/Write.
  - Sign-in goes through the directories in order. The first directory that has the username decides.
  - A scheduled synchronisation copies users, groups and memberships into Jira's own tables.
  - Users missing from the directory are not deleted: they become inactive.
- **Sources** (checked 10 Nov 2026):
  - [Connecting to an LDAP directory](https://confluence.atlassian.com/adminjiraserver/connecting-to-an-ldap-directory-938847052.html): field names, defaults, the Active Directory and generic LDAP presets
  - [Managing multiple directories](https://confluence.atlassian.com/adminjiraserver/managing-multiple-directories-938847055.html): order, first match decides
  - [Synchronizing data from external directories](https://confluence.atlassian.com/adminjiraserver/synchronizing-data-from-external-directories-938847057.html)
- **The app today** (after spec 0711):
  - The login form exists. It checks only `recovery_admin`'s password, and has a hook for directories (`addPasswordChecker`).
  - People come from Entra sign-in and SCIM.
  - Directory groups (`source = 'directory'`) are read-only in the app (spec 0104).

## Rules

- **R1: The list.** Administration › User directories lists directories in order, each with its type, status and last synchronisation.
  - Actions: Edit, Test, Synchronise, Disable or Enable, Move up, Move down.
  - Permission is **Read Only**. Jira's other two permissions are a recorded gap.
- **R2: Jira's fields and defaults.** A directory is Active Directory or generic LDAP.
  - **Server:** name, host, port (389, or 636 with LDAPS), security (none, LDAPS, StartTLS), bind username, bind password, base DN.
  - **Search:** additional user DN, additional group DN, page size (1000), synchronise every N minutes (60), read and connect timeouts.
  - **Active Directory user schema:** object class `user`; filter `(&(objectCategory=Person)(sAMAccountName=*))`; username `sAMAccountName`; first name `givenName`; last name `sn`; display name `displayName`; email `mail`; unique id `objectGUID`.
  - **Group schema:** object class `group`; filter `(objectCategory=Group)`; name `cn`; description `description`.
  - **Membership:** group members `member`; user's groups `memberOf`; "use the user's membership attribute" on for Active Directory, off for LDAP; nested groups off.
  - **Generic LDAP preset:** `inetOrgPerson`, `uid`, `groupOfNames`, `entryUUID`.
  - An unencrypted connection is allowed, as in Jira, with a warning on the page.
- **R3: The bind password is write-only.**
  - It is stored encrypted (AES-256-GCM) with the key in `SECRET_KEY`. The ciphertext is bound to its directory's id, so a copied row doesn't decrypt.
  - The API never returns it, only `hasPassword`.
  - Changing the host, port, security or bind username needs the password again, so a stored password can never be sent to another server.
  - Without `SECRET_KEY`, saving a password is refused (400) and the page says why.
- **R4: Test settings** works on the unsaved form. It reports each step:
  - connect;
  - bind as the service account;
  - user search (how many, and a few names);
  - group search;
  - optionally, a test user: found, their groups, and their password checked.
- **R5: Password sign-in** (the login form of 0711) goes through the enabled directories in order. The first that finds the username decides.
  - The app binds as the service account, finds the user with an escaped filter (RFC 4515), then binds as the user with the password.
  - An empty password is refused before anything is sent, because an empty password is an anonymous bind.
  - A user disabled in Active Directory (`userAccountControl` bit 2) is refused.
  - Every failure gives 0711's one message, and counts towards 0711's lock.
  - A directory that can't be reached answers 503 ("can't be reached right now"), which is not counted as a wrong password.
- **R6: First sign-in before a sync.** A person who signs in before the first sync is created then, with their groups.
  - People are matched by the directory's unique id, then by email. A person Entra or SCIM already created is linked, not duplicated.
  - A system administrator's or the owner's account is never linked by email (skipped and reported): whoever controls the directory's email attribute must not be able to take it over.
- **R7: Full synchronisation** reads all users and groups page by page.
  - Users are created or updated in batches, matched by unique id, then by email.
  - People with no email, or with an email that another directory's user already has, are skipped and listed in the result.
  - A changed email, name or username in the directory changes it in the app, recorded in the audit log as a change of that field (before and after). Linking by email stays automatic (PO, 10 Nov 2026).
- **R8: Nobody is deleted.**
  - A user missing from the directory, or disabled there, is deactivated (and audited). One who comes back is reactivated.
  - A directory user's status belongs to the directory: People bulk deactivate and reactivate refuse them (409).
- **R9: Directory groups are read-only** (spec 0104).
  - A group renamed in the directory is renamed in the app.
  - A group whose name is already an app group is skipped and listed in the result.
  - A group removed from the directory keeps its row (so its project grants survive) and loses its members.
- **R10: Memberships mirror the directory:** from each user's `memberOf` when the user's membership attribute is used, otherwise from each group's `member`. With nested groups on, a member of a group inside a group is a member of both.
- **R11: Scheduling.** Each enabled directory synchronises every N minutes through the jobs table.
  - Only one synchronisation of a directory runs at a time across servers (a database lock held while it runs).
  - Synchronise now starts one at once.
  - The page shows the progress and the last result.
  - If a directory that had users suddenly returns none, the synchronisation stops and changes nothing, so a mistyped base DN can't deactivate everyone.
- **R12: A disabled directory** takes no sign-ins and no synchronisations. Its people keep their accounts.
- **R13: Who changes this.** System admins signed in themselves (not with an access token). Every change is audited; the password appears only as "changed".

## Permissions

- **Everything on this page:** system admins, not through an access token.

## Data model and migration

- `user_directories`: name, type (`ad`, `ldap`), position, enabled, config jsonb, `password_enc` bytea, `last_sync` jsonb, created and updated.
- `users.directory_id`, `users.directory_guid`: unique together.
- `groups.directory_id`, `groups.directory_dn`. Directory groups keep `source = 'directory'`.

## API

- `GET /admin/directories`, `POST /admin/directories`
- `GET /admin/directories/:id`, `PUT /admin/directories/:id`
- `PUT /admin/directories/order`
- `POST /admin/directories/test`
- `POST /admin/directories/:id/sync`

## Screens

- **Administration › User directories:** the list; the editor with Jira's sections (Server settings, LDAP schema, Advanced, User schema, Group schema, Membership schema); Test settings with each step's result; the password field showing "Unchanged" until edited; synchronisation progress.
- **People:** a "Directory: name" badge on directory users.
- **Jira equivalent:** Administration › User management › User directories.

## System settings

None. Each directory has its own interval.

## Scale

- 40,000 users: paged search (page size from the directory), upserts in batches of 500, memberships replaced per group in one statement.
- The job lease is extended after each page, so a long synchronisation isn't taken over by another server.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: list, order, disable. Browser journey: an admin adds a directory |
| R2 | Server test: the defaults of each preset |
| R3 | Server test: the password round-trips encrypted, a copied row doesn't decrypt, GET has no password, a host change without it is refused |
| R4 | Server test: the steps against the fake directory. Browser journey: Test is all green |
| R5 | Server test: order and first match; `*)(uid=*` finds nobody; an empty password never binds; a disabled account is refused |
| R6 | Server test: sign-in before a sync creates the person; an Entra person is linked by email |
| R7, R8 | Server test: create, update, link, skip, deactivate, reactivate; the 409 on bulk |
| R9, R10 | Server test: rename, clash, removal; nested groups |
| R11 | Server test: a second synchronisation at once is skipped; zero users changes nothing |
| R12, R13 | Server test: a disabled directory refuses sign-in; permission matrix rows |

## Out of scope and deliberate divergences

- **Read/Write and Read Only with Local Groups:** not built (Read Only only).
- **Incremental synchronisation** (Active Directory's `uSNChanged`): later (spec 0713), once a full synchronisation of 40,000 users is measured.
- **Other directory types** (Crowd, internal): not built.
- **Manage user status locally:** not built. A directory user's status always follows the directory (R8).
- **Large Active Directory groups:** with the user's membership attribute (the default for Active Directory), a group's size doesn't matter. Reading a group's `member` in ranges (over 1,500 members) is not built.

## Open questions

None.

## Changelog

- 10 Nov 2026: R6 never links an administrator's or the owner's account by email (security review). R7 records directory changes to email, name and username as field changes (PO).
