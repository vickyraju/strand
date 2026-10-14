# Strand API

Fastify + Postgres. Schema lives in [../supabase/migrations](../supabase/migrations) (plain SQL, so it runs on Neon, Aurora or any Postgres; the folder name is historical).

```bash
for f in ../supabase/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done   # apply migrations in order
cp .env.example .env            # then: set -a; source .env; set +a
npm run dev                     # http://localhost:3001/health
DATABASE_URL=<throwaway db> npm test   # WIPES the public schema, then runs integration tests
```

- **API docs (Swagger UI):** `http://localhost:3001/docs` (raw spec at `/docs/json`). On by default for `NODE_ENV=development|test`; set `DOCS_ENABLED=1` to serve it on a deployed dev server. Click *Authorize* and enter `x-dev-user` + `x-dev-secret`.
- **Versioning:** the API lives under `/api/v1`. The older unversioned `/api/...` paths still answer (same handlers, hidden from the docs) so clients built earlier keep working; it will be removed after the web app moves (`VITE_API_PREFIX=/api/v1`).
- **Errors:** every error is `{ "error": "message", "code": "invalid_input|unauthorized|forbidden|not_found|conflict|rate_limited|internal", "errors": { "<field>": "<message>" } }`. `errors` appears only on 400 validation failures, keyed by field.
- **Responses:** each route's response body is a zod schema in `src/responses.ts`. It is shown in the docs and enforced on the way out, so a handler returning the wrong shape fails a test. Timestamps are ISO strings, dates `YYYY-MM-DD`.
- `/api/*`: JWT (Entra) auth; in dev `AUTH_DEV=1` accepts `x-dev-user: you@company.com`. First user becomes workspace owner; Entra app role `Strand.Admin` maps to admin.
- `/scim/v2/*`: Entra provisioning, bearer `SCIM_TOKEN`.
- `GET /api/projects/:key/events`: SSE stream of changes (Postgres LISTEN/NOTIFY).
- `POST /api/import`: one-time import of a browser `forge:v1` state (admin only).
- Container: `docker build -t strand-api .` — same image on Vercel/dev and EKS.
