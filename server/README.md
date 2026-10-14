# Strand API

Fastify + Postgres. Schema lives in [../supabase/migrations](../supabase/migrations) (plain Postgres, Aurora-compatible).

```bash
npx supabase start              # from repo root; applies migrations (needs Docker)
cp .env.example .env            # then: set -a; source .env; set +a
npm run dev                     # http://localhost:3001/health
DATABASE_URL=<throwaway db> npm test   # WIPES the public schema, then runs integration tests
```

- **API docs (Swagger UI):** `http://localhost:3001/docs` (raw spec at `/docs/json`). On by default for `NODE_ENV=development|test`; set `DOCS_ENABLED=1` to serve it on a deployed dev server. Click *Authorize* and enter `x-dev-user` + `x-dev-secret`.
- `/api/*`: JWT (Entra) auth; in dev `AUTH_DEV=1` accepts `x-dev-user: you@company.com`. First user becomes workspace owner; Entra app role `Strand.Admin` maps to admin.
- `/scim/v2/*`: Entra provisioning, bearer `SCIM_TOKEN`.
- `GET /api/projects/:key/events`: SSE stream of changes (Postgres LISTEN/NOTIFY).
- `POST /api/import`: one-time import of a browser `forge:v1` state (admin only).
- Container: `docker build -t strand-api .` — same image on Vercel/dev and EKS.
