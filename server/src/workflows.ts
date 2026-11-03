// Shared workflows (Jira's workflows and workflow schemes). System administrators keep global statuses, workflows and
// schemes; a project uses one scheme. The project's own statuses and transitions are that scheme applied: rebuilt here
// whenever the scheme, a workflow in it, or the project's work types change, so everything else keeps reading them.
//
// One planner (`plan`) decides what applying means for a project. Applying to one project, previewing a change across
// thousands, and the background job that applies it all use it, so a preview can't disagree with what then happens.
import { db, tx, type Db } from './db.ts'
import { HttpError, type Me } from './auth.ts'
import { audit, type Actor } from './audit.ts'
import { publish } from './events.ts'
import { enqueue, registerJob } from './jobs.ts'
import type { TransitionRules } from './shared/transitionRules.ts'

export interface LibTransition { id: string; name: string; fromIds: string[] | null; toId: string | null; rules: TransitionRules }
interface Wf { id: string; name: string; statuses: string[]; transitions: LibTransition[] }
interface Global { id: string; name: string; description: string; color: string; category: string }
interface Scheme { id: string; defaultWorkflowId: string; mappings: Record<string, string> }
interface Current { id: string; globalStatusId: string | null; name: string; category: string }
interface Group { type: string; statusId: string; n: number }
export type StatusMap = Record<string, string>
export interface Impact {
  project: { id: string; key: string; name: string }
  added: string[]; removed: string[]
  moves: { type: string; from: string; to: string; count: number }[]
}
/** What a change does across many projects, in a size a person can read. */
export interface Summary {
  projects: number
  /** Projects that gain or lose a status, or have items that move */
  changed: number
  itemsMoved: number
  added: string[]; removed: string[]
  /** Where items go, added up over every project, biggest first (at most 10) */
  moves: { from: string; to: string; count: number }[]
  /** The projects most changed (at most 10) */
  top: Impact[]
}

const CAT: Record<string, number> = { todo: 0, 'in-progress': 1, done: 2 }
/** A change that reaches no project, or doesn't change anything. */
export const nothing = (): Summary => ({ projects: 0, changed: 0, itemsMoved: 0, added: [], removed: [], moves: [], top: [] })

/** What applying a scheme does to one project: its statuses (global ids, in board order), which existing status is
 *  which global one, the items that move (by type and status, to a global status) and the statuses it gains and loses. */
export function plan(i: { types: string[]; scheme: Scheme; wfs: Map<string, Wf>; glob: Map<string, Global>; current: Current[]; groups: Group[]; statusMap?: StatusMap }) {
  const def = i.wfs.get(i.scheme.defaultWorkflowId)!
  const byType = new Map(i.types.map(t => [t, i.wfs.get(i.scheme.mappings[t] ?? def.id) ?? def]))
  const inUse = new Set([...byType.values()].map(w => w.id))
  const found = [def, ...[...i.wfs.values()].filter(w => w !== def).sort((a, b) => a.name.localeCompare(b.name))].filter(w => inUse.has(w.id))
  const used = found.length ? found : [def]
  const order: string[] = []
  for (const w of used) for (const g of w.statuses) if (!order.includes(g)) order.push(g)
  order.sort((a, b) => CAT[i.glob.get(a)!.category]! - CAT[i.glob.get(b)!.category]!)

  // A project status nothing manages (an imported one) takes the global status of the same name
  const current = i.current.map(s => ({ ...s }))
  const mine = new Map(current.filter(s => s.globalStatusId).map(s => [s.globalStatusId!, s]))
  for (const s of current) if (!s.globalStatusId) {
    const g = order.find(g => !mine.has(g) && i.glob.get(g)!.name.toLowerCase() === s.name.toLowerCase())
    if (g) { s.globalStatusId = g; mine.set(g, s) }
  }
  const byId = new Map(current.map(s => [s.id, s]))
  const moves: { type: string; fromId: string; to: string; count: number }[] = []
  for (const gr of i.groups) {
    const s = byId.get(gr.statusId)
    if (!s) continue
    const w = byType.get(gr.type) ?? def
    if (s.globalStatusId && w.statuses.includes(s.globalStatusId)) continue
    const chosen = i.statusMap?.[s.globalStatusId ?? ''] ?? i.statusMap?.[s.id]
    const to = chosen && w.statuses.includes(chosen) ? chosen
      : w.statuses.find(g => i.glob.get(g)!.category === s.category) ?? w.statuses[0]!
    moves.push({ type: gr.type, fromId: s.id, to, count: gr.n })
  }
  const kept = new Set(order.map(g => mine.get(g)?.id).filter(Boolean))
  return {
    byType, used, order, mine, byId, moves,
    added: order.filter(g => !mine.has(g)).map(g => i.glob.get(g)!.name),
    removed: current.filter(s => !kept.has(s.id)).map(s => s.name),
  }
}

/** The statuses whose items might have to move: those some workflow the project's types use doesn't have. Only items
 *  in these are counted, so a change that adds a status reads no items at all. */
function atRisk(types: string[], scheme: Scheme, wfs: Map<string, Wf>, current: Current[]) {
  const ws = [...new Set([scheme.defaultWorkflowId, ...types.map(t => scheme.mappings[t] ?? scheme.defaultWorkflowId)])].map(id => wfs.get(id)).filter(Boolean) as Wf[]
  return current.filter(s => !s.globalStatusId || ws.some(w => !w.statuses.includes(s.globalStatusId!))).map(s => s.id)
}

/** Which workflow each of a project's work types uses under a scheme (a type the scheme doesn't name uses its default). */
export async function typeWorkflows(d: Db, projectId: string, schemeId?: string) {
  const [s] = await d.query<Scheme>(
    `select id, default_workflow_id, mappings from workflow_schemes where id = coalesce($2, (select workflow_scheme_id from projects where id = $1))`, [projectId, schemeId ?? null])
  if (!s) throw new HttpError(404, 'No such workflow scheme')
  const types = await d.query<{ key: string }>('select key from work_types where project_id = $1 order by position, key', [projectId])
  const byType = new Map(types.map(t => [t.key, s.mappings[t.key] ?? s.defaultWorkflowId]))
  const rows = await d.query<Wf>('select id, name, statuses, transitions from workflows where id = any($1)', [[s.defaultWorkflowId, ...byType.values()]])
  const wfs = new Map(rows.map(w => [w.id, w]))
  return { scheme: s, types: types.map(t => t.key), byType, wfs, def: wfs.get(s.defaultWorkflowId)! }
}

/** The project's statuses an item of this type may be in, its workflow's first (where new work starts) first. */
export async function statusesFor(d: Db, projectId: string, type: string) {
  return (await d.query<{ id: string }>(
    `select s.id from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id
       join workflows w on w.id = coalesce((sc.mappings->>$2)::uuid, sc.default_workflow_id)
       cross join unnest(w.statuses) with ordinality x(gid, n)
       join statuses s on s.project_id = p.id and s.global_status_id = x.gid
      where p.id = $1 order by x.n`, [projectId, type])).map(r => r.id)
}

/** Status ids inside a transition's rules (parentStatus) through `map`; ones with no counterpart are dropped. */
export function mapRules(rules: TransitionRules, map: (id: string) => string | undefined): TransitionRules {
  if (!rules.validate?.some(v => v.kind === 'parentStatus')) return rules
  type V = NonNullable<TransitionRules['validate']>[number]
  const validate = rules.validate.flatMap((v): V[] => {
    if (v.kind !== 'parentStatus') return [v]
    const statusIds = v.statusIds.map(map).filter((x): x is string => !!x)
    return statusIds.length ? [{ ...v, statusIds }] : []
  })
  return { ...rules, validate }
}

const globalsOf = async (d: Db, wfs: Iterable<Wf>) => {
  const ids = [...new Set([...wfs].flatMap(w => w.statuses))]
  return new Map((await d.query<Global>('select id, name, description, color, category from wf_statuses where id = any($1)', [ids])).map(g => [g.id, g]))
}

/** Apply a scheme (by default the project's own) to a project: its statuses become the union of the workflows its
 *  types use, its transitions theirs, and every item in a status its type's workflow lacks moves, by `statusMap`
 *  (from a global or project status id to a global status id) or else to the first status of the same category. */
export async function applyScheme(d: Db, who: Actor, projectId: string, o: { schemeId?: string; statusMap?: StatusMap } = {}): Promise<Impact> {
  const [project] = await d.query<{ id: string; key: string; name: string }>('select id, key, name from projects where id = $1 for update', [projectId])
  const { scheme, types, wfs } = await typeWorkflows(d, projectId, o.schemeId)
  const glob = await globalsOf(d, wfs.values())
  const current = await d.query<Current>('select id, global_status_id, name, category from statuses where project_id = $1', [projectId])
  const risky = atRisk(types, scheme, wfs, current)
  const groups = risky.length ? await d.query<Group>(
    'select type, status_id, count(*)::int as n from issues where project_id = $1 and status_id = any($2) group by type, status_id', [projectId, risky]) : []
  const p = plan({ types, scheme, wfs, glob, current, groups, statusMap: o.statusMap })

  // Statuses: kept ones keep their id (and so their items), with the library's name, colour and place
  const ids = new Map<string, string>()
  for (const [n, g] of p.order.entries()) {
    const x = glob.get(g)!, have = p.mine.get(g)
    const [row] = have
      ? await d.query<{ id: string }>('update statuses set global_status_id = $2, name = $3, description = $4, color = $5, category = $6, position = $7 where id = $1 returning id', [have.id, g, x.name, x.description, x.color, x.category, n])
      : await d.query<{ id: string }>('insert into statuses (project_id, global_status_id, name, description, color, category, position) values ($1, $2, $3, $4, $5, $6, $7) returning id', [projectId, g, x.name, x.description, x.color, x.category, n])
    ids.set(g, row!.id)
  }
  const actor = who.me?.id ?? null
  for (const m of p.moves) {
    await d.query(`insert into activity (issue_id, actor_id, field, from_value, to_value, text)
                   select id, $4, 'statusId', $3::text, $5::text, 'Changed status (workflow change)' from issues where project_id = $1 and type = $2 and status_id = $3::uuid and deleted_at is null`,
    [projectId, m.type, m.fromId, actor, ids.get(m.to)])
    await d.query('update issues set status_id = $4, version = version + 1, updated_at = now() where project_id = $1 and type = $2 and status_id = $3', [projectId, m.type, m.fromId, ids.get(m.to)])
  }

  // Transitions: each workflow's, for the types that use it (null: every type does)
  const sources: string[] = []
  for (const w of p.used) {
    const mine = [...p.byType].filter(([, x]) => x.id === w.id).map(([k]) => k)
    const typeKeys = mine.length === p.byType.size ? null : mine
    for (const t of w.transitions) {
      const source = `${w.id}:${t.id}`
      sources.push(source)
      await d.query(`insert into transitions (project_id, source, name, from_ids, to_id, rules, type_keys) values ($1, $2, $3, $4, $5, $6, $7)
                     on conflict (project_id, source) do update set name = excluded.name, from_ids = excluded.from_ids, to_id = excluded.to_id, rules = excluded.rules, type_keys = excluded.type_keys`,
      [projectId, source, t.name, t.fromIds && t.fromIds.map(g => ids.get(g)!), t.toId && ids.get(t.toId), JSON.stringify(mapRules(t.rules ?? {}, g => ids.get(g))), typeKeys])
    }
  }
  await d.query('delete from transitions where project_id = $1 and (source is null or not (source = any($2)))', [projectId, sources])
  await d.query('delete from statuses where project_id = $1 and not (id = any($2))', [projectId, [...ids.values()]])

  const impact: Impact = {
    project, added: p.added, removed: p.removed,
    moves: p.moves.map(m => ({ type: m.type, from: p.byId.get(m.fromId)!.name, to: glob.get(m.to)!.name, count: m.count })),
  }
  if (p.moves.length) await publish(d, projectId, { type: 'issues.reranked' })
  if (current.length && (impact.added.length || impact.removed.length || p.moves.length))   // a new project's first statuses aren't a change
    await audit(d, who, { action: 'project.workflow.applied', type: 'workflow', project, after: impact })
  return impact
}

/** SQL condition: project `p` uses the workflow $N (through its scheme's default or a type's mapping). */
const usesWorkflow = (n: number) => `exists (select 1 from workflow_schemes sc where sc.id = p.workflow_scheme_id
  and (sc.default_workflow_id = $${n}::uuid or exists (select 1 from jsonb_each_text(sc.mappings) m where m.value = $${n}::text)))`
type Reach = { workflowId: string } | { schemeId: string }
const reachSql = (r: Reach, n: number) => ('workflowId' in r ? usesWorkflow(n) : `p.workflow_scheme_id = $${n}::uuid`)
const reachArg = (r: Reach) => ('workflowId' in r ? r.workflowId : r.schemeId)

/** How many projects a workflow or scheme reaches. */
export async function countUsing(d: Db, ws: string, r: Reach) {
  const [{ n }] = await d.query<{ n: number }>(`select count(*)::int as n from projects p where p.workspace_id = $1 and p.deleting_at is null and ${reachSql(r, 2)}`, [ws, reachArg(r)]) as any
  return n as number
}

/** One page of the projects a workflow or scheme reaches, by key (keyset: pass `after`, the last key seen). */
export async function pageUsing(d: Db, ws: string, r: Reach, o: { query?: string; after?: string; limit: number }) {
  const args: unknown[] = [ws, reachArg(r)]
  const where = ['p.workspace_id = $1', 'p.deleting_at is null', reachSql(r, 2)]
  if (o.query) { args.push(`%${o.query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(p.key ilike $${args.length} or p.name ilike $${args.length})`) }
  if (o.after) { args.push(o.after); where.push(`p.key > $${args.length}`) }
  args.push(o.limit + 1)
  const rows = await d.query<{ id: string; key: string; name: string; scheme: string }>(
    `select p.id, p.key, p.name, sc.name as scheme from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id
      where ${where.join(' and ')} order by p.key limit $${args.length}`, args)
  const more = rows.length > o.limit, items = more ? rows.slice(0, o.limit) : rows
  return { items, next: more ? items.at(-1)!.key : null }
}

/** "PAY, MOB, SUP and 397 more": a list that can be long, kept short. */
export const someOf = (names: string[], total = names.length, n = 3) =>
  total <= n ? names.join(', ') : `${names.slice(0, n).join(', ')} and ${(total - n).toLocaleString('en')} more`

/** What applying would do to every project a workflow or scheme reaches, as the definitions are now in `d` (call it
 *  inside the transaction that saved the change). Reads everything in a few queries, and only the items that could move. */
export async function summarize(d: Db, ws: string, r: Reach, statusMap?: StatusMap): Promise<Summary> {
  const projects = await d.query<{ id: string; key: string; name: string; schemeId: string }>(
    `select p.id, p.key, p.name, p.workflow_scheme_id as scheme_id from projects p where p.workspace_id = $1 and p.deleting_at is null and ${reachSql(r, 2)} order by p.key`, [ws, reachArg(r)])
  const out: Summary = { projects: projects.length, changed: 0, itemsMoved: 0, added: [], removed: [], moves: [], top: [] }
  if (!projects.length) return out
  const pids = projects.map(p => p.id)
  const schemes = new Map((await d.query<Scheme>('select id, default_workflow_id, mappings from workflow_schemes where id = any($1)', [[...new Set(projects.map(p => p.schemeId))]])).map(s => [s.id, s]))
  const wfIds = [...new Set([...schemes.values()].flatMap(s => [s.defaultWorkflowId, ...Object.values(s.mappings)]))]
  const wfs = new Map((await d.query<Wf>('select id, name, statuses, transitions from workflows where id = any($1)', [wfIds])).map(w => [w.id, w]))
  const glob = await globalsOf(d, wfs.values())
  const typesOf = new Map<string, string[]>(), currentOf = new Map<string, Current[]>(), groupsOf = new Map<string, Group[]>()
  for (const t of await d.query<{ projectId: string; key: string }>('select project_id, key from work_types where project_id = any($1) order by position, key', [pids]))
    typesOf.set(t.projectId, [...(typesOf.get(t.projectId) ?? []), t.key])
  for (const s of await d.query<Current & { projectId: string }>('select project_id, id, global_status_id, name, category from statuses where project_id = any($1)', [pids]))
    currentOf.set(s.projectId, [...(currentOf.get(s.projectId) ?? []), s])
  const risky = projects.flatMap(p => atRisk(typesOf.get(p.id) ?? [], schemes.get(p.schemeId)!, wfs, currentOf.get(p.id) ?? []))
  if (risky.length)
    for (const g of await d.query<Group & { projectId: string }>(
      'select project_id, type, status_id, count(*)::int as n from issues where status_id = any($1) group by project_id, type, status_id', [risky]))
      groupsOf.set(g.projectId, [...(groupsOf.get(g.projectId) ?? []), g])

  const added = new Set<string>(), removed = new Set<string>(), moves = new Map<string, number>(), impacts: (Impact & { n: number })[] = []
  for (const pr of projects) {
    const p = plan({ types: typesOf.get(pr.id) ?? [], scheme: schemes.get(pr.schemeId)!, wfs, glob, current: currentOf.get(pr.id) ?? [], groups: groupsOf.get(pr.id) ?? [], statusMap })
    const firstTime = !(currentOf.get(pr.id) ?? []).length
    if (firstTime || (!p.added.length && !p.removed.length && !p.moves.length)) continue
    const im = { project: { id: pr.id, key: pr.key, name: pr.name }, added: p.added, removed: p.removed,
      moves: p.moves.map(m => ({ type: m.type, from: p.byId.get(m.fromId)!.name, to: glob.get(m.to)!.name, count: m.count })), n: 0 }
    im.n = im.moves.reduce((a, m) => a + m.count, 0)
    out.changed++; out.itemsMoved += im.n
    p.added.forEach(x => added.add(x)); p.removed.forEach(x => removed.add(x))
    for (const m of im.moves) moves.set(`${m.from}\u0000${m.to}`, (moves.get(`${m.from}\u0000${m.to}`) ?? 0) + m.count)
    impacts.push(im)
  }
  out.added = [...added]; out.removed = [...removed]
  out.moves = [...moves].map(([k, count]) => ({ from: k.split('\u0000')[0]!, to: k.split('\u0000')[1]!, count })).sort((a, b) => b.count - a.count).slice(0, 10)
  out.top = impacts.sort((a, b) => b.n - a.n || a.project.key.localeCompare(b.project.key)).slice(0, 10).map(({ n: _n, ...i }) => i)
  return out
}

/** The apply job running (or waiting) in a workspace, if any: there is at most one, so changes apply in order. */
export async function runningApply(d: Db, ws: string) {
  const [j] = await d.query<{ id: string; status: string; payload: any; progress: any; createdAt: string }>(
    `select id, status, payload, progress, created_at from jobs where kind = 'workflow.apply' and workspace_id = $1 and status in ('queued', 'running') order by created_at limit 1`, [ws])
  return j ?? null
}

/** Queue applying a workflow or scheme to every project it reaches (inside the transaction that saved the change). */
export async function enqueueApply(d: Db, me: Me & { ip?: string }, r: Reach & { name: string }, statusMap: StatusMap, total: number) {
  const id = await enqueue(d, 'workflow.apply', { ...r, statusMap, actor: { id: me.id, email: me.email, workspaceId: me.workspaceId }, ip: me.ip ?? null },
    { workspaceId: me.workspaceId, createdBy: me.id, dedupeKey: `workflow.apply:${me.workspaceId}`, maxAttempts: 10 })
  await d.query('update jobs set progress = $2 where id = $1 and progress is null', [id, JSON.stringify({ total, done: 0, after: '', failed: [] })])
  return id
}

// Applies one project at a time, each in its own transaction, so one project that fails doesn't undo the rest; a
// failure is recorded and the job carries on. It remembers the last project done, so a retry (a pod restarting)
// carries on from there, and it renews its lease as it goes.
registerJob('workflow.apply', async (payload, job) => {
  const ws = payload.actor.workspaceId as string
  const r: Reach = payload.workflowId ? { workflowId: payload.workflowId } : { schemeId: payload.schemeId }
  const [row] = await db.query<{ progress: any }>('select progress from jobs where id = $1', [job.id])
  const pr = { total: 0, done: 0, after: '', failed: [] as { key: string; error: string }[], ...(row?.progress ?? {}) }
  pr.total = await countUsing(db, ws, r)
  const who = { me: payload.actor as Me, ip: payload.ip ?? undefined }
  for (;;) {
    const page = await pageUsing(db, ws, r, { after: pr.after, limit: 50 })
    for (const p of page.items) {
      try { await tx(d => applyScheme(d, who, p.id, { statusMap: payload.statusMap })) }
      catch (e) { if (pr.failed.length < 100) pr.failed.push({ key: p.key, error: String((e as Error)?.message ?? e).slice(0, 300) }) }
      pr.done++; pr.after = p.key
    }
    await db.query(`update jobs set progress = $2, locked_until = now() + interval '5 minutes' where id = $1`, [job.id, JSON.stringify(pr)])
    if (!page.next) break
  }
  await tx(d => audit(d, who, { action: 'workflow.applied', type: 'workflow', id: reachArg(r), name: payload.name ?? null,
    workspaceId: ws, after: { projects: pr.done, failed: pr.failed.length } }))
  return { applied: pr.done - pr.failed.length, failed: pr.failed }
})

/** Run `fn` in the transaction it is given, then, for a preview, undo it all and return what it reported. */
export async function previewing<T>(tx: <R>(fn: (d: Db) => Promise<R>) => Promise<R>, dryRun: boolean, fn: (d: Db) => Promise<T>): Promise<T> {
  if (!dryRun) return tx(fn)
  const PREVIEW = Symbol('preview')
  try {
    await tx(async d => { throw Object.assign(new Error('preview'), { [PREVIEW]: await fn(d) }) })
  } catch (e) { if (e && typeof e === 'object' && PREVIEW in e) return (e as any)[PREVIEW]; throw e }
  throw new Error('unreachable')
}
