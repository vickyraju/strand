# jira-build

Work management: projects, boards, backlogs and sprints, issues, timeline, inbox, workflows, automation and reports.

- **Web app** (`src/`): React 19 + Vite, served as static files from S3 behind CloudFront.
- **API** (`server/`): Fastify 5 on Node 24, runs on Amazon EKS. REST under `/api/v1`, live updates over server-sent events.
- **Database**: Amazon Aurora PostgreSQL through RDS Proxy. Schema in `server/migrations/`.
- **Sign-in**: Microsoft Entra ID (OIDC, PKCE). Users are provisioned over SCIM at `/scim/v2`.
- **Files**: S3, uploaded and downloaded by the browser with presigned URLs.
- Architecture and data model diagrams (draw.io): `docs/architecture/`.

## Configuration

Settings are listed, with comments, in `server/.env.example` (API) and `.env.example` (web build).

Entra ID needs two app registrations:

| Registration | Settings |
|---|---|
| API | Expose an API with the scope `access_as_user`; app role `Strand.Admin` for administrators. Its client id is `ENTRA_CLIENT_ID` on the API. |
| Web app | Single-page application, redirect URI `https://<site>/`, API permission on `access_as_user`. Its client id is `VITE_ENTRA_CLIENT_ID` in the web build. |

## Deploy

**Database.** Run `node scripts/migrate.ts` from `server/` (the image contains it) against the Aurora writer endpoint. It applies each migration once and is safe to repeat. `deploy/k8s/migrate-job.yaml` runs it as a Kubernetes Job.

**API.** `server/Dockerfile` builds the image (non-root, trusts the RDS CA bundle). `deploy/k8s/jira-build.yaml` is the Deployment, Service, autoscaler, disruption budget and ALB Ingress. It expects:

- a Secret `jira-build-api` with `DATABASE_URL` (RDS Proxy), `DATABASE_DIRECT_URL` (Aurora writer), `SCIM_TOKEN`, `GITHUB_WEBHOOK_SECRET`;
- an image pull secret `artifactory-pull` for the registry that holds the image;
- these variables when applying: `IMAGE`, `API_ROLE_ARN` (IAM role for the service account, S3 access only), `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ATTACHMENTS_BUCKET`, `AWS_REGION`, `ALB_SECURITY_GROUP_ID`, `ALB_CERTIFICATE_ARN`; the migration Job also needs `BUILD_TAG_SAFE` (a unique suffix).

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

**CloudFront** serves the bucket and forwards `/api/*`, `/scim/*` and `/integrations/*` to the ALB (all methods, no caching, `Authorization` header forwarded, origin timeout raised for live updates). Return `/index.html` for 403/404 so deep links work. With one domain for the app and the API, no CORS setup is needed.

## Develop and test

```bash
npm ci && npm test && npm run typecheck && npm run build     # web app
cd server && npm ci && npm run typecheck                      # API
DATABASE_URL=postgres://user@host/db npm test                 # API tests: need an empty throwaway PostgreSQL database
npm run openapi                                               # regenerate server/openapi.json after changing routes
```

The API tests sign in with tokens from a local stand-in for Entra, so they need no tenant. `npm run diagrams` regenerates the draw.io files from the migrations.
