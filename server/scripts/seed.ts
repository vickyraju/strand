// Loads the app's sample workspace (3 projects, 52 work items, sprints, comments, history) into a LOCAL dev database.
//   DATABASE_URL=postgres://postgres@127.0.0.1:54322/postgres SEED_EMAIL=you@local.dev node scripts/seed.ts
// The person with SEED_EMAIL (default alex@local.dev) becomes the workspace owner if there is none yet, so sign in with
// that address. Refuses to run on a database that already has projects, or on a non-local host (pass --remote to allow).
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sampleWorkspace } from '../../src/data/testdata.ts'

const url = process.env.DATABASE_URL
if (!url) { console.error('Set DATABASE_URL (a local database)'); process.exit(2) }
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !process.argv.includes('--remote')) {
  console.error(`Refusing to seed ${host}: it is not a local database (add --remote to override)`); process.exit(2)
}

const email = (process.env.SEED_EMAIL ?? 'alex@local.dev').toLowerCase()
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
const at = (ms?: number) => (ms ? new Date(ms).toISOString() : null)

const c = new pg.Client({ connectionString: url })
await c.connect()
try {
  await c.query('begin')
  if ((await c.query('select 1 from projects limit 1')).rowCount) throw new Error('This database already has projects; seed an empty one')

  // The owner: whoever owns the workspace already, or the person with SEED_EMAIL
  let ws = (await c.query('select id from workspaces order by created_at limit 1')).rows[0]?.id as string | undefined
  if (!ws) ws = (await c.query(`insert into workspaces (name) values ('Strand') returning id`)).rows[0].id
  let owner = (await c.query(`select u.id, u.name, u.initials, u.color from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and m.role = 'owner' limit 1`, [ws])).rows[0]
  if (!owner) {
    const name = email.split('@')[0]!
    owner = (await c.query(
      `insert into users (email, name, initials) values ($1, $2, $3) on conflict (email) do update set email = excluded.email returning id, name, initials, color`,
      [email, name, initialsOf(name)])).rows[0]
    await c.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner') on conflict do nothing`, [ws, owner.id])
  }

  const data = sampleWorkspace({ id: owner.id, name: owner.name, initials: owner.initials, color: owner.color })
  const run = (sql: string, params: unknown[]) => c.query(sql, params)

  for (const u of data.users ?? []) {
    await run('insert into users (id, email, name, initials, color, title) values ($1, $2, $3, $4, $5, $6)',
      [u.id, `${u.name.toLowerCase().replace(/[^a-z]+/g, '.')}@sample.local`, u.name, u.initials, u.color, u.title ?? null])
    await run(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')`, [ws, u.id])
  }

  const statusId = new Map<string, string>()                      // "projectId|sample status id" → real uuid (sample ids like "todo" repeat across projects)
  const sid = (projectId: string, id: string) => statusId.get(`${projectId}|${id}`) ?? id
  const nextNumber = new Map<string, number>()
  for (const p of data.projects ?? []) {
    nextNumber.set(p.id, p.nextNumber)
    for (const s of p.statuses) statusId.set(`${p.id}|${s.id}`, randomUUID())
    const layout = Object.fromEntries(Object.entries(p.layout ?? {}).map(([k, v]) => [sid(p.id, k), v]))
    await run(
      `insert into projects (id, workspace_id, key, name, description, color, template, lead_id, next_number, board_prefs, layout, sample, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, true, $11)`,
      [p.id, ws, p.key, p.name, p.description, p.color, p.template, p.leadId || null, p.nextNumber, JSON.stringify(layout), at(p.createdAt)])
    // everyone in the sample team works on every sample project; the lead administers it (the owner sees all as workspace owner)
    await run(`insert into project_members (project_id, user_id, role)
               select $1, m.user_id, case when m.user_id = $2 then 'admin' else 'member' end from memberships m where m.workspace_id = $3`,
      [p.id, p.leadId || null, ws])
    for (const [i, s] of p.statuses.entries())
      await run('insert into statuses (id, project_id, name, description, color, category, wip_limit, position) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [sid(p.id, s.id), p.id, s.name, s.description ?? '', s.color, s.category, s.wipLimit ?? null, i])
    for (const t of p.transitions)
      await run('insert into transitions (id, project_id, name, from_ids, to_id) values ($1, $2, $3, $4, $5)',
        [t.id, p.id, t.name, t.from === 'any' ? null : t.from.map(f => sid(p.id, f)), sid(p.id, t.to)])
    for (const [i, f] of p.fields.entries())
      await run('insert into field_defs (id, project_id, name, kind, options, position) values ($1, $2, $3, $4, $5, $6)', [f.id, p.id, f.name, f.kind, f.options ?? null, i])
    for (const t of p.templates)
      await run('insert into item_templates (id, project_id, name, type, title, description, priority, labels, estimate) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [t.id, p.id, t.name, t.type, t.title, t.description, t.priority, t.labels, t.estimate ?? null])
    for (const r of p.releases)
      await run('insert into releases (id, workspace_id, project_id, name, description, start_date, release_date, released, released_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [r.id, ws, p.id, r.name, r.description, r.startDate ?? null, r.releaseDate ?? null, r.released, at(r.releasedAt)])
  }

  for (const s of data.sprints ?? [])
    await run(`insert into sprints (id, workspace_id, project_id, name, goal, state, started_at, ends_at, completed_at, committed, completed, issue_ids)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [s.id, ws, s.projectId, s.name, s.goal, s.state, at(s.startedAt), at(s.endsAt), at(s.completedAt), s.committed ?? null, s.completed ?? null, s.issueIds ?? null])

  const issues = data.issues ?? []
  for (const i of issues) {
    await run(
      `insert into issues (id, workspace_id, project_id, number, type, title, description, status_id, priority, assignee_id, reporter_id, labels, estimate, time_estimate,
                           due_date, start_date, custom, rank, sprint_id, release_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [i.id, ws, i.projectId, Number(i.key.split('-')[1]), i.type, i.title, i.description, sid(i.projectId, i.status), i.priority, i.assigneeId ?? null, i.reporterId || null, i.labels,
        i.estimate ?? null, i.timeEstimate ?? null, i.dueDate ?? null, i.startDate ?? null, JSON.stringify(i.custom ?? {}), i.rank, i.sprintId ?? null, i.releaseId ?? null, at(i.createdAt), at(i.updatedAt)])
  }
  for (const i of issues) {                                          // parents after every issue exists
    if (i.parentId) await run('update issues set parent_id = $2 where id = $1', [i.id, i.parentId])
    for (const u of i.watcherIds) await run('insert into issue_watchers (issue_id, user_id) values ($1, $2) on conflict do nothing', [i.id, u])
    for (const l of i.links) await run('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing', [i.id, l.issueId, l.type])
    for (const w of i.worklogs) await run('insert into worklogs (id, issue_id, user_id, minutes, date, note, created_at) values ($1, $2, $3, $4, $5, $6, $7)', [w.id, i.id, w.userId || null, w.minutes, w.date, w.note, at(w.at)])
  }
  for (const m of data.comments ?? []) await run('insert into comments (id, issue_id, author_id, body, created_at, edited_at) values ($1, $2, $3, $4, $5, $6)', [m.id, m.issueId, m.authorId || null, m.body, at(m.createdAt), at(m.editedAt)])
  const projectOf = new Map((data.issues ?? []).map(i => [i.id, i.projectId]))
  for (const a of data.activity ?? []) {
    // a status change is stored the server's way: field 'statusId', with the real status ids
    const st = a.field === 'status', pid = projectOf.get(a.issueId) ?? ''
    await run('insert into activity (id, issue_id, actor_id, field, from_value, to_value, text, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [a.id, a.issueId, a.actorId && a.actorId !== 'automation' ? a.actorId : null, st ? 'statusId' : a.field ?? null,
       (st && a.from ? sid(pid, a.from) : a.from) ?? null, (st && a.to ? sid(pid, a.to) : a.to) ?? null, a.text, at(a.createdAt)])
  }
  for (const n of data.notifications ?? []) await run('insert into notifications (id, user_id, actor_id, issue_id, kind, text, read, archived, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [n.id, n.userId, n.actorId || null, n.issueId, n.kind, n.text, n.read, n.archived, at(n.createdAt)])
  for (const p of data.starred ?? []) await run('insert into stars (user_id, project_id) values ($1, $2) on conflict do nothing', [owner.id, p])

  await c.query('commit')
  const count = async (t: string) => (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n
  console.log(`Seeded: ${await count('projects')} projects, ${await count('issues')} work items, ${await count('sprints')} sprints, ${await count('comments')} comments, ${await count('users')} people.`)
  console.log(`Sign in as ${email}.`)
} catch (e) {
  await c.query('rollback').catch(() => {})
  console.error('Seed failed:', (e as Error).message)
  process.exitCode = 1
} finally {
  await c.end()
}
