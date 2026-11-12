# 0001 Signing in with Microsoft Entra; the first administrator

Status: Implemented

## Context and Jira reference

People sign in to the app with their company's Microsoft Entra ID account. The web app gets an Entra access token and sends it with every API call; the server checks it and finds, or creates, the person. On an empty system the first person to sign in creates the workspace and administers it.

Extended by spec 0711: Entra's settings are kept in Administration › Authentication methods (first taken from `ENTRA_*` on start), and the login form, fallback and recovery mode are added. Spec 0714 adds people created in the app.

- **Jira DC:** single sign-on through an identity provider is set up in Administration › Authentication methods ([Using multiple identity providers](https://confluence.atlassian.com/enterprise/using-multiple-identity-providers-1044779993.html)). The first administrator is the account made in the setup wizard. New users join the default group (`jira-users`), and administrators are those in `jira-system-administrators`.
  - The app follows Jira's groups: everyone joins **users-access**, and administrators are the members of **system-administrators**.
  - **Differs:** there is no setup wizard. The first person to sign in becomes the workspace's owner and a system administrator.

## Rules

- **R1: Only a valid Entra token signs in.** A request signs in with `Authorization: Bearer <access token>`. The token must be:
  - signed (RS256) by a key that Entra publishes at `<authority>/<tenant>/discovery/v2.0/keys`;
  - issued by `<authority>/<tenant>/v2.0`;
  - for the app's API: its audience is the API client id or `api://<API client id>`;
  - unexpired, with an `oid` claim.

  Anything else answers 401: no token ("Missing bearer token"), a malformed, forged, expired or mis-addressed one ("Invalid token"). Other headers (such as `x-dev-user`) never sign anyone in.
- **R2: One account per Entra person.** The person is found by the token's `oid`, then by email (`preferred_username`, else `email`, in lower case), which links the `oid` to that row. An email already linked to a different `oid` is refused: 403 "Email belongs to a different account".
- **R3: The Entra admin role.** A new person whose token carries the app role `JiraBuildPoc.Admin` joins system-administrators on their first request. Admin rights then belong to the group: a later token without the role leaves them in it until someone takes them out.
- **R4: The first person.** On an empty system the first request creates the one workspace ("Jira Build POC"). That person is its owner and joins system-administrators. People arriving at the same moment share that workspace, and exactly one of them is the owner; everyone else joins as a member.
- **R5: Created once.** A new person's browser sends several requests at once. Every one of them succeeds, and the person is created once. New people join users-access.
- **R6: Browser sign-in with PKCE.** The web app signs in with OAuth 2.0's authorization code flow and PKCE (RFC 7636), with no client secret.
  - The verifier is 32 random bytes and the state 16, both base64url. The challenge is the base64url SHA-256 of the verifier (`S256`).
  - The browser goes to `<authority>/<tenant>/oauth2/v2.0/authorize` with the web client id, `response_type=code`, the redirect address, `response_mode=query`, the scope the server publishes (spec 0711 R1), the state and the challenge.
- **R7: Refreshed before it expires.** The web app refreshes the access token when 60 seconds or less are left, so no request leaves with a token about to expire.
- **R8: Every call carries the token.** Each API request sends `Authorization: Bearer <token>`. A request with a body sends it as JSON with `content-type: application/json`. Without a token or a body, neither header is sent.

## Permissions

| Who | Becomes |
|---|---|
| The first person on an empty system | Workspace owner, in system-administrators |
| A new person with the `JiraBuildPoc.Admin` app role | In system-administrators |
| Anyone else signing in for the first time | Member, in users-access |

What each role may do: specs 0201 and 0717.

## Data model

- `workspaces` (`name`, `created_at`); the oldest one is the app's workspace. Migration `20261011202354_core_schema.sql`.
- `users`: `entra_oid` (unique), `email` (unique), `name`, `initials`, `active`. Same migration.
- `memberships`: workspace, user, `role` (`owner`, `admin`, `member`). Same migration.
- `groups.system_role` (`default-users` for users-access, `system-admins` for system-administrators), `group_members`, and the function `is_system_admin`. Migration `20261115090000_system_groups.sql`.

## API

- `GET /api/v1/me`: the signed-in person and their role; creates them (and the workspace, the first time) on first sight.
- `POST /api/v1/me/sign-in`: the web app calls it when it starts. Puts the person back in users-access (and system-administrators with the admin role) and records the sign-in. 204; 400 with an access token.
- Errors: 401 for a missing or invalid token; 403 "Email belongs to a different account"; 403 "Account is deactivated".

## Screens

- **The login page:** the Microsoft button (its name and settings from spec 0711). After signing in, the person returns to the page they were on.
- A token the server refuses (401) signs the person out and shows the login page again.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: forged, expired, wrong-audience, wrong-issuer, no-`oid` and header-only logins get 401; an `api://` audience gets in |
| R2, R3 | Server test: the admin role puts a new person in system-administrators, they stay without it, and another `oid` can't take the email |
| R4 | Server test: eight people on an empty system share one workspace; one owner, seven members |
| R5 | Server test: 25 rounds of 13 simultaneous first requests; all succeed, one user each |
| R6 | Unit test (web): the RFC 7636 test vector; random tokens are url-safe and differ; the authorize address and its parameters |
| R7 | Unit test (web): refreshed a minute before expiry |
| R8 | Unit test (web): the bearer header and JSON body; neither without a token or body |

## Out of scope and deliberate divergences

- **Setup wizard:** none; the first person to sign in administers the app.
- **SAML and other identity providers:** spec 0711.
