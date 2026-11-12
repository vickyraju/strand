# 0029 Rate limiting

Status: Implemented

## Context and Jira reference

Rate limiting keeps the app stable when a script sends too many requests. A system admin turns it on in System settings, sets how many requests a person may make, and can give some people their own setting.

Extended by spec 0706: which requests count (every API request but the web app's own) and Anonymous.

- **Jira DC:** [Improving instance stability with rate limiting](https://confluence.atlassian.com/adminjiraserver/improving-instance-stability-with-rate-limiting-983794911.html). A token bucket per user: **Requests allowed** per interval, saved up to **Max requests**. Modes **Allow unlimited**, **Limit** and **Block all**; per-user exemptions; `X-RateLimit-*` headers; 429 with `Retry-After`. Limits apply per node. The app follows Jira.

## Rules

- **R1: Off unless turned on.** With `rateLimiting.enabled` off (the default) nobody is limited.
- **R2: A bucket per person.** Each person has a bucket that holds `burst` requests and refills continuously at `requests` every `intervalSeconds`. Each request takes one. When the bucket is empty, the request is refused. Each person's bucket is their own.
- **R3: Where you stand.** Every counted response carries `X-RateLimit-Limit` (the burst), `X-RateLimit-Remaining`, `X-RateLimit-Interval-Seconds` and `X-RateLimit-FillRate` (the requests per interval).
- **R4: When to retry.** A refused request answers 429 `rate_limited`, "Too many requests: at most N every S seconds. Try again shortly.", with `Retry-After`: the seconds until one request is back (at least 1).
- **R5: Modes.** **Limit** uses the numbers. **Unlimited** never refuses. **Block** refuses every request, with `Retry-After: 3600` and "Requests from scripts and integrations are blocked by your administrator."
- **R6: Exemptions.** An exemption gives one person their own mode and numbers. Numbers it leaves out come from the general setting.

## Permissions

- **Change the setting, see the limited accounts:** system admins.

## Data model

- The `rateLimiting` setting in `system_settings`. Migration `20261031090000_system_settings.sql`.
- `rate_limited_accounts`: workspace, person, `first_at`, `last_at`, `times`. Same migration; spec 0706 changes it.

## API

- `PUT /api/v1/admin/settings/rateLimiting`: the setting.
- `GET /api/v1/admin/rate-limits/limited`: the people refused in the last 24 hours, newest first (at most 500).

## Screens

- **System settings › Rate limiting:** the mode, the numbers, the exemptions, and the list of limited accounts.

## System settings

`rateLimiting`: `enabled` (default off), `mode` (default `limit`), `requests` (default 100, 1–1,000,000), `intervalSeconds` (default 60, 1–86,400), `burst` (default 100, at least `requests`, up to 10,000,000), `exemptions` (up to 500).

## Scale

- Buckets live in each server's memory, so the limit applies per server (as Jira's applies per node). A bucket unused for a day is dropped.
- A refusal is recorded for the limited accounts list at most once a minute per person and server.

## Acceptance

| Rule | Test |
|---|---|
| R2, R3, R4 | Unit test (server): a bucket of 3 lets 3 through and refuses the 4th; the headers; `Retry-After` 5; a request is back after 5 seconds; another person has their own bucket |
| R1, R5, R6 | Unit test (server): off unless enabled; unlimited never refuses; block refuses; an exemption overrides for one person, the rest from the general setting |

## Out of scope and deliberate divergences

- **Which requests count, and Anonymous:** spec 0706.
