// Shared workflows (Jira's workflows and workflow schemes). System administrators keep global statuses, workflows and
// schemes; a project uses one scheme. The project's own statuses and transitions are that scheme applied: rebuilt here
// whenever the scheme, a workflow in it, or the project's work types change, so everything else keeps reading them.
import type { Db } from './db.ts'
import { HttpError } from './auth.ts'
import { audit, type Actor } from './audit.ts'
import { publish } from './events.ts'
import type { TransitionRules } from './shared/transitionRules.ts'

export interface LibTransition { id: string; name: string; fromIds: string[] | null; toId: string | null; rules: TransitionRules }
interface Wf { id: string; name: string; statuses: string[]; transitions: LibTransition[] }
interface Global { id: string; name: string; description: string; color: string; category: string }
export type StatusMap = Record<string, string>
export interface Impact {
  project: { id: string; key: string; name: string }
  added: string[]; removed: string[]
  moves: { type: string; from: string; to: string; count: number }[]
}

const CAT: Record<string, number> = { todo: 0, 'in-progress': 1, done: 2 }

/** Which workflow each of a project's work types uses under a scheme (a type the scheme doesn't name uses its default). */
export async function typeWorkflows(d: Db, projectId: string, schemeId?: string) {
  const [s] = await d.query<{ defaultWorkflowId: string; mappings: Record<string, string> }>(
    `select default_workflow_id, mappings from workflow_schemes where id = coalesce($2, (select workflow_scheme_id from projects where id = $1))`, [projectId, schemeId ?? null])
  if (!s) throw new HttpError(404, 'No such workflow scheme')
  const types = await d.query<{ key: string }>('select key from work_types where project_id = $1 order by position, key', [projectId])
  const byType = new Map(types.map(t => [t.key, s.mappings[t.key] ?? s.defaultWorkflowId]))
  const rows = await d.query<Wf>('select id, name, statuses, transitions from workflows where id = any($1)', [[s.defaultWorkflowId, ...byType.values()]])
  const wfs = new Map(rows.map(w => [w.id, w]))
  return { byType, wfs, def: wfs.get(s.defaultWorkflowId)! }
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

/** Apply a scheme (by default the project's own) to a project: its statuses become the union of the workflows its
 *  types use, its transitions theirs, and every item in a status its type's workflow lacks moves, by `statusMap`
 *  (from a global or project status id to a global status id) or else to the first status of the same category. */
export async function applyScheme(d: Db, who: Actor, projectId: string, o: { schemeId?: string; statusMap?: StatusMap } = {}): Promise<Impact> {
  const [project] = await d.query<{ id: string; key: string; name: string }>('select id, key, name from projects where id = $1 for update', [projectId])
  const { byType, wfs, def } = await typeWorkflows(d, projectId, o.schemeId)
  const inUse = new Set(byType.values())
  const found = [def, ...[...wfs.values()].filter(w => w !== def).sort((a, b) => a.name.localeCompare(b.name))].filter(w => inUse.has(w.id))
  const used = found.length ? found : [def]
  const order: string[] = []
  for (const w of used) for (const g of w.statuses) if (!order.includes(g)) order.push(g)
  const glob = new Map((await d.query<Global>('select id, name, description, color, category from wf_statuses where id = any($1)', [order])).map(g => [g.id, g]))
  order.sort((a, b) => CAT[glob.get(a)!.category]! - CAT[glob.get(b)!.category]!)

  // A project status nothing manages (an imported one) takes the global status of the same name
  const current = await d.query<{ id: string; globalStatusId: string | null; name: string; category: string }>(
    'select id, global_status_id, name, category from statuses where project_id = $1', [projectId])
  const mine = new Map(current.filter(s => s.globalStatusId).map(s => [s.globalStatusId!, s]))
  for (const s of current) if (!s.globalStatusId) {
    const g = order.find(g => !mine.has(g) && glob.get(g)!.name.toLowerCase() === s.name.toLowerCase())
    if (g) { s.globalStatusId = g; mine.set(g, s) }
  }

  // Items whose status isn't in their type's workflow, and where they go
  const groups = await d.query<{ type: string; statusId: string; n: number }>(
    'select type, status_id, count(*)::int as n from issues where project_id = $1 group by type, status_id', [projectId])
  const byId = new Map(current.map(s => [s.id, s]))
  const moves: { type: string; fromId: string; to: string; count: number }[] = []
  for (const gr of groups) {
    const s = byId.get(gr.statusId)!, w = wfs.get(byType.get(gr.type) ?? def.id) ?? def
    if (s.globalStatusId && w.statuses.includes(s.globalStatusId)) continue
    const chosen = o.statusMap?.[s.globalStatusId ?? ''] ?? o.statusMap?.[s.id]
    const to = chosen && w.statuses.includes(chosen) ? chosen
      : w.statuses.find(g => glob.get(g)!.category === s.category) ?? w.statuses[0]!
    moves.push({ type: gr.type, fromId: s.id, to, count: gr.n })
  }

  // Statuses: kept ones keep their id (and so their items), with the library's name, colour and place
  const ids = new Map<string, string>()
  for (const [i, g] of order.entries()) {
    const x = glob.get(g)!, have = mine.get(g)
    const [row] = have
      ? await d.query<{ id: string }>('update statuses set global_status_id = $2, name = $3, description = $4, color = $5, category = $6, position = $7 where id = $1 returning id', [have.id, g, x.name, x.description, x.color, x.category, i])
      : await d.query<{ id: string }>('insert into statuses (project_id, global_status_id, name, description, color, category, position) values ($1, $2, $3, $4, $5, $6, $7) returning id', [projectId, g, x.name, x.description, x.color, x.category, i])
    ids.set(g, row!.id)
  }
  const actor = who.me?.id ?? null
  for (const m of moves) {
    await d.query(`insert into activity (issue_id, actor_id, field, from_value, to_value, text)
                   select id, $4, 'statusId', $3::text, $5::text, 'Changed status (workflow change)' from issues where project_id = $1 and type = $2 and status_id = $3::uuid and deleted_at is null`,
    [projectId, m.type, m.fromId, actor, ids.get(m.to)])
    await d.query('update issues set status_id = $4, version = version + 1, updated_at = now() where project_id = $1 and type = $2 and status_id = $3', [projectId, m.type, m.fromId, ids.get(m.to)])
  }

  // Transitions: each workflow's, for the types that use it (null: every type does)
  const sources: string[] = []
  for (const w of used) {
    const types = [...byType].filter(([, wid]) => wid === w.id).map(([k]) => k)
    const typeKeys = types.length === byType.size ? null : types
    for (const t of w.transitions) {
      const source = `${w.id}:${t.id}`
      sources.push(source)
      await d.query(`insert into transitions (project_id, source, name, from_ids, to_id, rules, type_keys) values ($1, $2, $3, $4, $5, $6, $7)
                     on conflict (project_id, source) do update set name = excluded.name, from_ids = excluded.from_ids, to_id = excluded.to_id, rules = excluded.rules, type_keys = excluded.type_keys`,
      [projectId, source, t.name, t.fromIds && t.fromIds.map(g => ids.get(g)!), t.toId && ids.get(t.toId), JSON.stringify(mapRules(t.rules ?? {}, g => ids.get(g))), typeKeys])
    }
  }
  await d.query('delete from transitions where project_id = $1 and (source is null or not (source = any($2)))', [projectId, sources])
  const gone = await d.query<{ name: string }>('delete from statuses where project_id = $1 and not (id = any($2)) returning name', [projectId, [...ids.values()]])

  const impact: Impact = {
    project,
    added: order.filter(g => !mine.has(g)).map(g => glob.get(g)!.name),
    removed: gone.map(s => s.name),
    moves: moves.map(m => ({ type: m.type, from: byId.get(m.fromId)!.name, to: glob.get(m.to)!.name, count: m.count })),
  }
  if (moves.length) await publish(d, projectId, { type: 'issues.reranked' })
  if (current.length && (impact.added.length || impact.removed.length || moves.length))   // a new project's first statuses aren't a change
    await audit(d, who, { action: 'project.workflow.applied', type: 'workflow', project, after: impact })
  return impact
}

/** Projects whose scheme uses a workflow (as its default or for a type), or a scheme. */
export async function projectsUsing(d: Db, ws: string, o: { workflowId?: string; schemeId?: string }) {
  return d.query<{ id: string; key: string; name: string }>(
    `select p.id, p.key, p.name from projects p join workflow_schemes sc on sc.id = p.workflow_scheme_id
      where p.workspace_id = $1 and p.deleting_at is null
        and ($2::uuid is null or sc.default_workflow_id = $2 or exists (select 1 from jsonb_each_text(sc.mappings) m where m.value = $2::text))
        and ($3::uuid is null or sc.id = $3)
      order by p.key`, [ws, o.workflowId ?? null, o.schemeId ?? null])
}

/** Run `fn` in the transaction it is given, then, for a preview, undo it all and return what it reported. Previews are
 *  the real change, rolled back, so they can't disagree with what applying does. */
export async function previewing<T>(tx: <R>(fn: (d: Db) => Promise<R>) => Promise<R>, dryRun: boolean, fn: (d: Db) => Promise<T>): Promise<T> {
  if (!dryRun) return tx(fn)
  const PREVIEW = Symbol('preview')
  try {
    await tx(async d => { throw Object.assign(new Error('preview'), { [PREVIEW]: await fn(d) }) })
  } catch (e) { if (e && typeof e === 'object' && PREVIEW in e) return (e as any)[PREVIEW]; throw e }
  throw new Error('unreachable')
}
