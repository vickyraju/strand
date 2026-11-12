# 0002 Personal access tokens

Status: Implemented

## Context and Jira reference

Scripts and integrations call the API with a personal access token instead of a person's sign-in. Each person creates their own tokens in Settings; a token acts as them, can be given a lifetime, and can be revoked at any time.

Extended by spec 0711 (R12): `recovery_admin` can't manage tokens either.

- **Jira DC:** personal access tokens are created in the user's profile, shown once, and sent as `Authorization: Bearer <token>`. A token acts with its owner's permissions, can expire, and can be revoked. Administrators set how many tokens a person may have and their longest lifetime. The app follows Jira.

## Rules

- **R1: Created once, with the secret.** `POST /me/tokens` answers 201 with the token itself, once: `jbp_` and 43 url-safe characters (256 random bits). The name is trimmed. The answer also has a hint (the last 4 characters), `lastUsedAt` (null) and `expiresAt`. Without a lifetime, the token lasts the default (`accessTokens.defaultExpiryDays`, 90 days).
- **R2: Only a hash is kept.** The database holds the token's SHA-256 hash, never the token. `GET /me/tokens` lists a person's tokens, newest first, with `id`, `name`, `hint`, `createdAt`, `expiresAt`, `lastUsedAt` and `expired`, and never the secret.
- **R3: A token acts as its owner.** A request with `Authorization: Bearer jbp_…` is the owner, with the owner's current role and project roles: a viewer's token can read a project but not create work in it (403). `lastUsedAt` is written at most once a minute.
- **R4: A token can't manage tokens.** Listing, creating or revoking tokens with a token answers 403 "Sign in with your account to manage access tokens", so a leaked token can't make or hide others. For `recovery_admin`: spec 0711 R12.
- **R5: Revoking.** `DELETE /me/tokens/:id` deletes the token (204) and it stops working at once (401). Nobody sees or revokes another person's tokens: their ids answer 404 "Token not found", as does a token already revoked.
- **R6: Refused tokens.** An expired, unknown or malformed token answers 401 "Invalid token". An expired token stays in its owner's list with `expired: true`; 30 days after it expired it is deleted, the next time anyone creates a token.
- **R7: At most 10 active.** A person may have at most `accessTokens.maxPerUser` (10) unexpired tokens. One more answers 409 "You can have at most 10 active tokens; revoke one first". A person's creates take turns (a lock on their row), so creating many at once never passes the limit. Revoking one frees a slot.
- **R8: A deactivated owner's tokens stop.** They answer 403 "Account is deactivated".
- **R9: Names and lifetimes.** The name is 1–40 characters after trimming. The lifetime is a whole number of days, from 1 to `accessTokens.maxExpiryDays` (365); longer answers 400 "A token can last at most 365 days".
- **R10: Status in Settings.** Each token shows as active, **expires soon** (5 days or fewer left) or expired; the server's `expired` flag wins over the browser's clock. Only unexpired tokens count toward the limit shown.
- **R11: The example call.** After creating a token, Settings shows a call to test it: `curl -H "Authorization: Bearer <token>" <API address>/api/v1/me`.
- **R12: Lifetimes offered.** The lifetime picker offers 7, 30, 90, 180 and 365 days, plus the default and the longest allowed, never more than the longest. Labels read "30 days", "1 year", "2 years".

## Permissions

| Action | The token's owner, signed in | The owner, with a token | Anyone else (including admins) |
|---|---|---|---|
| Create, list | Yes | No (403) | Only their own |
| Revoke | Yes | No (403) | No (404) |
| Use a token | Acts as the owner | | |

## Data model

- `personal_access_tokens`: `user_id`, `name` (1–40), `token_hash` (unique), `hint`, `created_at`, `expires_at`, `last_used_at`. Migration `20261023090000_personal_access_tokens.sql`.

## API

- `GET /api/v1/me/tokens`
- `POST /api/v1/me/tokens` `{ name, expiresInDays? }`: 201; 400 for a bad name or lifetime; 403 when tokens are turned off; 409 at the limit.
- `DELETE /api/v1/me/tokens/:id`: 204; 404.
- Every token management route answers 403 when called with a token.

## Screens

- **Settings › Personal access tokens:** the list with each token's status, last use and expiry; **Create token** (name and lifetime), the new token shown once with the example call; **Revoke**.

## System settings

`accessTokens`:

- `enabled` (default on). Off: creating answers 403 "Personal access tokens are turned off in System settings", and tokens answer 401 "Personal access tokens are turned off".
- `maxPerUser` (default 10, 1–100).
- `maxExpiryDays` (default 365, up to 3650) and `defaultExpiryDays` (default 90, not more than `maxExpiryDays`).

## Acceptance

| Rule | Test |
|---|---|
| R1, R2 | Server test: created with the secret, listed without it; the row holds only the hash |
| R3 | Server test: a token acts as its owner with the owner's role; last use recorded at most once a minute. Server test: a viewer's token is read-only |
| R4 | Server test: listing, creating and revoking with a token answer 403 |
| R5 | Server test: revoking stops the token; another person's token answers 404 |
| R6 | Server test: expired, unknown and malformed tokens refused; expired shown as expired, then dropped after 30 days |
| R7 | Server test: 13 created at once never pass 10; revoking frees a slot |
| R8 | Server test: a deactivated owner's token answers 403 |
| R9 | Server test: names and lifetimes checked at their limits |
| R10 | Unit test (web): active, expires soon, expired; only unexpired tokens count |
| R11 | Unit test (web): the example call |
| R12 | Unit test (web): lifetimes offered follow the administrator's limits |

## Out of scope and deliberate divergences

- **Administrators revoking other people's tokens:** not built; a deactivated person's tokens stop working (R8).
