#!/bin/sh
# Runs the whole app on this machine: Postgres, the API (dev login) and the web app.   sh scripts/dev-local.sh
# First run creates the database, applies the migrations and loads the sample workspace. Later runs reuse it.
#   Sign in at http://localhost:5173 with SEED_EMAIL (default alex@local.dev) and the secret "local-dev-secret".
#   Start over:  psql -h 127.0.0.1 -p 54322 -U postgres -c "truncate workspaces, users cascade"  and run this again.
# Attachments need S3-compatible storage: set S3_BUCKET, S3_ENDPOINT, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY before running.
# Ctrl+C stops the API and the web app. Postgres keeps running; stop it with: pg_ctl -D ~/.strand-local/pg stop
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA=${STRAND_LOCAL:-$HOME/.strand-local}
PORT_DB=54322
SEED_EMAIL=${SEED_EMAIL:-alex@local.dev}
DB="postgres://postgres@127.0.0.1:$PORT_DB/postgres"

mkdir -p "$DATA"
[ -d "$DATA/pg" ] || initdb -D "$DATA/pg" -U postgres -A trust >/dev/null
pg_ctl -D "$DATA/pg" status >/dev/null 2>&1 || pg_ctl -D "$DATA/pg" -o "-p $PORT_DB -k /tmp" -l "$DATA/pg.log" -w start >/dev/null

# Migrations: each file once, in name order
psql "$DB" -q -c "create table if not exists local_migrations (name text primary key)" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  n=$(basename "$f")
  if [ -z "$(psql "$DB" -tAc "select 1 from local_migrations where name = '$n'")" ]; then
    psql "$DB" -v ON_ERROR_STOP=1 -q -1 -f "$f" >/dev/null && psql "$DB" -q -c "insert into local_migrations values ('$n')" >/dev/null
    echo "applied $n"
  fi
done

# Sample data, only into an empty database
if [ "$(psql "$DB" -tAc "select count(*) from projects")" = "0" ]; then
  (cd "$ROOT/server" && DATABASE_URL="$DB" SEED_EMAIL="$SEED_EMAIL" node scripts/seed.ts)
fi

# The API gets an explicit environment so it can never pick up the hosted database from server/.env
(cd "$ROOT/server" && exec env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DB" PORT=3001 NODE_ENV=development AUTH_DEV=1 \
  DEV_AUTH_SECRET=local-dev-secret CORS_ORIGINS=http://localhost:5173 DOCS_ENABLED=1 PG_POOL=10 EMAIL_TRANSPORT=log \
  S3_BUCKET="${S3_BUCKET:-}" S3_ENDPOINT="${S3_ENDPOINT:-}" AWS_REGION="${AWS_REGION:-us-east-1}" \
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}" node src/index.ts) &
API=$!
trap 'kill $API 2>/dev/null' EXIT INT TERM
cd "$ROOT"
echo "API http://localhost:3001 (docs at /docs)   Web http://localhost:5173   Sign in: $SEED_EMAIL / local-dev-secret"
VITE_API_URL=http://localhost:3001 VITE_API_PREFIX=/api/v1 npx vite --port 5173 --strictPort
