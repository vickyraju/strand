# 0706 Rate limiting for everyone

Status: Ported (aws-jira `ccb750d`, strand `e7cda82`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: AD-04

## Context and Jira reference

- **Jira DC** ([Improving instance stability with rate limiting](https://confluence.atlassian.com/adminjiraserver/improving-instance-stability-with-rate-limiting-983794911.html), DC 11.3, checked 10 Nov 2026).
  - **Which requests:** every **external REST API request**, whatever its authentication (basic auth, OAuth, a session cookie from a script). People using Jira's own pages aren't limited, including the calls those pages make.
  - **Anonymous requests** count together as one user, **Anonymous**. Atlassian suggests giving Anonymous an exemption with a higher limit.
  - **Settings:** Requests allowed per interval, Max requests (the burst); modes Allow unlimited, Limit, Block all; per-user exemptions; the List of limited accounts (cluster-wide, Anonymous included).
  - **Limits apply per node.** Responses carry `X-RateLimit-*`; refused requests get 429 with `retry-after`.
- **Strand today** (spec in commit `6ee3111`): the same settings, but only requests made with **personal access tokens** count. A script using an Entra token or a login-form session, and anonymous requests, are never limited.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20summary%20~%20%22rate%20limit*%22%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Strand |
|---|---|---|---|
| [JRASERVER-74805](https://jira.atlassian.com/browse/JRASERVER-74805) The documentation doesn't say UI requests are ignored | | Suggestion | **Built:** the settings page says which requests count (R1) |
| [JRASERVER-72634](https://jira.atlassian.com/browse/JRASERVER-72634), [JRASERVER-74928](https://jira.atlassian.com/browse/JRASERVER-74928) Limited accounts don't add up across nodes; wrong counts | | Bugs | **Built already:** the list is kept in the database, for every server |
| [JRASERVER-77838](https://jira.atlassian.com/browse/JRASERVER-77838) The settings page errors once someone is limited | | Bug | **Built already:** covered by the existing tests |
| [JRASERVER-73332](https://jira.atlassian.com/browse/JRASERVER-73332) Exemptions for groups | 4 | Gathering interest | **Proposal P1** |
| [JRASERVER-72621](https://jira.atlassian.com/browse/JRASERVER-72621) A dry run: log who would be limited, limit nobody | 2 | Gathering interest | **Proposal P2** |
| [JRASERVER-74709](https://jira.atlassian.com/browse/JRASERVER-74709) Limit only at certain times of day | | Gathering interest | Not proposed |
| Limits per node, so a script spread over nodes gets more (Jira's documentation) | | Documented limit | **Proposal P3** |

**Proposals for the product owner** (not built until chosen):

- **P1: Group exemptions:** an exemption for a group applies to everyone in it (a person's own exemption still wins).
- **P2: Dry run:** a fourth mode that counts and lists who would have been limited, refusing nobody.
- **P3: One limit across servers**, counted in the database, instead of one per server (as Jira's).

## Rules

- **R1: Which requests count.** With rate limiting on, every API request counts against its person's bucket, whatever the sign-in (an access token, an Entra token, a login-form session, the developer login), **except** requests from Strand's own web app.
  - A request is the web app's when its `Origin` is one of the app's addresses (`CORS_ORIGINS`), or the browser marks it same-origin.
  - Requests with an access token always count, from anywhere (as before).
  - System settings › Rate limiting says this in its description.
- **R2: Anonymous.** Requests without a sign-in (the login form, "Can't access your account?", setting a password, the login page's configuration and images) count together as one person, **Anonymous**, whoever sends them (as Jira's).
  - An exemption can be given to Anonymous like to anyone.
  - Anonymous appears in the List of limited accounts.
- **R3: Unchanged:** modes, numbers, exemptions, headers, 429 with `retry-after`, per server. The message no longer says "with access tokens".

## Permissions

Unchanged (system admins).

## Data model and migration

- `rate_limited_accounts.user_id` becomes nullable: null is Anonymous.
- The `rateLimiting` setting's exemptions accept `anonymous` as well as a person's id.
- `strand` gets the same migration in `supabase/migrations`.

## API

Unchanged, except: exemptions take `userId: "anonymous"`; `GET /admin/rate-limits/limited` lists Anonymous with `userId: null`.

## Screens

System settings › Rate limiting: the description of what counts; **Anonymous** in the exemption picker and the limited list.

## System settings

`rateLimiting` (R1 changes what counts).

## Scale

One more bucket lookup per request when rate limiting is on; nothing when it is off.

## Acceptance

| Rule | Proved by |
|---|---|
| R1 | Server test: an Entra-token script is limited; the same requests from the web app's origin aren't; tokens always are |
| R2 | Server test: anonymous login attempts are limited together; an Anonymous exemption lifts it; Anonymous in the list |
| R3 | Existing rate limiting tests |

## Strand branch

Same rules; the developer login counts as a sign-in.

## Out of scope and deliberate divergences

- **Allowlists by URL or OAuth consumer** (Jira's startup properties): not built.

## Open questions

None.

## Changelog
