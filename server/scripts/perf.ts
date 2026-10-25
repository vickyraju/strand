// Performance at realistic volume: seeds a scratch database with a large workspace, then times the API's main reads
// through the real app (in process, no network), and checks each against a budget.
//   DATABASE_URL=postgres://…/scratch PERF_ITEMS=100000 node scripts/perf.ts
// The database is wiped first: point it at a scratch database only. Exits 1 if a budget is missed.
import pg from 'pg'
import { randomBytes } from 'node:crypto'

const url = process.env.DATABASE_URL
if (!url || !/scratch|perf|test|_t\b|\/t$/.test(url)) { console.error('Set DATABASE_URL to a scratch database (its name must say perf, scratch or test): it is wiped'); process.exit(2) }
const ITEMS = Number(process.env.PERF_ITEMS ?? 100_000)
const PROJECTS = Number(process.env.PERF_PROJECTS ?? 20)
const PEOPLE = Number(process.env.PERF_PEOPLE ?? 500)
const RUNS = Number(process.env.PERF_RUNS ?? 10)
Object.assign(process.env, { NODE_ENV: 'test', JOBS_POLL_MS: '0', DUE_SCAN_INTERVAL_MS: '0', FILE_SWEEP_MS: '0', ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID ?? 't', ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID ?? 'c' })

const c = new pg.Client({ connectionString: url })
await c.connect()
const t0 = Date.now()
const q = (sql: string, args: unknown[] = []) => c.query(sql, args)
await q('drop schema public cascade; create schema public')
await c.end()
const { execFileSync } = await import('node:child_process')
execFileSync(process.execPath, [new URL('./migrate.ts', import.meta.url).pathname], { env: process.env, stdio: 'ignore' })
const s = new pg.Client({ connectionString: url })
await s.connect()
const sq = (sql: string, args: unknown[] = []) => s.query(sql, args)

// ── Seed: one workspace, people, projects (Scrum, four statuses, the default any-to-any moves), items spread over them
// with labels, priorities, assignees, due dates, sprints and a status history; a few security levels and comments ──
const [ws] = (await sq(`insert into workspaces (name) values ('Perf') returning id`)).rows
await sq(`insert into users (email, name, initials) select 'p' || n || '@perf.test', 'Person ' || n, 'P' || (n % 10) from generate_series(1, $1) n`, [PEOPLE])
await sq(`insert into memberships (workspace_id, user_id, role) select $1, id, case when email = 'p1@perf.test' then 'owner' else 'member' end from users`, [ws.id])
await sq(`insert into projects (workspace_id, key, name, template, lead_id)
          select $1, 'P' || n, 'Project ' || n, 'scrum', (select id from users where email = 'p1@perf.test') from generate_series(1, $2) n`, [ws.id, PROJECTS])
await sq(`insert into statuses (project_id, name, color, category, position)
          select p.id, s.name, '#999999', s.cat, s.pos from projects p,
            (values ('To do', 'todo', 0), ('In progress', 'in-progress', 1), ('In review', 'in-progress', 2), ('Done', 'done', 3)) s(name, cat, pos)`)
await sq(`insert into transitions (project_id, name, from_ids, to_id) select project_id, name, null, id from statuses`)
await sq(`insert into project_members (project_id, user_id, role) select p.id, u.id, case when u.email = 'p1@perf.test' then 'admin' else 'member' end from projects p, users u`)
await sq(`insert into sprints (workspace_id, project_id, name, state) select $1, id, 'Sprint 1', 'active' from projects`, [ws.id])
await sq(`insert into security_levels (project_id, name, members) select id, 'Restricted', '[{"kind":"role","role":"admin"},{"kind":"reporter"}]' from projects`)
console.log(`seeding ${ITEMS.toLocaleString('en')} items…`)
await sq(`
  with people as (select array_agg(id order by email) as ids from users),
       st as (select project_id, array_agg(id order by position) as ids from statuses group by project_id),
       pr as (select row_number() over (order by key) as n, id from projects)
  insert into issues (workspace_id, project_id, number, type, title, description, status_id, priority, assignee_id, reporter_id,
                      labels, estimate, due_date, sprint_id, rank, security_level_id, created_at, updated_at)
  select $1, pr.id, g.n, (array['story','task','bug','task'])[1 + g.n % 4],
         'Item ' || g.n || ' ' || (array['login','payments','export','search','mobile','billing','reports','api'])[1 + g.n % 8] || ' work',
         'Description of item ' || g.n || ' with some words about ' || (array['latency','errors','layout','copy'])[1 + g.n % 4],
         st.ids[1 + g.n % 4], (array['urgent','high','medium','low','none'])[1 + g.n % 5],
         case when g.n % 7 = 0 then null else people.ids[1 + g.n % array_length(people.ids, 1)] end, people.ids[1 + (g.n * 7) % array_length(people.ids, 1)],
         array[(array['ui','backend','infra','docs'])[1 + g.n % 4]], 1 + g.n % 8, current_date + (g.n % 60 - 20),
         case when g.n % 3 = 0 then (select id from sprints where project_id = pr.id) end, g.n * 1024,
         case when g.n % 50 = 0 then (select id from security_levels where project_id = pr.id) end,
         now() - (g.n % 365) * interval '1 day', now() - (g.n % 90) * interval '1 hour'
    from generate_series(1, $2) g(n) join pr on pr.n = 1 + g.n % $3, people, st where st.project_id = pr.id`, [ws.id, ITEMS, PROJECTS])
await sq(`update projects p set next_number = (select coalesce(max(number), 0) + 1 from issues where project_id = p.id)`).catch(() => {})
await sq(`insert into activity (issue_id, actor_id, field, from_value, to_value, text, created_at)
          select i.id, i.reporter_id, 'statusId', st0.id::text, i.status_id::text, 'Changed status', i.created_at + interval '1 day'
            from issues i join statuses st0 on st0.project_id = i.project_id and st0.position = 0 where i.status_id <> st0.id`)
await sq(`insert into comments (issue_id, author_id, body) select id, reporter_id, 'A comment on ' || title from issues where number % 10 = 0`)
await sq('analyze')
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

// ── Sign in as a member (not an admin: the slower, access-checked path) with an access token ──
const { hashToken } = await import('../src/auth.ts')
const token = 'jbp_' + randomBytes(32).toString('base64url').slice(0, 43)
const [member] = (await sq(`select id from users where email = 'p2@perf.test'`)).rows
await sq(`insert into personal_access_tokens (user_id, name, token_hash, hint, expires_at) values ($1, 'perf', $2, 'perf', now() + interval '1 day')`, [member.id, hashToken(token)])
await s.end()

const { build } = await import('../src/app.ts')
const app = await build()
const auth = { authorization: `Bearer ${token}` }
const key = 'P1-' + PROJECTS                                                                          // an item of project P1 (P1 gets the multiples of PROJECTS)
const jql = (j: string) => `/api/v1/search?limit=50&jql=${encodeURIComponent(j)}`
// [name, path, budget for p95 in ms]
const CHECKS: [string, string, number][] = [
  ['Open one item (all of it)', `/api/v1/issues/${key}`, 300],
  ['Board / backlog: first page of a project', '/api/v1/projects/P1/issues?limit=200', 800],
  ['Search: free text, all projects', '/api/v1/search?q=payments&limit=50', 1000],
  ['Search: by key', `/api/v1/search?q=${key}&limit=50`, 300],
  ['JQL: fields and ORDER BY', jql('project = P1 AND priority in (urgent, high) AND status != Done ORDER BY updated DESC'), 1000],
  ['JQL: text and assignee', jql('text ~ "latency" AND assignee = currentUser()'), 1000],
  ['Your work', '/api/v1/me/work', 500],
  ['Your work: counts', '/api/v1/me/work/summary', 800],
  ['Project summary counts', '/api/v1/projects/P1/summary', 1000],
  ['Notifications', '/api/v1/notifications', 300],
  ['Report data: a whole project', '/api/v1/projects/P1/report-data', 3000],
]
const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!
let missed = 0
console.log(`\n${ITEMS.toLocaleString('en')} items in ${PROJECTS} projects, ${PEOPLE} people; ${RUNS} runs each (after one warm-up)\n`)
console.log('Check'.padEnd(46) + 'p50 ms'.padStart(8) + 'p95 ms'.padStart(8) + 'budget'.padStart(8) + '  rows')
for (const [name, path, budget] of CHECKS) {
  const times: number[] = []
  let rows = 0
  for (let n = 0; n <= RUNS; n++) {
    const start = performance.now()
    const r = await app.inject({ method: 'GET', url: path, headers: auth })
    const ms = performance.now() - start
    if (r.statusCode !== 200) { console.error(`${name}: ${r.statusCode} ${r.body.slice(0, 200)}`); process.exit(1) }
    if (n === 0) { const b = JSON.parse(r.body); rows = Array.isArray(b) ? b.length : b.items?.length ?? b.issues?.length ?? 1; continue }
    times.push(ms)
  }
  const p95 = pct(times, 0.95)
  const ok = p95 <= budget
  if (!ok) missed++
  console.log(`${ok ? ' ' : '✗'} ${name.padEnd(44)}${pct(times, 0.5).toFixed(0).padStart(8)}${p95.toFixed(0).padStart(8)}${String(budget).padStart(8)}  ${rows}`)
}
await app.close()
console.log(missed ? `\n${missed} over budget` : '\nAll within budget')
process.exit(missed ? 1 : 0)
