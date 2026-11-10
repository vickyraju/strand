import { db, tx, type Db } from './db.ts'
import { canJoinWork } from './access.ts'
import { ruleContext, transitionTo, type TransitionRow } from './transitions.ts'
import { problems } from './shared/transitionRules.ts'
import { enqueue, registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'
import { jqlToSql, parseOr400 } from './jqlSql.ts'
import type { Me } from './auth.ts'

/** `actorId`: whose change fired it (`currentUser()` in its condition); null for a schedule. */
export interface RuleCtx { projectId: string; issueId: string; reporterId: string | null; leadId: string | null; actorId?: string | null }
type Trigger = { kind: 'created' } | { kind: 'assigned' } | { kind: 'status'; to: string } | { kind: 'scheduled' }
/** A global rule (no project, spec 0709) names statuses by name: `toName` in its trigger, `name` in a status action. */
type Rule = { id: string; name: string; trigger: any; actions: any[]; ownerId?: string | null; condition?: string | null; projectId?: string | null }
export interface Step { action: string; outcome: 'done' | 'skipped' | 'unchanged' | 'failed'; note?: string }

const NOBODY = '00000000-0000-0000-0000-000000000000'

/** Does the item match a rule's JQL condition (spec 0709 R1)? JQL sees every item; currentUser() is whoever fired the rule. */
export async function conditionMet(d: Db, issueId: string, condition: string | null | undefined, actorId?: string | null): Promise<boolean> {
  if (!condition?.trim()) return true
  const [w] = await d.query<{ workspaceId: string }>('select workspace_id from issues where id = $1', [issueId])
  const me = { id: actorId ?? NOBODY, workspaceId: w!.workspaceId, admin: true, role: 'admin', via: 'entra', email: 'automation', name: 'Automation', groupIds: [] } as unknown as Me
  const args: unknown[] = [issueId]
  const sql = await jqlToSql(d, me, parseOr400(condition), args)
  return (await d.query(`select 1 from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
                          where i.id = $1 ${sql.where ? `and (${sql.where})` : ''}`, args)).length > 0
}

/** The rules a change in a project runs: the project's own, and the global rules whose scope covers it (spec 0709 R3). */
const RULES_FOR = `select r.id, r.name, r.trigger, r.actions, r.owner_id, r.condition, r.project_id from rules r, projects p
  where p.id = $1 and r.enabled and (r.project_id = p.id or (r.project_id is null and r.workspace_id = p.workspace_id and (
    r.scope->>'kind' = 'all' or (r.scope->>'kind' = 'category' and r.scope->>'categoryId' = p.category_id::text)
    or (r.scope->>'kind' = 'projects' and r.scope->'projectIds' ? p.id::text))))
  order by r.project_id nulls last, r.id`

/** Does the project's workflow have a move from one status to another (whatever its rules)? A project with no transitions allows any move. */
export async function moveAllowed(d: Db, projectId: string, from: string, to: string, type?: string): Promise<boolean> {
  if (from === to) return true
  const [{ n }] = await d.query<{ n: number }>('select count(*)::int as n from transitions where project_id = $1', [projectId]) as any
  if (!n) return true
  const ok = await d.query(
    `select 1 from transitions where project_id = $1 and to_id = $2 and (from_ids is null or $3 = any(from_ids))
        and (type_keys is null or $4::text is null or $4 = any(type_keys))`, [projectId, to, from, type ?? null])
  return ok.length > 0
}

/** One history row written by automation (no person is the actor). */
const history = (d: Db, issueId: string, field: string | null, from: unknown, to: unknown, text: string) =>
  d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, null, $2, $3, $4, $5)',
    [issueId, field, from == null ? null : String(from), to == null ? null : String(to), text])

/** Do one rule's actions to one item, in order, and say what each did. Automation follows the same rules as people:
 *  it cannot make a move the workflow forbids, nor give work to someone outside the project; such an action is
 *  skipped, and the skip is written to the item's history. */
async function act(d: Db, ctx: RuleCtx, r: Rule): Promise<Step[]> {
  const steps: Step[] = []
  for (let a of r.actions) {
    const [cur] = await d.query<{ statusId: string; assigneeId: string | null; priority: string; labels: string[]; type: string }>(
      'select status_id, assignee_id, priority, labels, type from issues where id = $1', [ctx.issueId])
    const set = (col: string, value: unknown) =>
      d.query(`update issues set ${col} = $2, updated_at = now(), version = version + 1 where id = $1`, [ctx.issueId, value])
    const skip = async (action: string, note: string) => { steps.push({ action, outcome: 'skipped', note }); await history(d, ctx.issueId, null, null, null, `Automation skipped ${note}`) }
    switch (a.kind) {
      case 'assign': {
        const to = a.to === 'reporter' ? ctx.reporterId : a.to === 'lead' ? ctx.leadId : a.to === 'unassign' ? null : a.to
        if (to === cur!.assigneeId) { steps.push({ action: 'assign', outcome: 'unchanged' }); break }
        if (to && !(await canJoinWork(d, ctx.projectId, to))) { await skip('assign', 'an assignment: that person is not in this project'); break }
        await set('assignee_id', to)
        await history(d, ctx.issueId, 'assigneeId', cur!.assigneeId, to, 'Automation changed assignee')
        steps.push({ action: 'assign', outcome: 'done' })
        break
      }
      case 'priority':
        if (a.value === cur!.priority) { steps.push({ action: 'priority', outcome: 'unchanged' }); break }
        if (!(await d.query('select 1 from priorities p join issues i on i.workspace_id = p.workspace_id where i.id = $1 and p.key = $2', [ctx.issueId, a.value])).length)
          throw new Error(`“${a.value}” isn’t a priority in the list`)                // the rule fails, and only its changes are undone
        await set('priority', a.value)
        await history(d, ctx.issueId, 'priority', cur!.priority, a.value, 'Automation changed priority')
        steps.push({ action: 'priority', outcome: 'done' })
        break
      case 'label':
        if (cur!.labels.includes(a.value)) { steps.push({ action: 'label', outcome: 'unchanged' }); break }
        await set('labels', [...cur!.labels, a.value])
        await history(d, ctx.issueId, 'labels', cur!.labels, [...cur!.labels, a.value], 'Automation added a label')
        steps.push({ action: 'label', outcome: 'done' })
        break
      case 'status': {
        if (a.name !== undefined) {                       // a global rule's status, by name, in this item's project
          const [s] = await d.query<{ id: string }>('select id from statuses where project_id = $1 and lower(name) = lower($2)', [ctx.projectId, a.name])
          if (!s) { await skip('status', `a status change: this project has no status “${a.name}”`); break }
          a = { ...a, value: s.id }
        }
        if (a.value === cur!.statusId) { steps.push({ action: 'status', outcome: 'unchanged' }); break }
        const [target] = await d.query('select 1 from statuses where id = $1 and project_id = $2', [a.value, ctx.projectId])
        if (!target || !(await moveAllowed(d, ctx.projectId, cur!.statusId, a.value, cur!.type))) { await skip('status', 'a status change the workflow does not allow'); break }
        // the transition's rules apply to automation too (those about who moves don't: no person is moving)
        const { ISSUE_ROW, runActions } = await import('./routes/issues.ts')
        const [item] = await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [ctx.issueId])
        const rctx = await ruleContext(d, item, null)
        let t: TransitionRow | null
        try { t = await transitionTo(d, item, a.value, rctx) } catch { await skip('status', 'a status change the transition’s rules do not allow'); break }
        const why = Object.values(problems(t?.rules, rctx, item, { ...item, statusId: a.value }))
        if (why.length) { await skip('status', `a status change: ${why.join('; ')}`); break }
        await set('status_id', a.value)
        await history(d, ctx.issueId, 'statusId', cur!.statusId, a.value, 'Automation changed status')
        if (t) await runActions(d, null, ctx.issueId, t, rctx)
        steps.push({ action: 'status', outcome: 'done' })
        break
      }
      case 'comment':
        await d.query('insert into comments (issue_id, author_id, body) values ($1, null, $2)', [ctx.issueId, a.body])
        steps.push({ action: 'comment', outcome: 'done' })
        break
      default:
        steps.push({ action: String(a.kind), outcome: 'skipped', note: 'an action Strand doesn’t know' })
    }
  }
  return steps
}

const resultOf = (steps: Step[]) => steps.some(s => s.outcome === 'skipped') ? 'some_skipped' as const
  : steps.some(s => s.outcome === 'done') ? 'success' as const : 'no_change' as const

/** Run enabled automation rules for one trigger. Actions never re-trigger rules (no loops). Each rule runs in its own
 *  savepoint: one that fails undoes only its own changes (the edit that triggered it still saves), the run is recorded
 *  as failed, and the rule's owner is told. Every run goes to the rule's audit log (rule_runs).
 *  ponytail: runs inline in the request transaction; move to a queue worker when rules get slow or numerous. */
export async function runRules(d: Db, ctx: RuleCtx, t: Trigger) {
  const rules = await d.query<Rule>(RULES_FOR, [ctx.projectId])
  const statusName = t.kind === 'status' && rules.some(r => r.trigger.toName !== undefined)
    ? (await d.query<{ name: string }>('select name from statuses where id = $1', [t.to]))[0]?.name.toLowerCase() : undefined
  for (const r of rules) {
    if (r.trigger.kind !== t.kind) continue
    if (t.kind === 'status' && (r.trigger.toName !== undefined ? String(r.trigger.toName).toLowerCase() !== statusName : r.trigger.to !== t.to)) continue
    await runOne(d, ctx, r, t)
  }
  // the audit log keeps 90 days
  await d.query(`delete from rule_runs where project_id = $1 and at < now() - interval '90 days'`, [ctx.projectId])
}

/** One rule on one item: its condition, then its actions in a savepoint, and the run recorded. */
async function runOne(d: Db, ctx: RuleCtx, r: Rule, t: Trigger) {
    await d.query('savepoint automation_rule')
    try {
      if (!(await conditionMet(d, ctx.issueId, r.condition, ctx.actorId))) {
        await d.query('release savepoint automation_rule')
        await d.query('update rules set runs = runs + 1 where id = $1', [r.id])
        await d.query(`insert into rule_runs (rule_id, project_id, issue_id, trigger, result) values ($1, $2, $3, $4, 'condition_not_met')`, [r.id, ctx.projectId, ctx.issueId, JSON.stringify(t)])
        return
      }
      const steps = await act(d, ctx, r)
      await d.query('release savepoint automation_rule')
      await d.query('update rules set runs = runs + 1 where id = $1', [r.id])
      await history(d, ctx.issueId, null, null, null, 'Automation rule ran')
      await d.query('insert into rule_runs (rule_id, project_id, issue_id, trigger, result, steps) values ($1, $2, $3, $4, $5, $6)',
        [r.id, ctx.projectId, ctx.issueId, JSON.stringify(t), resultOf(steps), JSON.stringify(steps)])
    } catch (e) {
      await d.query('rollback to savepoint automation_rule')
      const error = e instanceof Error ? e.message : String(e)
      await d.query('update rules set runs = runs + 1, failures = failures + 1 where id = $1', [r.id])
      await d.query(`insert into rule_runs (rule_id, project_id, issue_id, trigger, result, steps, error) values ($1, $2, $3, $4, 'failed', '[]', $5)`,
        [r.id, ctx.projectId, ctx.issueId, JSON.stringify(t), error.slice(0, 2000)])
      if (r.ownerId) await d.query(`insert into notifications (user_id, actor_id, issue_id, kind, text) values ($1, null, $2, 'automation', $3)`,
        [r.ownerId, ctx.issueId, `Automation rule “${r.name}” failed: ${error.slice(0, 200)}`])
    }
}

/** What a rule would do to an item, without doing it: its actions run in a savepoint that is then undone. */
export async function dryRun(d: Db, ctx: RuleCtx, r: Pick<Rule, 'actions' | 'condition'>): Promise<{ steps: Step[]; error: string | null; conditionMet: boolean }> {
  if (!(await conditionMet(d, ctx.issueId, r.condition, ctx.actorId))) return { steps: [], error: null, conditionMet: false }
  await d.query('savepoint automation_dry_run')
  try {
    return { steps: await act(d, ctx, { id: '', name: '', trigger: { kind: 'created' }, ...r }), error: null, conditionMet: true }
  } catch (e) {
    return { steps: [], error: e instanceof Error ? e.message : String(e), conditionMet: true }
  } finally {
    await d.query('rollback to savepoint automation_dry_run')
  }
}

// ── Scheduled rules (spec 0709 R2): a background job per rule; the next run is queued when one ends, so runs never overlap ──

/** Queue the rule's next scheduled run (replacing one already waiting, so a changed interval takes effect). */
export async function scheduleRule(d: Db, r: { id: string; enabled: boolean; trigger: any }, workspaceId: string) {
  await d.query(`delete from jobs where dedupe_key = $1 and status = 'queued'`, [`automation.scheduled:${r.id}`])
  if (!r.enabled || r.trigger?.kind !== 'scheduled') return
  await enqueue(d, 'automation.scheduled', { ruleId: r.id }, { workspaceId, dedupeKey: `automation.scheduled:${r.id}`, maxAttempts: 1,
    runAt: new Date(Date.now() + Number(r.trigger.everyMinutes) * 60_000) })
}

/** Checks a rule before it is saved: its condition and its schedule's JQL parse, and the interval is long enough. */
export async function checkRule(d: Db, me: Me, r: { trigger?: any; condition?: string | null }) {
  const { checkQueries } = await import('./boards.ts')
  const { HttpError } = await import('./auth.ts')
  if (r.condition?.trim()) await checkQueries(d, me, { jql: r.condition, quickFilters: [], swimlanes: { by: 'none' } })
  if (r.trigger?.kind === 'scheduled') {
    if (!r.trigger.jql?.trim()) throw new HttpError(400, 'A scheduled rule needs a JQL query: the work items it acts on', { trigger: 'JQL needed' })
    await checkQueries(d, me, { jql: r.trigger.jql, quickFilters: [], swimlanes: { by: 'none' } })
    const { minScheduleMinutes } = await getSetting(me.workspaceId, 'automation')
    if (!(Number(r.trigger.everyMinutes) >= minScheduleMinutes))
      throw new HttpError(400, `A scheduled rule runs at most every ${minScheduleMinutes} minutes (System settings › Automation)`, { trigger: `At least ${minScheduleMinutes} minutes` })
  }
}

registerJob('automation.scheduled', async (p: { ruleId: string }, job) => {
  await db.query('update jobs set dedupe_key = null where id = $1', [job.id])   // so the next run can be queued
  const [r] = await db.query<Rule & { enabled: boolean; scope: any; workspaceId: string | null; lastRunAt: string | null; ws: string }>(
    `select r.*, coalesce(r.workspace_id, p.workspace_id) as ws from rules r left join projects p on p.id = r.project_id where r.id = $1`, [p.ruleId])
  if (!r || !r.enabled || r.trigger.kind !== 'scheduled') return { ran: 0 }
  const started = new Date()
  try {
    const { maxItemsPerRun } = await getSetting(r.ws, 'automation')
    const me = { id: NOBODY, workspaceId: r.ws, admin: true, role: 'admin', via: 'entra', email: 'automation', name: 'Automation', groupIds: [] } as unknown as Me
    const args: unknown[] = [r.ws]
    const sql = await jqlToSql(db, me, parseOr400(r.trigger.jql), args)
    const scope = r.projectId ? `p.id = $${args.push(r.projectId)}`
      : r.scope.kind === 'category' ? `p.category_id::text = $${args.push(r.scope.categoryId)}`
      : r.scope.kind === 'projects' ? `p.id = any($${args.push(r.scope.projectIds)}::uuid[])` : 'true'
    // changed by a person since the last run: automation's own changes (its history has no person) don't count, so it can't chase itself
    const since = r.trigger.changedSinceLastRun && r.lastRunAt
      ? `and exists (select 1 from activity a where a.issue_id = i.id and a.actor_id is not null and a.created_at > $${args.push(r.lastRunAt)})` : ''
    args.push(maxItemsPerRun + 1)
    const items = await db.query<{ id: string; projectId: string; reporterId: string | null; leadId: string | null }>(
      `select i.id, i.project_id, i.reporter_id, p.lead_id from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
        where i.workspace_id = $1 and i.deleted_at is null and p.deleting_at is null and p.archived_at is null and ${scope} ${since}
          ${sql.where ? `and (${sql.where})` : ''} order by i.updated_at, i.id limit $${args.length}`, args)
    const left = items.length > maxItemsPerRun ? items.length - maxItemsPerRun : 0
    for (const i of items.slice(0, maxItemsPerRun))
      await tx(d => runOne(d, { projectId: i.projectId, issueId: i.id, reporterId: i.reporterId, leadId: i.leadId, actorId: null }, r, { kind: 'scheduled' }))
    if (left && items[0]) await db.query(`insert into rule_runs (rule_id, project_id, trigger, result, steps) values ($1, $2, $3, 'some_skipped', $4)`,
      [r.id, items[0].projectId, JSON.stringify({ kind: 'scheduled' }), JSON.stringify([{ action: 'scheduled', outcome: 'skipped', note: `${left === 1 ? 'one more work item' : 'more work items'} than ${maxItemsPerRun} matched: the rest wait for the next run` }])])
    await db.query('update rules set last_run_at = $2 where id = $1', [r.id, started])
    return { ran: Math.min(items.length, maxItemsPerRun) }
  } finally {
    await tx(d => scheduleRule(d, r, r.ws))
  }
})
