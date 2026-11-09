# 0714 Local users: Jira's internal directory

Status: Ported (aws-jira `0e12055`, strand `f57ca64`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: DIR-05, DIR-06

## Context and Jira reference

- **Jira DC:** every Jira has an **internal directory** beside any LDAP or Active Directory ones. Its users are kept by Jira.
  - Administration › User management › **Create user**: Username, Password, Full name, Email; **Send notification email** sends the username and a link to set a password, valid 24 hours. Leaving the password empty means the person can only get in through that link or **Can't access your account?** on the login page.
  - **Edit**: username, full name and email can be changed; **Active** can be cleared (deactivate).
  - **Actions › Set password**: an admin sets a new password.
  - People change their own password in their profile.
  - Users from LDAP or Active Directory can't be renamed, edited or given a password in Jira: that happens in their directory.
  - Atlassian recommends deactivating people rather than deleting them.
- **Source** (checked 10 Nov 2026): [Create, edit, or remove a user](https://confluence.atlassian.com/adminjiraserver/create-edit-or-remove-a-user-938847025.html), Jira DC 11.3.
- **Strand today:**
  - People come from Entra sign-in, SCIM and (spec 0712) user directories. Administration › People can only view and bulk-change them.
  - The login form (spec 0711) checks `recovery_admin` and user directories; Strand keeps no passwords of its own.

## Rules

- **R1: The internal directory.** Everyone who isn't from a user directory is in Strand's internal directory: people created here, and people who arrived through Entra or SCIM.
  - Administration › User directories lists **Strand internal directory** first, with how many active people it has.
  - The login form checks it first, then the user directories in their order (Jira's default order). The first directory that has the username decides.
- **R2: Create user** (Administration › People › Create user): Username, Full name, Email, Password, and **Send notification email**.
  - The username is 1–255 letters, digits and `. _ - @ +`, unique ignoring case among everyone (directory users too), and never `recovery_admin`. The email is unique.
  - With no password, **Send notification email** must be ticked, so the person has a way in.
  - The new person is a member of the workspace and in users-access, like anyone who signs in for the first time.
  - **Create another** keeps the dialog open for the next one.
- **R3: Edit details:** username, full name, email, and active.
  - Only for internal directory users. A directory user's details answer 409: they change in their directory.
  - The usual People rules hold: nobody deactivates themselves, and Strand keeps an active system administrator.
- **R4: Set password** (an admin, for an internal directory user): the new password works at once, and the person's other login-form sessions end.
- **R5: Passwords.**
  - Kept only as a salted scrypt hash, never returned.
  - At least `signIn.passwordMinLength` characters (default 8), at most 1024.
  - The login form checks them with 0711's one message and lock. An internal user with no password can't sign in with the form (Entra still works).
- **R6: Can't access your account?** The login form asks for a username or email and always answers the same ("If that account exists, we've sent an email"), so it never tells which accounts exist.
  - Internal directory users get an email with a link to set a password, valid 24 hours. Directory users are told nothing more: their password is in their directory.
  - At most one email per account every 5 minutes.
  - It needs email set up (System settings › Email notifications: sender and app address). Otherwise nothing is sent.
- **R7: The link** (`/?reset=…`): 256 random bits, kept only as a hash, used once.
  - Setting the password through it ends the person's login-form sessions, clears their lock, and is audited.
  - The link from **Send notification email** is the same kind of link.
- **R8: Change your own password** (Settings › Password): internal directory users who have a password give the current one and a new one. Their other login-form sessions end.
- **R9: Who.** Creating, editing and setting passwords: system admins, signed in themselves (not with an access token). Every change is audited (before and after; a password only as "set").

## Permissions

| Action | Who |
|---|---|
| Create, edit, set password | System admins, not with an access token |
| Can't access your account, the reset link | Anyone |
| Change own password | The person, signed in (not with an access token) |

## Data model and migration

- `users.password_hash` (scrypt), `users.password_changed_at`.
- `password_resets`: token hash, user, expires at, used at, created at.
- `signIn` gains `passwordMinLength` (default 8).
- `strand` gets the same migration in `supabase/migrations`.

## API

- `POST /admin/users`, `PATCH /admin/users/:id`, `PUT /admin/users/:id/password`
- Public: `POST /auth/forgot`, `POST /auth/reset`
- `PUT /me/password`
- `GET /me` gains `hasPassword` and `directory` (null for the internal directory). People rows gain `username` and `hasPassword`.

## Screens

- **People:** a **Create user** button; each internal directory person has **Edit** (details, active) and **Set password**.
- **Login form:** a **Can't access your account?** link; `/?reset=…` shows **Set your password**.
- **Settings › Password** for people with a password.
- **User directories:** the internal directory's row.

## System settings

`signIn.passwordMinLength`.

## Scale

Hashing a password takes about 50 ms of CPU, and the login form's lock limits how often a username is tried.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: internal first, then directories; the internal directory's row |
| R2, R3 | Server test: create (rules, duplicates, notification), edit, directory users refused. Browser journey: an admin creates a user who then signs in |
| R4, R5 | Server test: set password ends other sessions; the hash; minimum length; no password, no form sign-in |
| R6, R7 | Server test: the same answer for everyone; the email and its link; once only; expiry; one every 5 minutes |
| R8 | Server test: the current password is needed; other sessions end |
| R9 | Server test: an access token is refused; audit entries; permission matrix rows |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Deleting users:** not built; deactivate (Jira's recommendation). Anonymizing is a later spec.
- **Moving the internal directory** in the order: it is always first (Jira's default).
- **Password policy** beyond a minimum length: not built.

## Open questions

None.

## Changelog
