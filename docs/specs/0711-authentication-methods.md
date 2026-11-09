# 0711 Authentication methods: Entra SSO configured in Administration, the login form, fallback and recovery

Status: Approved (PO, 10 Nov 2026: "make sso configurable in the admin section … so the system admin can configure the sso enable or disable it when needed"; "when sso is turned off it will show a username and password field to login, check how it is in Jira data center")
Parity rows: AUTH-01, AUTH-02, AUTH-03

## Context and Jira reference

- **Jira DC 8.15 and later:** Administration › System › **Authentication methods** (it was called SSO 2.0 before).
  - Configurations are listed in order, and each one can be enabled or disabled.
  - The default username/password **login form** can be shown or hidden. With one SSO method and the form hidden, people go straight to it.
  - `enable-authentication-fallback` keeps the login form reachable even when it is hidden.
  - **Recovery mode:** a startup property (`-Datlassian.recovery.password`) gives a temporary `recovery_admin` account when everything else is broken.
- **Sources** (checked 10 Nov 2026):
  - [Using multiple identity providers](https://confluence.atlassian.com/enterprise/using-multiple-identity-providers-1044779993.html)
  - [Obtaining authentication methods via REST](https://confluence.atlassian.com/jirakb/how-to-obtain-authentication-methods-via-a-database-sql-query-or-rest-api-in-jira-datacenter-1319567431.html): `show-login-form`, `enable-authentication-fallback`
  - [Recover admin rights (recovery mode)](https://confluence.atlassian.com/jirakb/restore-passwords-to-recover-admin-user-rights-in-jira-server-and-data-center-972329273.html)
- **Strand today:**
  - **Server:** Microsoft Entra is the only sign-in. It is configured by `ENTRA_*` environment variables, read once at start, and the server refuses to start without them.
  - **Web app:** the Entra values are fixed when it is built (`VITE_ENTRA_*`).
  - **No login form.** Strand has never had passwords.
  - **Strand branch:** a developer login only.

## Rules

- **R1: Public sign-in configuration.** `GET /auth/config` needs no sign-in. The login page reads it to show:
  - whether the login form is shown;
  - whether fallback is on;
  - the Entra button: its name, the tenant, the web client id, the authority and the scope.

  It never reveals recovery mode or anything about directories.
- **R2: Upgrading changes nothing.** On start, if no Entra configuration is stored but `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are set, Strand stores one from them, enabled. It uses `ENTRA_AUTHORITY` and `ENTRA_WEB_CLIENT_ID` too.
  - The seed is audited, and from then on the stored configuration wins.
  - The server no longer needs `ENTRA_*` to start.
- **R3: Entra configuration.** A system admin edits:
  - enabled;
  - the button's name (default "Microsoft");
  - tenant id;
  - API client id (the audience of the tokens);
  - web client id (the app the browser signs in with);
  - authority (default `https://login.microsoftonline.com`).

  Enabling it first fetches Entra's discovery document. The issuer must match, and the signing keys must be reachable; otherwise it answers 400 saying what failed. A configuration can be saved disabled without the check.
- **R4: Changes apply everywhere.** Every server uses the current configuration within 10 seconds. When Entra is disabled, Entra tokens are refused (401), and changing the tenant stops tokens from the old one.
- **R5: At least one way in, as in Jira.** Each of these is refused with 409 "At least one authentication method must be shown on the login page":
  - hiding the login form while Entra is disabled;
  - disabling Entra while the login form is hidden.

  Recovery mode does not count.
- **R6: Authentication fallback** (Jira's `enable-authentication-fallback`, off by default).
  - With the form hidden and fallback on, `/?auth_fallback` shows the form.
  - With the form hidden and fallback off, the server refuses password sign-ins (403 "The login form is turned off"), except for `recovery_admin`.
- **R7: One method, straight there.** With the form hidden and Entra enabled, the login page goes straight to Microsoft, unless `?auth_fallback` is in the address.
- **R8: Password sign-in and sessions.** A sign-in through the form returns a session.
  - The token starts `jbs_`, is 256 random bits, and is stored only as a hash.
  - It ends after `signIn.sessionIdleMinutes` without use (default 300, Jira's 5 hours). "Remember my login on this computer" keeps it for `signIn.rememberDays` (default 14).
  - Sign out ends it at once on every server.
  - A deactivated person is refused (403) and appears in Refused sign-ins.

  Which passwords are checked: `recovery_admin`'s (R10) and, from spec 0712, those of user directories.
- **R9: Failed sign-ins.** Every failure gives one message, so nobody learns which usernames exist: "Sorry, your username and password are incorrect - please try again."
  - After `signIn.maxFailures` failures (default 3, Jira's CAPTCHA threshold), the username is locked for `signIn.lockMinutes` (default 5): 429 with `Retry-After`.
  - While a username is locked, no password is checked anywhere, so the company directory's own lockout is never tripped.
  - An empty password always fails.
  - A successful sign-in clears the count.
- **R10: Recovery mode** is on while the server has `STRAND_RECOVERY_PASSWORD` (16 characters or more).
  - `recovery_admin` signs in with it through the form, whatever R5 and R6 say. It is a system admin, and every sign-in is audited.
  - It can change Authentication methods: restoring access is what it is for.
  - System admins see a banner on every page: "Strand is running in recovery mode".
  - `recovery_admin` can't be the first person in a new workspace, and can't create access tokens.
  - When the variable is removed, its sessions stop working and it is taken out of system-administrators.
- **R11: Who changes this.** Only a system admin who signed in themselves (not through an access token) can change authentication methods. Every change is audited with before and after.
- **R12: Personal access tokens** are managed by people signed in through Entra or the login form, not with a token or as `recovery_admin`.
- **R13 (strand): developer login.** It stays as it is (`AUTH_DEV`), for development only.

## Permissions

- **Read the public configuration:** anyone, signed in or not.
- **Sign in or out:** anyone.
- **Change authentication methods:** system admins signed in themselves.

## Data model and migration

- `auth_config`, a single row for the whole system, readable before any workspace exists:
  - `login_form` (default true);
  - `fallback` (default false);
  - `entra` jsonb.
- `user_sessions`:
  - hash of the token;
  - user;
  - via: `password` or `recovery`;
  - expires at, idle until, last used.
- `login_failures`: username, failures, locked until.
- A new System setting `signIn`: `{ maxFailures 3, lockMinutes 5, sessionIdleMinutes 300, rememberDays 14 }`. It is read from the oldest workspace, with defaults before any exists.
- `strand` gets the same migration in `supabase/migrations`.

## API

- **Public** (no sign-in):
  - `GET /auth/config`
  - `POST /auth/login` `{ username, password, remember?, fallback? }`
  - `POST /auth/logout`
- **Admin:**
  - `GET /admin/authentication`
  - `PUT /admin/authentication` `{ loginForm, fallback }`
  - `PUT /admin/authentication/entra`
- **`GET /me`** gains `recovery` for system admins.

## Screens

- **The login page** is built from R1:
  - the Entra button;
  - the Username / Password form with "Remember my login on this computer";
  - Jira's error message.
- **Administration › Authentication methods:**
  - the login form switch;
  - the fallback switch, with its address;
  - the Entra configuration and its enabled switch.
- **The recovery banner.**
- **Jira equivalent:** Administration › System › Authentication methods.

## System settings

`signIn` (R8, R9).

## Scale

- **Configuration:** one row, cached per server for 10 seconds.
- **Sessions:** found by the hash's primary key, and touched at most once a minute.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: `/auth/config` without sign-in; no secrets or recovery flag |
| R2 | Server test: seeded once from the environment, then the stored configuration wins |
| R3, R4 | Server test: a failing discovery check gives 400; disabling refuses Entra tokens; changing the tenant refuses old ones |
| R5 | Server test: the two 409s |
| R6, R7 | Server test: the fallback gate. Browser journey: the hidden form returns with `?auth_fallback` |
| R8 | Server test: a session works, expires when idle, lasts with remember, ends at sign-out; a deactivated person is refused |
| R9 | Server test: the same message for every failure; the lock and `Retry-After`; no password checked while locked |
| R10 | Server test: recovery on and off. Browser journey: `recovery_admin` signs in, sees the banner, changes the methods |
| R11, R12 | Server test: an access token can't change the methods; `recovery_admin` can't create a token; permission matrix rows |

## Strand branch

Same rules, and the browser's Entra sign-in comes to strand. The developer login stays (R13):
- with `AUTH_DEV`, `GET /auth/config` also says `dev: true`, and the login page shows the dev form;
- the login form is still at `?auth_fallback`, so recovery mode works on a development server too;
- a request with a bearer token (Entra, or a login-form session) is never taken as the dev login.

## Out of scope and deliberate divergences

- **Passwords kept by Strand itself** (Jira's internal directory): not built. The form checks directories (0712) and `recovery_admin` only.
- **SAML and other OpenID Connect providers:** not built. Entra is the only one, by the product owner's choice.
- **CAPTCHA:** a temporary lock replaces Jira's CAPTCHA.

## Open questions

None.

## Changelog
