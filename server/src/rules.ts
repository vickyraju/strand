import type { Db } from './db.ts'

export interface RuleCtx { projectId: string; issueId: string; reporterId: string | null; leadId: string | null }
type Trigger = { kind: 'created' } | { kind: 'assigned' } | { kind: 'status'; to: string }

/** Run enabled automation rules for one trigger. Actions never re-trigger rules (no loops).
 *  ponytail: runs inline in the request transaction; move to a queue worker when rules get slow or numerous. */
export async function runRules(d: Db, ctx: RuleCtx, t: Trigger) {
  const rules = await d.query<{ id: string; trigger: Trigger; actions: any[] }>(
    'select id, trigger, actions from rules where project_id = $1 and enabled', [ctx.projectId])
  for (const r of rules) {
    if (r.trigger.kind !== t.kind || (t.kind === 'status' && (r.trigger as any).to !== t.to)) continue
    for (const a of r.actions) {
      switch (a.kind) {
        case 'assign': {
          const to = a.to === 'reporter' ? ctx.reporterId : a.to === 'lead' ? ctx.leadId : a.to === 'unassign' ? null : a.to
          await d.query('update issues set assignee_id = $2, updated_at = now(), version = version + 1 where id = $1', [ctx.issueId, to])
          break
        }
        case 'priority':
          await d.query('update issues set priority = $2, updated_at = now(), version = version + 1 where id = $1', [ctx.issueId, a.value]); break
        case 'label':
          await d.query(`update issues set labels = array(select distinct unnest(labels || $2::text)), updated_at = now(), version = version + 1 where id = $1`, [ctx.issueId, a.value]); break
        case 'status':
          await d.query('update issues set status_id = $2, updated_at = now(), version = version + 1 where id = $1', [ctx.issueId, a.value]); break
        case 'comment':
          await d.query('insert into comments (issue_id, author_id, body) values ($1, null, $2)', [ctx.issueId, a.body]); break
      }
    }
    await d.query('update rules set runs = runs + 1 where id = $1', [r.id])
    await d.query(`insert into activity (issue_id, actor_id, text) values ($1, null, $2)`, [ctx.issueId, `Automation rule ran`])
  }
}
