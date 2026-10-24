import type { Db } from './db.ts'
import { canJoinWork } from './access.ts'
import { ruleContext, transitionTo, type TransitionRow } from './transitions.ts'
import { problems } from './shared/transitionRules.ts'

export interface RuleCtx { projectId: string; issueId: string; reporterId: string | null; leadId: string | null }
type Trigger = { kind: 'created' } | { kind: 'assigned' } | { kind: 'status'; to: string }

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

/** Run enabled automation rules for one trigger. Actions never re-trigger rules (no loops).
 *  Automation follows the same rules as people: it cannot make a move the workflow forbids, nor give work to someone
 *  outside the project. Such an action is skipped and the skip is written to the item's history.
 *  ponytail: runs inline in the request transaction; move to a queue worker when rules get slow or numerous. */
export async function runRules(d: Db, ctx: RuleCtx, t: Trigger) {
  const rules = await d.query<{ id: string; trigger: Trigger; actions: any[] }>(
    'select id, trigger, actions from rules where project_id = $1 and enabled', [ctx.projectId])
  for (const r of rules) {
    if (r.trigger.kind !== t.kind || (t.kind === 'status' && (r.trigger as any).to !== t.to)) continue
    for (const a of r.actions) {
      const [cur] = await d.query<{ statusId: string; assigneeId: string | null; priority: string; labels: string[]; type: string }>(
        'select status_id, assignee_id, priority, labels, type from issues where id = $1', [ctx.issueId])
      const set = (col: string, value: unknown) =>
        d.query(`update issues set ${col} = $2, updated_at = now(), version = version + 1 where id = $1`, [ctx.issueId, value])
      switch (a.kind) {
        case 'assign': {
          const to = a.to === 'reporter' ? ctx.reporterId : a.to === 'lead' ? ctx.leadId : a.to === 'unassign' ? null : a.to
          if (to === cur!.assigneeId) break
          if (to && !(await canJoinWork(d, ctx.projectId, to))) {
            await history(d, ctx.issueId, null, null, null, 'Automation skipped an assignment: that person is not in this project'); break
          }
          await set('assignee_id', to)
          await history(d, ctx.issueId, 'assigneeId', cur!.assigneeId, to, 'Automation changed assignee')
          break
        }
        case 'priority':
          if (a.value === cur!.priority) break
          await set('priority', a.value)
          await history(d, ctx.issueId, 'priority', cur!.priority, a.value, 'Automation changed priority')
          break
        case 'label':
          if (cur!.labels.includes(a.value)) break
          await set('labels', [...cur!.labels, a.value])
          await history(d, ctx.issueId, 'labels', cur!.labels, [...cur!.labels, a.value], 'Automation added a label')
          break
        case 'status': {
          const [target] = await d.query('select 1 from statuses where id = $1 and project_id = $2', [a.value, ctx.projectId])
          if (!target || !(await moveAllowed(d, ctx.projectId, cur!.statusId, a.value, cur!.type))) {
            await history(d, ctx.issueId, null, null, null, 'Automation skipped a status change the workflow does not allow'); break
          }
          if (a.value === cur!.statusId) break
          // the transition's rules apply to automation too (those about who moves don't: no person is moving)
          const { ISSUE_ROW, runActions } = await import('./routes/issues.ts')
          const [item] = await d.query<any>(`${ISSUE_ROW} where i.id = $1`, [ctx.issueId])
          const rctx = await ruleContext(d, item, null)
          let t: TransitionRow | null
          try { t = await transitionTo(d, item, a.value, rctx) } catch {
            await history(d, ctx.issueId, null, null, null, 'Automation skipped a status change the transition’s rules do not allow'); break
          }
          const why = Object.values(problems(t?.rules, rctx, item, { ...item, statusId: a.value }))
          if (why.length) { await history(d, ctx.issueId, null, null, null, `Automation skipped a status change: ${why.join('; ')}`); break }
          await set('status_id', a.value)
          await history(d, ctx.issueId, 'statusId', cur!.statusId, a.value, 'Automation changed status')
          if (t) await runActions(d, null, ctx.issueId, t, rctx)
          break
        }
        case 'comment':
          await d.query('insert into comments (issue_id, author_id, body) values ($1, null, $2)', [ctx.issueId, a.body]); break
      }
    }
    await d.query('update rules set runs = runs + 1 where id = $1', [r.id])
    await history(d, ctx.issueId, null, null, null, 'Automation rule ran')
  }
}
