# jira-build

Work management: projects, boards, backlogs and sprints, issues, timeline, inbox, workflows, automation and reports.

- **Web app** (`src/`): React 19 + Vite, served as static files from S3 behind CloudFront.
- **API** (`server/`): Fastify 5 on Node 24, runs on Amazon EKS. REST under `/api/v1`, live updates over server-sent events.
- **Database**: Amazon Aurora PostgreSQL through RDS Proxy. Schema in `server/migrations/`.
- **Sign-in**: Microsoft Entra ID (OIDC, PKCE). Users are provisioned over SCIM at `/scim/v2`.
- **Scripts and integrations**: personal access tokens (see below).
- **Files**: S3, uploaded and downloaded by the browser with presigned URLs.
- Architecture and data model diagrams (draw.io): `docs/architecture/`.

## Configuration

Settings are listed, with comments, in `server/.env.example` (API) and `.env.example` (web build).

Entra ID needs two app registrations (the web app's sign-in; scripts use tokens instead):

| Registration | Settings |
|---|---|
| API | Expose an API with the scope `access_as_user`; app role `Strand.Admin` for administrators. Its client id is `ENTRA_CLIENT_ID` on the API. |
| Web app | Single-page application, redirect URI `https://<site>/`, API permission on `access_as_user`. Its client id is `VITE_ENTRA_CLIENT_ID` in the web build. |

## API access with personal access tokens

Anyone signed in can create tokens under **Settings > Personal access tokens**: give it a name and a lifetime (1 to 365 days), then copy it. It is shown once. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer jbp_..." https://<site>/api/v1/me
```

- A token acts as its owner, with the owner's role. It stops working when it expires, when it is revoked, or when the owner is deactivated (SCIM).
- At most 10 active tokens per person. Only a hash is stored. "Last used" is recorded at most once a minute.
- Tokens cannot create, list or revoke tokens; that needs the web sign-in.
- The API reference is in `server/openapi.json` (and at `/docs` when `DOCS_ENABLED=1`).

## Deploy

**Database.** Run `node scripts/migrate.ts` from `server/` (the image contains it) against the Aurora writer endpoint. It applies each migration once and is safe to repeat. `deploy/k8s/migrate-job.yaml` runs it as a Kubernetes Job.

**API.** `server/Dockerfile` builds the image (non-root, trusts the RDS CA bundle). `deploy/k8s/jira-build.yaml` is the Deployment, Service, autoscaler, disruption budget and ALB Ingress. It expects:

- a Secret `jira-build-api` with `DATABASE_URL` (RDS Proxy), `DATABASE_DIRECT_URL` (Aurora writer), `SCIM_TOKEN`, `GITHUB_WEBHOOK_SECRET`;
- an image pull secret `artifactory-pull` for the registry that holds the image;
- these variables when applying: `IMAGE`, `API_ROLE_ARN` (IAM role for the service account: S3 access, and `ses:SendEmail` from a verified sender for notification emails), `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ATTACHMENTS_BUCKET`, `AWS_REGION`, `ALB_SECURITY_GROUP_ID`, `ALB_CERTIFICATE_ARN`; the migration Job also needs `BUILD_TAG_SAFE` (a unique suffix).

```bash
envsubst < deploy/k8s/migrate-job.yaml | kubectl apply -f - && kubectl -n jira-build wait --for=condition=complete job --all --timeout=300s
envsubst < deploy/k8s/jira-build.yaml  | kubectl apply -f - && kubectl -n jira-build rollout status deployment/jira-build-api
```

**Web app.** Build with `VITE_API_URL` (the CloudFront address), `VITE_ENTRA_TENANT_ID` and `VITE_ENTRA_CLIENT_ID` set, then copy `dist/` to the web bucket:

```bash
npm ci && npm run build
aws s3 sync dist s3://<web-bucket> --delete --exclude index.html --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html s3://<web-bucket>/index.html --cache-control no-cache
```

The build also writes `THIRD_PARTY_NOTICES.txt` (the licence notices of the bundled libraries). Upload it with the rest of `dist/`; the licences require it to ship with the app.

**CloudFront** serves the bucket and forwards `/api/*`, `/scim/*` and `/integrations/*` to the ALB (all methods, no caching, `Authorization` header forwarded, origin timeout raised for live updates). Return `/index.html` for 403/404 so deep links work. With one domain for the app and the API, no CORS setup is needed.

## Dependency rule: nothing newer than 72 hours

Security requirement: only dependency versions published at least 72 hours ago are used, direct and indirect.

- `.npmrc` (root and `server/`) sets `min-release-age=3`, so `npm install`, `npm update` and adding a package skip anything newer.
- `npm run check:deps` reads both lockfiles, looks up each pinned version's publish time on the npm registry, and fails with the newest old-enough version for each offender. Run it in the pipeline before building (it needs registry access). Raise the limit with `-- --hours 96`.
- To fix an offender: `npm install <name>@<old-enough version>`, then run the check again.

## Develop and test

```bash
npm ci && npm test && npm run typecheck && npm run build     # web app
cd server && npm ci && npm run typecheck                      # API
DATABASE_URL=postgres://user@host/db npm test                 # API tests: need an empty throwaway PostgreSQL database
npm run openapi                                               # regenerate server/openapi.json after changing routes
```

The API tests sign in with tokens from a local stand-in for Entra, so they need no tenant. `npm run diagrams` regenerates the draw.io files from the migrations.

End-to-end journeys run the real web app and API in Google Chrome (installed; nothing is downloaded) against a throwaway database, which they wipe:

```bash
E2E_DATABASE_URL=postgres://user@host/scratch npm run e2e     # CHROME_PATH=… to use another Chromium
```

They cover creating a project and giving a teammate read-only access, @mentions reaching the Inbox, the workflow and its rules, work types, workflow versions, time tracking, components, sharing views, JQL, automation, CSV import, notification settings, issue security, a sprint from start to completion, and losing access while the project is open.

Performance at volume: seeds a throwaway database (wiped; its name must say perf, scratch or test) with a large workspace and times the main reads against budgets, exiting 1 if one is missed:

```bash
cd server && DATABASE_URL=postgres://user@host/perf PERF_ITEMS=100000 node scripts/perf.ts    # PERF_PROJECTS, PERF_PEOPLE, PERF_RUNS
```
