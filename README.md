# Jira Build POC

A work management app built to behave like Jira Data Center, so a team can move from Jira DC with its data and habits intact: projects, work items, boards, backlogs and sprints, workflows, JQL search, notifications, automation, reports, administration and a Jira importer.

- **Web app** (`src/`): React 19 + Vite, a static single-page app.
- **API** (`server/`): Fastify 5 on Node 24 LTS (see `.nvmrc`). REST under `/api/v1`, live updates over server-sent events, Jira-compatible addresses under `/rest/api/2`.
- **Database**: PostgreSQL 15+. Schema in `server/migrations/`.
- **Sign-in**: Microsoft Entra ID (OIDC, PKCE), a login form backed by LDAP/Active Directory or the internal directory, and personal access tokens for scripts. Users can be provisioned over SCIM at `/scim/v2`.
- **Files**: any S3-compatible store, uploaded and downloaded by the browser with presigned URLs.

## Built from specs

Every behaviour starts as a spec in [`docs/specs/`](docs/specs/README.md), approved before code is written. Each spec states Jira DC's behaviour, numbered rules (`R1`, `R2`, …), permissions, data model, API and screens. Tests name the rules they prove (`test('[0101.R2] …')`), so each rule can be traced to its tests:

```bash
python3 scripts/spec-coverage.py .     # every rule of every spec is cited by a test, or its spec says why not
```

## Configuration

Settings are listed, with comments, in `server/.env.example` (API) and `.env.example` (web build).

How people sign in is set in **Administration › Authentication methods** (spec 0711): Microsoft Entra single sign-on, the username and password login form, or both, each turned on or off without a restart. On first start the API stores Entra's settings from `ENTRA_*`; after that the page wins.

Entra ID needs two app registrations (the web app's sign-in; scripts use tokens instead):

| Registration | Settings |
|---|---|
| API | Expose an API with the scope `access_as_user`; app role `JiraBuildPoc.Admin` for administrators. Its client id is the **API client ID** (`ENTRA_CLIENT_ID`). |
| Web app | Single-page application, redirect URI `https://<site>/`, API permission on `access_as_user`. Its client id is the **Web client ID** (`ENTRA_WEB_CLIENT_ID`). |

The login form checks passwords against your company's directories: add Active Directory or LDAP in **Administration › User directories** (spec 0712). It needs `SECRET_KEY` on the API (32 characters or more) to store the service account's password, and the API must reach the domain controllers (LDAPS on 636, or StartTLS on 389; a company CA goes in `NODE_EXTRA_CA_CERTS`).

People who aren't in a company directory can be created in **Administration › People › Create user** (the internal directory, spec 0714). Their passwords are kept as salted hashes; "Can't access your account?" on the login form emails a link when email notifications are set up.

Locked out (Entra misconfigured, the login form hidden)? Set `RECOVERY_PASSWORD` (16 characters or more) on the API, sign in as `recovery_admin` at `https://<site>/?auth_fallback`, fix the methods, then remove the variable.

## Running it

```bash
cd server && npm ci && DATABASE_URL=postgres://user@host/db npm run migrate   # applies each migration once; safe to repeat
npm start                                                                      # the API, on PORT (3001)
cd .. && npm ci && VITE_API_URL=http://localhost:3001 npm run build            # the web app, in dist/
```

Serve `dist/` and the API from one domain (forward `/api/*`, `/rest/*`, `/scim/*` and `/integrations/*` to the API, and answer unknown paths with `index.html` so deep links work); then no CORS setup is needed. Behind a load balancer, set `TRUST_PROXY` (for example `1`) so sign-ins and the audit log record the client's address. The build also writes `THIRD_PARTY_NOTICES.txt`, the licence notices of the bundled libraries, which must ship with the app.

## API access with personal access tokens

Anyone signed in can create tokens under **Settings › Personal access tokens**: give it a name and a lifetime (1 to 365 days), then copy it. It is shown once. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer jbp_..." https://<site>/api/v1/me
```

- A token acts as its owner, with the owner's role. It stops working when it expires, when it is revoked, or when the owner is deactivated.
- At most 10 active tokens per person. Only a hash is stored. "Last used" is recorded at most once a minute.
- Tokens cannot create, list or revoke tokens; that needs the web sign-in.
- The API reference is in `server/openapi.json` (and at `/docs` when `DOCS_ENABLED=1`).

## Test results from CI

Projects with testing on (Project settings › Testing) take results from CI at the addresses Xray for Jira Data Center uses, so a pipeline that sent results to Xray only needs this server's address and a personal access token:

```bash
curl -H "Authorization: Bearer $API_TOKEN" -F "file=@target/junit.xml" \
  "https://<site>/rest/raven/1.0/import/execution/junit?projectKey=PAY&testPlanKey=PAY-120&testEnvironments=linux;chrome&fixVersion=5.1"
```

- `…/import/execution/junit`: JUnit XML (multipart `file`, or the XML as the body), including Xray's `test_key`, `test_summary`, `requirements` and `testrun_comment` properties.
- `…/import/execution/cucumber`: Cucumber JSON. A scenario tagged with a test's key updates that test; tags naming requirements link them.
- `…/import/execution`: Xray JSON.
- The same imports are at `/api/v1/testing/import/{junit|cucumber|xray}`.

## Dependency rule: nothing newer than 72 hours

Only dependency versions published at least 72 hours ago are used, direct and indirect.

- `.npmrc` (root and `server/`) sets `min-release-age=3`, so `npm install`, `npm update` and adding a package skip anything newer.
- `npm run check:deps` reads both lockfiles, looks up each pinned version's publish time on the npm registry, and fails with the newest old-enough version for each offender. Raise the limit with `-- --hours 96`.
- `npm audit` in the root and in `server/` reports no known vulnerabilities.

## Develop and test

```bash
npm ci && npm test && npm run typecheck && npm run build     # web app
cd server && npm ci && npm run typecheck                      # API
DATABASE_URL=postgres://user@host/db npm test                 # API tests: need an empty throwaway PostgreSQL database
npm run openapi                                               # regenerate server/openapi.json after changing routes
```

The API tests sign in with tokens from a local stand-in for Entra, so they need no tenant.

End-to-end journeys run the real web app and API in Google Chrome (installed; nothing is downloaded) against a throwaway database, which they wipe:

```bash
E2E_DATABASE_URL=postgres://user@host/scratch npm run e2e     # CHROME_PATH=… to use another Chromium
```

Performance at volume: seeds a throwaway database (wiped; its name must say perf, scratch or test) with a large workspace and times the main reads against budgets, exiting 1 if one is missed:

```bash
cd server && DATABASE_URL=postgres://user@host/perf PERF_ITEMS=100000 node scripts/perf.ts    # PERF_PROJECTS, PERF_PEOPLE, PERF_RUNS
```

A Jira DC inventory (spec 0801) reads a Jira instance, read-only, and reports what would come over:

```bash
node scripts/jira-inventory/inventory.mjs --help
```
