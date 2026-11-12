# 0003 REST API and database conventions

Status: Implemented

## Context and Jira reference

Every screen of the web app works through one REST API, which scripts can call too (spec 0002). These are the rules every route follows: the path, the documentation, errors, status codes, ids, edits, paging and browsers. The database schema changes only through numbered migrations.

- **Jira DC:** the REST API lives under `/rest/api/2`. Errors carry `errorMessages` and per-field `errors`; creates answer 201 and deletes 204; issues can be addressed by key or by id.
  - The app follows Jira on status codes, per-field errors and key-or-id addresses.
  - **Differs:** the app's own API is `/api/v1` with its own error shape (R4). Some of Jira's own addresses are served too: remote links (spec 0507) and webhooks (spec 0715).

## Rules

- **R1: One path, `/api/v1`.** Every API route is under `/api/v1`; `/api/me` and other unversioned paths answer 404. The web app writes paths as `/api/…` and swaps in the prefix: `/api/v1` unless `VITE_API_PREFIX` overrides it (behind a gateway). Only paths under `/api/` are rewritten.
- **R2: Documented.** The OpenAPI document (`/docs/json`, served when `DOCS_ENABLED=1`) is titled "Jira Build POC API", with two security schemes, `bearer` and `scimToken`.
  - Every route except `/health` and `/ready` has a summary and a tag.
  - Every `/api/v1` operation documents 401, and 400 when it takes input, with the error shape of R4.
  - The committed `server/openapi.json` matches the code (`npm run openapi` writes it).
- **R3: Schemas are enforced.** Each route's request schema rejects bad input before the handler runs: 400 "Invalid input". Each documented response body is written through its schema, so what the handler sends is what the document says.
- **R4: One error shape.** Every error answers `{ error, code }`, plus `errors` (a message per field) for bad input.
  - Codes follow the status: 400 `invalid_input`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 429 `rate_limited`; a busy database 503 `busy`; anything else 500 `internal`.
  - Unknown routes answer 404 `{ "error": "Route not found", "code": "not_found" }`. Malformed JSON answers 400 `invalid_input`, never a stack trace.
- **R5: Status codes.** Creates answer 201 Created, and are documented under 201, not 200. Updates and actions answer 200. Deletes answer 204.
- **R6: Client ids.** Creating a work item, comment, sprint, custom field, view or work log accepts an optional `id` (a UUID), so the web app keeps its own id. Sending the same id again answers 409 instead of making a duplicate, also when the same create arrives several times at once: exactly one is created.
- **R7: Edits.** A `PATCH` changes only the fields sent; `null` clears a field.
  - With `If-Match: <version>`, an edit of an older version answers 409 "Edited elsewhere (current version N)". When several people edit the same version at once, exactly one wins and the version goes up by one.
  - Without `If-Match`, an edit that waited for another change applies to the latest copy and isn't refused.
- **R8: Key or id.** Work items are addressed by key (`PAY-12`) or id, and projects by key (`PAY`) or id. An unknown one answers 404 `not_found`.
- **R9: Paging never repeats or skips.** Lists page with an opaque `next` cursor. Search results page by (`updated_at`, `id`), newest first, to the microsecond, so rows saved in the same millisecond are neither repeated nor skipped.
- **R10: Browsers only from listed origins.** A browser may call the API only from an address in `CORS_ORIGINS` (comma-separated; a trailing `/` is ignored).
  - The preflight needs no sign-in, answers 204, and allows `content-type`, `authorization`, `if-match` and `x-workflow-override`.
  - Responses to a listed origin carry `access-control-allow-origin` and expose `content-disposition` and `retry-after`. Other origins get no CORS headers.
- **R11: Health and readiness.** `GET /health` answers 200 with no sign-in. `GET /ready` checks the database: 200 `{ ok: true }`, or 503 `{ ok: false }`. Every response carries `x-content-type-options: nosniff`.
- **R12: Migrations.** `server/scripts/migrate.ts` applies `server/migrations/*.sql` in name order, each once and in its own transaction, recording it in `schema_migrations`. An advisory lock lets several servers run it at once. A second run applies nothing and says "up to date"; a failed migration is rolled back and named.
- **R13: The client's address.** The address recorded for sign-ins and in the audit log is the connection's, unless `TRUST_PROXY` names the proxies in front of the server (a hop count, or their addresses and CIDRs); only then is `X-Forwarded-For` read. Unset, nothing is trusted, so a client can't put another address in the log.

## Permissions

As spec 0201's table. Preflight, `/health` and `/ready` need no sign-in.

## Data model

- `schema_migrations` (`name`, `applied_at`), made by the migration script itself.
- Timestamps are read as ISO strings, dates as `YYYY-MM-DD`, and `bigint` and `numeric` as numbers. Column names become camelCase in answers.
- Work items carry a `version`, raised by each edit (migration `20261011202354_core_schema.sql`).

## API

- `/api/v1/…`: the API (bearer sign-in: an Entra token, a session or an access token).
- `/docs`, `/docs/json`: the documentation, only with `DOCS_ENABLED=1`.
- `/health`, `/ready`: open.
- Request bodies up to 20 MB.

## Screens

- None of its own. The web app shows the server's `error` message when a call fails, or "Could not reach the server.".

## Scale

- Lists page on the server: `limit` (default 50, at most 200 for search) and a `next` cursor.
- Each server keeps up to `PG_POOL` (10) database connections. A request that waits more than 5 seconds for one answers 503 "The server is busy. Try again in a moment." A statement may run for `PG_STATEMENT_TIMEOUT_MS` (30 s).

## Acceptance

| Rule | Test |
|---|---|
| R1 | Server test: `/api/v1` is the only path. Unit test (web): paths get the `/api/v1` prefix unless it is overridden |
| R2 | Server test: every route documented; the committed document matches; 400 and 401 documented with the error shape |
| R3 | Server test: a bad body refused before the handler. Server test: every documented response produced by the real handler |
| R4 | Server test: the error shape and codes; unknown routes; malformed JSON |
| R5 | Server test: 201, 200 and 204; creates documented under 201 |
| R6 | Server tests: client ids for work items, comments, sprints, custom fields, views and work logs; reuse is a 409. Server test (concurrency): the same comment sent five times at once is created once |
| R7 | Server test: patch can null fields. Server test (concurrency): five same-version edits, one wins; an unchecked edit isn't refused; edits during a sprint's completion all succeed |
| R8 | Server test: work items and projects by key or id |
| R9 | Server test: 12 items saved in the same millisecond page with no repeats or gaps |
| R10 | Server test: listed origins allowed, others not; preflight needs no sign-in |
| R11 | Server test: health open; readiness checks the database; `nosniff` |
| R12 | Server test: every migration applied once; a second run changes nothing |
| R13 | Server test: the setting's forms; with none set, a forged `X-Forwarded-For` doesn't reach the audit log |

## Out of scope and deliberate divergences

- **Jira's REST API (`/rest/api/2`) as a whole:** not served; only the parts named in other specs.
- **Jira's error shape** (`errorMessages`): the app's is R4.
