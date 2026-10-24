import type { Db } from './db.ts'
import { canJoinWork } from './access.ts'
import { ruleContext, transitionTo, type TransitionRow } from './transitions.ts'
import { problems } from './shared/transitionRules.ts'

export interface RuleCtx { projectId: string; issueId: string; reporterId: string | null; leadId: string | null }
type Trigger = { kind: 'created' } | { kind: 'assigned' } | { kind: 'status'; to: string }
type Rule = { id: string; name: string; trigger: Trigger; actions: any[]; ownerId?: string | null }
export interface Step { action: string; outcome: 'done' | 'skipped' | 'unchanged' | 'failed'; note?: string }

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
  for (const a of r.actions) {
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
  const rules = await d.query<Rule>('select id, name, trigger, actions, owner_id from rules where project_id = $1 and enabled order by id', [ctx.projectId])
  for (const r of rules) {
    if (r.trigger.kind !== t.kind || (t.kind === 'status' && (r.trigger as any).to !== t.to)) continue
    await d.query('savepoint automation_rule')
    try {
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
  // the audit log keeps 90 days
  await d.query(`delete from rule_runs where project_id = $1 and at < now() - interval '90 days'`, [ctx.projectId])
}

/** What a rule would do to an item, without doing it: its actions run in a savepoint that is then undone. */
export async function dryRun(d: Db, ctx: RuleCtx, r: Pick<Rule, 'actions'>): Promise<{ steps: Step[]; error: string | null }> {
  await d.query('savepoint automation_dry_run')
  try {
    return { steps: await act(d, ctx, { id: '', name: '', trigger: { kind: 'created' }, ...r }), error: null }
  } catch (e) {
    return { steps: [], error: e instanceof Error ? e.message : String(e) }
  } finally {
    await d.query('rollback to savepoint automation_dry_run')
  }
}
